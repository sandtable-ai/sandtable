import { createRequire } from "node:module";

/** The installed sandtable-ai version. package.json sits one level above both `src/` and `dist/`, and ships in the npm package. */
export const version = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
