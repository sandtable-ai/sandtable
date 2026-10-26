import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

// `init --transcripts` drafts one chat per model call. A call that fails after the client's retries, such as a Bedrock
// 503 on a large chat, used to throw away every chat drafted before it (#402). Now the drafted chats are written, the
// failed ones are named with their error, and init prints the command that drafts only them, then exits 2.

const proposal = (id: string, load: string) => ({
  id,
  description: `Vetted carrier negotiates ${load} and settles under the ceiling.`,
  quote: "Twenty-three and you've got a truck.",
  tags: ["negotiation"],
  persona_id: "easygoing",
  new_persona: null,
  instructions: `You are Dana at Blue Mesa Trucking, MC 100101. You want ${load}. Ask for $2,600; accept $2,250 or more.`,
  script: [`Hi, MC 100101, Blue Mesa. Looking at ${load}.`, "I need $2,600.", "Deal, book it.", "Thanks."],
  new_rows: [
    {
      table: "loads",
      fields: [
        { name: "load_id", value: load },
        { name: "origin", value: "Dallas, TX" },
        { name: "destination", value: "Atlanta, GA" },
        { name: "pickup_date", value: "2026-11-10" },
        { name: "equipment", value: "dry_van" },
        { name: "weight_lbs", value: 40000 },
        { name: "posted_rate", value: 2100 },
        { name: "max_rate", value: 2400 },
        { name: "status", value: "available" },
      ],
    },
  ],
  existing_rows: [],
  expect_state: [{ table: "bookings", conditions: [{ field: "load_id", op: "eq", value: load }], count: 1 }],
  reference: [],
  expect_called: ["verify_carrier", "book_load"],
  expect_not_called: [],
});

const drafts: Record<string, ReturnType<typeof proposal>> = {
  "call-1.txt": proposal("negotiate-first-lane", "L-2001"),
  "call-3.txt": proposal("negotiate-third-lane", "L-2003"),
};

/**
 * A stand-in for the Messages API on localhost: it answers a chat in `drafts` with its proposal, a chat in `denied`
 * with a 403, and any other chat with a 503 the client must not retry. `seen` lists the chats it was sent, in order.
 */
async function stubApi(denied: string[] = []): Promise<{ url: string; server: Server; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      // The prompt arrives inside JSON, so its quotes are escaped.
      const file = /<transcript file=\\"([^"\\]+)\\">/.exec(body)?.[1] ?? "";
      seen.push(file);
      const draft = drafts[file];
      if (denied.includes(file)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "You don't have access to the model with the specified model ID." }));
        return;
      }
      if (!draft) {
        res.writeHead(503, { "content-type": "application/json", "x-should-retry": "false" });
        res.end(JSON.stringify({ message: "Bedrock is unable to process your request." }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: JSON.stringify(draft) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 200 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, seen };
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A copy of the freight domain to draft into, and a directory of chats with these names. */
async function setup(files: string[]): Promise<{ domain: string; chats: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sandtable-init-failed-"));
  const domain = path.join(dir, "domain");
  const chats = path.join(dir, "chats");
  await cp(path.resolve("examples/freight"), domain, { recursive: true });
  await mkdir(chats);
  for (const f of files) await writeFile(path.join(chats, f), "REP: Hi. CALLER: Twenty-three and you've got a truck.");
  return { domain, chats };
}

async function init(url: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const kept = Object.entries(process.env).filter(([k]) => !k.startsWith("ANTHROPIC_") && !k.startsWith("AWS_") && k !== "SANDTABLE_PROVIDER");
  const env = { ...Object.fromEntries(kept), ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: url };
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["src/cli.ts", "init", ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe.skipIf(!process.features.typescript)("init --transcripts when a chat's call fails", () => {
  it("writes the chats that drafted, names the failed one with its error and a command for it, and exits 2", async () => {
    const stub = await stubApi();
    server = stub.server;
    const { domain, chats } = await setup(["call-1.txt", "call-2.txt", "call-3.txt"]);
    const r = await init(stub.url, "--transcripts", chats, "-o", domain, "-m", "claude-sonnet-5-5");
    expect(r.code).toBe(2);
    const tasks = await readFile(path.join(domain, "tasks.yaml"), "utf8");
    expect(tasks).toContain("id: negotiate-first-lane");
    expect(tasks).toContain("id: negotiate-third-lane");
    expect(r.stdout).toContain("2 task(s), 0 persona(s), 2 seed row(s) drafted");
    expect(r.stdout).toContain("Next: accept or fix each drafted item");
    expect(r.stderr).toContain("✗ 1 of 3 transcripts' drafting calls failed, so nothing was drafted from it. The other 2 were drafted as above:");
    expect(r.stderr).toContain("    call-2.txt: 503 Bedrock is unable to process your request.");
    expect(r.stderr).toContain(`  Draft it again with:\n    npx sandtable-ai init --transcripts ${path.join(chats, "call-2.txt")} -o ${domain} -m claude-sonnet-5-5\n`);
  });

  it("writes nothing when every chat's call fails, and gives the command for the whole directory", async () => {
    const stub = await stubApi();
    server = stub.server;
    // The stub answers none of these chats.
    const { domain, chats } = await setup(["call-2.txt", "call-4.txt", "call-5.txt"]);
    const before = await readFile(path.join(domain, "tasks.yaml"), "utf8");
    const r = await init(stub.url, "--transcripts", chats, "-o", domain);
    expect(r.code).toBe(2);
    expect(await readFile(path.join(domain, "tasks.yaml"), "utf8")).toBe(before);
    expect(r.stdout).not.toContain("Next: accept or fix");
    expect(r.stderr).toContain("✗ All 3 transcripts' drafting calls failed, so nothing was drafted from them:");
    expect(r.stderr).toContain(`  Draft them again with:\n    npx sandtable-ai init --transcripts ${chats} -o ${domain}\n`);
  });

  it("stops at an error every later chat would hit too, names it once, and lists the chats not sent with their commands", async () => {
    // A denied model fails every call the same way: after it, no chat is sent, and nothing waits on retries per chat.
    const stub = await stubApi(["call-2.txt"]);
    server = stub.server;
    const { domain, chats } = await setup(["call-1.txt", "call-2.txt", "call-3.txt"]);
    const r = await init(stub.url, "--transcripts", chats, "-o", domain);
    expect(r.code).toBe(2);
    expect(stub.seen).toEqual(["call-1.txt", "call-2.txt"]);
    const tasks = await readFile(path.join(domain, "tasks.yaml"), "utf8");
    expect(tasks).toContain("id: negotiate-first-lane");
    expect(tasks).not.toContain("id: negotiate-third-lane");
    expect(r.stdout).toContain("Next: accept or fix each drafted item");
    expect(r.stderr).toContain(
      [
        "✗ Drafting stopped at call-2.txt: its call failed in a way every later call would too, so 1 transcript wasn't sent. The other 1 was drafted as above:",
        "    call-2.txt: 403 You don't have access to the model with the specified model ID.",
        "    not sent: call-3.txt",
        "  Draft them again with:",
        `    npx sandtable-ai init --transcripts ${path.join(chats, "call-2.txt")} -o ${domain}`,
        `    npx sandtable-ai init --transcripts ${path.join(chats, "call-3.txt")} -o ${domain}`,
      ].join("\n"),
    );
    expect(r.stderr.match(/403/g)).toHaveLength(1);
  });
});
