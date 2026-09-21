// Adapter registry: one ATS per module, dispatched by the FormPlan's `ats` or by the tab's URL —
// and then, within that ATS, by what the control turns out to be.
//
// A board's adapter tunes the handful of widgets that board actually renders (`HANDLES`). A form
// that grows a date picker, a number field or a geocoder is not a reason to force the value down
// the text path: `detectControl` names the widget and anything the ATS adapter does not tune is
// routed to `generic`, which is the shared ladder in `src/browser/controls.mjs`.

import { detectControl } from "../controls.mjs";
import * as ashby from "./ashby.mjs";
import * as generic from "./generic.mjs";
import * as greenhouse from "./greenhouse.mjs";

export const adapters = { greenhouse, ashby, generic };

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

/**
 * The selector detection should look at, resolved against the live DOM: the FormPlan's guess at
 * an element id is not always the element (Ashby keys radio groups off the field entry, not an
 * id). An adapter with nothing to resolve just answers with its own `selectorFor`.
 */
export async function resolveSelector(page, ats, question) {
  const adapter = adapters[String(ats ?? "").toLowerCase()] ?? generic;
  if (adapter.resolveSelector) return adapter.resolveSelector(page, question);
  return (adapter.selectorFor ?? generic.selectorFor)(question);
}

/** Does this ATS adapter tune that control itself? Everything else belongs to `generic`. */
export function handles(ats, control) {
  const adapter = adapters[String(ats ?? "").toLowerCase()];
  return Boolean(adapter?.HANDLES?.has(control));
}

export async function setField(page, question, value, opts = {}) {
  const ats = opts?.ats ?? question?.ats ?? atsFromUrl(page?.url?.() ?? "");
  const adapter = adapterFor(ats);
  const selector = opts.selector ?? (await resolveSelector(page, ats, question));
  const detected = opts.detected ?? (await detectControl(page, selector, { question }));
  const target = adapter.HANDLES?.has(detected.control) ? adapter : generic;
  return target.setField(page, question, value, { ...opts, detected, selector });
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
