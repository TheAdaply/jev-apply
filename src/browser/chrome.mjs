// Chrome lifecycle (PLAN D12, risk 7): spawn the user's own Chrome once on a dedicated
// profile with a remote-debugging port, attach with Playwright's library over CDP, and on exit
// drop only the CDP connection — the filled tab must outlive the runner process.
//
// Chrome ≥ 136 refuses --remote-debugging-port on the default profile, so the profile is always
// CONFIG_DIR/profile; it also accumulates history, which is what a score-based captcha looks at.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

import { paths } from "../config.mjs";

export const DEFAULT_PORT = 9223;

/** The user's real browser first; Chromium / Chrome for Testing only as a fallback. */
export const CHROME_CANDIDATES = [
  process.env.JEV_CHROME_PATH,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

export function chromeBinary() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `no Chrome binary found. Install Google Chrome or set JEV_CHROME_PATH. Looked at:\n  ${CHROME_CANDIDATES.join("\n  ")}`,
    );
  }
  return found;
}

export function chromeArgs({ profileDir, port }) {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
}

/** `GET /json/version` — the liveness probe for the CDP endpoint. null when nothing answers. */
export async function cdpVersion(port = DEFAULT_PORT, { timeoutMs = 1000 } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdpVersion(port);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** Detached so the browser outlives this process (D12); stdio ignored so it never holds the pipe. */
export function spawnChrome({ profileDir, port, binary = chromeBinary() }) {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const child = spawn(binary, chromeArgs({ profileDir, port }), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid, binary };
}

/**
 * Attach to the dedicated-profile Chrome, spawning it first if the port is dead.
 * → { browser, context, endpoint, spawned, version, port, profileDir }
 */
export async function connect({
  profileDir = paths.profile,
  port = DEFAULT_PORT,
  timeoutMs = 45000,
  spawnIfMissing = true,
} = {}) {
  let version = await cdpVersion(port);
  let spawned = false;

  if (!version) {
    if (!spawnIfMissing) throw new Error(`no CDP endpoint on 127.0.0.1:${port} and spawning is disabled`);
    spawnChrome({ profileDir, port });
    spawned = true;
    version = await waitForEndpoint(port, timeoutMs);
    if (!version) {
      throw new Error(
        `Chrome did not open a CDP endpoint on 127.0.0.1:${port} within ${Math.round(timeoutMs / 1000)}s ` +
          `(profile ${profileDir}). Another Chrome may already own that profile.`,
      );
    }
  }

  const endpoint = `http://127.0.0.1:${port}`;
  const browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error(`connected to ${endpoint} but Chrome exposes no browser context`);
  }
  return { browser, context, endpoint, spawned, version, port, profileDir };
}

const stripSlash = (u) => String(u ?? "").replace(/\/+$/, "");

/** Every live page of a context (or of every context, when handed a Browser). */
export function pagesOf(contextOrBrowser) {
  const contexts = typeof contextOrBrowser?.contexts === "function"
    ? contextOrBrowser.contexts()
    : [contextOrBrowser];
  return contexts.flatMap((c) => (typeof c?.pages === "function" ? c.pages() : []));
}

/** The already-open tab for a posting — how `--answers` / `--resume` re-attach (D12). */
export async function findTab(context, urlPrefix) {
  const want = stripSlash(urlPrefix);
  if (!want) return null;
  for (const page of pagesOf(context)) {
    if (page.isClosed?.()) continue;
    const here = stripSlash(page.url());
    if (here === want || here.startsWith(want) || want.startsWith(here)) return page;
  }
  return null;
}

/**
 * The tab for a posting: reuse the open one (re-runs must not pile up tabs), else open it.
 * Brings the tab to the front so the user sees what the runner is doing.
 */
export async function openTab(context, url, { reuse = true, waitUntil = "domcontentloaded", timeout = 45000 } = {}) {
  const existing = reuse ? await findTab(context, url) : null;
  const page = existing ?? (await context.newPage());
  if (!existing) await page.goto(url, { waitUntil, timeout });
  await page.bringToFront().catch(() => {});
  await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
  return page;
}

/**
 * Drop the CDP connection and nothing else. Playwright's `close()` on a CDP-attached browser
 * closes the websocket transport (it only disposes contexts *it* created — we use Chrome's own),
 * so Chrome, its profile and the filled tab survive. Verified against the live endpoint.
 */
export async function disconnect(browser, { port = DEFAULT_PORT, verify = true } = {}) {
  if (browser?.isConnected?.()) await browser.close().catch(() => {});
  const chromeAlive = verify ? Boolean(await cdpVersion(port, { timeoutMs: 2000 })) : null;
  if (verify && !chromeAlive) {
    process.stderr.write(`[chrome] warning: CDP endpoint on ${port} went away after disconnect\n`);
  }
  return { disconnected: true, chromeAlive };
}

/** Where the dedicated profile lives, for messages and install.mjs. */
export const profilePath = () => path.resolve(paths.profile);
