// Resolves a bare company name (+ optional careers page URL) to a provider
// identifier by trying slug guesses against the three provider APIs.

import { providers } from "./providers/index.mjs";

const KEY_BY_PROVIDER = { greenhouse: "token", ashby: "org", lever: "site" };
const PROVIDER_ORDER = ["greenhouse", "ashby", "lever"];

function slugCandidates(name) {
  const lower = String(name).toLowerCase().trim();
  const noSep = lower.replace(/[^a-z0-9]/g, "");
  const dash = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return [...new Set([noSep, dash])].filter(Boolean);
}

// Direct hint from the careers URL's hostname/path, e.g.
// https://job-boards.greenhouse.io/acme -> { provider:"greenhouse", value:"acme" }
function hintFromCareersUrl(careersUrl) {
  if (!careersUrl) return null;
  let u;
  try {
    u = new URL(careersUrl);
  } catch {
    return null;
  }
  const segs = u.pathname.split("/").filter(Boolean);
  if (!segs[0]) return null;
  if (/(^|\.)greenhouse\.io$/.test(u.hostname)) return { provider: "greenhouse", value: segs[0] };
  if (/(^|\.)ashbyhq\.com$/.test(u.hostname)) return { provider: "ashby", value: segs[0] };
  if (/(^|\.)lever\.co$/.test(u.hostname)) return { provider: "lever", value: segs[0] };
  return null;
}

// { name?, careers_url? } → { provider, token|org|site } | { provider:"unknown" }
export async function resolveCompany({ name, careers_url } = {}) {
  const mods = await providers();
  const byId = new Map(mods.map((m) => [m.id, m]));

  const attempts = [];
  const hint = hintFromCareersUrl(careers_url);
  if (hint) attempts.push(hint);
  if (name) {
    for (const value of slugCandidates(name)) {
      for (const provider of PROVIDER_ORDER) attempts.push({ provider, value });
    }
  }

  const tried = new Set();
  for (const attempt of attempts) {
    const dedupeKey = `${attempt.provider}:${attempt.value}`;
    if (tried.has(dedupeKey)) continue;
    tried.add(dedupeKey);

    const mod = byId.get(attempt.provider);
    const key = KEY_BY_PROVIDER[attempt.provider];
    if (!mod || !key) continue;

    try {
      const entry = { [key]: attempt.value, name };
      const jobs = await mod.fetch(entry, {});
      if (Array.isArray(jobs) && jobs.length > 0) {
        return { provider: attempt.provider, [key]: attempt.value };
      }
    } catch {
      // not this provider/slug — try the next candidate
    }
  }

  return { provider: "unknown" };
}
