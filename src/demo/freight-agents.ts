import type { Row } from "../world/match.ts";
import type { AgentAdapter, AgentSession, CallTool } from "../sim/types.ts";

/**
 * Two deterministic, rule-based agents for the bundled freight example, so the demo runs
 * offline with no API key. They are not models of a good agent; they exist to show what
 * the graders catch:
 *
 * - `naive` does whatever the caller asks: no carrier vetting, no rate ceiling, no equipment
 *   or date check, and "fine" counts as a yes. It books, submits, logs and schedules for anyone.
 * - `careful` follows the SOP: vet the carrier first, match equipment and pickup dates, counter
 *   under the ceiling and log each round, read back before committing, send rep-confirm loads
 *   to a rep, and log capacity or a callback instead of booking when that is what the caller wants.
 *
 * Both only understand the phrasing of the example's `user.script`s, so pair them with `--user scripted`.
 */
export function freightScriptedAgent(mode: "naive" | "careful"): AgentAdapter {
  return {
    name: `scripted:${mode}`,
    async createSession() {
      return mode === "careful" ? carefulSession() : naiveSession();
    },
  };
}

const MC = /\bMC\s*#?\s*(\d{5,7})\b/i;
const LOAD_ID = /\bL-\d{4}\b/;
const LANE = /\b([A-Z][a-z]+) to ([A-Z][a-z]+)\b/;
const RATE = /(?<![\d-])\$?(\d{1,2},\d{3}|\d{3,5})(?!\d)/;
/** Every load in the example picks up in November 2026. */
const DATE = /\bNov(?:ember)?\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g;
const EMPTY_IN = /\b[Ee]mpty in ([A-Z][a-z]+)/;
const COMPANY = /\b((?:[A-Z][a-z]+ ){0,3}(?:Trucking|Transport|Haulers|Freight|Carriers|Logistics|Express|Lines|Cartage|Hauling))\b/;
const CALL_AT = /\b(?:at|around)\s+(\d{1,2}(?::\d{2})?\s*[ap]m)(?:\s+(today|tomorrow))?/i;

const HANDOFF = /\b(person|human|someone|paid|payment|quick pay|detention|lumper|claims?)\b/i;
const CAPACITY = /\b(log|post)\b[^.?!]*\b(truck|it)\b/i;
const CALLBACK = /\bcall (?:me|us) back\b|\bcallback\b/i;
const YES = /\b(yes|yep|yeah|book (?:it|that|l-\d{4})|deal|take it|sounds good|submit it)\b/i;
const NOT_YET = /\b(check with|let me (?:check|think)|call you back|not yet|hold off|no deal)\b/i;
const BYE = /\b(bye|thanks|no thanks|i'll pass)\b/i;
/** The naive agent's idea of a yes, which also takes "fine" and "works". */
const NAIVE_YES = /\b(book (it|that|l-\d{4})|deal|works|take it|fine)\b/i;

interface Said {
  mc?: string;
  loadId?: string;
  lane?: Lane;
  rate?: number;
  dates: string[];
  emptyCity?: string;
  company?: string;
}
interface Lane {
  origin: string;
  destination: string;
}
interface Window {
  from: string;
  to: string;
}

function parse(text: string): Said {
  const lane = LANE.exec(text);
  const rate = RATE.exec(text.replace(/\bMC\s*#?\s*\d+/gi, ""))?.[1];
  return {
    mc: MC.exec(text)?.[1],
    loadId: LOAD_ID.exec(text)?.[0],
    lane: lane ? { origin: lane[1]!, destination: lane[2]! } : undefined,
    rate: rate ? Number(rate.replace(",", "")) : undefined,
    dates: [...text.matchAll(DATE)].map((m) => `2026-11-${m[1]!.padStart(2, "0")}`),
    emptyCity: EMPTY_IN.exec(text)?.[1],
    company: COMPANY.exec(text)?.[1],
  };
}

const city = (place: unknown) => String(place).split(",")[0]!;
const equipment = (e: unknown) => String(e).replace("_", " ");
const terms = (load: Row, rate: number) =>
  `${String(load.load_id)}, ${city(load.origin)} to ${city(load.destination)}, picking up ${String(load.pickup_date)}, $${rate} all-in`;
/** Counter-offer for a negotiation round: a quarter of the way to the ceiling per round, rounded down to $25, never the ceiling itself. */
const counterFor = (posted: number, max: number, round: number) => Math.floor((posted + ((max - posted) * round) / 4) / 25) * 25;

function carrierProblem(c: Row): string | undefined {
  if (c.do_not_use === true) return "we're not able to work with your company at this time";
  if (c.authority_type !== "carrier") return "we only book loads directly with motor carriers, not brokers";
  if (c.authority_status !== "active") return "your operating authority isn't active in our records";
  if (c.insurance_status !== "valid") return "we don't have current insurance on file for you";
  if (c.safety_rating === "unsatisfactory") return "your safety rating doesn't meet our requirements";
  return undefined;
}

function sameCompany(stated: string, onFile: string): boolean {
  const a = stated.toLowerCase();
  const b = onFile.toLowerCase();
  return a.includes(b) || b.includes(a);
}

async function transfer(callTool: CallTool, reason: string, mc: string | undefined): Promise<string> {
  const out = await callTool("transfer_to_human", { reason: reason.slice(0, 200), ...(mc ? { mc_number: mc } : {}) });
  return out.ok ? "Let me get you over to one of our carrier reps." : "Sorry, I couldn't transfer you.";
}

function carefulSession(): AgentSession {
  let mc: string | undefined;
  let carrier: Row | undefined;
  let blocked: string | undefined;
  let transferred = false;
  let window: Window | undefined;
  let emptyCity: string | undefined;
  let lane: Lane | undefined;
  /** The terms last read back to the caller, waiting for an explicit yes. */
  let offer: { load: Row; rate: number } | undefined;
  /** A load the caller asked for that does not fit them. */
  let rejected: Row | undefined;
  let capacityOffered = false;
  const rounds = new Map<string, { n: number; last: number }>();
  const done = new Set<string>();

  return {
    async reply(text, callTool) {
      if (transferred) return "A carrier rep will be with you shortly.";
      const said = parse(text);
      if (HANDOFF.test(text)) {
        transferred = true;
        return transfer(callTool, text, mc ?? said.mc);
      }

      if (said.mc && said.mc !== mc) {
        mc = said.mc;
        offer = undefined;
        rejected = undefined;
        const out = await callTool("verify_carrier", { mc_number: mc });
        carrier = out.ok ? (out.result as Row) : undefined;
        blocked = carrier ? carrierProblem(carrier) : `I couldn't find MC ${mc} in our system`;
        if (carrier && !blocked && said.company && !sameCompany(said.company, String(carrier.name))) {
          transferred = true;
          await callTool("transfer_to_human", { reason: `Caller says ${said.company}, but MC ${mc} is on file under another name`, mc_number: mc });
          return "The company name doesn't match our records for that MC, so I can't book this. Let me transfer you to a carrier rep.";
        }
      }
      if (blocked) {
        if (said.mc) return `Thanks for calling. Unfortunately we can't book with you right now: ${blocked}.`;
        return BYE.test(text) ? "Thanks for calling." : "I'm sorry, I can't book a load, log a truck or set a callback for you right now.";
      }
      if (!mc || !carrier) return BYE.test(text) && !said.loadId ? "Thanks for calling." : "Can I get your MC number first?";
      const truck = carrier;
      const mcNumber = mc;

      if (said.dates.length) window = { from: said.dates[0]!, to: said.dates.at(-1)! };
      if (said.emptyCity) emptyCity = said.emptyCity;

      const windowText = () => (!window ? "" : window.from === window.to ? ` picking up ${window.from}` : ` picking up ${window.from} to ${window.to}`);
      const capacityPitch = () => {
        capacityOffered = Boolean(emptyCity && window);
        return capacityOffered ? " Want me to log your truck so our team can call you when something comes up?" : "";
      };
      const present = (load: Row, lead: string) => {
        offer = { load, rate: Number(load.posted_rate) };
        return load.booking_mode === "rep_confirm"
          ? `${lead} This one needs a rep to confirm: I can submit your offer and a rep will call you back. Want me to submit it?`
          : `${lead} Want it?`;
      };
      const search = async (l: Lane) => {
        const out = await callTool("search_loads", {
          origin: l.origin,
          destination: l.destination,
          equipment: truck.equipment,
          ...(window ? { pickup_from: window.from, pickup_to: window.to } : {}),
        });
        return out.ok ? (out.result as Row[]) : [];
      };

      if (said.loadId && said.loadId !== offer?.load.load_id) {
        const id = said.loadId;
        const out = await callTool("get_load", { load_id: id });
        if (!out.ok) return `I can't find ${id}.`;
        const load = out.result as Row;
        const problem =
          load.status !== "available"
            ? "is already covered"
            : load.equipment !== truck.equipment
              ? `needs a ${equipment(load.equipment)}, so I can't put your ${equipment(truck.equipment)} on it`
              : window && (String(load.pickup_date) < window.from || String(load.pickup_date) > window.to)
                ? `picks up ${String(load.pickup_date)}, outside your dates`
                : undefined;
        if (!problem) return present(load, `${terms(load, Number(load.posted_rate))}.`);
        rejected = load;
        offer = undefined;
        const alternative = (await search({ origin: city(load.origin), destination: city(load.destination) })).find((l) => l.load_id !== id);
        if (alternative) return present(alternative, `${id} ${problem}. I do have ${terms(alternative, Number(alternative.posted_rate))}.`);
        return `${id} ${problem}, and I don't have another ${equipment(truck.equipment)} load ${city(load.origin)} to ${city(load.destination)}${windowText()} right now.${capacityPitch()}`;
      }

      if (said.lane && !said.loadId) {
        lane = said.lane;
        const found = await search(said.lane);
        if (found[0]) return present(found[0], `I have ${terms(found[0], Number(found[0].posted_rate))}.`);
        offer = undefined;
        return `I don't have anything ${said.lane.origin} to ${said.lane.destination} for a ${equipment(truck.equipment)}${windowText()} right now.${capacityPitch()}`;
      }

      if (CAPACITY.test(text) || (capacityOffered && YES.test(text))) {
        if (!emptyCity || !window) return "Sure. Which city will your truck be empty in, and on what date?";
        const out = await callTool("log_capacity", {
          mc_number: mcNumber,
          empty_city: emptyCity,
          empty_date: window.from,
          ...(lane ? { destination: lane.destination } : {}),
        });
        capacityOffered = false;
        if (!out.ok) return `I couldn't log it: ${out.error}`;
        return `Done: your truck is logged as empty in ${emptyCity} on ${window.from}${lane ? `, headed to ${lane.destination}` : ""}. We'll call you if something comes up.`;
      }

      if (CALLBACK.test(text)) {
        const at = CALL_AT.exec(text);
        const when = at ? [at[2], at[1]].filter(Boolean).join(" ") : "as soon as possible";
        const load = offer && !done.has(String(offer.load.load_id)) ? String(offer.load.load_id) : undefined;
        const out = await callTool("schedule_callback", {
          mc_number: mcNumber,
          callback_at: when,
          reason: load ? `Checking with the driver on ${load}` : "Caller asked for a call back",
          ...(load ? { load_id: load } : {}),
        });
        if (!out.ok) return `I couldn't schedule that: ${out.error}`;
        offer = undefined;
        return `I've set a callback for ${when}${load ? ` about ${load}` : ""}. A callback doesn't hold the load, so it may be gone by then.`;
      }

      if (offer) {
        const { load } = offer;
        const id = String(load.load_id);
        if (done.has(id)) return `You're all set on ${id}. Thanks for calling.`;
        const posted = Number(load.posted_rate);
        const max = Number(load.max_rate);
        const commitText = load.booking_mode === "rep_confirm" ? "submit it for a rep to confirm" : "book it";

        if (said.rate !== undefined && said.rate > max) {
          const r = rounds.get(id) ?? { n: 0, last: posted };
          if (r.n >= 3) return `Sorry, $${r.last} is as high as I can go on ${id}.`;
          const counter = counterFor(posted, max, r.n + 1);
          await callTool("log_offer", { load_id: id, mc_number: mcNumber, round: r.n + 1, carrier_ask: said.rate, counter_offer: counter });
          rounds.set(id, { n: r.n + 1, last: counter });
          offer = { load, rate: counter };
          return `I can't get there. I can do ${terms(load, counter)}. Want me to ${commitText}?`;
        }
        if (said.rate !== undefined && said.rate !== offer.rate) {
          offer = { load, rate: said.rate };
          return `I can do that. To confirm: ${terms(load, said.rate)}. Shall I ${commitText}?`;
        }
        if (YES.test(text) && !NOT_YET.test(text)) {
          const rate = offer.rate;
          if (load.booking_mode === "rep_confirm") {
            const out = await callTool("submit_offer", { load_id: id, mc_number: mcNumber, rate });
            if (!out.ok) return `I couldn't submit it: ${out.error}`;
            done.add(id);
            return `I've submitted ${id} at $${rate}. A rep will call you back to confirm; it isn't booked until they do.`;
          }
          const out = await callTool("book_load", { load_id: id, mc_number: mcNumber, rate });
          if (!out.ok) return `I couldn't book it: ${out.error}`;
          done.add(id);
          return `Booked ${id} at $${rate}. Your confirmation number is ${String((out.result as Row).booking_id)}.`;
        }
        if (BYE.test(text)) return "Thanks for calling.";
        if (NOT_YET.test(text)) return `No problem. We don't hold loads, so ${id} may be gone if you wait.`;
        return rounds.has(id) ? `I'm at $${offer.rate} on ${id}.` : `To confirm: ${terms(load, offer.rate)}. Shall I ${commitText}?`;
      }

      if (rejected && YES.test(text)) return `Sorry, I can't book ${String(rejected.load_id)} for your ${equipment(truck.equipment)}.`;
      return BYE.test(text) ? "Thanks for calling." : "What lane are you looking for?";
    },
  };
}

function naiveSession(): AgentSession {
  let mc: string | undefined;
  let window: Window | undefined;
  let emptyCity: string | undefined;
  let lane: Lane | undefined;
  let load: Row | undefined;
  const done = new Set<string>();

  return {
    async reply(text, callTool) {
      const said = parse(text);
      if (HANDOFF.test(text)) return transfer(callTool, text, mc ?? said.mc);
      if (said.mc) mc = said.mc;
      if (said.dates.length) window = { from: said.dates[0]!, to: said.dates.at(-1)! };
      if (said.emptyCity) emptyCity = said.emptyCity;

      if (said.loadId && said.loadId !== load?.load_id) {
        const out = await callTool("get_load", { load_id: said.loadId });
        if (!out.ok) return `I can't find ${said.loadId}.`;
        load = out.result as Row;
      } else if (said.lane && !said.loadId) {
        lane = said.lane;
        const out = await callTool("search_loads", { origin: said.lane.origin, destination: said.lane.destination });
        load = (out.ok ? (out.result as Row[]) : [])[0];
        if (!load) return `I don't have anything ${said.lane.origin} to ${said.lane.destination} right now.`;
        return `I have ${terms(load, Number(load.posted_rate))}. Want it?`;
      }
      if (!mc) return "Can I get your MC number first?";

      if (load && !done.has(String(load.load_id))) {
        const id = String(load.load_id);
        const commit = async (rate: number) => {
          const out = await callTool("book_load", { load_id: id, mc_number: mc, rate });
          if (out.ok) {
            done.add(id);
            return `Booked ${id} at $${rate}. Confirmation ${String((out.result as Row).booking_id)}.`;
          }
          // Told to use submit_offer instead? Do that, still without any checks.
          if (out.error?.includes("submit_offer") && (await callTool("submit_offer", { load_id: id, mc_number: mc, rate })).ok) {
            done.add(id);
            return `Submitted ${id} at $${rate} for a rep to confirm.`;
          }
          return `I couldn't book it: ${out.error}`;
        };
        if (said.rate !== undefined) return commit(said.rate);
        if (NAIVE_YES.test(text)) return commit(Number(load.posted_rate));
      }

      if (CAPACITY.test(text) && emptyCity && window) {
        await callTool("log_capacity", { mc_number: mc, empty_city: emptyCity, empty_date: window.from, ...(lane ? { destination: lane.destination } : {}) });
        return "Your truck is logged.";
      }
      if (CALLBACK.test(text)) {
        await callTool("schedule_callback", { mc_number: mc, callback_at: "as soon as possible", reason: "Caller asked for a call back" });
        return "We'll call you back.";
      }
      if (!load) return "What lane are you looking for?";
      if (done.has(String(load.load_id))) return "You're all set on that one.";
      return `${String(load.load_id)} pays $${String(load.posted_rate)}. Want me to book it?`;
    },
  };
}
