import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { DOMAIN_FILE } from "./load.ts";

/**
 * The `# TODO(review):` notes `init` writes above a drafted tool, invariant or task, keyed by `"<kind> <id>"`, such
 * as `"task book-load"`. They are YAML comments, so they're read from the files: sandtable.yaml, and the files its
 * `tools`, `invariants` and `tasks` keys name. A file that can't be read or parsed gives no notes; loading the domain
 * reports that.
 */
export async function reviewNotes(target: string): Promise<Map<string, string[]>> {
  const file = (await stat(target).catch(() => undefined))?.isDirectory() ? path.join(target, DOMAIN_FILE) : target;
  const notes = new Map<string, string[]>();
  const root = await parse(file);
  if (!root || !YAML.isMap(root.contents)) return notes;
  for (const [key, kind, idKey] of [["tools", "tool", "name"], ["invariants", "invariant", "id"], ["tasks", "task", "id"]] as const) {
    let doc = root;
    let list = root.get(key, true);
    // A list kept in its own file, as `tasks: ./tasks.yaml` is.
    if (YAML.isScalar(list) && typeof list.value === "string" && /\.ya?ml$/i.test(list.value.trim())) {
      const included = await parse(path.resolve(path.dirname(file), list.value.trim()));
      if (!included) continue;
      doc = included;
      list = included.contents;
    }
    if (!YAML.isSeq(list)) continue;
    list.items.forEach((item, i) => {
      if (!YAML.isMap(item)) return;
      const id = item.get(idKey);
      // A comment above a file's first item can belong to the file or the list instead of the item.
      const comments = [i === 0 && doc !== root ? doc.commentBefore : undefined, i === 0 ? list.commentBefore : undefined, item.commentBefore];
      const lines = comments.filter((c): c is string => typeof c === "string").flatMap((c) => c.split("\n").map((l) => l.trim()));
      const itemNotes = lines.filter((l) => l.startsWith("TODO(review):")).map((l) => l.slice("TODO(review):".length).trim());
      if (id !== undefined && itemNotes.length) notes.set(`${kind} ${String(id)}`, itemNotes);
    });
  }
  return notes;
}

async function parse(file: string): Promise<YAML.Document | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const doc = YAML.parseDocument(text);
  return doc.errors.length ? undefined : doc;
}
