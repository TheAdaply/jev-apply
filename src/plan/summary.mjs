// The ≤20-line report the user reads before clicking Submit (PLAN §2.6).
//
// Rules from the plan: no probabilities anywhere, every ► item carries a handle `remember.mjs`
// accepts (`d1`, `c1`), and the whole thing fits on one screen. Sections that have nothing to say
// are omitted rather than printed empty, and a long section collapses to "… +N more" instead of
// spilling past the line budget.

import path from "node:path";

const MAX_LINES = 20;
const MAX_WIDTH = 150;

const clip = (s, n) => {
  const text = String(s ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

/** Question labels are sentences; the summary wants the handle-sized version. */
const short = (label, n = 42) => clip(String(label ?? "").replace(/\s*\?$/, ""), n);

const isFilled = (d) => d.action === "fill" || d.action === "check";

/**
 * @param {{formPlan:object, decisions:object[], slug:string, status:string}} args
 * @returns {string} the summary, `\n`-joined, never more than 20 lines.
 */
export function renderSummary({ formPlan, decisions, slug, status = "ready_to_submit" }) {
  const job = formPlan?.job ?? {};
  const company = job.company ?? "";
  const header = `${clip(company, 40)} — ${clip(job.title ?? "", 60)} · ${clip(formPlan?.url ?? "", 90)}   ${status === "ready_to_submit" ? "ready to submit" : "needs your answers"}`;

  const drafts = decisions.filter((d) => d.action === "draft");
  const checks = decisions.filter((d) => d.action === "check");
  const answered = decisions.filter((d) => d.source === "user");
  const policies = decisions.filter((d) => d.class === "policy_gate" && isFilled(d));
  const money = decisions.filter((d) => d.topic === "salary" && isFilled(d));
  const asks = decisions.filter((d) => d.action === "ask");
  const resume = decisions.find((d) => d.source === "document" && /resum|cv/i.test(d.label ?? ""));

  const filled = decisions.filter(isFilled).length;
  const lines = [header, `Filled ${filled} of ${decisions.length}${resume?.value ? ` · résumé: ${path.basename(resume.value)}` : ""}`];

  for (const [i, d] of drafts.entries()) {
    lines.push(row("DRAFTED", `d${i + 1} "${short(d.label)}"${d.words ? ` ${d.words} words` : ""} — ${d.why}`));
  }
  for (const [i, d] of checks.entries()) {
    lines.push(row("CHECK", `c${i + 1} "${short(d.label)}": ${valueOf(d)} (${reason(d.why, 44)})`));
  }
  if (answered.length) lines.push(row("YOU ANSWERED", join(answered.map((d) => `${short(d.label, 30)}: ${valueOf(d, 24)} (${reason(d.why.replace(/^you answered — /, ""))})`))));
  for (const d of policies) lines.push(row("POLICY", `"${short(d.label)}": ${valueOf(d)} — answered by you, ${company} only`));
  for (const d of money) lines.push(row("MONEY", `salary: ${valueOf(d, 60)} (${reason(d.why)})`));

  const notFilled = skipSummary(decisions);
  if (notFilled.length) lines.push(row("NOT FILLED", join(notFilled)));
  if (asks.length) lines.push(row("NEEDS YOU", join(asks.map((d) => `${short(d.label, 44)} (${reason(d.why)})`), 2)));

  lines.push(`If Submit errors: run \`apply.mjs --resume ${slug}\` — it lists every field with its intended value.`);
  return fit(lines).join("\n");
}

function row(tag, text) {
  return `► ${tag.padEnd(12)} ${clip(text, MAX_WIDTH - 15)}`;
}

/** The `why` clause, trimmed to what the user needs to see next to the label. */
const reason = (why, n = 36) =>
  clip(String(why ?? "").replace(/^optional — /, "").replace(/ on file$/, "").split(" (")[0], n);

const join = (items, max = 3) =>
  items.slice(0, max).join(" · ") + (items.length > max ? ` · +${items.length - max} more` : "");

function valueOf(d, n = 40) {
  if (d.class === "sensitive") return "••••";
  return clip(d.option ?? d.value ?? "(no value)", n);
}

/** Skipped rows, with the EEO block collapsed into the single line the user cares about. */
function skipSummary(decisions) {
  const skipped = decisions.filter((d) => d.action === "skip");
  const eeo = skipped.filter((d) => d.class === "sensitive");
  const rest = skipped.filter((d) => d.class !== "sensitive").map((d) => `${short(d.label, 28)} (${reason(d.why, 28)})`);
  return eeo.length ? [...rest, `EEO section, ${eeo.length} questions (${reason(eeo[0].why.replace(/^EEO: /, ""), 26)})`] : rest;
}

/** Keep the footer, drop the least important middle lines until the budget is met. */
function fit(lines) {
  if (lines.length <= MAX_LINES) return lines;
  const head = lines.slice(0, 2);
  const footer = lines[lines.length - 1];
  const body = lines.slice(2, -1);
  const keep = body.slice(0, MAX_LINES - 4);
  return [...head, ...keep, row("", `+${body.length - keep.length} more items — see decisions.json`), footer];
}
