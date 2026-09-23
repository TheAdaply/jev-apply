// The only place confidence thresholds live (AGENTS.md). Everything else imports `gate`.
//
// Provenance: 0.5 / 0.15 are the starting points from PLAN §2.2 step 7. The vendor's own 0.5/0.9
// bands are an illustrative example in the docs, not measured (docs/research/03, correction 08 §7),
// so M0-b recalibrates these two numbers against the real forms. Change them here, nowhere else.

import { NONE } from "./client.mjs";

export const GATES = {
  /** Below this confidence we ask the user instead of filling. */
  askBelow: 0.5,
  /** Top-to-runner-up probability margin below which a filled value is flagged for review. */
  checkGap: 0.15,
  /** Noul probability at or above which a multi-select option is ticked (`src/jev/plan.mjs`). */
  noulSelect: 0.5,
  answersGate: 0.6,
  faithfulGate: 0.6,
  verifyBelow: 0.5,
};

/**
 * Full-time-years boundaries between the salary table's levels: `< early` is "entry", `< senior`
 * is "early", the rest is "senior". They select the salary-table row, i.e. the number typed into a
 * compensation field, so they live here with the other tuning numbers rather than in `derive.mjs`.
 * A `salary-baselines.yaml` may override them with its own `rule.levels` block — the table owns its
 * vocabulary the same way its `markets:` block does (`derive.levelCutoffs`).
 */
export const LEVEL_YEARS = { early: 1, senior: 3 };

/** Margin between the picked label and the best alternative; `undefined` if not computable. */
export function runnerUpGap(probabilities, picked) {
  if (!probabilities || typeof probabilities !== "object") return undefined;
  const top = probabilities[picked];
  if (typeof top !== "number") return undefined;
  let runnerUp = 0;
  for (const [label, p] of Object.entries(probabilities)) {
    if (label === picked) continue;
    if (typeof p === "number" && p > runnerUp) runnerUp = p;
  }
  return top - runnerUp;
}

/**
 * Turn a validated Choice answer into an action.
 * `none_of_these` or low confidence → "ask"; a thin margin over the runner-up → "check"
 * (fill, but show it to the user); otherwise → "fill".
 * @param {{choice:string, confidence:number, probabilities?:Record<string,number>}} answer
 * @returns {"fill"|"check"|"ask"}
 */
export function gate({ choice, confidence, probabilities }) {
  if (choice === NONE || choice === undefined || choice === null) return "ask";
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < GATES.askBelow) return "ask";
  const gap = runnerUpGap(probabilities, choice);
  if (gap === undefined) return "check"; // no distribution to judge the margin by → never silent
  return gap < GATES.checkGap ? "check" : "fill";
}
