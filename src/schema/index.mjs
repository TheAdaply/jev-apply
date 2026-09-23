// The schema slice's public surface (docs/CONTRACTS.md §src/schema).
// Import from here, not from the per-ATS modules.

export { detectAts, sniffAts, normalize, fetchSchema, loadFormPlan, recordSchema } from "./normalize.mjs";
export { fetchGreenhouse, normalizeGreenhouse } from "./greenhouse.mjs";
export { fetchAshby, normalizeAshby } from "./ashby.mjs";
export {
  classify,
  parseLimits,
  cleanLabel,
  htmlToText,
  decodeEntities,
} from "./classes.mjs";
