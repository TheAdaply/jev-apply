#!/usr/bin/env node
// Submit-step check for `src/plan/execute.mjs` + the three adapters' `findSubmit`/`confirmSubmitted`.
//
//   node scripts/submit-smoke.mjs [--port 9224] [--home /tmp/jev-bench] [--profile DIR] [--keep]
//
// Drives `eval/fixtures/submit-form.html` — fill every required field, click the real Submit
// button, wait for the board's confirmation — three times, once per outcome the runner has to
// tell apart:
//
//   1. the form submits          → `submitted`, with the thank-you page detected and a screenshot
//                                  of it on disk at applications/<slug>/submitted.png
//   2. an error banner appears   → `blocked{submit_failed}`, nothing claimed, the tab left alone
//   3. a captcha challenge opens → `blocked{submit_failed}`, same, because the runner never
//                                  solves one and a form behind a challenge is not submitted
//
// plus the two pure-detection assertions that keep a real posting safe: all three adapters find
// the *application* form's button (not the newsletter form's, which the fixture puts after it in
// the DOM on purpose), and all three recognise the confirmation page.
//
// Never a real posting. This is the only place Submit is ever clicked in development: the fixture
// is local, the candidate is invented, and the browser is the bench's own (port 9224, its own
// profile — never 9223, which is where the user's real applications are filled). The script
// refuses to run against `~/.config/jev-apply`.
//
// 9224 is shared with the bench and the screenshot eval, and opening a tab brings it to the
// front, which is enough to spoil somebody else's shot. When another pass is mid-flight, run
// this on a browser of its own instead of coordinating a window:
//
//   node scripts/submit-smoke.mjs --port 9226 --profile /tmp/jev-submit-smoke/profile
//
// `connect()` spawns Chrome on that profile if the port is dead, and the fixtures do not care
// which browser they render in.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ─── the private home, decided before anything that reads it is imported ───────────────────────
//
// `src/config.mjs` resolves CONFIG_DIR from JEV_APPLY_HOME at import time, so the bench home has
// to be in the environment before the first `import` of a module that touches it — hence the
// dynamic imports below. This is what keeps the smoke's traces and screenshots out of the user's
// own store even when it is run with a bare `node scripts/submit-smoke.mjs`.

function parseArgs(argv) {
  const out = {
    port: Number(process.env.JEV_CHROME_PORT) || 9224,
    home: process.env.JEV_APPLY_HOME || "/tmp/jev-bench",
    profileDir: null,
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--home") out.home = argv[++i];
    else if (a === "--profile") out.profileDir = argv[++i];
    else if (a === "--keep") out.keep = true;
    else throw new Error(`unknown flag ${a}`);
  }
  out.home = path.resolve(out.home);
  out.profileDir ??= path.join(out.home, "profile");
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.home === path.join(homedir(), ".config", "jev-apply")) {
  process.stderr.write("refusing to run against the real private store — pass --home /tmp/jev-bench\n");
  process.exit(1);
}
process.env.JEV_APPLY_HOME = args.home;

const { REPO_ROOT } = await import("../src/config.mjs");
const generic = await import("../src/browser/adapters/generic.mjs");
const greenhouse = await import("../src/browser/adapters/greenhouse.mjs");
const ashby = await import("../src/browser/adapters/ashby.mjs");
const { connect, disconnect, openTab } = await import("../src/browser/chrome.mjs");
const { autoSubmitOn, matchLiveControls, priorSubmit, submitApplication, submitOutcome, submitReadiness } = await import("../src/plan/execute.mjs");
const { appendTrace, maskSelectors, traceDir } = await import("../src/browser/trace.mjs");
const { renderSummary } = await import("../src/plan/summary.mjs");

const FORM = pathToFileURL(path.join(REPO_ROOT, "eval", "fixtures", "submit-form.html")).href;
const THANKS = pathToFileURL(path.join(REPO_ROOT, "eval", "fixtures", "submit-thanks.html")).href;
const SLUG = "fixture-submit-smoke";

/** The invented candidate, as FormPlan questions — nobody's real name, nobody's real address. */
const FIELDS = [
  { qid: "first_name", selector: "#first_name", label: "First Name", type: "text", control: "text", class: "identity", required: true, value: "Robin" },
  { qid: "last_name", selector: "#last_name", label: "Last Name", type: "text", control: "text", class: "identity", required: true, value: "Sanchez" },
  { qid: "email", selector: "#email", label: "Email", type: "text", control: "text", class: "identity", required: true, value: "robin@bench.invalid" },
  { qid: "question_90001", selector: "#question_90001", label: "Why do you want to work here?", type: "textarea", control: "textarea", class: "why_us", required: false, value: "Because this form is a fixture." },
];

const formPlan = { ats: null, url: FORM, job: { company: "Fixture Corp", title: "Senior Fixture Engineer" }, questions: FIELDS };

let failures = 0;
const checks = [];

function check(label, ok, detail = "") {
  checks.push({ label, ok: ok === true, ...(detail ? { detail } : {}) });
  if (ok !== true) failures += 1;
  process.stdout.write(`${ok === true ? "ok  " : "FAIL"} - ${label}${detail ? ` — ${detail}` : ""}\n`);
}

/** Fill the form the way the executor does: one field at a time, each one read back. */
async function fillForm(page) {
  const results = [];
  for (const q of FIELDS) {
    const result = await generic.setField(page, q, q.value, { trace: SLUG });
    results.push({ qid: q.qid, ok: result.ok === true, observed: result.observed });
  }
  return results;
}

/** One fixture variant, end to end: open, fill, submit, and report what the runner concluded. */
async function runCase({ context, name, url }) {
  const page = await openTab(context, url, { reuse: false });
  await generic.waitForForm(page, { timeout: 15000 });
  const filled = await fillForm(page);
  const result = await submitApplication({ page, ats: null, formPlan: { ...formPlan, url }, slug: SLUG });
  const outcome = submitOutcome(result);
  const landed = page.url();
  const title = await page.title().catch(() => "");
  return { name, page, filled, result, outcome, landed, title };
}

async function main() {
  const { browser, context, endpoint, spawned, version } = await connect({ port: args.port, profileDir: args.profileDir });
  process.stdout.write(
    `connect  ${endpoint} port=${args.port} spawned=${spawned} home=${args.home} chrome=${JSON.stringify(version?.Browser ?? "?")}\n`,
  );
  const opened = [];
  const cases = {};

  try {
    // ── 1. the happy path: filled, clicked, confirmed ─────────────────────────────────────────
    const ok = await runCase({ context, name: "submitted", url: FORM });
    opened.push(ok.page);
    cases.submitted = {
      status: ok.outcome.status,
      confirmation: ok.result.confirmation,
      captcha: ok.result.captcha,
      selector: ok.result.selector,
      ms: ok.result.ms,
    };
    check("fixture: every field filled and read back", ok.filled.every((f) => f.ok), ok.filled.filter((f) => !f.ok).map((f) => f.qid).join(", "));
    check("submit: the application form was submitted", ok.result.ok === true, ok.result.detail ?? "");
    check('submit: status is "submitted"', ok.outcome.status === "submitted", ok.outcome.status);
    check("submit: the thank-you page was detected", ok.result.confirmation?.detected === true, ok.result.confirmation?.strategy ?? "");
    check("submit: the confirmation screenshot is on disk", Boolean(ok.result.confirmation?.screenshot) && existsSync(ok.result.confirmation.screenshot), ok.result.confirmation?.screenshot ?? "none");
    check("submit: the browser landed on the confirmation page", ok.landed.endsWith("submit-thanks.html"), ok.landed);
    check("submit: the newsletter form was never submitted", !/SUBSCRIBED/.test(ok.title), ok.title);
    check("submit: waited for the lazily injected captcha script", ok.result.captcha?.referenced === true && ok.result.captcha?.ready === true, `waited ${ok.result.captcha?.waited_ms ?? "?"}ms`);

    // ── 2. an error banner is never a success ─────────────────────────────────────────────────
    const banner = await runCase({ context, name: "error_banner", url: `${FORM}?fail=banner` });
    opened.push(banner.page);
    cases.error_banner = { status: banner.outcome.status, reason: banner.outcome.reason, cause: banner.result.cause, detail: banner.result.detail, screenshot: banner.outcome.screenshot ?? null };
    check("error banner: not reported as submitted", banner.result.ok === false, String(banner.result.ok));
    check('error banner: status is blocked{submit_failed}', banner.outcome.status === "blocked" && banner.outcome.reason === "submit_failed", `${banner.outcome.status}{${banner.outcome.reason}}`);
    check("error banner: the banner is what stopped it", banner.result.cause === "error_banner", banner.result.cause);
    check("error banner: the failure was photographed", Boolean(banner.outcome.screenshot) && existsSync(banner.outcome.screenshot), banner.outcome.screenshot ?? "none");
    check("error banner: the tab is still on the form", banner.landed.includes("submit-form.html"), banner.landed);

    // ── 3. a captcha challenge is never a success ─────────────────────────────────────────────
    const captcha = await runCase({ context, name: "captcha_challenge", url: `${FORM}?fail=captcha` });
    opened.push(captcha.page);
    cases.captcha_challenge = { status: captcha.outcome.status, reason: captcha.outcome.reason, cause: captcha.result.cause, screenshot: captcha.outcome.screenshot ?? null };
    check("captcha: status is blocked{submit_failed}", captcha.outcome.status === "blocked" && captcha.outcome.reason === "submit_failed", `${captcha.outcome.status}{${captcha.outcome.reason}}`);
    check("captcha: the challenge is what stopped it", captcha.result.cause === "captcha_challenge", captcha.result.cause);

    // ── 4. detection only: the right button, by every adapter's own rules, with no click ──────
    // The happy-path tab has navigated to the confirmation, so detection needs a fresh form.
    const fresh = await openTab(context, FORM, { reuse: false });
    opened.push(fresh);
    await generic.waitForForm(fresh, { timeout: 15000 });
    const found = {
      generic: await generic.findSubmit(fresh),
      greenhouse: await greenhouse.findSubmit(fresh),
      ashby: await ashby.findSubmit(fresh),
    };
    cases.find_submit = found;
    for (const [name, hit] of Object.entries(found)) {
      check(`${name}: finds the application form's Submit button`, hit?.selector === "#submit_app", `${hit?.selector ?? "none"} "${hit?.text ?? ""}" (${hit?.found_by ?? hit?.strategy ?? ""})`);
    }
    check("detection clicked nothing", (await fresh.title()) === "jev-apply submit fixture — application form" && fresh.url().endsWith("submit-form.html"), fresh.url());

    // ── 5. the confirmation page, read by all three adapters ──────────────────────────────────
    const thanks = await openTab(context, THANKS, { reuse: false });
    opened.push(thanks);
    const confirmed = {
      generic: await generic.confirmSubmitted(thanks),
      greenhouse: await greenhouse.confirmSubmitted(thanks),
      ashby: await ashby.confirmSubmitted(thanks),
    };
    cases.confirm = Object.fromEntries(Object.entries(confirmed).map(([k, v]) => [k, { detected: v.detected, strategy: v.strategy ?? null }]));
    for (const [name, verdict] of Object.entries(confirmed)) {
      check(`${name}: recognises the confirmation page`, verdict.detected === true, verdict.strategy ?? verdict.reason ?? "");
    }
    // The same rules must *not* fire on the form itself, or every run would report success.
    const notYet = await generic.confirmSubmitted(fresh);
    check("generic: the form page is not a confirmation", notYet.detected === false, notYet.strategy ?? "");

    // ── 6. the readiness gate (pure) ──────────────────────────────────────────────────────────
    const empty = { unfilled: [], unknown: [] };
    check("readiness: an open question blocks the click", submitReadiness({ decisions: [{ action: "ask" }], state: empty }).ready === false);
    check("readiness: a required control still empty blocks the click", submitReadiness({ decisions: [{ action: "fill" }], state: { unfilled: [{}], unknown: [] } }).ready === false);
    check("readiness: a finished form is clickable", submitReadiness({ decisions: [{ action: "fill" }], state: empty }).ready === true);

    // ── 7. the preference gate (pure): nothing but an explicit yes may click ──────────────────
    const yes = [true, "yes", "Yes", "true", "on", "1", { value: "yes" }, { answer: true }];
    const no = [undefined, null, "", false, "no", "No", "false", "0", "maybe", "later", {}, { value: "no" }];
    check(`p.auto_submit: every explicit yes reads as on (${yes.length} forms)`, yes.every((v) => autoSubmitOn(v) === true), yes.filter((v) => autoSubmitOn(v) !== true).map((v) => JSON.stringify(v)).join(", "));
    check(`p.auto_submit: everything else reads as off (${no.length} forms, incl. absent)`, no.every((v) => autoSubmitOn(v) === false), no.filter((v) => autoSubmitOn(v) !== false).map((v) => JSON.stringify(v)).join(", "));

    // ── 8. the live demographic block's matching rule (pure) ──────────────────────────────────
    // The Greenhouse case Eeo measured: `#hispanic_ethnicity` is on no schema row, `#race` has a
    // row whose control was not in the DOM when the fill loop reached it, `#gender` is done.
    const liveRows = [
      { qid: "gender", label: "Gender", selector: "#gender", control: "react_select", multiple: false },
      { qid: "hispanic_ethnicity", label: "Are you Hispanic/Latino?", selector: "#hispanic_ethnicity", control: "react_select", multiple: false },
      { qid: "race", label: "Race", selector: "#race", control: "react_select", multiple: false },
      { qid: "4012865007", label: "How would you describe your gender identity?", selector: "#4012865007", control: "react_select", multiple: true },
      { qid: "veteran_status", label: "Veteran Status", selector: "#veteran_status", control: "react_select", multiple: false },
    ];
    const liveQuestions = [
      { qid: "gender", label: "Gender", class: "sensitive" },
      { qid: "race", label: "Race", class: "sensitive" },
      { qid: "demographic_4012865007", label: "How would you describe your gender identity?", class: "sensitive" },
      { qid: "veteran_status", label: "Veteran Status", class: "sensitive" },
    ];
    const liveDecisions = [
      { qid: "gender", action: "fill", value: "Male", readback: { ok: true } },
      { qid: "race", action: "ask", value: "White", why: "the form has no control for this question" },
      { qid: "demographic_4012865007", action: "fill", option: "Man", readback: { ok: true } },
      { qid: "veteran_status", action: "ask", why: "no p.eeo answer for this one" },
    ];
    const matched = matchLiveControls(liveRows, { questions: liveQuestions, decisions: liveDecisions });
    cases.live_sensitive = { retry: matched.retry.map((r) => r.decision.qid), novel: matched.novel.map((q) => q.qid) };
    check("live EEO: a control with no schema row becomes a new question", matched.novel.length === 1 && matched.novel[0].qid === "hispanic_ethnicity", matched.novel.map((q) => q.qid).join(", "));
    check("live EEO: the new question is sensitive and keeps the page's control", matched.novel[0]?.class === "sensitive" && matched.novel[0]?.selector === "#hispanic_ethnicity");
    check("live EEO: a row that mounted late is retried with its resolved answer", matched.retry.length === 1 && matched.retry[0].decision.qid === "race", matched.retry.map((r) => r.decision.qid).join(", "));
    check("live EEO: an already read-back row is left alone", !matched.retry.some((r) => r.decision.qid === "gender") && !matched.novel.some((q) => q.qid === "gender"));
    check("live EEO: `demographic_<id>` and the DOM's `<id>` are the same row", !matched.novel.some((q) => q.qid === "4012865007"));
    check("live EEO: a row memory cannot answer stays the user's question", !matched.retry.some((r) => r.decision.qid === "veteran_status") && !matched.novel.some((q) => q.qid === "veteran_status"));

    // ── 9. the double-submit guard: a click on record is never repeated ───────────────────────
    // The case that matters is the crash: a run killed during the 45 s confirmation wait never
    // reaches settle(), so decisions.json says nothing and only the pre-click trace row knows.
    const scratch = [];
    const guard = async (rows, frozen = null) => {
      const slug = `fixture-guard-${Math.random().toString(36).slice(2, 8)}`;
      scratch.push(slug);
      if (rows.length) for (const row of rows) await appendTrace(slug, row);
      return priorSubmit(slug, frozen);
    };
    const afterCrash = await guard([{ op: "submit", stage: "attempt", selector: "#submit_app" }]);
    check("guard: a pre-click trace row alone refuses a second click", afterCrash.attempted === true && afterCrash.confirmed === false, afterCrash.sources.join(" + "));
    const afterConfirmed = await guard([{ op: "submit", stage: "attempt" }, { op: "submit", ok: true, clicked: true }]);
    check("guard: a confirmed submit is remembered as confirmed", afterConfirmed.attempted === true && afterConfirmed.confirmed === true);
    const afterNotFound = await guard([{ op: "submit", ok: false, clicked: false, cause: "submit_not_found" }]);
    check("guard: a failure that never reached the button stays retryable", afterNotFound.attempted === false, JSON.stringify(afterNotFound));
    const afterFills = await guard([{ op: "set", qid: "first_name", ok: true }]);
    check("guard: an ordinary fill is not a submit", afterFills.attempted === false);
    const frozenOnly = await guard([], { submit_attempted: true });
    check("guard: the frozen record alone also refuses", frozenOnly.attempted === true && frozenOnly.sources.includes("decisions.json"));
    const clean = await guard([]);
    check("guard: a posting with no submit on record is clickable", clean.attempted === false && clean.sources.length === 0);

    // ── 10. the summary's EEO line: counts, never values ──────────────────────────────────────
    const eeoDecisions = [
      { qid: "first_name", label: "First Name", action: "fill", source: "fact", value: "Robin" },
      ...["gender", "race", "veteran_status", "disability_status"].map((qid) => ({ qid, label: qid, class: "sensitive", action: "fill", source: "preference", option: "Prefer not to say", value: "Prefer not to say" })),
      { qid: "ancestry", label: "Ancestry", class: "sensitive", action: "ask", why: "this form splits your saved race into 3 answers" },
    ];
    const eeoSummary = renderSummary({
      formPlan: { url: "https://job-boards.greenhouse.io/acme/jobs/1", job: { company: "Acme", title: "Engineer" } },
      decisions: eeoDecisions,
      slug: "acme-1",
      status: "needs_user",
    });
    const eeoLine = eeoSummary.split("\n").find((l) => l.includes("EEO")) ?? "";
    cases.eeo_line = eeoLine.trim();
    check("summary: filled demographic rows get a counted EEO line", /EEO\s+4 of 5 answered/.test(eeoLine), eeoLine.trim());
    check("summary: the EEO line says how many are still the user's", /1 left for you/.test(eeoLine));
    check("summary: no demographic value is printed anywhere in the summary", !/Prefer not to say/.test(eeoSummary), eeoSummary.split("\n").filter((l) => /Prefer not to say/.test(l)).join(" | "));
    check("readiness: an open demographic row is counted, never subtracted", (() => {
      const r = submitReadiness({ decisions: eeoDecisions, state: { unfilled: [], unknown: [] } });
      return r.ready === false && r.asks === 1 && r.sensitive === 1;
    })());

    // ── 11. the receipt's mask: submitted.png is the one photo taken of a *filled* form ───────
    // A board that confirms in place (Ashby) leaves the answered demographic block under the
    // receipt, and a react-select's own `selector` is a 3px hidden input — painting that over
    // hides nothing while the committed text beside it stays readable (measured by Eeo on the
    // live board). `submittedShot` masks with exactly this list, so the wrappers have to be in it.
    const maskPlan = { questions: [{ qid: "gender", class: "sensitive", selector: "#gender" }, { qid: "first_name", class: "identity", selector: "#first_name" }] };
    const masks = maskSelectors(maskPlan);
    cases.receipt_mask = masks;
    check("receipt: the demographic control's rendered wrapper is masked, not just its input", masks.some((m) => /^\.select-shell:has\(#gender\)$/.test(m)) && masks.includes("#gender"), masks.join(" "));
    check("receipt: a non-sensitive control is never masked", !masks.some((m) => m.includes("#first_name")), masks.filter((m) => m.includes("first_name")).join(" "));
    cases.guard = { after_crash: afterCrash, after_not_found: afterNotFound };
    // The guard reads real files, so it writes real ones; they are throwaway and go straight away.
    for (const slug of scratch) await rm(traceDir(slug), { recursive: true, force: true });
  } finally {
    if (!args.keep) for (const page of opened) await page.close().catch(() => {});
    await disconnect(browser, { port: args.port });
  }

  const passed = checks.filter((c) => c.ok).length;
  process.stdout.write(`\nRESULT   ${failures ? "FAIL" : "PASS"} ${passed}/${checks.length} checks · trace ${path.join(traceDir(SLUG), "trace.jsonl")}\n`);
  process.stdout.write(`${JSON.stringify({ status: failures ? "failed" : "ok", checks: checks.length, failures, cases }, null, 1)}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.stdout.write(`RESULT FAIL ${JSON.stringify(String(err.message ?? err))}\n`);
  process.exit(1);
});
