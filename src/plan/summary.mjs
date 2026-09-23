// The ≤20-line report the user reads before clicking Submit (PLAN §2.6), plus the run's
// usage/cost accounting — the numbers behind its last line and behind `apply.mjs`'s `usage` block.
//
// Rules from the plan: no probabilities anywhere, every ► item carries a handle `remember.mjs`
// accepts (`d1`, `c1`), and the whole thing fits on one screen. Sections that have nothing to say
// are omitted rather than printed empty, and a long section collapses to "… +N more" instead of
// spilling past the line budget.
//
// The accounting half is pure: it is handed the two clients' counters (`usageTotals()` from
// `src/jev/client.mjs` and `src/writer/openai.mjs`) and turns them into tokens, milliseconds and
// dollars against `PRICING`. A model `PRICING` does not name makes the dollar figure `null`, which
// every renderer prints as `cost: unknown` — never a guessed rate.

import path from "node:path";

import { PRICING } from "../config.mjs";

const MAX_LINES = 20;
const MAX_WIDTH = 150;

const clip = (s, n) => {
  const text = String(s ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

/** Question labels are sentences; the summary wants the handle-sized version. */
const short = (label, n = 42) => clip(String(label ?? "").replace(/\s*\?$/, ""), n);

const isFilled = (d) => d.action === "fill" || d.action === "check";

/** The word after the URL on line 1 — one per terminal status, never a probability. */
const HEADLINE = {
  submitted: "submitted",
  ready_to_submit: "ready to submit",
  needs_user: "needs your answers",
  blocked: "blocked",
};

/**
 * @param {{formPlan:object, decisions:object[], slug:string, status:string, usage?:object,
 *          submit?:object|null}} args
 *   `usage` is a `usageReport()` block; given, it adds the ► COST line above the footer.
 *   `submit` is `submitApplication()`'s result; given, it adds the ► SUBMITTED line — what the
 *   board said back and where the screenshot of it is — or the ► SUBMIT line for one that was
 *   clicked and never confirmed, which is the line that tells the user to finish by hand.
 * @returns {string} the summary, `\n`-joined, never more than 20 lines.
 */
export function renderSummary({ formPlan, decisions, slug, status = "ready_to_submit", usage = null, submit = null }) {
  const job = formPlan?.job ?? {};
  const company = job.company ?? "";
  const header = `${clip(company, 40)} — ${clip(job.title ?? "", 60)} · ${clip(formPlan?.url ?? "", 90)}   ${HEADLINE[status] ?? status}`;

  const drafts = decisions.filter((d) => d.action === "draft");
  const checks = decisions.filter((d) => d.action === "check");
  const answered = decisions.filter((d) => d.source === "user");
  const policies = decisions.filter((d) => d.class === "policy_gate" && isFilled(d));
  const money = decisions.filter((d) => d.topic === "salary" && isFilled(d));
  const asks = decisions.filter((d) => d.action === "ask");
  const resume = decisions.find((d) => d.source === "document" && /resum|cv/i.test(d.label ?? ""));

  const filled = decisions.filter(isFilled).length;
  const lines = [header, `Filled ${filled} of ${decisions.length}${resume?.value ? ` · résumé: ${path.basename(resume.value)}` : ""}`];
  if (submit?.ok) lines.push(row("SUBMITTED", submitLine(submit)));
  else if (submit) lines.push(row("SUBMIT", `clicked, not confirmed (${submit.cause ?? "unknown"}) — ${reason(submit.detail, 60)}`));

  // ► DRAFTED is the one group whose text the user did not write, so the line says how long it
  // is, what it was built from, and — on a dry run — that it was never typed into the form.
  for (const [i, d] of drafts.entries()) {
    const state = d.value == null ? " (not written)" : d.dry ? " (dry run — not typed)" : "";
    lines.push(row("DRAFTED", `d${i + 1} "${short(d.label)}"${d.words ? ` ${d.words} words` : ""}${state} — ${d.why}`));
  }
  for (const [i, d] of checks.entries()) {
    lines.push(row("CHECK", `c${i + 1} "${short(d.label)}": ${valueOf(d)} (${reason(d.why, 44)})`));
  }
  if (answered.length) lines.push(row("YOU ANSWERED", join(answered.map((d) => `${short(d.label, 30)}: ${valueOf(d, 24)} (${reason(d.why.replace(/^you answered — /, ""))})`))));
  for (const d of policies) lines.push(row("POLICY", `"${short(d.label)}": ${valueOf(d)} — answered by you, ${company} only`));
  for (const d of money) lines.push(row("MONEY", `salary: ${valueOf(d, 60)} (${reason(d.why)})`));

  // The demographic block, by count only. A user who turned `p.eeo` on still gets to see that
  // nine controls were written on their behalf, and the values themselves are never printed —
  // not here, not in the trace, not in a screenshot (AGENTS.md).
  const eeo = decisions.filter((d) => d.class === "sensitive");
  if (eeo.length) {
    // `eeoAnswered`, not `answered`: the outer `answered` is the `source:"user"` *array*, and a
    // later edit that lifts this line out of the block would silently swap it for a count.
    const eeoAnswered = eeo.filter(isFilled).length;
    const open = eeo.filter((d) => d.action === "ask").length;
    lines.push(row("EEO", `${eeoAnswered} of ${eeo.length} answered from your saved p.eeo (values not printed)${open ? ` · ${open} left for you` : ""}`));
  }

  const notFilled = skipSummary(decisions);
  if (notFilled.length) lines.push(row("NOT FILLED", join(notFilled)));
  if (asks.length) lines.push(row("NEEDS YOU", join(asks.map((d) => `${short(d.label, 44)} (${reason(d.why)})`), 2)));

  // The two lines the user needs *after* a run are the cost of it and what to do next, so both
  // are footer: `fit` drops from the middle, never from here. A submitted application's "next"
  // is the receipt, not the resume line — there is nothing left to finish by hand.
  const footer = [
    submit?.ok
      ? `Submitted — the board's confirmation is at ${submit.confirmation?.screenshot ?? `applications/${slug}/submitted.png`}`
      : `If Submit errors: run \`apply.mjs --resume ${slug}\` — it lists every field with its intended value.`,
  ];
  if (usage) footer.unshift(row("COST", costLine(usage)));
  return fit(lines, footer).join("\n");
}

/** What the board said back, and where the picture of it is. */
function submitLine(submit) {
  const c = submit.confirmation ?? {};
  const said = c.text ? `"${clip(c.text, 60)}"` : c.url ? clip(c.url, 60) : "confirmed";
  return `${said} — by ${c.strategy ?? "the board's confirmation"}${c.screenshot ? ` · ${path.basename(c.screenshot)}` : ""}`;
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

/**
 * Skipped rows, for the NOT FILLED line. The demographic block used to be collapsed here, back
 * when a sensitive row with no stated preference was `skip`; it never skips now (every path in
 * `resolve.mjs`'s `sensitiveRow` is a fill or an ask), so the EEO block has its own counted line
 * above and this function is only about the optional text and opt-ins nobody answered.
 */
function skipSummary(decisions) {
  return decisions
    .filter((d) => d.action === "skip")
    .map((d) => `${short(d.label, 28)} (${reason(d.why, 28)})`);
}

/** Head and footer always survive; the least important middle lines go until the budget is met. */
function fit(lines, footer) {
  const all = [...lines, ...footer];
  if (all.length <= MAX_LINES) return all;
  const head = lines.slice(0, 2);
  const body = lines.slice(2);
  const keep = body.slice(0, MAX_LINES - 3 - footer.length);
  return [...head, ...keep, row("", `+${body.length - keep.length} more items — see decisions.json`), ...footer];
}

// ─── usage and cost ───────────────────────────────────────────────────────────────────────────

/** Per-phase wall clock for one posting: schema fetch, planning (deterministic + Jev), browser. */
export function newPhases() {
  return { schema: 0, plan: 0, browser: 0 };
}

/** Run `fn`, adding its wall time to `phases[key]`. Accumulates, so a phase may be entered twice. */
export async function timed(phases, key, fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    phases[key] += Date.now() - started;
  }
}

/**
 * `now − base` over the writer's `usageTotals()` shape, so one posting can be billed for its own
 * calls inside a process that made others. `base` omitted means "everything so far".
 */
export function deltaUsage(now, base = null) {
  if (!base) return now;
  const out = { calls: now.calls - base.calls, input_tokens: now.input_tokens - base.input_tokens, output_tokens: now.output_tokens - base.output_tokens, by_model: {} };
  for (const [model, row] of Object.entries(now.by_model ?? {})) {
    const was = base.by_model?.[model] ?? { calls: 0, input_tokens: 0, output_tokens: 0 };
    const delta = { calls: row.calls - was.calls, input_tokens: row.input_tokens - was.input_tokens, output_tokens: row.output_tokens - was.output_tokens };
    if (delta.calls || delta.input_tokens || delta.output_tokens) out.by_model[model] = delta;
  }
  return out;
}

/** `{requests, usage:{…}}` (a planner's per-posting tally) and `{requests, input_tokens, …}` (the client's) both read the same. */
const jevCounts = (jev) => ({
  requests: jev?.requests ?? 0,
  input_tokens: jev?.usage?.input_tokens ?? jev?.input_tokens ?? 0,
  output_tokens: jev?.usage?.output_tokens ?? jev?.output_tokens ?? 0,
});

const round6 = (n) => (n == null ? null : Math.round(n * 1e6) / 1e6);

function rateCost(rate, { input_tokens, output_tokens }) {
  if (!rate || rate.input_per_mtok == null || rate.output_per_mtok == null) return null;
  return (input_tokens / 1e6) * rate.input_per_mtok + (output_tokens / 1e6) * rate.output_per_mtok;
}

/**
 * Exact key, or the undated form of a dated snapshot (`gpt-5.4-2026-03-01` → `gpt-5.4`).
 * Never a prefix match: `gpt-5.4-pro` starts with `gpt-5.4` and costs twelve times as much, so
 * a prefix rule would silently bill a $30/$180 model at $2.50/$15. An unpriced model is `null`,
 * which every renderer prints as `cost: unknown`.
 */
function openaiRate(model) {
  const table = PRICING.openai ?? {};
  const name = String(model ?? "");
  return table[name] ?? table[name.replace(/-\d{4}-\d{2}-\d{2}$/, "")] ?? null;
}

/** One model with no published rate makes the whole figure unknown rather than an undercount. */
function openaiCost(openai) {
  const models = Object.entries(openai.by_model ?? {});
  if (!models.length) return openai.calls ? null : 0;
  let total = 0;
  for (const [model, row] of models) {
    const usd = rateCost(openaiRate(model), row);
    if (usd == null) return null;
    total += usd;
  }
  return total;
}

/**
 * The `usage` block every `apply.mjs` status carries, and what the bench sums per posting.
 *
 * The phases are *not* a partition of `ms_total`: a conditional follow-up discovered on a
 * half-filled form is re-planned from inside the fill loop (PLAN §2.2 step 9), so that Jev round
 * trip is counted in both `ms_plan` and `ms_browser`. They are "time spent in this activity",
 * not disjoint slices, and may sum past `ms_total`.
 * @param {{started?:number, ms_total?:number, phases?:object, jev?:object, openai?:object}} args
 * @returns {{ms_total:number, ms_schema:number, ms_plan:number, ms_browser:number,
 *            jev:{requests,input_tokens,output_tokens,usd}, openai:{calls,input_tokens,output_tokens,usd},
 *            usd_total:number|null}}
 */
export function usageReport({ started = null, ms_total = null, phases = {}, jev = null, openai = null } = {}) {
  const j = jevCounts(jev);
  const o = { calls: openai?.calls ?? 0, input_tokens: openai?.input_tokens ?? 0, output_tokens: openai?.output_tokens ?? 0, by_model: openai?.by_model ?? {} };
  const jevUsd = round6(rateCost(PRICING.jev, j));
  const openaiUsd = round6(openaiCost(o));
  return {
    ms_total: ms_total ?? (started ? Date.now() - started : 0),
    ms_schema: phases.schema ?? 0,
    ms_plan: phases.plan ?? 0,
    ms_browser: phases.browser ?? 0,
    jev: { ...j, usd: jevUsd },
    openai: { calls: o.calls, input_tokens: o.input_tokens, output_tokens: o.output_tokens, usd: openaiUsd },
    usd_total: jevUsd == null || openaiUsd == null ? null : round6(jevUsd + openaiUsd),
  };
}

/** `$0.000190`, `$0` or `cost: unknown` — never a rounded-to-zero dollar figure. */
export function money(usd) {
  if (usd == null) return "cost: unknown";
  if (usd === 0) return "$0";
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 0.000001) return "$<0.000001";
  return `$${usd.toFixed(6)}`;
}

/** `Jev 2 req / 4530 tok / $0.000190 · OpenAI 0 tok / $0 · wall 7.8s` (PLAN §2.6 line budget). */
export function costLine(usage) {
  const jevTok = usage.jev.input_tokens + usage.jev.output_tokens;
  const openaiTok = usage.openai.input_tokens + usage.openai.output_tokens;
  return [
    `Jev ${usage.jev.requests} req / ${jevTok} tok / ${money(usage.jev.usd)}`,
    `OpenAI ${openaiTok} tok / ${money(usage.openai.usd)}`,
    `wall ${(usage.ms_total / 1000).toFixed(1)}s`,
  ].join(" · ");
}
