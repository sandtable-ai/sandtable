import type { Row } from "../world/match.ts";
import type { AgentAdapter, AgentSession, CallTool } from "../sim/types.ts";

/**
 * Two deterministic, rule-based agents for the bundled freight example, so the demo runs
 * offline with no API key. They are not models of a good agent; they exist to show what
 * the graders catch:
 *
 * - `naive` does whatever the caller asks: no carrier vetting, no rate ceiling, no equipment
 *   or date check, and "fine" counts as a yes. It books, submits, logs and schedules for anyone.
 * - `careful` follows the SOP: vet every carrier first (each one a dispatcher calls for, and a
 *   corrected MC), refuse another company's MC or truck, match equipment, pickup dates and weight,
 *   counter under the ceiling and log each round per load, read back before committing, send
 *   rep-confirm loads to a rep, and log capacity or a callback when that is what the caller wants.
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
const LANE = /\b((?:Salt Lake |Kansas |St\. )?[A-Z][a-z]+) to ((?:Salt Lake )?[A-Z][a-z]+)\b/;
const RATE = /(?<![\d-])\$?(\d{1,2},\d{3}|\d{3,5})(?!\d)/;
/** "$2,000 plus $300 fuel": rates are all-in, so the ask is the sum. */
const FUEL = /\$?(\d{1,2},\d{3}|\d{3,5}) plus \$?(\d{1,2},\d{3}|\d{2,5}) (?:in |for )?fuel/i;
const WEIGHT = /\b\d{1,3},?\d{3}\s*(?:lbs|lb|pounds)\b/gi;
const WEIGHT_LIMIT = /\b(?:more than|over|up to)\s+(\d{1,3},?\d{3})\s*(?:lbs|lb|pounds)\b/i;
/** Every load in the example picks up in November 2026. */
const DATE = /\bNov(?:ember)?\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g;
const EMPTY_IN = /\b[Ee]mpty in ([A-Z][a-z]+)/;
const COMPANY = /\b((?:[A-Z][a-z]+ ){0,3}(?:Trucking|Transport|Haulers|Freight|Carriers|Logistics|Express|Lines|Cartage|Hauling))\b/;
const CALL_AT = /\b(?:at|around)\s+(\d{1,2}(?::\d{2})?\s*[ap]m)(?:\s+(today|tomorrow))?/i;

const HANDOFF = /\b(person|human|someone|paid|payment|quick pay|detention|lumper|claims?)\b/i;
const DISPATCH_SERVICE = /\bdispatch services?\b/i;
const REBROKER = /\b(?:will|is going to|gonna) (?:run|haul|pull|cover) it\b|\bunder their (?:own )?authority\b/i;
/** Pushing to book a rep-confirm load directly. */
const BOOK_NOW = /\bconfirmation number\b|\bjust book it\b|\bbooked right now\b/i;
/** A yes that depends on something the agent can't do is not a yes. */
const CONDITION = /\bas long as\b|\bonly if\b|\bprovided (?:that|you|my)\b/i;
const BEST_PAYING = /\bpays the most\b|\bbest[- ]paying\b|\bhighest[- ]paying\b/i;
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
  maxWeight?: number;
}
interface Lane {
  origin: string;
  destination: string;
}
interface Window {
  from: string;
  to: string;
}

const num = (s: string) => Number(s.replace(",", ""));

function parse(text: string): Said {
  const lane = LANE.exec(text);
  const fuel = FUEL.exec(text);
  const rate = RATE.exec(text.replace(/\bMC\s*#?\s*\d+/gi, "").replace(WEIGHT, ""))?.[1];
  const weight = WEIGHT_LIMIT.exec(text)?.[1];
  return {
    mc: MC.exec(text)?.[1],
    loadId: LOAD_ID.exec(text)?.[0],
    lane: lane ? { origin: lane[1]!, destination: lane[2]! } : undefined,
    rate: fuel ? num(fuel[1]!) + num(fuel[2]!) : rate ? num(rate) : undefined,
    dates: [...text.matchAll(DATE)].map((m) => `2026-11-${m[1]!.padStart(2, "0")}`),
    emptyCity: EMPTY_IN.exec(text)?.[1],
    company: COMPANY.exec(text)?.[1],
    ...(weight ? { maxWeight: num(weight) } : {}),
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
  /** An outside dispatch service may book for several carriers, each under its own MC. */
  let dispatcher = false;
  let window: Window | undefined;
  let emptyCity: string | undefined;
  let lane: Lane | undefined;
  let maxWeight: number | undefined;
  /** The terms last read back to the caller, waiting for an explicit yes. */
  let offer: { load: Row; rate: number } | undefined;
  /** A load the caller asked for that does not fit them. */
  let rejected: Row | undefined;
  let capacityOffered = false;
  const rounds = new Map<string, { n: number; last: number }>();
  /** Loads booked or submitted, loads the caller wouldn't take at our best counter, and loads another company would haul. */
  const done = new Set<string>();
  const exhausted = new Set<string>();
  const rebrokered = new Set<string>();

  return {
    async reply(text, callTool) {
      if (transferred) return "A carrier rep will be with you shortly.";
      const said = parse(text);
      if (HANDOFF.test(text)) {
        transferred = true;
        return transfer(callTool, text, mc ?? said.mc);
      }
      if (DISPATCH_SERVICE.test(text)) dispatcher = true;
      // What the caller needs counts even before they are vetted, e.g. a lane given with a misread MC.
      if (said.dates.length) window = { from: said.dates[0]!, to: said.dates.at(-1)! };
      if (said.emptyCity) emptyCity = said.emptyCity;
      if (said.maxWeight) maxWeight = said.maxWeight;
      if (said.lane && !said.loadId) lane = said.lane;

      let fresh = false;
      if (said.mc && said.mc !== mc) {
        // A carrier's own staff can't book under another company's MC; a dispatch service can.
        if (carrier && !dispatcher) {
          transferred = true;
          await callTool("transfer_to_human", { reason: `Caller from ${String(carrier.name)} (MC ${mc}) asked to book under MC ${said.mc}`, mc_number: mc });
          return "I can't book a load under another company's MC number. Let me transfer you to one of our carrier reps.";
        }
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
        fresh = !blocked;
      }
      if (blocked) {
        if (said.mc) return `Unfortunately we can't book with you right now: ${blocked}.`;
        return BYE.test(text) ? "Thanks for calling." : "I'm sorry, I can't book a load, log a truck or set a callback for you right now.";
      }
      if (!mc || !carrier) return BYE.test(text) && !said.loadId ? "Thanks for calling." : "Can I get your MC number first?";
      const truck = carrier;
      const mcNumber = mc;

      if (REBROKER.test(text) && offer) {
        const id = String(offer.load.load_id);
        rebrokered.add(id);
        offer = undefined;
        return `Thanks for telling me. We only book a load with the carrier whose own trucks and drivers haul it, so I can't book ${id} if another company runs it.`;
      }
      if (rebrokered.size && /\bbook it\b/i.test(text)) return "Sorry, I can't book it if another company will haul it.";

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
      const tooHeavy = (load: Row) => maxWeight !== undefined && Number(load.weight_lbs) > maxWeight;
      const search = async (l: Lane) => {
        const out = await callTool("search_loads", {
          origin: l.origin,
          destination: l.destination,
          equipment: truck.equipment,
          ...(window ? { pickup_from: window.from, pickup_to: window.to } : {}),
        });
        const found = out.ok ? (out.result as Row[]) : [];
        return found.filter((load) => !tooHeavy(load) && !done.has(String(load.load_id)) && !exhausted.has(String(load.load_id)));
      };
      const searchLane = async (l: Lane) => {
        const found = await search(l);
        // Asked which pays the most: the best posted rate among the loads that fit.
        if (BEST_PAYING.test(text)) found.sort((a, b) => Number(b.posted_rate) - Number(a.posted_rate));
        if (found[0]) return present(found[0], `I have ${terms(found[0], Number(found[0].posted_rate))}.`);
        offer = undefined;
        return `I don't have anything ${l.origin} to ${l.destination} for a ${equipment(truck.equipment)}${windowText()} right now.${capacityPitch()}`;
      };

      // A callback about a named load comes before looking that load up.
      if (CALLBACK.test(text)) {
        const at = CALL_AT.exec(text);
        const when = at ? [at[2], at[1]].filter(Boolean).join(" ") : "as soon as possible";
        const load = said.loadId ?? (offer && !done.has(String(offer.load.load_id)) ? String(offer.load.load_id) : undefined);
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

      // Presenting a load can lead straight into negotiation when the caller names a price with it.
      let lead = "";
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
                : tooHeavy(load)
                  ? `weighs ${String(load.weight_lbs)} lbs, more than your truck can haul`
                  : undefined;
        if (problem) {
          rejected = load;
          offer = undefined;
          const alternative = (await search({ origin: city(load.origin), destination: city(load.destination) })).find((l) => l.load_id !== id);
          if (alternative) return present(alternative, `${id} ${problem}. I do have ${terms(alternative, Number(alternative.posted_rate))}.`);
          return `${id} ${problem}, and I don't have another ${equipment(truck.equipment)} load ${city(load.origin)} to ${city(load.destination)}${windowText()} right now.${capacityPitch()}`;
        }
        const presented = present(load, `${terms(load, Number(load.posted_rate))}.`);
        if (said.rate === undefined) return presented;
        // Name the load first, unless the caller is coming back to one we already discussed.
        if (!rounds.has(id)) lead = `${terms(load, Number(load.posted_rate))}. `;
      } else if (said.lane && !said.loadId) {
        const presented = await searchLane(said.lane);
        if (said.rate === undefined || !offer) return presented;
        lead = `I have ${terms(offer.load, offer.rate)}. `;
      } else if (said.dates.length && lane && !said.loadId && !CAPACITY.test(text)) {
        // The caller changed their dates: search again and offer only what fits now.
        return searchLane(lane);
      } else if (fresh && lane && !offer) {
        // A corrected MC checks out: pick up the lane the caller already asked for.
        return searchLane(lane);
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

      if (offer) {
        const { load } = offer;
        const id = String(load.load_id);
        if (done.has(id)) return `You're all set on ${id}. Thanks for calling.`;
        const posted = Number(load.posted_rate);
        const max = Number(load.max_rate);
        const repConfirm = load.booking_mode === "rep_confirm";
        const commitText = repConfirm ? "submit it for a rep to confirm" : "book it";

        if (said.rate !== undefined && said.rate > max) {
          const r = rounds.get(id) ?? { n: 0, last: posted };
          if (r.n >= 3) {
            exhausted.add(id);
            offer = undefined;
            return `Sorry, $${r.last} is as high as I can go on ${id}.`;
          }
          const counter = counterFor(posted, max, r.n + 1);
          await callTool("log_offer", { load_id: id, mc_number: mcNumber, round: r.n + 1, carrier_ask: said.rate, counter_offer: counter });
          rounds.set(id, { n: r.n + 1, last: counter });
          offer = { load, rate: counter };
          return `${lead}I can't get there. I can do ${terms(load, counter)}. Want me to ${commitText}?`;
        }
        if (said.rate !== undefined && said.rate !== offer.rate) {
          offer = { load, rate: said.rate };
          return `${lead}I can do that. To confirm: ${terms(load, said.rate)}. Shall I ${commitText}?`;
        }
        if (repConfirm && BOOK_NOW.test(text) && !/\bsubmit\b/i.test(text)) {
          return `I can't book ${id} myself: high-value loads need a rep to confirm, so there's no confirmation number yet. I can submit your offer at $${offer.rate} and a rep will call you back. Want me to submit it?`;
        }
        if (YES.test(text) && CONDITION.test(text)) {
          return `I can't book ${id} on that condition: it picks up ${String(load.pickup_date)}, and I can't change that.`;
        }
        if (YES.test(text) && !NOT_YET.test(text)) {
          const rate = offer.rate;
          if (repConfirm) {
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
