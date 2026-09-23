// FRAMEWORK §2(d): the widget accepting a value is not evidence that it answers the question.
import { noul, NONE, planRequests, systemOne } from "../jev/client.mjs";
import { GATES } from "../jev/gates.mjs";
import { appendTrace } from "../browser/trace.mjs";
import { resolveSelector } from "../browser/adapters/index.mjs";

const writing = (d) => ["fill", "check", "draft"].includes(d.action) && (d.value != null || d.option != null);
export const sensitiveRow = (d) => d.class === "sensitive" || d.understanding?.sensitive === true;
export const passingVerification = (d) => sensitiveRow(d)
  ? d.readback?.ok === true && d.readback?.observed_matches === true
  : d.readback?.ok === true && d.verified?.ok === true && Number.isFinite(d.verified.noul) && d.verified.noul >= GATES.verifyBelow;

export function verificationCounts(decisions = []) {
  const rows = decisions.filter((d) => writing(d) || d.verified != null);
  return { ok: rows.filter((d) => writing(d) && passingVerification(d)).length, total: rows.length };
}

export async function verifyFilled({ pairs, slug = null, signal, jev = systemOne }) {
  const rows = {};
  const questions = {};
  for (const [index, pair] of pairs.entries()) {
    if (pair.sensitive) continue; // protected values never enter the verification request
    rows[pair.qid] = { question: pair.question, filled_value: pair.filled_value, candidate: pair.candidate ?? null, resolved_value: pair.resolved_value ?? null, derivation: pair.derivation ?? null, reference_date: pair.derivation?.reference_date ?? null };
    questions[`ver_${index}`] = noul(
      `Does rows[${JSON.stringify(pair.qid)}].filled_value answer that row's question correctly for this applicant, including all qualifiers, supported by its candidate evidence and explicit derivation? A relative timing rule is evaluated against reference_date to produce resolved_value. No evidence or an unrelated answer means false (${NONE}).`,
      { true: "The visible answer is supported and answers this exact question", false: `${NONE}: unsupported, unrelated, or does not answer the question as asked` },
    );
  }
  if (!Object.keys(questions).length) return { verdicts: {}, requests: 0, usage: {} };
  const state = { rows };
  if (planRequests(state, questions).length !== 1) throw new Error("verification exceeds one-request budget");
  await appendTrace(slug, { op: "jev_request", stage: "verify", state, questions });
  let result;
  try {
    result = await jev({ state, questions, signal });
  } catch (err) {
    await appendTrace(slug, { op: "jev_error", stage: "verify", error: err.name ?? "Error" });
    err.requests = 1;
    throw err;
  }
  await appendTrace(slug, { op: "jev_response", stage: "verify", answers: result.answers, requests: result.requests ?? 1, usage: result.usage, ms: result.ms });
  const verdicts = {};
  for (const [index, pair] of pairs.entries()) {
    if (pair.sensitive) continue;
    const value = result.answers?.[`ver_${index}`]?.noul;
    const n = Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
    verdicts[pair.qid] = { noul: n, ok: n !== null && n >= GATES.verifyBelow };
  }
  return { verdicts, requests: result.requests ?? 1, usage: result.usage ?? {} };
}

// Only clear controls with a native empty state. Never choose a different option as a substitute.
export async function clearControl({ page, question, ats, slug }) {
  let result = { ok: false, cleared: false, reason: "unsafe_to_clear" };
  let selector = question?.selector;
  try {
    selector = await resolveSelector(page, ats, question);
    const input = page.locator(selector).first();
    const kind = await input.evaluate((el) => ({ tag: el.tagName, type: el.type, role: el.getAttribute("role"), combobox: Boolean(el.closest('[class*="select__control"], [class*="select-shell"]')) }));
    if ((kind.tag === "TEXTAREA" || (kind.tag === "INPUT" && ["text", "email", "tel", "url", "number", "date", "search"].includes(kind.type))) && kind.role !== "combobox" && !kind.combobox) {
      await input.fill("");
      result = { cleared: true, ok: (await input.inputValue()) === "" };
    } else if (kind.tag === "SELECT") {
      const empty = await input.evaluate((el) => el.multiple || [...el.options].some((o) => o.value === ""));
      if (empty) {
        const multiple = await input.evaluate((el) => el.multiple);
        await input.selectOption(multiple ? [] : "");
        result = { cleared: true, ok: await input.evaluate((el) => [...el.selectedOptions].every((o) => o.value === "")) };
      }
    }
  } catch {
    result = { ok: false, cleared: false, reason: "clear_failed" };
  }
  await appendTrace(slug, { op: "clear", stage: "verify", qid: question?.qid, selector, ...result });
  return result;
}
// A re-attach must not verify a previous run's cached read-back.
async function refreshReadback({ page, ats, question, decision, slug }) {
  let observed = null;
  try {
    const selector = await resolveSelector(page, ats, question);
    observed = await page.locator(selector).first().evaluate((el) => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const box = el.closest('fieldset, [class*="ashby-application-form-field"], [class*="select-shell"], [class*="select__control"]') ?? el;
      const chips = [...box.querySelectorAll('[class*="singleValue"], [class*="single-value"], [class*="multi-value__label"]')];
      if (chips.length) return chips.map((c) => clean(c.textContent)).join("; ");
      if (el.tagName === "SELECT") return [...el.selectedOptions].map((o) => clean(o.label)).join("; ");
      const pressed = box.querySelector('button[data-option][aria-pressed="true"]');
      if (pressed) return clean(pressed.getAttribute("data-option"));
      const checked = [...box.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked')];
      if (checked.length) return checked.map((c) => clean(c.labels?.[0]?.textContent ?? c.value)).join("; ");
      if (el.type === "file") return [...(el.files ?? [])].map((f) => f.name).join("; ");
      if ("value" in el && !["radio", "checkbox"].includes(el.type)) return String(el.value);
      return null;
    });
  } catch {
    // A disappeared or unreadable control cannot inherit a passing verdict from disk.
  }
  const sensitive = sensitiveRow(decision);
  const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  decision.readback = {
    ...decision.readback,
    ok: observed != null && observed !== "",
    observed: sensitive ? "" : observed ?? "",
    ...(sensitive ? { observed_matches: observed != null && norm(observed) === norm(decision.option ?? decision.value) } : {}),
  };
  await appendTrace(slug, { op: "readback", stage: "verify", qid: decision.qid, ...decision.readback });
  if (!decision.readback.ok) {
    decision.action = "ask";
    decision.verified = { noul: null, ok: false };
    decision.why = "the value on the page could not be read for semantic verification";
  }
}

export async function verifyDecisions({ page = null, ats, formPlan, decisions, slug = null, budget = null, signal, refresh = false, jev = systemOne, clear = clearControl }) {
  const byQid = new Map((formPlan?.questions ?? []).map((q) => [q.qid, q]));
  if (refresh && page) {
    for (const d of decisions.filter(writing)) {
      await refreshReadback({ page, ats, question: byQid.get(d.qid) ?? d, decision: d, slug });
    }
  }
  const filled = decisions.filter((d) => writing(d) && d.readback?.ok === true && !sensitiveRow(d));
  const pairs = filled.map((d) => {
    const q = byQid.get(d.qid) ?? d;
    return { qid: d.qid, question: { label: q.label, help: q.help ?? "", qualifiers: d.understanding?.qualifiers ?? [] }, filled_value: d.readback.observed,
      candidate: d.source === "user" ? { text: d.value, answers_questions: [q.label], source: "user" } : d.selected ?? null, resolved_value: d.value ?? null, derivation: d.derivation ?? null };
  });
  let result = { verdicts: {}, requests: 0, usage: {} };
  if (pairs.length) {
    try {
      result = await verifyFilled({ pairs, slug, signal, jev });
    } catch (err) {
      // Unknown is not a passing judgement. Leave a visible ask and an auditable null verdict.
      result.unavailable = true;
      result.requests = err.requests ?? 0;
    }
  }
  let reverted = 0;
  for (const d of decisions.filter((row) => writing(row) && sensitiveRow(row) && !passingVerification(row))) {
    d.action = "ask";
    d.verified = { noul: null, ok: false };
    d.why = "the sensitive option on the page was not confirmed as the stated option";
    d.resolution = "asked_gate";
    reverted += 1;
  }
  for (const d of filled) {
    d.verified = result.verdicts[d.qid] ?? { noul: null, ok: false };
    if (d.verified.ok) continue;
    d.action = "ask";
    d.why = result.unavailable ? "semantic verification unavailable — answer this question before submitting" : "the value on the page does not answer this question";
    d.resolution = "asked_gate";
    if (page && d.verified.noul !== null) d.verify_clear = await clear({ page, question: byQid.get(d.qid) ?? d, ats, slug });
    reverted += 1;
  }
  const counts = verificationCounts(decisions);
  await appendTrace(slug, { op: "verify", ...counts, reverted, unavailable: result.unavailable === true, verdicts: result.verdicts });
  budget?.spend(result.requests);
  return { verified: counts.ok, total: counts.total, reverted, requests: result.requests, usage: result.usage };
}
