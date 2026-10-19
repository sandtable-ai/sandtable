#!/usr/bin/env node
// Renders the README and social images in this folder with headless Chrome, over the DevTools
// protocol, with no npm dependency. Run from the repo root (Node 22.18+, Chrome or Chromium):
//
//   node assets/render.mjs og        # og.html                 -> og.png (1280x640), docs/images/og.png (1200x630)
//   node assets/render.mjs report    # offline naive run       -> report.png, report-dark.png
//   node assets/render.mjs trial     # trial.html              -> trial.png, trial-dark.png
//   node assets/render.mjs all
//
// og.html and trial.html load Fira Sans and Fira Code from Google Fonts, so rendering them needs
// the network. The report screenshot runs `sandtable run` offline (rule-based agent, scripted
// caller, no model calls) and uses the report's own system fonts. Set CHROME to pick a browser.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("Chrome not found: set CHROME to a Chrome or Chromium binary");
  return found;
}

async function launch() {
  const profile = mkdtempSync(path.join(tmpdir(), "sandtable-render-"));
  const proc = spawn(findChrome(), [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--force-color-profile=srgb",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.once("exit", (code) => reject(new Error(`Chrome exited (${code}): ${buf}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const close = async () => {
    ws.close();
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    proc.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { send, listeners, close };
}

/**
 * Opens `url` at `width`x`height` CSS px and `scale` device pixels per CSS px, waits for fonts,
 * runs `prepare` (an expression that returns the page rect to capture, in CSS px) or clips to the
 * element matching `clip`, and writes a PNG.
 */
async function shoot(browser, { url, width, height, scale = 2, scheme = "light", prepare, clip, transparent = false, out }) {
  const { send, listeners } = browser;
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  await s("Page.enable");
  await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  if (transparent) await s("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  const loaded = new Promise((resolve) => {
    const l = (msg) => { if (msg.sessionId === sessionId && msg.method === "Page.loadEventFired") { listeners.delete(l); resolve(); } };
    listeners.add(l);
  });
  await s("Page.navigate", { url });
  await loaded;
  const evaluate = async (expression) => {
    const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${out}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  await evaluate("document.fonts.ready.then(() => true)");
  // Web fonts come in unicode-range subsets and only the ones in use load, so every family needs one
  // loaded face and no face may have failed.
  const missing = await evaluate(`(() => {
    const faces = [...document.fonts], families = [...new Set(faces.map((f) => f.family))];
    return [...faces.filter((f) => f.status === "error").map((f) => f.family + " " + f.weight),
      ...families.filter((fam) => !faces.some((f) => f.family === fam && f.status === "loaded"))];
  })()`);
  if (missing.length) throw new Error(`${out}: fonts did not load: ${[...new Set(missing)].join(", ")} (og.html and trial.html need the network)`);
  const rect = prepare ? await evaluate(prepare)
    : clip ? await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(clip)}).getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`)
    : { x: 0, y: 0, width, height };
  const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...rect, scale: 1 } });
  writeFileSync(path.join(here, out), Buffer.from(data, "base64"));
  await send("Target.closeTarget", { targetId });
  console.log(`${path.relative(root, path.join(here, out))}  ${Math.round(rect.width * scale)}x${Math.round(rect.height * scale)}`);
}

const fileUrl = (name) => pathToFileURL(path.join(here, name)).href;

const targets = {
  // The GitHub social preview (1280x640) and the docs og:image (1200x630), each laid out natively.
  async og(browser) {
    await shoot(browser, { url: fileUrl("og.html"), width: 1280, height: 640, scale: 1, out: "og.png" });
    await shoot(browser, { url: fileUrl("og.html"), width: 1200, height: 630, scale: 1, out: "../docs/images/og.png" });
  },

  // A failing trial of the offline naive run, at 2x for high-DPI screens. The viewport is the width
  // of a README column, so the report's text shows at its real size on GitHub.
  async report(browser) {
    const dir = mkdtempSync(path.join(tmpdir(), "sandtable-report-"));
    try {
      execFileSync(process.execPath, [
        path.join(root, "src/cli.ts"), "run", path.join(root, "examples/freight"),
        "--agent", "scripted:naive", "--user", "scripted", "-o", dir,
      ], { stdio: "ignore" });
      // The expired-insurance trial, from its title down to the agent's reply after the tool call
      // that broke the rules. The two goodbye turns after it are cropped off.
      const prepare = `(() => {
        show(R.tasks.findIndex((t) => t.id === "expired-insurance"), 0);
        const card = document.querySelector(".trial").getBoundingClientRect();
        const reply = document.querySelector(".ev.tool .viol").closest(".ev").nextElementSibling.getBoundingClientRect();
        return { x: card.x + scrollX, y: card.y + scrollY, width: card.width, height: reply.bottom + 8 - card.y };
      })()`;
      for (const scheme of ["light", "dark"]) {
        await shoot(browser, {
          url: pathToFileURL(path.join(dir, "report.html")).href, width: 832, height: 900, scheme, prepare,
          out: scheme === "light" ? "report.png" : "report-dark.png",
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  // How one trial runs and is graded, for the README: light and dark, on a transparent background.
  async trial(browser) {
    for (const scheme of ["light", "dark"]) {
      await shoot(browser, {
        url: fileUrl("trial.html"), width: 832, height: 400, scheme, clip: "figure", transparent: true,
        out: scheme === "light" ? "trial.png" : "trial-dark.png",
      });
    }
  },
};

const wanted = process.argv.slice(2);
const names = wanted.includes("all") ? Object.keys(targets) : wanted;
if (!names.length || names.some((n) => !targets[n])) {
  console.error(`usage: node assets/render.mjs <${Object.keys(targets).join("|")}|all>...`);
  process.exit(2);
}
const browser = await launch();
try {
  for (const n of names) await targets[n](browser);
} finally {
  await browser.close();
}
