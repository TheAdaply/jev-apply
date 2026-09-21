// Running one posting through the real runner, and cleaning up after it.
//
// The benchmark deliberately shells out to `scripts/apply.mjs --url … --json` instead of calling
// the pipeline in-process: that is the binary a user runs, it owns its own Chrome connection and
// its own 120 s budget, and one posting that wedges cannot take the whole bench with it. The
// child's single stdout JSON object is the contract (AGENTS.md), so there is nothing to scrape.
//
// Three things this module is careful about:
//   * **Credentials.** `~/.config/jev-apply/env` is the only source (AGENTS.md). The bench home
//     never gets an `env` file — the keys travel in the child's environment and are never logged,
//     written or echoed.
//   * **The port.** A bench child must talk to *its* Chrome. `assertBenchPort` refuses to run when
//     something else already owns the bench port, so synthetic data can never be typed into the
//     user's own profile.
//   * **The tab.** The runner is built never to close a tab (D12). A benchmark that fills twenty
//     forms would leave twenty tabs open, so the bench closes each one itself, by URL, afterwards.

import { spawn } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { connect, disconnect, findTab, cdpVersion } from "../browser/chrome.mjs";

const REAL_ENV_FILE = path.join(homedir(), ".config", "jev-apply", "env");
const KEYS = ["TYPESAFE_API_KEY", "OPENAI_API_KEY"];

/**
 * The two keys, from the environment or from the user's real env file — never from the bench
 * home, and never returned anywhere they can be printed by accident: the caller passes this
 * straight into `spawn`'s `env`.
 *
 * @returns {Promise<{env:Record<string,string>, found:string[], missing:string[]}>}
 */
export async function loadSecrets(file = REAL_ENV_FILE) {
  const env = {};
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    /* no env file: the process environment may still carry the keys */
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line.replace(/^\s*#.*$/, ""));
    if (!m) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (KEYS.includes(m[1]) && value) env[m[1]] = value;
  }
  for (const key of KEYS) if (process.env[key]) env[key] = process.env[key];
  return { env, found: KEYS.filter((k) => env[k]), missing: KEYS.filter((k) => !env[k]) };
}

/**
 * Which profile is the browser on `port` running?
 *
 * Chrome will not say: `/json/version` reports the build, and `Browser.getBrowserCommandLine`
 * (the call that would return `--user-data-dir`) is refused unless the browser was launched with
 * `--enable-automation`, which `chromeArgs` deliberately does not pass. Two facts do line up,
 * though: `SystemInfo.getProcessInfo` names the browser process id, and Chrome symlinks
 * `<profile>/SingletonLock` to `<hostname>-<pid>` of the process that owns that profile. Equal
 * pids mean the browser answering on this port is running out of this profile.
 *
 * `DevToolsActivePort` is checked first because it is free, but Chrome only writes it for some
 * launch shapes — it is absent when `--remote-debugging-port` names an explicit port.
 */
async function profilePid(profileDir) {
  const link = await readlink(path.join(profileDir, "SingletonLock")).catch(() => "");
  const pid = Number(/-(\d+)$/.exec(link)?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function activePort(profileDir) {
  const text = await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8").catch(() => "");
  return Number(text.split("\n")[0].trim()) || null;
}

/** The browser process id behind a live CDP endpoint, or null when the browser will not say. */
async function browserPid(port, profileDir) {
  let conn = null;
  try {
    conn = await connect({ profileDir, port, spawnIfMissing: false });
    const session = await conn.browser.newBrowserCDPSession();
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    await session.detach().catch(() => {});
    return processInfo?.find((p) => p.type === "browser")?.id ?? null;
  } catch {
    return null;
  } finally {
    if (conn) await disconnect(conn.browser, { port, verify: false }).catch(() => {});
  }
}

/**
 * Refuse to benchmark through somebody else's browser. Nothing on the port is fine — the child
 * spawns its own Chrome on the bench profile.
 *
 * @returns {Promise<{ok:true, state:"free"|"bench", via?:string}>}
 * @throws when a browser that is not the bench profile answers on `port`
 */
export async function assertBenchPort({ port, home, userHome = path.join(homedir(), ".config", "jev-apply") }) {
  const benchProfile = path.join(home, "profile");
  if (!(await cdpVersion(port))) return { ok: true, state: "free" };

  if ((await activePort(benchProfile)) === port) return { ok: true, state: "bench", via: "DevToolsActivePort" };
  const live = await browserPid(port, benchProfile);
  if (live != null && live === (await profilePid(benchProfile))) return { ok: true, state: "bench", via: "SingletonLock pid" };

  const userProfile = path.join(userHome, "profile");
  const theirs = live != null && live === (await profilePid(userProfile));
  throw new Error(
    `a browser is already listening on 127.0.0.1:${port} and it is not the bench profile at ${benchProfile}` +
      (theirs ? ` — it is the jev-apply profile at ${userProfile}.` : ".") +
      ` Close it or pass --port. Refusing to type synthetic data into a profile the bench does not own.`,
  );
}

/** The last line of stdout that parses as a JSON object — the runner's one-object contract. */
export function parseResult(stdout) {
  const lines = String(stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* stderr noise can never reach here; a non-JSON stdout line is simply not the result */
    }
  }
  return null;
}

const TERMINAL = new Set(["ready_to_submit", "needs_user", "blocked"]);

/**
 * Run `apply.mjs --url <posting> --json` to a terminal status.
 *
 * @param {{url:string, home:string, port:number, repoRoot:string, secrets:object,
 *          timeoutMs?:number, onLog?:(line:string)=>void}} args
 * @returns {Promise<{result:object|null, status:string, code:number|null, ms:number, stderr:string}>}
 */
export function runApply({ url, home, port, repoRoot, secrets = {}, timeoutMs = 300_000, onLog = null }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/apply.mjs", "--url", url, "--json"], {
      cwd: repoRoot,
      env: { ...process.env, ...secrets, JEV_APPLY_HOME: home, JEV_CHROME_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      if (onLog) for (const line of text.split("\n")) if (line.trim()) onLog(line);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ result: null, status: "blocked", reason: `spawn_failed: ${err.message}`, code: null, ms: Date.now() - started, stderr });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const result = parseResult(stdout);
      const status = TERMINAL.has(result?.status) ? result.status : "blocked";
      resolve({
        result,
        status,
        ...(status === "blocked" && !result ? { reason: timedOut ? `bench_timeout after ${Math.round(timeoutMs / 1000)}s` : `no JSON on stdout (exit ${code})` } : {}),
        code,
        ms: Date.now() - started,
        stderr: stderr.slice(-4000),
      });
    });
  });
}

/** Both artefacts of one application, already parsed. Missing files are empty, not an error. */
export async function readArtifacts(home, slug) {
  if (!slug) return { decisions: [], trace: [], frozen: null };
  const dir = path.join(home, "applications", slug);
  const [decisionsText, traceText] = await Promise.all([
    readFile(path.join(dir, "decisions.json"), "utf8").catch(() => ""),
    readFile(path.join(dir, "trace.jsonl"), "utf8").catch(() => ""),
  ]);
  let frozen = null;
  try {
    frozen = decisionsText ? JSON.parse(decisionsText) : null;
  } catch {
    frozen = null;
  }
  return { decisions: frozen?.decisions ?? [], trace: traceText, frozen, dir };
}

/**
 * Close the posting's tab on the bench browser. The runner never closes a tab (D12) because the
 * user's filled form has to survive it; a benchmark has no user, and twenty open tabs slow every
 * subsequent posting down.
 *
 * @returns {Promise<{closed:boolean, why?:string}>}
 */
export async function closeTab({ url, home, port }) {
  const profileDir = path.join(home, "profile");
  if (!(await cdpVersion(port))) return { closed: false, why: "no browser on the bench port" };
  let conn = null;
  try {
    conn = await connect({ profileDir, port, spawnIfMissing: false });
    const page = await findTab(conn.context, url);
    if (!page) return { closed: false, why: "no tab for this posting" };
    await page.close({ runBeforeUnload: false });
    return { closed: true };
  } catch (err) {
    return { closed: false, why: err.message };
  } finally {
    if (conn) await disconnect(conn.browser, { port, verify: false }).catch(() => {});
  }
}
