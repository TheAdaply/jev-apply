// The benchmark's input list.
//
// Two shapes are accepted, because the list is built by hand before it is built by a researcher:
//
//   bench/postings.yml     `postings:` — a list of {url, company, family, ats, controls[], notes},
//                          ordered easiest → hardest, optionally with a `control_summary:` map.
//   any other file         one URL per line, `#` comments and blank lines ignored. This is the
//                          smoke list: two fixture URLs are enough to prove the harness runs.
//
// Nothing here fetches anything. `company` and `ats` are filled in from the URL when the file
// does not state them, so a bare URL list still produces a readable table.

import { readFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

/** `jobs.ashbyhq.com/baseten/<uuid>/application` → ashby/baseten; Greenhouse → the board token. */
export function fromUrl(url) {
  const ashby = /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i.exec(url);
  if (ashby) return { ats: "ashby", company: ashby[1], id: ashby[2].slice(0, 8) };
  const gh = /^https?:\/\/(?:job-boards|boards)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i.exec(url);
  if (gh) return { ats: "greenhouse", company: gh[1], id: gh[2] };
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* not a URL — the caller reports it as unsupported */
  }
  return { ats: "unknown", company: host || "unknown", id: "" };
}

const titleCase = (s) =>
  String(s ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .trim();

function normalizeRow(row, index) {
  const url = String(row?.url ?? row ?? "").trim();
  const derived = fromUrl(url);
  return {
    n: index + 1,
    url,
    company: row?.company ?? titleCase(derived.company),
    ats: String(row?.ats ?? derived.ats).toLowerCase(),
    family: row?.family ?? null,
    controls: Array.isArray(row?.controls) ? row.controls : [],
    notes: row?.notes ?? null,
  };
}

/**
 * @param {string} file `.yml`/`.yaml` postings file, or a plain list of URLs.
 * @returns {Promise<{file:string, source:"yaml"|"urls", postings:object[], control_summary:object|null}>}
 */
export async function loadPostings(file) {
  const text = await readFile(file, "utf8");
  const yamlish = /\.ya?ml$/i.test(file);

  if (yamlish) {
    const doc = YAML.parse(text) ?? {};
    const list = Array.isArray(doc) ? doc : Array.isArray(doc.postings) ? doc.postings : [];
    if (!list.length) throw new Error(`${path.basename(file)} has no \`postings:\` entries`);
    return {
      file,
      source: "yaml",
      postings: list.map(normalizeRow),
      control_summary: doc.control_summary ?? null,
      generated: doc.generated ?? null,
      verified: doc.verified ?? null,
    };
  }

  const urls = text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
  if (!urls.length) throw new Error(`${path.basename(file)} lists no URLs`);
  return { file, source: "urls", postings: urls.map(normalizeRow), control_summary: null, generated: null, verified: null };
}
