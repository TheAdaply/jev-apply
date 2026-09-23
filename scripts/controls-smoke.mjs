#!/usr/bin/env node
// Control coverage check for `src/browser/controls.mjs` (PLAN §2.2 step 8, risk 6).
//
//   node scripts/controls-smoke.mjs [--port 9224] [--profile DIR] [--keep]
//
// Opens `eval/fixtures/controls.html` and drives every control kind the ladder claims to handle,
// three times each:
//
//   1. the WRONG value on an empty control: refused (`ok:false`), and nothing committed. This is
//      the option-0 test — a menu that filtered down to nothing, or a vocabulary with no entry for
//      the answer, must leave the control exactly as empty as it found it.
//   2. the CORRECT value: accepted (`ok:true`) and read back.
//   3. the WRONG value again, now over a committed answer: still refused, and the committed text
//      byte-identical. That is the ladder's "never clear a committed value on failure" rule, the
//      same property `browser-smoke.mjs` asserts against the live Greenhouse react-select.
//
// Nothing here is a unit test of the fixture: every assertion is the adapter contract, and every
// committed value is read straight off the DOM, never from the adapter's own report.
//
// The browser is isolated from the user's by construction — its own profile directory and port
// 9224, never the 9223 profile real applications are filled in. `--profile /tmp/jev-bench/profile`
// shares the bench browser.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "../src/config.mjs";
import * as generic from "../src/browser/adapters/generic.mjs";
import { detectControl } from "../src/browser/controls.mjs";
import { connect, disconnect, openTab } from "../src/browser/chrome.mjs";
import { norm } from "../src/browser/readback.mjs";

const FIXTURE = pathToFileURL(path.join(REPO_ROOT, "eval", "fixtures", "controls.html")).href;
/** Never `paths.profile`: that is the profile the user's real applications are filled in. */
const BENCH_PROFILE = "/tmp/jev-controls-smoke/profile";

function parseArgs(argv) {
  const out = {
    port: Number(process.env.JEV_CHROME_PORT) || 9224,
    profileDir: process.env.JEV_APPLY_HOME ? path.join(process.env.JEV_APPLY_HOME, "profile") : BENCH_PROFILE,
    keep: false,
    url: FIXTURE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--profile") out.profileDir = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--keep") out.keep = true;
    else throw new Error(`unknown flag ${a}`);
  }
  return out;
}

/**
 * One row per control. `q` is the FormPlan question as the planner would produce it — including a
 * deliberately stale `control` on the rows where the schema's guess is wrong, so detection has
 * something to override. `read` returns the control's committed state straight from the DOM.
 */
const ROWS = [
  {
    name: "text",
    q: { qid: "text_name", selector: "#text_name", control: "text", label: "Full name", class: "identity" },
    good: "Jane Doe",
    bad: "Jane Doe Of The Very Long Name",
    maxlength: 10,
    read: (page) => page.$eval("#text_name", (el) => el.value),
  },
  {
    name: "textarea",
    q: { qid: "text_about", selector: "#text_about", control: "text", label: "Short note", class: "optional_text" },
    good: "Short and within the limit.",
    bad: "A note that runs well past the forty character limit this field enforces.",
    maxlength: 40,
    read: (page) => page.$eval("#text_about", (el) => el.value),
  },
  {
    name: "native_select",
    q: {
      qid: "native_role",
      selector: "#native_role",
      control: "react_select", // the schema guessed wrong; the DOM is a <select>
      label: "Team",
      class: "circumstance",
      options: [{ label: "Research Engineer", value: "research" }],
    },
    good: "research", // answered by option *value*: rung 2 of the native-select ladder
    bad: "Astronaut",
    read: (page) => page.$eval("#native_role", (el) => (el.selectedIndex > 0 ? el.options[el.selectedIndex].text : "")),
  },
  {
    name: "react_select",
    q: { qid: "rs_input", selector: "#rs_input", control: "react_select", label: "Preferred role", class: "circumstance" },
    good: "Inference Engineer",
    bad: "Astronaut",
    read: (page) => page.$eval(".select-shell[data-widget=single] .select__single-value", (el) => (el.hidden ? "" : el.textContent)),
  },
  {
    name: "multi_select",
    q: { qid: "multi_input", selector: "#multi_input", control: "react_select", type: "multi_select", label: "Languages", class: "circumstance" },
    good: "Python | Rust",
    bad: "COBOL | Fortran",
    read: (page) =>
      page.$$eval("#multi_values .select__multi-value__label", (els) => els.map((e) => e.textContent).join(" | ")),
  },
  {
    // The Figma shape: the schema calls a `multi_value_multi_select` a checkbox group, the board
    // renders a multi-value react-select, and the id it is addressed by carries the `[]`.
    name: "multi_planned_cb",
    q: {
      qid: "multi_plan[]",
      selector: '[id="multi_plan[]"]',
      control: "checkbox",
      type: "multi_select",
      label: "Which languages do you use professionally",
      class: "circumstance",
    },
    good: "Python | Rust",
    bad: "COBOL | Fortran",
    read: (page) =>
      page.$$eval("#multi_plan_values .select__multi-value__label", (els) => els.map((e) => e.textContent).join(" | ")),
  },
  {
    name: "combobox",
    q: { qid: "combo_input", selector: "#combo_input", control: "text", label: "How did you hear about us", class: "circumstance" },
    good: "Hacker News",
    bad: "Skywriting",
    read: (page) => page.$eval("#combo_input", (el) => el.value),
  },
  {
    name: "location",
    q: { qid: "location", selector: "#location", control: "react_select", label: "Where are you based", class: "identity" },
    good: "Lyon, France", // "Lyon" is below the geocoder's minimum: the ladder must retry qualified
    bad: "Atlantis, Oceania",
    read: (page) => page.$eval("#location", (el) => el.value),
  },
  {
    // Ashby's geocoder: a country-only index, and an input with no id, no name and no label of
    // its own — the field's `label[for="<data-field-path>"]` is the only thing that says "place".
    name: "location_country",
    q: {
      qid: "geo_country",
      selector: '[data-field-path="geo_country"] [class*="ashby-application-form-input"]',
      control: "react_select",
      label: "Location",
      class: "identity",
    },
    good: "Lisbon, Portugal", // the city is not in the index; the country the answer names is
    bad: "Atlantis, Oceania",
    read: (page) => page.$eval('[data-field-path="geo_country"] input', (el) => el.value),
  },
  {
    name: "radio",
    q: { qid: "field_shift", selector: "#field_shift", control: "radio", label: "Which shift do you prefer?", class: "circumstance" },
    good: "Weekends",
    bad: "Whenever",
    read: (page) =>
      page.$eval("#field_shift", (el) => {
        const on = el.querySelector("input[type=radio]:checked");
        return on ? (document.querySelector(`label[for="${on.id}"]`)?.textContent ?? "").trim() : "";
      }),
  },
  {
    name: "checkbox_group",
    q: { qid: "field_langs", selector: "#field_langs", control: "checkbox", label: "Which do you know?", class: "circumstance" },
    good: "Python | Rust",
    bad: "COBOL | Fortran",
    read: (page) =>
      page.$$eval("#field_langs input:checked", (els) =>
        els.map((e) => (document.querySelector(`label[for="${e.id}"]`)?.textContent ?? "").trim()).join(" | "),
      ),
  },
  {
    // Ashby's MultiValueSelect (N2). Nothing the members share identifies the group — every box
    // is named after its own option — so a field that publishes five options must not be driven
    // as a Boolean. Two values are selected here because the failure mode lost *all* of them:
    // `not_boolean`, nothing ticked, the row handed back as an `ask`.
    name: "checkbox_group_ashby",
    q: {
      qid: "cb_communities",
      selector: '[data-field-path="cb_communities"]',
      // What src/schema/ashby.mjs publishes for a MultiValueSelect — the stale guess detection
      // has to override, and the shape the Boolean rung used to claim.
      control: "checkbox",
      type: "multi_select",
      label: "Which of the following communities do you belong to?",
      class: "circumstance",
      options: [
        { label: "Neurodiverse", value: "Neurodiverse" },
        { label: "Parent", value: "Parent" },
        { label: "Veteran", value: "Veteran" },
        { label: "Refugee or immigrant", value: "Refugee or immigrant" },
        { label: "I prefer not to answer", value: "I prefer not to answer" },
      ],
    },
    good: "Neurodiverse | Veteran",
    bad: "Astronaut | Submariner",
    read: (page) =>
      page.$$eval('[data-field-path="cb_communities"] input:checked', (els) =>
        els.map((e) => (document.querySelector(`label[for="${e.id}"]`)?.textContent ?? "").trim()).join(" | "),
      ),
  },
  {
    name: "checkbox",
    q: { qid: "agree", selector: "#agree", control: "checkbox", label: "I agree to the terms", class: "policy_gate" },
    good: "Yes",
    bad: "Maybe",
    read: (page) => page.$eval("#agree", (el) => (el.checked ? "yes" : "")),
  },
  {
    // Cloudflare's and 1Password's acknowledgement: a one-option multi-select wearing a single
    // checkbox. The planner answers it with the option's `value`, never with "yes".
    name: "checkbox_1option",
    q: {
      qid: "ack_privacy[]",
      selector: '[id="ack_privacy[]"]',
      control: "checkbox",
      type: "multi_select",
      label: "Acknowledge/Confirm",
      class: "policy_gate",
      options: [{ label: "Please review and acknowledge our Candidate Privacy Policy", value: "751204582" }],
    },
    good: "751204582",
    bad: "Maybe",
    read: (page) => page.$eval("#ack_privacy_1", (el) => (el.checked ? "checked" : "")),
  },
  {
    name: "date",
    q: { qid: "start_date", selector: "#start_date", control: "text", label: "Earliest start", class: "circumstance" },
    good: "2027-03-14",
    bad: "sometime next spring",
    read: (page) => page.$eval("#start_date", (el) => el.value),
  },
  {
    name: "date_native",
    q: { qid: "iso_date", selector: "#iso_date", control: "date", label: "Graduation date", class: "circumstance" },
    good: "2024-06-30",
    bad: "next spring",
    read: (page) => page.$eval("#iso_date", (el) => el.value),
  },
  {
    // Ashby's date control (§2 item 5). The row carries no `type: "date"` on purpose: the plan's
    // own field type is not always there to rescue it (a replan writes the *detected* control
    // back onto the question), so detection has to recognise the widget from the element alone.
    // The wrong value is the exact sentence that was committed into the live one.
    name: "date_ashby",
    q: {
      qid: "ashby_start",
      selector: '[data-field-path="ashby_start"] input',
      control: "text",
      label: "What is your earliest possible/desired start date?",
      class: "circumstance",
    },
    good: "2027-03-14",
    bad: "Available immediately",
    read: (page) => page.$eval('[data-field-path="ashby_start"] input', (el) => el.value),
  },
  {
    name: "number",
    q: { qid: "years", selector: "#years", control: "text", label: "Years of experience", class: "circumstance" },
    good: "7",
    bad: "quite a few",
    read: (page) => page.$eval("#years", (el) => el.value),
  },
  {
    name: "tel",
    q: { qid: "phone", selector: "#phone", control: "tel", label: "Phone", class: "identity", country: "Germany" },
    badQ: { country: "Atlantis" }, // a number under the wrong dial code is the wrong number
    good: "+49 30 5550123",
    bad: "+49 30 5550123",
    read: (page) => page.$eval("#phone_country", (el) => (el.selectedIndex > 0 ? el.options[el.selectedIndex].text : "")),
  },
  {
    name: "unknown",
    q: { qid: "submit", selector: "#submit", control: "text", label: "Submit application", class: "optional_text" },
    good: null, // a <button> takes no value at all: both directions must report unknown_control
    bad: "anything",
    read: () => "",
  },
];

const tick = (ok) => (ok ? "ok" : "FAIL");
/**
 * `attemptSet` turns a thrown error into `{ok:false, reason:"error: …"}`, which is indistinguishable
 * from a deliberate refusal unless you look — a `verify is not defined` bug passed as "wrong value
 * correctly refused" once already this session. A refusal caused by a programmer error is a FAIL.
 */
const refusal = (r) => r.ok === false && !/^error:/.test(String(r.reason ?? ""));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { browser, context, endpoint, spawned, version } = await connect({ port: args.port, profileDir: args.profileDir });
  process.stdout.write(
    `connect  ${endpoint} port=${args.port} spawned=${spawned}${spawned ? ` profile=${args.profileDir}` : " (attached to the browser already on this port)"} chrome=${JSON.stringify(version?.Browser ?? "?")}\n`,
  );

  const page = await openTab(context, args.url, { reuse: false });
  await generic.waitForForm(page, { timeout: 15000 });
  const lines = [];
  let pass = true;

  const committed = async (row) => norm(await Promise.resolve(row.read(page)).catch(() => ""));

  for (const row of ROWS) {
    const started = Date.now();
    const detected = await detectControl(page, row.q.selector, { question: row.q });
    const badQ = { ...row.q, ...(row.badQ ?? {}) };

    // Phase 1 — wrong value on an empty control: refused, and nothing committed. The option-0 test.
    const bad = await generic.setField(page, badQ, row.bad, { trace: null });
    const afterBad = await committed(row);

    // Phase 2 — correct value: accepted and read back.
    let good = { ok: false, observed: "", reason: "not_attempted" };
    let afterGood = afterBad;
    if (row.good !== null) {
      good = await generic.setField(page, row.q, row.good, { trace: null });
      afterGood = await committed(row);
    }

    // Phase 3 — the same wrong value over a *committed* answer: still refused, and the committed
    // text byte-identical. This is the ladder's "never clear a committed value on failure" rule,
    // and it only exists as a test here (browser-smoke asserts the same thing on the live board).
    let again = null;
    let afterAgain = afterGood;
    if (row.good !== null && !row.maxlength) {
      again = await generic.setField(page, badQ, row.bad, { trace: null });
      afterAgain = await committed(row);
    }

    const refused = refusal(bad);
    // A vocabulary control must hold nothing after a refused value. A free-text field has no
    // vocabulary to fall back to: the only write it may keep is the truncation its own
    // `maxlength` performed, which is exactly what made the write fail.
    const noFallback = afterBad === "" || (row.maxlength ? afterBad === norm(String(row.bad)).slice(0, row.maxlength) : false);
    const accepted = row.good === null ? bad.reason === "unknown_control" : good.ok === true && afterGood !== "";
    const kept = again === null ? true : refusal(again) && afterAgain === afterGood && afterGood !== "";
    const rowOk = refused && noFallback && accepted && kept;
    pass = pass && rowOk;

    lines.push({
      control: detected.control,
      field: row.name,
      correct: row.good === null ? "n/a" : tick(good.ok === true),
      wrong: tick(refused),
      empty: tick(noFallback),
      kept: again === null ? "n/a" : tick(kept),
      reason: bad.reason ?? "",
      ms: Date.now() - started,
      rowOk,
      planned: detected.agreed ? "" : detected.planned,
    });
  }

  // A one-option multi-select declined. "No" is an answer to a pick-many row, not a failure to
  // set one: nothing is selected, nothing is *un*selected, and the row is reported filled — the
  // optional marketing opt-in 1Password carries next to its required acknowledgement.
  const declineQ = {
    qid: "ack_news[]",
    selector: '[id="ack_news[]"]',
    control: "checkbox",
    type: "multi_select",
    label: "Stay in touch",
    class: "circumstance",
    options: [{ label: "Yes, tell me about future openings", value: "912" }],
  };
  const declined = await generic.setField(page, declineQ, "No", { trace: null });
  const declinedBox = await page.$eval("#ack_news_1", (el) => el.checked);
  const declineOk = declined.ok === true && declined.observed === "unchecked" && declinedBox === false;
  pass = pass && declineOk;

  const submitted = await page.evaluate(() => window.__submitted ?? 0);
  if (submitted !== 0) pass = false;

  const w = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
  process.stdout.write(
    `${w("control", 15)} ${w("field", 14)} ${w("correct", 8)} ${w("wrong=false", 11)} ${w("empty", 6)} ${w("kept", 5)} ${w("ms", 5)} refusal\n`,
  );
  for (const l of lines) {
    process.stdout.write(
      `${w(l.control, 15)} ${w(l.field, 14)} ${w(l.correct, 8)} ${w(l.wrong, 11)} ${w(l.empty, 6)} ${w(l.kept, 5)} ${w(l.ms, 5)} ${l.reason}\n`,
    );
  }
  const overrides = lines.filter((l) => l.planned);
  process.stdout.write(
    `decline  ${tick(declineOk)} one-option multi-select answered "No": ok=${declined.ok} observed=${JSON.stringify(declined.observed)} checked=${declinedBox}\n`,
  );
  process.stdout.write(`detect   ${lines.length} controls, ${overrides.length} overrode the plan: ${overrides.map((l) => `${l.field} ${l.planned}→${l.control}`).join(", ")}\n`);
  process.stdout.write(`RESULT   ${pass ? "PASS" : "FAIL"} ${lines.filter((l) => l.rowOk).length}/${lines.length} controls · submit_clicks=${submitted}\n`);

  if (!args.keep) await page.close().catch(() => {});
  await disconnect(browser, { port: args.port });
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.stdout.write(`RESULT FAIL ${JSON.stringify(String(err.message ?? err))}\n`);
  process.exit(1);
});
