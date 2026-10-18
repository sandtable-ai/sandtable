import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { DOMAIN_FILE } from "../spec/load.ts";
import type { Invariant, Task } from "../spec/schema.ts";

/**
 * Append drafted items to a list in a domain, editing the YAML document in place so
 * existing comments and formatting survive. Follows `key: ./file.yaml` includes.
 * Returns the file that was edited.
 */
export async function appendToDomainList(
  domainDir: string,
  key: "invariants" | "tasks",
  items: (Invariant | Task)[],
  trailingComment?: string,
): Promise<string> {
  const main = path.join(domainDir, DOMAIN_FILE);
  const mainDoc = YAML.parseDocument(await readFile(main, "utf8"));
  const value = mainDoc.get(key);

  let file = main;
  let doc: YAML.Document = mainDoc;
  let seq: unknown;
  if (typeof value === "string" && /\.ya?ml$/i.test(value)) {
    file = path.resolve(domainDir, value);
    const included = YAML.parseDocument(await readFile(file, "utf8"));
    if (YAML.isSeq(included.contents)) {
      doc = included;
    } else {
      // e.g. a placeholder file holding only `[]` and comments
      doc = new YAML.Document([]);
      doc.commentBefore = included.commentBefore;
    }
    seq = doc.contents;
  } else {
    seq = mainDoc.get(key, true);
    if (!YAML.isSeq(seq)) {
      seq = mainDoc.createNode([]);
      mainDoc.set(key, seq);
    }
  }

  const list = seq as YAML.YAMLSeq;
  list.flow = false;
  for (const item of items) {
    const node = doc.createNode(item) as YAML.YAMLMap;
    for (const pair of node.items) {
      // Keep the rule body and its source on one line each.
      if (YAML.isMap(pair.value) && ["source", "before", "limit", "match", "never"].includes(String((pair.key as YAML.Scalar).value))) {
        pair.value.flow = true;
      }
    }
    list.items.push(node);
  }
  if (trailingComment) list.comment = [list.comment, trailingComment].filter(Boolean).join("\n");
  await writeFile(file, doc.toString({ lineWidth: 0 }));
  return file;
}
