#!/usr/bin/env node
// Phase B1/B2/B3 observable check for the browser layer (PLAN §4, D12, risks 1/6/7).
//
//   node scripts/browser-smoke.mjs --url <posting> [--ats greenhouse|ashby]
//   node scripts/browser-smoke.mjs --url <posting> --attach-only
//
// The first run spawns (or attaches to) Chrome on the dedicated profile, fills the identity
// fields, exercises one select/radio *and* a deliberately non-matching value, uploads a résumé,
// prints `snapshotRequired`, then disconnects **without closing**. The second run proves the tab
// survived by re-attaching and reading the first name back. Submit is never clicked.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT, slugify } from "../src/config.mjs";
import { adapterFor, atsFromUrl, waitForForm } from "../src/browser/adapters/index.mjs";
import { DEFAULT_PORT, connect, disconnect, findTab, openTab } from "../src/browser/chrome.mjs";
import { byId, norm } from "../src/browser/readback.mjs";
import { tracePath } from "../src/browser/trace.mjs";

const FIRST = "Test";
const LAST = "User";
const EMAIL = "test@example.com";

function parseArgs(argv) {
  const out = { attachOnly: false, port: DEFAULT_PORT, pdf: path.join(REPO_ROOT, "eval", "fixtures", "blank.pdf") };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--ats") out.ats = argv[++i];
    else if (a === "--attach-only") out.attachOnly = true;
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--pdf") out.pdf = argv[++i];
    else if (a === "--slug") out.slug = argv[++i];
    else throw new Error(`unknown flag ${a}`);
  }
  if (!out.url) throw new Error("usage: browser-smoke.mjs --url <posting-url> [--ats greenhouse|ashby] [--attach-only]");
  out.ats = out.ats ?? atsFromUrl(out.url);
  if (!out.ats) throw new Error(`cannot tell the ATS from ${out.url}; pass --ats greenhouse|ashby`);
  out.slug = out.slug ?? `smoke-${slugify(new URL(out.url).hostname.split(".")[0] + "-" + new URL(out.url).pathname)}`.slice(0, 60);
  return out;
}

/** A 346-byte, one-page, structurally valid PDF — enough for an ATS résumé field. */
function ensureBlankPdf(file) {
  if (existsSync(file)) return file;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const startxref = body.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${body}${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`,
    "latin1",
  );
  return file;
}

const results = [];
function report(op, field, result) {
  results.push({ op, field, ok: result.ok, attempts: result.attempts, reason: result.reason ?? null });
  const observed = JSON.stringify(String(result.observed ?? "").slice(0, 56));
  const reason = result.reason ? ` reason=${result.reason}` : "";
  process.stdout.write(
    `${op.padEnd(8)} ${String(field).slice(0, 26).padEnd(26)} ok:${String(result.ok).padEnd(5)} ` +
      `attempts:${result.attempts} observed=${observed}${reason}\n`,
  );
}

function requiredLine(rows) {
  const empty = rows.filter((r) => !r.filled).map((r) => r.qid ?? r.label);
  return (
    `required ${rows.length} controls, ${rows.length - empty.length} filled` +
    (empty.length ? ` · empty: ${empty.slice(0, 6).join(", ")}${empty.length > 6 ? " …" : ""}` : "")
  );
}

/** Find the sponsorship/visa react-select on the live Greenhouse form by its label. */
async function greenhouseVisaSelect(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
    const selects = [...document.querySelectorAll("input.select__input")].map((el) => ({
      qid: el.id,
      required: el.getAttribute("aria-required") === "true",
      label: norm(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent ?? "").replace(/\s*\*$/, ""),
    }));
    return (
      selects.find((s) => s.required && /sponsor/i.test(s.label)) ??
      selects.find((s) => s.required && /(visa|authoriz)/i.test(s.label)) ??
      null
    );
  });
}

/** First non-EEO Boolean (Yes/No button pair) on the live Ashby form. */
async function ashbyBoolean(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
    for (const entry of document.querySelectorAll("div.ashby-application-form-field-entry")) {
      const p = entry.getAttribute("data-field-path") ?? "";
      if (/eeoc|gender|race|veteran|disability/i.test(p)) continue;
      if (!entry.querySelector("button[data-option]")) continue;
      return { qid: p, label: norm(entry.querySelector("label")?.textContent ?? "") };
    }
    return null;
  });
}

async function runGreenhouse(page, trace, pdf) {
  const gh = adapterFor("greenhouse");
  const text = (qid, cls = "identity") => ({ qid, control: "text", required: true, class: cls });

  report("set", "first_name", await gh.setField(page, text("first_name"), FIRST, { trace }));
  report("set", "last_name", await gh.setField(page, text("last_name"), LAST, { trace }));
  report("set", "email", await gh.setField(page, text("email"), EMAIL, { trace }));

  const visa = await greenhouseVisaSelect(page);
  let select = { ok: false, observed: "", attempts: 0, reason: "no_visa_select_found" };
  let wrong = { ok: true, observed: "", attempts: 0, reason: "not_attempted" };
  if (visa) {
    const q = { qid: visa.qid, label: visa.label, control: "react_select", required: true, class: "circumstance" };
    select = await gh.setField(page, q, "No", { trace });
    report("select", visa.qid, select);
    wrong = await gh.setField(page, q, "Maybe", { trace });
    report("select!", `${visa.qid} (Maybe)`, wrong);
  } else {
    report("select", "visa", select);
  }

  const upload = await gh.uploadFile(page, { qid: "resume", control: "file", required: false, class: "identity" }, pdf, { trace });
  report("upload", "resume", upload);
  process.stdout.write(`${requiredLine(await gh.snapshotRequired(page))}\n`);

  // The bad value must neither commit option 0 ("Yes, I will require … sponsorship") nor clear
  // what was already chosen: the read-back has to be byte-for-byte the committed answer.
  const unchanged = select.ok && norm(wrong.observed) === norm(select.observed);
  return { select, wrong, upload, negativeOk: wrong.ok === false && unchanged };
}

async function runAshby(page, context, trace, pdf) {
  const ab = adapterFor("ashby");
  const text = (qid, cls = "identity") => ({ qid, control: "text", required: true, class: cls });

  report("set", "name", await ab.setField(page, text("_systemfield_name"), `${FIRST} ${LAST}`, { trace }));
  report("set", "email", await ab.setField(page, text("_systemfield_email"), EMAIL, { trace }));

  const bool = await ashbyBoolean(page);
  let select = { ok: false, observed: "", attempts: 0, reason: "no_boolean_found" };
  let wrong = { ok: true, observed: "", attempts: 0, reason: "not_attempted" };
  if (bool) {
    const q = { qid: bool.qid, label: bool.label, control: "radio", required: true, class: "circumstance" };
    select = await ab.setField(page, q, "No", { trace });
    report("boolean", bool.qid.slice(0, 20), select);
    wrong = await ab.setField(page, q, "Maybe", { trace });
    report("boolean!", `${bool.qid.slice(0, 12)} (Maybe)`, wrong);
  } else {
    report("boolean", "work_auth", select);
  }

  const upload = await ab.uploadFile(page, { qid: "_systemfield_resume", control: "file", required: true, class: "identity" }, pdf, { trace });
  report("upload", "_systemfield_resume", upload);
  process.stdout.write(`${requiredLine(await ab.snapshotRequired(page))}\n`);

  // Real Ashby radio groups here are EEO-only, which the runner must not touch: prove the
  // `label[for$="-radio-N"]` path on the static replica instead.
  const fixture = `file://${path.join(REPO_ROOT, "eval", "fixtures", "ashby-radio.html")}`;
  const fx = await openTab(context, fixture, { reuse: false });
  const radio = await ab.setField(
    fx,
    { qid: "q_shift", label: "Which shift do you prefer?", control: "radio", required: true, class: "circumstance" },
    "Weekends",
    { trace },
  );
  report("radio", "fixture q_shift", radio);
  await fx.close().catch(() => {});

  const unchanged = select.ok && norm(wrong.observed) === norm(select.observed);
  return { select, wrong, upload, radio, negativeOk: wrong.ok === false && unchanged };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pdf = ensureBlankPdf(args.pdf);
  const { browser, context, endpoint, spawned, version } = await connect({ port: args.port });
  process.stdout.write(
    `connect  ${endpoint} spawned=${spawned} chrome=${JSON.stringify(version?.Browser ?? "unknown")}\n`,
  );

  let ok = false;
  let tabUrl = args.url;
  try {
    if (args.attachOnly) {
      const page = await findTab(context, args.url);
      if (!page) {
        report("attach", args.ats, { ok: false, observed: "", attempts: 1, reason: "tab_not_found" });
      } else {
        tabUrl = page.url();
        const field = args.ats === "greenhouse" ? "first_name" : "_systemfield_name";
        const expected = args.ats === "greenhouse" ? FIRST : `${FIRST} ${LAST}`;
        const observed = norm(await page.locator(byId(field)).first().inputValue({ timeout: 10000 }).catch(() => ""));
        ok = observed === expected;
        report("attach", field, { ok, observed, attempts: 1, reason: ok ? null : `expected ${JSON.stringify(expected)}` });
      }
    } else {
      const page = await openTab(context, args.url);
      tabUrl = page.url();
      // `load` fires before either ATS has rendered its form.
      const ready = await waitForForm(page).then(() => true).catch(() => false);
      process.stdout.write(`tab      ${tabUrl} form_ready=${ready}\n`);
      const out =
        args.ats === "greenhouse"
          ? await runGreenhouse(page, args.slug, pdf)
          : await runAshby(page, context, args.slug, pdf);
      const texts = results.filter((r) => r.op === "set");
      ok =
        texts.length >= 2 &&
        texts.every((r) => r.ok) &&
        out.select.ok === true &&
        out.upload.ok === true &&
        out.negativeOk === true &&
        (out.radio ? out.radio.ok === true : true);
    }
  } finally {
    const state = await disconnect(browser, { port: args.port });
    process.stdout.write(`disconnect chrome_alive=${state.chromeAlive} tab=${tabUrl}\n`);
    if (!state.chromeAlive) ok = false;
  }

  process.stdout.write(
    `RESULT ${JSON.stringify({ ats: args.ats, mode: args.attachOnly ? "attach-only" : "fill", ok, tab: tabUrl, trace: tracePath(args.slug), steps: results })}\n`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.stdout.write(`RESULT ${JSON.stringify({ ok: false, error: String(err.message ?? err) })}\n`);
  process.exit(1);
});
