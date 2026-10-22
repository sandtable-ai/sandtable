/**
 * Personal values a drafted task copied from its transcript. `scrubPii` removes emails, phone numbers and card
 * numbers before a transcript leaves the machine, and keeps short identifiers on purpose, since tasks need the
 * order and account IDs a call is about. The model is told to replace names, but doesn't always, and it can
 * rebuild an email from a username it was shown. This scan runs locally on the draft, with no model call, and
 * names each value it finds so a person replaces it with a fictional one. It is deliberately narrow: it can miss
 * a detail worded in a way it doesn't look for, and a false positive costs only a review note.
 */

/** Emails, phone numbers and card numbers: the shapes `scrubPii` removes. */
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/** The emails in a text, without the period that ends a sentence such as "write to jdoe42@example.test." */
const emailsIn = (text: string) => [...text.matchAll(EMAIL)].map((m) => m[0].replace(/\.+$/, ""));
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

/**
 * A username or handle: two or more lowercase letters (dots and underscores allowed) then at least two digits, such
 * as `ap296680`, `jdoe42` or `mia.k_07`. Order, account and load IDs (`O-2019`, `A-519`, `L-1004`) are uppercase with
 * a dash and never match.
 */
const HANDLE = /\b[a-z][a-z._]+\d{2,}\b/g;

/** An email's local part too generic to mean a person when it stands alone in a draft. */
const GENERIC_LOCAL_PARTS = new Set(["admin", "contact", "hello", "help", "info", "mail", "noreply", "office", "orders", "sales", "support", "team"]);

/**
 * A street address: a house number, one to three capitalized words, then a street suffix, such as `5203 Brushwick Dr`
 * or `18 Old Mill Road.` The draft may spell the suffix another way, so it is matched on the number and the words.
 */
const STREET_SUFFIX = "St|Street|Dr|Drive|Ave|Avenue|Rd|Road|Ln|Lane|Blvd|Boulevard|Way|Ct|Court|Pl|Place|Ter|Terrace";
const ADDRESS = new RegExp(`\\b(\\d{1,6})\\s+((?:[A-Z][a-z]+\\s+){1,3})(?:${STREET_SUFFIX})\\b\\.?`, "g");

/** A capitalized word of a name: "Doe", "O'Neil", "Smith-Jones". */
const WORD = "[A-Z][a-z]+(?:['-][A-Za-z][a-z]+)?";
/** Two or three capitalized words. */
const FULL_NAME = `${WORD}(?: ${WORD}){1,2}`;
/** A name the caller gives: "my name is Jane Doe", "this is Jane Doe", "I'm Jane Doe", "it's Jane Doe", "name's Jane Doe". */
const INTRO = new RegExp(`\\b(?:[Mm]y name is|[Mm]y name's|[Nn]ame's|[Tt]his is|I'm|I am|[Ii]t's|[Ii]t is)\\s+(${FULL_NAME})`, "g");
/** A speaker label with the name in parentheses, "Customer (Jane Doe):", or a name as the label, "Jane Doe:". */
const LABEL_IN_PARENS = new RegExp(`\\b[A-Za-z]+\\s*\\((${FULL_NAME})\\)\\s*:`, "g");
const LABEL = new RegExp(`^[ \\t]*(${FULL_NAME})[ \\t]*:`, "gm");
/**
 * The labels a customer's messages carry. A message after one that is only a name, or that starts with a name and a
 * comma or period, gives the caller's name: "Customer: Jane Doe", "User: Doe Jane, and my username is …". The
 * business's side (Agent, Rep, Support) isn't read this way, since its messages name products and pages, not people.
 */
const CUSTOMER_ROLES = ["Customer", "User", "Caller", "Client", "Guest", "Member", "Patient", "Shopper", "Buyer", "Carrier", "Driver", "Visitor"];
const ROLE = CUSTOMER_ROLES.map((r) => `[${r[0]}${r[0]!.toLowerCase()}]${r.slice(1)}`).join("|");
const NAME_MESSAGE = new RegExp(`^[ \\t]*(?:\\[[^\\]\\n]*\\][ \\t]*)?(?:${ROLE})[ \\t]*(?:\\([^)\\n]*\\))?[ \\t]*:[ \\t]*(${FULL_NAME})[ \\t]*(?:[,.]|$)`, "gm");

/** Words that start a speaker label or a sentence and are never part of a person's name. */
const NOT_NAMES = new Set([
  "Agent", "Assistant", "Bot", "Caller", "Customer", "Dispatch", "Dispatcher", "Human", "Operator", "Rep", "Representative",
  "Service", "Support", "System", "Team", "User", "Hello", "Hi", "Hey", "Thanks", "Thank", "Good", "Morning", "Afternoon", "Evening",
  "Yes", "No", "Okay", "Ok", "Sure", "Please", "Sorry", "Great", "Perfect", "Bye", "Goodbye", "Again", "There", "Order", "Account", "Number",
]);

interface Personal {
  /** The value as it appears in the transcript. */
  value: string;
  /** Whether a text of the draft holds it, or what it holds of it (a rebuilt email, a surname). */
  find: (text: string) => string | undefined;
}

const digits = (s: string) => s.replace(/\D/g, "");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A whole word, not part of a longer one or of an email, which the email rules report.
const wordIn = (word: string, flags = "") => new RegExp(`(?<![\\w@.])${escape(word)}(?![\\w@])`, flags);

/** The personal values in one transcript, as written before scrubbing, minus those `known` already holds. */
export function personalValues(raw: string, known: string): Personal[] {
  const out = new Map<string, Personal>();
  const knows = (v: string) => known.toLowerCase().includes(v.toLowerCase());
  const add = (p: Personal) => {
    if (!out.has(p.value) && !knows(p.value)) out.set(p.value, p);
  };

  // A username can come back as an email the model made up from it, so it is collected first.
  const handles = new Set([...raw.matchAll(HANDLE)].map((m) => m[0].toLowerCase()));
  const emails = [...new Set(emailsIn(raw))];
  for (const e of emails) handles.add(e.split("@")[0]!.toLowerCase());
  for (const email of emails) {
    add({ value: email, find: (text) => (text.toLowerCase().includes(email.toLowerCase()) ? email : undefined) });
  }
  // Any email in the draft whose local part is a username or an email's local part from the chat.
  if (handles.size) {
    add({
      value: "an email made from a username in the chat",
      find: (text) => emailsIn(text).find((e) => handles.has(e.split("@")[0]!.toLowerCase()) && !knows(e)),
    });
  }
  // Usernames, and each email's local part on its own: a draft may keep `jdoe42` without its `@domain`.
  const locals = emails.map((e) => e.split("@")[0]!).filter((l) => l.length >= 4 && !GENERIC_LOCAL_PARTS.has(l.toLowerCase()));
  for (const handle of new Set([...[...raw.matchAll(HANDLE)].map((m) => m[0]), ...locals])) {
    const re = wordIn(handle, "i");
    add({ value: handle, find: (text) => (re.test(text) ? handle : undefined) });
  }
  for (const m of raw.matchAll(ADDRESS)) {
    const words = m[2]!.trim().split(/\s+/);
    // The number and the street's words, with whatever suffix the draft gives it.
    const re = new RegExp(`(?<![\\w])${m[1]}\\s+${words.map(escape).join("\\s+")}(?:\\s+(?:${STREET_SUFFIX})\\b\\.?)?`, "i");
    add({ value: m[0].trim(), find: (text) => re.exec(text)?.[0].trim() });
  }
  for (const re of [PHONE, CARD]) {
    for (const m of raw.matchAll(re)) {
      const number = digits(m[0]);
      if (number.length < 10) continue;
      add({ value: m[0].trim(), find: (text) => [...text.matchAll(PHONE), ...text.matchAll(CARD)].map((x) => x[0].trim()).find((x) => digits(x) === number) });
    }
  }
  for (const re of [INTRO, LABEL_IN_PARENS, LABEL, NAME_MESSAGE]) {
    for (const m of raw.matchAll(re)) {
      const name = m[1]!.trim();
      const words = name.split(" ");
      if (words.some((w) => NOT_NAMES.has(w))) continue;
      const surname = words.at(-1)!;
      const full = new RegExp(`(?<![\\w])${words.map(escape).join("\\s+")}(?![\\w])`);
      const last = surname.length >= 4 && !knows(surname) ? wordIn(surname) : undefined;
      add({ value: name, find: (text) => (full.test(text) ? name : last?.test(text) ? surname : undefined) });
    }
  }
  return [...out.values()];
}

/** One part of a drafted task, by where it is: "the caller's instructions", "seed row customers C-12". */
export interface Place {
  where: string;
  text: string;
}

/**
 * For each personal value of the transcript that the draft holds, a review note: which value, and where.
 * `known` is the domain's text before drafting (its seed rows, policy and tools), so a value the domain
 * already has, such as a seeded customer's name, isn't reported as copied.
 */
export function copiedValueNotes(raw: string, file: string, places: readonly Place[], known: string): string[] {
  // One note per value found, however many rules found it (an email the chat had is also one made from its username).
  const found = new Map<string, string[]>();
  for (const p of personalValues(raw, known)) {
    for (const place of places) {
      const hit = p.find(place.text);
      if (hit) found.set(hit, [...(found.get(hit) ?? []), place.where]);
    }
  }
  return [...found].map(([value, where]) => `copied from ${file}: replace "${value}" with a fictional value (in ${[...new Set(where)].join(", ")})`);
}
