#!/usr/bin/env node
// Renders the README and social images in this folder with headless Chrome, over the DevTools
// protocol, with no npm dependency. Run from the repo root (Node 22.18+, Chrome or Chromium):
//
//   node assets/render.mjs og        # og.html                 -> og.png (1280x640), docs/images/og.png (1200x630)
//   node assets/render.mjs report    # offline naive run       -> report.png, report-dark.png
//   node assets/render.mjs trial     # trial.html              -> trial.png, trial-dark.png
//   node assets/render.mjs brand     # brand/avatar.svg        -> brand/avatar.png (512x512)
//   node assets/render.mjs promo     # promo.html, 16:9        -> docs/images/promo.mp4 (1920x1080), promo.png (1600x900)
//   node assets/render.mjs all       # all of the above
//   node assets/render.mjs promo-social   # promo.html, 4:5    -> promo-social.mp4 (1080x1350), not committed
//
// og.html, trial.html and promo.html load Fira Sans and Fira Code from Google Fonts, so rendering
// them needs the network. The report screenshot runs `sandtable run` offline (rule-based agent,
// scripted caller, no model calls) and uses the report's own system fonts. The videos are encoded
// with ffmpeg, which must be on PATH, and take a few minutes each. Set CHROME to pick a browser.

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
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
 * Opens `url` at `width`x`height` CSS px and `scale` device pixels per CSS px, and waits for its
 * fonts. Returns the page's DevTools session, an `evaluate` for expressions and `close`.
 */
async function open(browser, { url, width, height, scale, scheme = "light", transparent = false, out }) {
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
  if (missing.length) throw new Error(`${out}: fonts did not load: ${[...new Set(missing)].join(", ")} (og.html, trial.html and promo.html need the network)`);
  return { s, evaluate, close: () => send("Target.closeTarget", { targetId }) };
}

/**
 * Opens `url` as `open` does, runs `prepare` (an expression that returns the page rect to capture,
 * in CSS px) or clips to the element matching `clip`, and writes a PNG.
 */
async function shoot(browser, { url, width, height, scale = 2, scheme = "light", prepare, clip, transparent = false, out }) {
  const { s, evaluate, close } = await open(browser, { url, width, height, scale, scheme, transparent, out });
  const rect = prepare ? await evaluate(prepare)
    : clip ? await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(clip)}).getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`)
    : { x: 0, y: 0, width, height };
  const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...rect, scale: 1 } });
  writeFileSync(path.join(here, out), Buffer.from(data, "base64"));
  await close();
  console.log(`${path.relative(root, path.join(here, out))}  ${Math.round(rect.width * scale)}x${Math.round(rect.height * scale)}`);
}

/**
 * Films a page whose script defines `seek(t)` and `DURATION` (promo.html): one screenshot per
 * frame, piped to ffmpeg as an H.264 MP4 that browsers and social sites play.
 */
async function film(browser, { url, width, height, scale, fps = 30, out }) {
  const { s, evaluate, close } = await open(browser, { url, width, height, scale, out });
  // Web fonts load per unicode-range subset as text appears, so seek through the timeline once first.
  await evaluate("(async () => { for (let t = 0; t <= DURATION; t += 0.25) seek(t); await document.fonts.ready; return true; })()");
  const frames = Math.round((await evaluate("DURATION")) * fps);
  const ffmpeg = spawn("ffmpeg", [
    "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
    // Convert with the BT.709 matrix and say so in the file: an untagged video leaves players to guess, and
    // they shift the colors (the terracotta plays redder).
    "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-tune", "animation", "-movflags", "+faststart",
    path.join(here, out),
  ], { stdio: ["pipe", "ignore", "inherit"] });
  const encoded = new Promise((resolve, reject) => {
    ffmpeg.once("error", (err) => reject(err.code === "ENOENT" ? new Error(`${out}: ffmpeg not found on PATH`) : err));
    ffmpeg.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${out}: ffmpeg exited ${code}`))));
  });
  for (let i = 0; i < frames; i++) {
    await evaluate(`(seek(${i / fps}), new Promise((resolve) => requestAnimationFrame(() => resolve(true))))`);
    const { data } = await s("Page.captureScreenshot", { format: "png" });
    if (!ffmpeg.stdin.write(Buffer.from(data, "base64"))) await once(ffmpeg.stdin, "drain");
  }
  ffmpeg.stdin.end();
  await encoded;
  await close();
  console.log(`${path.relative(root, path.join(here, out))}  ${width * scale}x${height * scale}, ${frames} frames`);
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
      // The naive agent fails freight's critical tasks, so the run exits 1 for that gate: a complete run all the same.
      const run = spawnSync(process.execPath, [
        path.join(root, "src/cli.ts"), "run", path.join(root, "examples/freight"),
        "--agent", "scripted:naive", "--user", "scripted", "-o", dir,
      ], { stdio: "ignore" });
      if (run.status !== 0 && run.status !== 1) throw new Error(`the naive run exited ${run.status ?? run.signal}`);
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

  // The GitHub organization avatar, 512x512.
  async brand(browser) {
    await shoot(browser, { url: fileUrl("brand/avatar.svg"), width: 512, height: 512, scale: 1, out: "brand/avatar.png" });
  },

  // The overview video for the docs home page, and the still the README links to it from, at 2x.
  async promo(browser) {
    await film(browser, { url: `${fileUrl("promo.html")}?layout=wide`, width: 1280, height: 720, scale: 1.5, out: "../docs/images/promo.mp4" });
    await shoot(browser, { url: `${fileUrl("promo.html")}?layout=wide&poster&t=26`, width: 1280, height: 720, scale: 1.25, out: "promo.png" });
  },

  // The same video in 4:5, for social posts. It isn't committed, so `all` skips it.
  async "promo-social"(browser) {
    await film(browser, { url: fileUrl("promo.html"), width: 1080, height: 1350, scale: 1, out: "promo-social.mp4" });
  },
};

const wanted = process.argv.slice(2);
const names = wanted.includes("all") ? Object.keys(targets).filter((n) => n !== "promo-social") : wanted;
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
