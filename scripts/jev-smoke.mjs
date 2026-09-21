#!/usr/bin/env node
// Jev connectivity + contract check (PLAN A1).
//   node scripts/jev-smoke.mjs                one Choice (3 candidates + none_of_these) and one Noul
//   node scripts/jev-smoke.mjs --split-test   300 Choices → proves the estimator splits and merges
// One JSON object on stdout; human lines on stderr. Exit 1 if the check fails.

import { JEV_MODEL } from "../src/config.mjs";
import {
  systemOne,
  closeJevClient,
  choice,
  noul,
  withNone,
  planRequests,
  estimateQuestionTokens,
  NONE,
} from "../src/jev/client.mjs";

const round = (n, d = 4) => (typeof n === "number" ? Number(n.toFixed(d)) : n);
const roundAll = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, round(v)]));

async function smoke() {
  const state = {
    job: { title: "Senior Inference Engineer", company: "Acme" },
    form_field: { label: "What is your preferred email address?", input_type: "text", help: "" },
  };
  const questions = {
    which_saved_item: choice(
      "Which saved item belongs in `form_field`? Pick the one holding exactly the information the field asks for.",
      withNone({
        "f.contact.email": "Contact email address",
        "f.contact.phone": "Mobile phone number",
        "f.links.github": "GitHub profile URL",
      }),
    ),
    needs_user: noul(
      "Does `form_field` ask about the applicant's personal circumstances rather than their contact details?",
      { true: "It asks about circumstances such as visa status, notice period, or salary",
        false: "It asks for a contact detail, link, or document" },
    ),
  };

  const { answers, usage, ms, requests, model } = await systemOne({ state, questions });
  const picked = answers.which_saved_item;
  const ok = picked.choice === "f.contact.email" && picked.choice !== NONE;
  return {
    ok,
    out: {
      mode: "smoke",
      model,
      ms,
      requests,
      usage,
      answers: {
        which_saved_item: {
          choice: picked.choice,
          confidence: round(picked.confidence),
          probabilities: roundAll(picked.probabilities),
        },
        needs_user: { noul: round(answers.needs_user.noul) },
      },
      expected: { which_saved_item: "f.contact.email", ms_window: [300, 2000] },
    },
  };
}

async function splitTest() {
  const COUNT = 300;
  const state = {
    job: { title: "Senior Inference Engineer", company: "Acme", location: "Remote (EU)" },
    note: "Each question is evaluated in isolation against this state.",
  };
  const questions = {};
  for (let i = 0; i < COUNT; i++) {
    questions[`canon_q${i}`] = choice(
      `Which canonical question is form field ${i} an instance of? Pick the one asking for the same information as "${i % 2 ? "How many years of Python experience do you have?" : "What is your email address?"}".`,
      withNone({
        "q.core.contact_email": "Your email address (also: 'email', 'contact email', 'work email')",
        "q.core.phone": "Your phone number (also: 'mobile', 'contact number', 'best number to reach you')",
        "q.core.years_python": "Years of professional Python experience (also: 'how long have you used Python')",
        "q.core.notice_period": "Notice period at your current employer (also: 'when can you start', 'availability')",
        "q.core.salary": "Expected base salary (also: 'compensation expectations', 'desired salary')",
      }),
    );
  }

  const batches = planRequests(state, questions);
  const estimated = Object.entries(questions).reduce((n, [id, q]) => n + estimateQuestionTokens(id, q), 0);
  const { answers, usage, ms, requests, model } = await systemOne({ state, questions });

  const ids = Object.keys(answers);
  const expectedIds = Object.keys(questions);
  const merged = ids.length === COUNT && expectedIds.every((id) => answers[id] !== undefined);
  const tally = {};
  for (const id of expectedIds) tally[answers[id].choice] = (tally[answers[id].choice] ?? 0) + 1;
  return {
    ok: requests >= 2 && merged,
    out: {
      mode: "split-test",
      model,
      ms,
      requests,
      questions: COUNT,
      answers: ids.length,
      validated: ids.length, // systemOne throws JevValidationError before returning
      merged,
      estimatedTokens: estimated,
      batchSizes: batches.map((b) => Object.keys(b).length),
      usage,
      tally,
      sample: {
        canon_q0: { choice: answers.canon_q0.choice, confidence: round(answers.canon_q0.confidence) },
        canon_q1: { choice: answers.canon_q1.choice, confidence: round(answers.canon_q1.confidence) },
      },
    },
  };
}

const split = process.argv.includes("--split-test");
try {
  const { ok, out } = split ? await splitTest() : await smoke();
  process.stdout.write(JSON.stringify(out) + "\n");
  process.stderr.write(
    `${out.mode}: ${out.requests} request(s), ${out.ms} ms, model ${out.model}, ${ok ? "OK" : "FAILED"}\n`,
  );
  await closeJevClient();
  process.exit(ok ? 0 : 1);
} catch (err) {
  process.stdout.write(
    JSON.stringify({
      mode: split ? "split-test" : "smoke",
      model: JEV_MODEL,
      error: err.name,
      reason: err.message,
      ...(err.detail ? { detail: err.detail } : {}),
    }) + "\n",
  );
  await closeJevClient().catch(() => {});
  process.exit(1);
}
