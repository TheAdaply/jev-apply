#!/usr/bin/env node
// EEO control check on a live Greenhouse posting. This mutates a real form with invented
// demographic answers: use --live deliberately, never during a user's application or demo.
//
//   node scripts/eeo-smoke.mjs --live --url https://job-boards.greenhouse.io/<board>/jobs/<id>
//
// Uses a separate smoke Chrome profile, never ~/.config/jev-apply/profile. Reads back only
// the demographic rows and redacts values from stdout; Submit is never clicked. A CDP port
// already owned by a different profile is refused before any tab is opened.
//
// Why a dedicated check: the board asks this block in an order its own API does not describe.
// `#hispanic_ethnicity` has no schema row, and `#race` is not in the DOM until that question is
// answered (EEO-1 asks ethnicity first, race only when the answer is No), so the rows are read off
// the live page — `greenhouse.eeoControls()` — and re-read after every fill, which is how a
// control that mounts in response to an earlier answer gets filled at all.

import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { connect, disconnect, openTab } from "../src/browser/chrome.mjs";
import { loadFormPlan } from "../src/schema/index.mjs";
import { detectAts } from "../src/schema/normalize.mjs";
import { resolveForm } from "../src/plan/resolve.mjs";
import { paths } from "../src/config.mjs";
import * as greenhouse from "../src/browser/adapters/greenhouse.mjs";

const SMOKE_PROFILE = path.join(tmpdir(), "jev-apply-eeo-smoke", "profile");

class Blocked extends Error {}
async function isolatedProfile() {
  const canonical = (p) => realpath(p).catch(() => path.resolve(p));
  const smoke = await canonical(SMOKE_PROFILE);
  const userProfiles = [paths.profile, path.join(homedir(), ".config", "jev-apply", "profile")];
  for (const user of userProfiles) {
    if (smoke === (await canonical(user))) throw new Blocked("EEO smoke profile resolves to the user's application profile");
  }
  return SMOKE_PROFILE;
}


const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (line) => process.stderr.write(`${line}\n`);
const REDACTED = "<redacted:sensitive>";

/**
 * A synthetic demographic profile — not a person, and deliberately not the user's. Every one of
 * the five fields is exercised: two that the form spells differently from the stored token
 * (`female` → "Female" / "Woman", `white` → "White" / "White or European"), one the form asks in
 * its own yes/no question (`hispanic_latino`), and the standing `decline` stance for the survey
 * questions the five fields do not answer.
 */
const SYNTHETIC_EEO = Object.freeze({
  gender: "female",
  hispanic_latino: "no",
  race: "white",
  veteran_status: "veteran",
  disability_status: "yes",
  other_demographics: "decline",
});

const syntheticMemory = () => ({
  facts: [],
  preferences: [{ id: "p.eeo", value: { ...SYNTHETIC_EEO }, source: "user", updated: "2026-09-23" }],
  documents: [],
  answers: [],
  stories: [],
  drafts: [],
  corrections: [],
});

function parseArgs(argv) {
  const args = { url: null, port: 9224, schema: null, live: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i];
    else if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg === "--schema") args.schema = argv[++i];
    else if (arg === "--live") args.live = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Blocked(`unknown argument ${arg}`);
  }
  if (!args.help && !args.url) throw new Blocked("usage: eeo-smoke.mjs --live --url <posting> [--port 9224] [--schema <file>]");
  if (!args.help && !Number.isFinite(args.port)) throw new Blocked("--port must be a number");
  if (!args.help && !args.live) throw new Blocked("EEO smoke writes synthetic demographic values to a live form; pass --live to opt in");
  return args;
}

/**
 * The posting's schema, for the option lists the API does publish. Never fatal: the live page is
 * the authority either way, and a row with no published options is answered with the canonical
 * wording instead of the form's own.
 *
 * The two sides do not agree on ids — the normalizer files a demographic question as
 * `demographic_<id>` while the board renders `<id>` as the input's id — so the index is keyed by
 * the digits of the qid *and* by the question's own label.
 */
async function schemaOptions(source) {
  const indexKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  try {
    const plan = await loadFormPlan(source);
    const index = new Map();
    for (const q of (plan.questions ?? []).filter((q) => q.class === "sensitive")) {
      for (const key of [indexKey(q.qid), indexKey(q.qid).replace(/^demographic/, ""), indexKey(q.label)]) {
        if (key && !index.has(key)) index.set(key, q);
      }
    }
    return { job: plan.job ?? {}, find: (live) => index.get(indexKey(live.qid)) ?? index.get(indexKey(live.label)) ?? null };
  } catch (err) {
    log(`schema unavailable (${String(err.message).split("\n")[0].slice(0, 80)}) — live options only`);
    return { job: {}, find: () => null };
  }
}

/** Live control + whatever the schema knows about it → one FormPlan question. */
const asQuestion = (live, schema) => ({
  qid: live.qid,
  label: live.label || schema?.label || live.qid,
  section: live.section || schema?.section || null,
  required: schema?.required ?? false,
  type: live.multiple ? "multi_select" : "single_select",
  control: live.control,
  selector: live.selector,
  class: "sensitive",
  ...(schema?.options?.length ? { options: schema.options } : {}),
});

/**
 * Did the control come back holding exactly what we set? Compared here, never printed.
 * Equality only: a substring test would pass "No" against "I am not a protected veteran", which
 * is the wrong demographic answer reported as a success.
 */
function committed(observed, intended) {
  const norm = (s) =>
    String(s ?? "")
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const want = norm(intended);
  const got = norm(observed);
  if (!want || !got) return false;
  // A multi-select reads back as its chips joined with " | "; one of them must be the answer.
  return got === want || got.split(" | ").some((chip) => chip === want);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    emit({ ok: false, blocked: "usage: eeo-smoke.mjs --live --url <posting> [--port 9224] [--schema <file>]" });
    return;
  }
  if (detectAts(args.url)?.ats !== "greenhouse") throw new Blocked("only hosted Greenhouse job URLs are supported");
  const profileDir = await isolatedProfile();

  const schema = await schemaOptions(args.schema ?? args.url);
  const mem = syntheticMemory();

  const { browser, context, endpoint, spawned } = await connect({ profileDir, port: args.port });
  log(`attached to ${endpoint}${spawned ? " (spawned)" : ""}`);
  const rows = [];
  let page = null;
  try {
    page = await openTab(context, args.url, { reuse: false });
    await greenhouse.waitForForm(page);
    await page.waitForTimeout(1000);

    const done = new Set();
    // Two rounds: a control that only mounts once an earlier answer is given (`#race` after the
    // ethnicity question) is not in the first reading of the page.
    for (let round = 0; round < 3; round += 1) {
      const live = (await greenhouse.eeoControls(page)).filter((r) => !done.has(r.qid));
      if (!live.length) break;
      const questions = live.map((r) => asQuestion(r, schema.find(r)));
      const { decisions } = resolveForm({ ats: "greenhouse", url: args.url, job: schema.job, questions }, { mem });
      const byQid = new Map(decisions.map((d) => [d.qid, d]));

      for (const control of live) {
        const decision = byQid.get(control.qid);
        const question = questions.find((q) => q.qid === control.qid);
        done.add(control.qid);
        if (!decision || decision.action !== "fill") {
          rows.push({ qid: control.qid, label: control.label, section: control.section, ok: false, filled: false, why: decision?.why ?? "no decision" });
          continue;
        }
        const intended = decision.option ?? decision.value;
        const result = await greenhouse.setField(page, question, intended, { trace: () => {} });
        // Read the control back off the page itself, not out of the setter's return value.
        const after = (await greenhouse.eeoControls(page)).find((r) => r.qid === control.qid);
        const observed = after?.value ?? "";
        const matched = committed(observed, intended);
        rows.push({
          qid: control.qid,
          label: control.label,
          section: control.section,
          ok: result.ok === true && matched,
          filled: Boolean(observed),
          value: REDACTED,
          observed: REDACTED,
          ...(result.strategy ? { strategy: result.strategy } : {}),
          ...(result.ok && matched ? {} : { reason: result.reason ?? (observed ? "read-back does not match" : "nothing committed") }),
        });
      }
    }
  } finally {
    if (browser) await disconnect(browser, { port: args.port, verify: false });
  }

  const ok = rows.length > 0 && rows.every((r) => r.ok);
  emit({
    ok,
    url: args.url,
    port: args.port,
    profile: "synthetic",
    rows: rows.length,
    read_back_ok: rows.filter((r) => r.ok).length,
    submitted: false,
    fields: rows,
  });
  // `process.exitCode`, not `process.exit()`: stdout is async when it is a pipe, and exiting
  // inside the same tick truncates a 2.5 kB report for whatever is reading it.
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  if (err instanceof Blocked) {
    emit({ ok: false, blocked: err.message });
    process.exitCode = 1;
    return;
  }
  log(err?.stack ?? String(err));
  process.exitCode = 1;
});
