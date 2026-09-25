// Offline: "current or previous/last/former employer" labels resolve from the saved employment
// facts instead of falling through to the canonical bank and asking. No network, no Jev, no memory.
//
//   node --test eval/employer-labels.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classify } from "../src/schema/classes.mjs";
import { acceptsMostRecent, resolveForm } from "../src/plan/resolve.mjs";

const mem = {
  facts: [
    { id: "f.identity.full_name", value: "Example Person", source: "user" },
    { id: "f.employment.current", value: "Globex", source: "user" },
    { id: "f.employment.current_title", value: "Data Scientist", source: "user" },
  ],
  preferences: [],
  answers: [],
  stories: [],
  documents: [],
};

const EMPLOYER = [
  "Who is your current or previous employer?",
  "Who is your current or last employer?",
  "What is your current or former company?",
  "Who is your current or most recent employer?",
];
const TITLE = ["What is your current or previous job title?", "What is your current or last role?"];

const resolve = (label) => {
  const form = {
    job: { company: "Acme", title: "Data Scientist", location: "Singapore", country: "SG" },
    questions: [{ qid: "q", label, class: classify(label, "", "text", true), type: "text", required: true }],
  };
  return resolveForm(form, { mem, now: new Date("2026-09-25") }).decisions[0];
};

describe("current-or-previous employer and title labels", () => {
  for (const label of [...EMPLOYER, ...TITLE]) {
    it(`classifies "${label}" as identity`, () => {
      assert.equal(classify(label, "", "text", true), "identity");
    });
  }
  for (const label of EMPLOYER) {
    it(`fills "${label}" from f.employment.current`, () => {
      const row = resolve(label);
      assert.equal(row.action, "fill");
      assert.equal(row.value, "Globex");
    });
  }
  for (const label of TITLE) {
    it(`fills "${label}" from f.employment.current_title`, () => {
      const row = resolve(label);
      assert.equal(row.action, "fill");
      assert.equal(row.value, "Data Scientist");
    });
  }
  it("a label naming a past role accepts the most recent one; a bare 'current' does not", () => {
    for (const label of [...EMPLOYER, ...TITLE, "Current or past employer"]) assert.ok(acceptsMostRecent(label), label);
    assert.ok(!acceptsMostRecent("Current company"));
  });
});
