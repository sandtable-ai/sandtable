import type { Row } from "../world/match.ts";
import type { AgentAdapter } from "../sim/types.ts";

/**
 * Two deterministic, rule-based agents for the bundled freight example, so the demo runs
 * offline with no API key. They are not models of a good agent; they exist to show what
 * the graders catch:
 *
 * - `naive` books whatever the caller asks for: no carrier vetting, no rate ceiling, no equipment check.
 * - `careful` follows the SOP: vet the carrier first, hold the rate ceiling, match equipment.
 *
 * Pair them with `--user scripted`, which replays each task's `user.script`.
 */
export function freightScriptedAgent(mode: "naive" | "careful"): AgentAdapter {
  const careful = mode === "careful";
  return {
    name: `scripted:${mode}`,
    async createSession() {
      let mc: string | undefined;
      let carrier: Row | undefined;
      let blocked: string | undefined;
      let load: Row | undefined;
      const booked = new Set<string>();

      return {
        async reply(text, callTool) {
          if (/\b(person|human|someone|paid|payment)\b/i.test(text)) {
            const out = await callTool("transfer_to_human", { reason: text.slice(0, 200), ...(mc ? { mc_number: mc } : {}) });
            return out.ok ? "Let me get you over to one of our carrier reps." : "Sorry, I couldn't transfer you.";
          }

          const mcMatch = /\bMC\s*#?\s*(\d{5,7})\b/i.exec(text)?.[1];
          if (mcMatch && mcMatch !== mc) {
            mc = mcMatch;
            carrier = undefined;
            blocked = undefined;
            if (careful) {
              const out = await callTool("verify_carrier", { mc_number: mc });
              carrier = out.ok ? (out.result as Row) : undefined;
              blocked = carrier ? carrierProblem(carrier) : "I couldn't find that MC number";
            }
          }
          if (careful && blocked) return `Thanks for calling. Unfortunately we can't book with you right now: ${blocked}.`;

          const loadId = /\bL-\d{4}\b/.exec(text)?.[0];
          const lane = /\b([A-Z][a-z]+)\s+to\s+([A-Z][a-z]+)\b/.exec(text);
          if (lane && !loadId) {
            const args: Row = { origin: lane[1], destination: lane[2] };
            if (careful && carrier) args.equipment = carrier.equipment;
            const out = await callTool("search_loads", args);
            const found = out.ok ? (out.result as Row[]) : [];
            load = found[0];
            if (!load) return `I don't have anything ${lane[1]} to ${lane[2]} right now.`;
            return `I have ${String(load.load_id)}, ${String(load.origin)} to ${String(load.destination)}, picking up ${String(load.pickup_date)}, paying $${String(load.posted_rate)}. Want it?`;
          }
          if (loadId && loadId !== load?.load_id) {
            const out = await callTool("get_load", { load_id: loadId });
            if (!out.ok) return `I can't find ${loadId}.`;
            load = out.result as Row;
            if (careful && load.status !== "available") {
              load = undefined;
              return `${loadId} is already covered, sorry.`;
            }
            if (careful && carrier && carrier.equipment !== load.equipment) {
              const needed = String(load.equipment);
              load = undefined;
              return `${loadId} needs a ${needed}, so I can't put your truck on it.`;
            }
          }

          if (!load) return mc ? "What lane are you looking for?" : "Can I get your MC number first?";
          if (!mc) return "Can I get your MC number first?";
          const id = String(load.load_id);
          if (booked.has(id)) return "You're all set on that one.";

          const posted = Number(load.posted_rate);
          const max = Number(load.max_rate);
          const rateText = /(?<![\d-])\$?(\d{1,2},\d{3}|\d{3,5})(?!\d)/.exec(text.replace(/\bMC\s*#?\s*\d+/gi, ""))?.[1];
          const proposed = rateText ? Number(rateText.replace(",", "")) : undefined;
          const agrees = /\b(book (it|that|l-\d{4})|deal|works|take it|fine)\b/i.test(text);

          const book = async (rate: number) => {
            const out = await callTool("book_load", { load_id: id, mc_number: mc, rate });
            if (!out.ok) return `I couldn't book it: ${out.error}`;
            booked.add(id);
            return `Booked ${id} at $${rate}. Confirmation ${String((out.result as Row).booking_id)}.`;
          };

          if (proposed !== undefined) {
            if (careful && proposed > max) return `I can't get there. Best I can do is $${Math.round((posted + max) / 2 / 25) * 25}.`;
            return book(proposed);
          }
          if (agrees) return book(posted);
          return `${id} pays $${posted}. Want me to book it?`;
        },
      };
    },
  };
}

function carrierProblem(c: Row): string | undefined {
  if (c.do_not_use === true) return "we're not able to work with your company at this time";
  if (c.authority_status !== "active") return "your operating authority isn't active in our records";
  if (c.insurance_status !== "valid") return "we don't have current insurance on file for you";
  if (c.safety_rating === "unsatisfactory") return "your safety rating doesn't meet our requirements";
  return undefined;
}
