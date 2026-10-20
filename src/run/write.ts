import { rename, writeFile } from "node:fs/promises";

/**
 * Write a file whole or not at all: write a temporary file next to it, then rename it into place. A
 * results.json holds conversations that cost money to produce, so an interrupted rewrite must never
 * leave it half written.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}
