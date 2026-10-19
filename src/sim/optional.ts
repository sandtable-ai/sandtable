/**
 * Import an optional peer package. When it is not installed, say how to install it where the CLI
 * can find it: next to sandtable-ai. A package installed on its own in the current directory is
 * invisible to `npx sandtable-ai`, which resolves imports from its own cache.
 */
export async function importOptional<T>(name: string, load: () => Promise<T>, neededFor: string): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (!isMissing(err, name)) throw err;
    throw new Error(
      `${neededFor} needs the optional package ${name}. Install it next to sandtable-ai: npm install --save-dev sandtable-ai ${name}, then npx sandtable <command>. For a one-off run: npx -p sandtable-ai -p ${name} sandtable <command>`,
    );
  }
}

function isMissing(err: unknown, name: string): boolean {
  const e = err as { code?: string; message?: string };
  return (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND") && (e.message ?? "").includes(name);
}
