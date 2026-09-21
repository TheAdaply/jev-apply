// Adapter registry: one ATS per module, dispatched by the FormPlan's `ats` or by the tab's URL.

import * as ashby from "./ashby.mjs";
import * as greenhouse from "./greenhouse.mjs";

export const adapters = { greenhouse, ashby };

/** v1 supports hosted Greenhouse and Ashby only (PLAN §2.2 step 1). */
export function atsFromUrl(url) {
  const u = String(url ?? "");
  if (/(^|\/\/)(job-boards|boards)\.greenhouse\.io\//.test(u)) return "greenhouse";
  if (/(^|\/\/)jobs\.ashbyhq\.com\//.test(u)) return "ashby";
  return null;
}

export function adapterFor(ats) {
  const key = String(ats ?? "").toLowerCase();
  const adapter = adapters[key];
  if (!adapter) throw new Error(`unsupported_ats: ${ats ?? "(none)"} — v1 supports ${Object.keys(adapters).join(", ")}`);
  return adapter;
}

function resolve(page, question, opts) {
  const ats = opts?.ats ?? question?.ats ?? atsFromUrl(page?.url?.() ?? "");
  return adapterFor(ats);
}

export async function setField(page, question, value, opts = {}) {
  return resolve(page, question, opts).setField(page, question, value, opts);
}

export async function uploadFile(page, question, filePath, opts = {}) {
  return resolve(page, question, opts).uploadFile(page, question, filePath, opts);
}

export async function snapshotRequired(page, opts = {}) {
  return resolve(page, null, opts).snapshotRequired(page);
}

/** Block until the ATS's client-rendered form exists; `load` fires long before it does. */
export async function waitForForm(page, opts = {}) {
  return resolve(page, null, opts).waitForForm(page, opts);
}
