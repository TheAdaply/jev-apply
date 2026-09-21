// URL → FormPlan. Detects the ATS, fetches the public schema (no browser), and dispatches to the
// per-ATS normalizer. Also the offline path: `--schema <file>` plans from a recorded raw response.
// PLAN §2.2 steps 1–3.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchGreenhouse, normalizeGreenhouse } from "./greenhouse.mjs";
import { fetchAshby, normalizeAshby } from "./ashby.mjs";

// v1 supports the two hosted boards only. An embedded board (iframe#grnhse_iframe on a company
// site) or any other ATS returns null → apply.mjs emits blocked{reason:"unsupported_ats"}.
const GREENHOUSE_RE = /^https?:\/\/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i;
const ASHBY_RE = /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** detectAts(url) → {ats:"greenhouse",token,id} | {ats:"ashby",org,id} | null */
export function detectAts(url) {
  const href = String(url || "").trim();
  const gh = GREENHOUSE_RE.exec(href);
  if (gh) return { ats: "greenhouse", token: gh[1], id: gh[2] };
  const ashby = ASHBY_RE.exec(href);
  if (ashby) return { ats: "ashby", org: ashby[1], id: ashby[2].toLowerCase() };
  return null;
}

/** Which ATS a recorded raw response came from, by shape. */
export function sniffAts(raw) {
  if (raw?.data?.jobPosting || raw?.jobPosting || raw?.applicationForm) return "ashby";
  if (Array.isArray(raw?.questions) || typeof raw?.absolute_url === "string") return "greenhouse";
  return null;
}

/** normalize(raw, ats, url) → FormPlan. `ats` may be omitted; the shape is then sniffed. */
export function normalize(raw, ats, url) {
  const kind = ats || sniffAts(raw);
  if (kind === "greenhouse") return normalizeGreenhouse(raw, url);
  if (kind === "ashby") return normalizeAshby(raw, url);
  throw unsupported(`unrecognised schema shape${url ? ` for ${url}` : ""}`);
}

/** Fetch the raw public schema for an already-detected posting. */
export async function fetchSchema(target) {
  return target.ats === "greenhouse"
    ? fetchGreenhouse({ token: target.token, id: target.id })
    : fetchAshby({ org: target.org, id: target.id });
}

/** loadFormPlan(urlOrFile) → FormPlan. http(s) → fetch + normalize; anything else → recorded JSON. */
export async function loadFormPlan(urlOrFile) {
  const source = String(urlOrFile || "").trim();
  if (/^https?:\/\//i.test(source)) {
    const target = detectAts(source);
    if (!target) throw unsupported(`unsupported_ats: ${source}`);
    return normalize(await fetchSchema(target), target.ats, source);
  }
  const raw = JSON.parse(await readFile(source, "utf8"));
  const ats = sniffAts(raw);
  if (!ats) throw unsupported(`unrecognised schema file: ${source}`);
  return normalize(raw, ats, urlFromFile(raw, ats, source));
}

/**
 * recordSchema(url, dir) → saves the raw response as <ats>-<board>-<short id>.json and returns the
 * path. The board slug is part of the name because an Ashby response carries no organization
 * handle, and `_source_url` is written beside the response so a renamed or hand-written fixture
 * still plans against the posting it was recorded from instead of one rebuilt from its filename.
 */
export async function recordSchema(url, dir = "eval/fixtures") {
  const target = detectAts(url);
  if (!target) throw unsupported(`unsupported_ats: ${url}`);
  const raw = await fetchSchema(target);
  const board = target.ats === "greenhouse" ? target.token : target.org;
  const file = path.resolve(dir, `${target.ats}-${board}-${shortId(target.id)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ _source_url: url, ...raw }, null, 1)}\n`);
  return file;
}

/**
 * Rebuild the posting URL for a recorded file. `_source_url` is the recording's own answer and is
 * used whenever it parses as a supported posting; fixtures recorded before it was written fall back
 * to what the response carries (Greenhouse) or to the board slug in the filename (an Ashby response
 * names no organization, so a renamed file is the one case that can still go wrong).
 */
function urlFromFile(raw, ats, file) {
  const recorded = typeof raw?._source_url === "string" ? raw._source_url.trim() : "";
  if (recorded && detectAts(recorded)) return recorded;
  if (ats === "greenhouse") return raw.absolute_url || "";
  const posting = raw?.data?.jobPosting || raw?.jobPosting || raw;
  const parts = path.basename(file, ".json").split("-");
  const org = parts.slice(1, -1).join("-");
  return org && posting?.id ? `https://jobs.ashbyhq.com/${org}/${posting.id}/application` : "";
}

function shortId(id) {
  return String(id).split("-")[0];
}

function unsupported(message) {
  const err = new Error(message);
  err.reason = "unsupported_ats";
  return err;
}
