/**
 * A caller turn that sounds like the simulated user stepping out of its role: talking about its own
 * instructions, saying its goal is met, or describing the agent in the third person instead of
 * speaking to it. Such a turn says nothing about the agent, but the agent hears it, so the trial is
 * worth reading before its verdict is trusted. Notes never change whether a trial passed.
 */
export interface CallerNote {
  /** The caller's turn, counting from 1. */
  turn: number;
  /** The sentence that was flagged. */
  text: string;
  /** Why, e.g. "talks about its instructions". */
  why: string;
}

/**
 * The phrases that flag a turn. They are deliberately narrow: a real caller says "my goal is to book
 * this load" or "the agent I spoke to yesterday", and neither is flagged. A real caller who quotes
 * "the agent told me last week" is, and a role break worded any other way is missed.
 */
const PATTERNS: { why: string; re: RegExp }[] = [
  // "my instructions say", "per my script", but not "my instructions from dispatch".
  { why: "talks about its instructions", re: /\bmy (?:instructions|script|persona)\b(?!\s+(?:from|at|for|with)\b)/i },
  { why: "talks about its instructions", re: /\b(?:as instructed|role-?play(?:ing)?|simulated (?:customer|caller|user)|as the (?:customer|caller|user)\b)/i },
  { why: "says its goal is met", re: /\bmy (?:goal|task) (?:is|was|has been) (?:now )?(?:met|complete|completed|achieved|accomplished|done)\b/i },
  // "The agent asked for three things at once", "the agent's first counter-offer", "Agent says they can't",
  // not "the agent I spoke to" or "can I talk to an agent". "The agent told me" is left out: a caller can
  // say it of a call last week.
  {
    why: "talks about the agent in the third person",
    re: /\bthe (?:agent|assistant)(?:'s\b| (?:has |had |just |now |then |also )?(?:asked|asks|is asking|said|says|wants|wanted|offered|offers|is offering|countered|quoted|proposed|recommended|suggested|explained|transferred|needs|requested|requests|confirmed|confirms|mentioned|mentions|didn't|did not|hasn't|has not)\b)|(?<=^|[.!?]\s+)agent (?:says|said|asks|asked|offers|offered)\b/im,
  },
];

/** The sentence of `text` around index `at`: sentences end at `.`, `?` or `!` before a space, or at a line break. */
function sentenceAt(text: string, at: number): string {
  let start = 0;
  for (const m of text.matchAll(/[.!?](?=\s)|\n/g)) {
    if (m.index >= at) return text.slice(start, m.index + (m[0] === "\n" ? 0 : 1)).trim();
    start = m.index + 1;
  }
  return text.slice(start).trim();
}

/** One note per caller turn that matches a pattern, with every reason it matched. */
export function callerNotes(events: readonly { type: string; text?: string }[]): CallerNote[] {
  const notes: CallerNote[] = [];
  let turn = 0;
  for (const e of events) {
    if (e.type !== "user" || e.text === undefined) continue;
    turn++;
    const hits = PATTERNS.map((p) => ({ why: p.why, at: e.text!.search(p.re) })).filter((h) => h.at >= 0);
    if (!hits.length) continue;
    const why = [...new Set(hits.map((h) => h.why))].join("; ");
    notes.push({ turn, text: sentenceAt(e.text, Math.min(...hits.map((h) => h.at))), why });
  }
  return notes;
}
