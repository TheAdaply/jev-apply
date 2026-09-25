// Offline unit tests for pure modules: no network, no Jev key, no browser, no user memory.
//
//   node --test eval/unit.test.mjs
//
// Complements eval/plan.test.mjs (which needs live Jev) by pinning the AGENTS.md invariants that
// can be checked without a model: Jev answer validation, confidence gating, and scan dedup.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { companyRoleKey, dedupeJobs, normalizeUrl } from "../src/discover/dedupe.mjs";
import { GATES, gate, runnerUpGap } from "../src/jev/gates.mjs";
import { JevValidationError, NONE, validateAnswer, withNone } from "../src/jev/client.mjs";

describe("normalizeUrl", () => {
  it("strips tracking params, keeps gh_jid, sorts the rest", () => {
    assert.equal(
      normalizeUrl("https://Boards.Greenhouse.io/acme/jobs/?utm_source=x&gh_jid=42&ref=hn&b=2&a=1"),
      "boards.greenhouse.io/acme/jobs?a=1&b=2&gh_jid=42",
    );
  });
  it("treats trailing slashes and tracking-only variants as equal", () => {
    assert.equal(normalizeUrl("https://jobs.lever.co/acme/1/"), normalizeUrl("https://jobs.lever.co/acme/1?lever-source=li"));
  });
  it("passes through unparseable input and undefined", () => {
    assert.equal(normalizeUrl(" not a url "), "not a url");
    assert.equal(normalizeUrl(undefined), undefined);
  });
});

describe("companyRoleKey", () => {
  const key = (title) => companyRoleKey({ company: "Acme", title });

  it("strips spaced and parenthesised location suffixes", () => {
    assert.equal(key("Senior Engineer - Berlin, DE"), "acme::senior engineer");
    assert.equal(key("Senior Engineer (Berlin) (Remote)"), "acme::senior engineer");
    assert.equal(key("Staff Engineer | Remote"), "acme::staff engineer");
    assert.equal(key("Staff Engineer — London"), "acme::staff engineer");
  });
  it("keeps hyphenated words intact", () => {
    assert.equal(key("Full-Stack Engineer"), "acme::full stack engineer");
    assert.equal(key("Front-End Engineer - NYC"), "acme::front end engineer");
    assert.equal(key("Co-Founder"), "acme::co founder");
  });
});

describe("dedupeJobs", () => {
  it("keeps distinct hyphenated roles at the same company", () => {
    const jobs = [
      { company: "Acme", title: "Full-Stack Engineer", url: "https://a.example/1" },
      { company: "Acme", title: "Full-Time Designer", url: "https://a.example/2" },
    ];
    assert.equal(dedupeJobs(jobs).length, 2);
  });
  it("drops same-URL and same-role duplicates, and honours seen keys without mutating them", () => {
    const jobs = [
      { company: "Acme", title: "ML Engineer", url: "https://a.example/1?utm_source=x" },
      { company: "Acme", title: "Other", url: "https://a.example/1" },
      { company: "Acme", title: "ML Engineer (Remote)", url: "https://a.example/3" },
      { company: "Beta", title: "ML Engineer", url: "https://b.example/1" },
    ];
    const seen = new Set(["beta::ml engineer"]);
    assert.deepEqual(dedupeJobs(jobs, seen).map((j) => j.url), ["https://a.example/1?utm_source=x"]);
    assert.equal(seen.size, 1);
  });
});

describe("gate", () => {
  it("asks on none_of_these, missing choice, or low/invalid confidence", () => {
    assert.equal(gate({ choice: NONE, confidence: 0.99, probabilities: { [NONE]: 0.99, a: 0.01 } }), "ask");
    assert.equal(gate({ choice: undefined, confidence: 0.99 }), "ask");
    assert.equal(gate({ choice: "a", confidence: GATES.askBelow - 0.01, probabilities: { a: 0.9, b: 0.1 } }), "ask");
    assert.equal(gate({ choice: "a", confidence: NaN, probabilities: { a: 0.9, b: 0.1 } }), "ask");
  });
  it("checks on a thin margin or a missing distribution, fills otherwise", () => {
    assert.equal(gate({ choice: "a", confidence: 0.9, probabilities: { a: 0.5, b: 0.45, c: 0.05 } }), "check");
    assert.equal(gate({ choice: "a", confidence: 0.9 }), "check");
    assert.equal(gate({ choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } }), "fill");
  });
  it("runnerUpGap is undefined when the pick has no probability", () => {
    assert.equal(runnerUpGap({ b: 1 }, "a"), undefined);
    assert.ok(Math.abs(runnerUpGap({ a: 0.7, b: 0.2, c: 0.1 }, "a") - 0.5) < 1e-9);
  });
});

describe("validateAnswer (choice)", () => {
  const q = { type: "choice", instructions: "pick", criteria: withNone({ a: "A", b: "B" }) };
  const ok = { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.8, b: 0.15, [NONE]: 0.05 } };
  const rejects = (answer, pattern) =>
    assert.throws(() => validateAnswer("q1", q, answer), (err) => err instanceof JevValidationError && pattern.test(err.message + JSON.stringify(err)));

  it("every choice question carries a none_of_these exit", () => {
    assert.ok(NONE in q.criteria);
  });
  it("accepts a well-formed answer", () => {
    assert.equal(validateAnswer("q1", q, ok), ok);
  });
  it("rejects a choice outside the criteria", () => {
    rejects({ ...ok, choice: "z" }, /not one of the criteria/);
  });
  it("rejects probabilities that do not sum to ~1", () => {
    rejects({ ...ok, probabilities: { a: 0.8, b: 0.5, [NONE]: 0.05 } }, /sum to/);
  });
  it("rejects a choice that is not the argmax", () => {
    rejects({ ...ok, choice: "b" }, /most probable/);
  });
  it("rejects mismatched probability keys and non-numeric confidence", () => {
    rejects({ ...ok, probabilities: { a: 0.8, b: 0.2 } }, /keys do not match/);
    rejects({ ...ok, confidence: "high" }, /confidence/);
  });
});
