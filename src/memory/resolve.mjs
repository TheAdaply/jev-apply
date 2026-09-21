// Lookup and scope resolution over a loaded memory object (PLAN §2.4).
// Resolution order is company > role_family > global, everywhere, for everything scoped.

import { slugify } from "../config.mjs";
import { parseScope, scopeRank } from "./schema.mjs";

/** @returns the whole fact row (`{id, value, since?, source, updated}`) so callers can cite it. */
export function getFact(mem, id) {
  return (mem?.facts ?? []).find((row) => row?.id === id);
}

/** Convenience for the common `getFact(...)?.value` read. */
export function factValue(mem, id, fallback = undefined) {
  const row = getFact(mem, id);
  return row ? row.value : fallback;
}

/** Every fact whose id starts with `prefix` (e.g. `"f.work_auth."`). */
export function listFacts(mem, prefix) {
  return (mem?.facts ?? []).filter((row) => typeof row?.id === "string" && row.id.startsWith(prefix));
}

function scopeMatches(scope, ctx) {
  const parsed = parseScope(scope);
  if (!parsed) return false;
  if (parsed.kind === "global") return true;
  if (parsed.kind === "company") return Boolean(ctx.company) && slugify(parsed.key) === slugify(ctx.company);
  return Boolean(ctx.role_family) && slugify(parsed.key) === slugify(ctx.role_family);
}

/**
 * Resolve one preference for this posting.
 * @param {object} mem memory from `loadMemory()`
 * @param {string} id e.g. `"p.salary"`
 * @param {{company?:string, role_family?:string}} [ctx]
 * @returns {{id:string, value:any, scope:string, source:any, overridden:boolean}|undefined}
 *   `undefined` when nothing applies — the caller must then `ask`, never default.
 */
export function resolvePreference(mem, id, ctx = {}) {
  const row = (mem?.preferences ?? []).find((r) => r?.id === id);
  if (!row) return undefined;

  let best = null;
  for (const override of Array.isArray(row.overrides) ? row.overrides : []) {
    if (!override || typeof override !== "object") continue;
    if (!scopeMatches(override.scope, ctx)) continue;
    if (override.value === undefined || override.value === null) continue;
    if (!best || scopeRank(override.scope) > scopeRank(best.scope)) best = override;
  }
  if (best) {
    return { id, value: best.value, scope: parseScope(best.scope).text, source: best.source ?? row.source, overridden: true };
  }
  if (row.value === undefined || row.value === null) return undefined;
  return { id, value: row.value, scope: "global", source: row.source, overridden: false };
}

/** Every preference that resolves under this context, as `{id: resolved}`. */
export function resolveAll(mem, ctx = {}) {
  const out = {};
  for (const row of mem?.preferences ?? []) {
    if (typeof row?.id !== "string") continue;
    const resolved = resolvePreference(mem, row.id, ctx);
    if (resolved) out[row.id] = resolved;
  }
  return out;
}

/** Corrections that apply here, most specific first (a company rule outranks a global one). */
export function applicableCorrections(mem, ctx = {}) {
  return (mem?.corrections ?? [])
    .filter((row) => scopeMatches(row?.scope ?? "global", ctx))
    .sort((a, b) => scopeRank(b?.scope ?? "global") - scopeRank(a?.scope ?? "global"));
}

/**
 * Saved answers for a canonical question, most specific scope first.
 * `kind: "never"` rows are saved history the resolver must not offer, so they are dropped here.
 */
export function answersFor(mem, qid, ctx = {}) {
  return (mem?.answers ?? [])
    .filter((row) => row?.qid === qid && row?.kind !== "never" && scopeMatches(row?.scope ?? "global", ctx))
    .filter((row) => !ctx.role_family || !row.family || slugify(row.family) === slugify(ctx.role_family))
    .sort((a, b) => scopeRank(b?.scope ?? "global") - scopeRank(a?.scope ?? "global"));
}

/** Stories usable as writer material / selector pool: `use: never` rows stay saved but hidden. */
export function usableStories(mem) {
  return (mem?.stories ?? []).filter((row) => row?.use !== "never");
}

/** The résumé to attach for this posting: role-family match first, then the stated default. */
export function documentFor(mem, ctx = {}) {
  const docs = mem?.documents ?? [];
  if (ctx.role_family) {
    const match = docs.find((d) => (d?.role_families ?? []).some((f) => slugify(f) === slugify(ctx.role_family)));
    if (match) return match;
  }
  const pref = resolvePreference(mem, "p.resume_by_role_family", ctx);
  const byFamily = pref?.value?.[ctx.role_family] ?? pref?.value?.default;
  if (byFamily) {
    const match = docs.find((d) => d?.id === byFamily);
    if (match) return match;
  }
  return docs.length === 1 ? docs[0] : undefined;
}
