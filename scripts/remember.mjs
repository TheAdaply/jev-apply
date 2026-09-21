#!/usr/bin/env node
// scripts/remember.mjs — turn one spoken instruction into one memory row.
//
//   remember.mjs "<instruction>" [--scope global|company:<slug>|role_family:<family>]
//
// Jev *selects* what kind of row this is and which scope it belongs to (it never writes the text —
// the row's content is the user's own words). One JSON object on stdout: `{status, kind, id, scope}`.

import { slugify } from "../src/config.mjs";
import { NONE, choice, closeJevClient, noul, systemOne, withNone } from "../src/jev/client.mjs";
import { GATES } from "../src/jev/gates.mjs";
import { loadMemory, upsertRow } from "../src/memory/store.mjs";
import { resolvePreference } from "../src/memory/resolve.mjs";
import { mintId, nextHandle, parseScope, rowKey, stamp } from "../src/memory/schema.mjs";

class Blocked extends Error {}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (line) => process.stderr.write(`${line}\n`);

const KINDS = {
  fact: "The instruction states a personal fact about the user — something an application form could ask for, such as a name, a date, a number, a school, or work authorization.",
  preference: "The instruction states how the user wants applications answered from now on — salary, notice period, locations, which résumé, what to say or avoid.",
  correction: "The instruction corrects or forbids something an application previously said or did.",
  promote_draft: "The instruction tells the assistant to keep a draft or answer from an application — it names a handle such as d1 or c1.",
};

function parseArgs(argv) {
  const args = { instruction: null, scope: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--scope") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Blocked("--scope needs a value (global | company:<slug> | role_family:<family>)");
      if (!parseScope(value)) throw new Blocked(`bad scope ${JSON.stringify(value)} — use global, company:<slug>, or role_family:<family>`);
      args.scope = parseScope(value).text;
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      throw new Blocked('usage: remember.mjs "<instruction>" [--scope global|company:<slug>|role_family:<family>]');
    } else if (flag.startsWith("--")) {
      throw new Blocked(`unknown flag ${flag}`);
    } else if (args.instruction === null) {
      args.instruction = flag;
    } else {
      throw new Blocked("one instruction at a time; quote it as a single argument");
    }
  }
  if (!args.instruction?.trim()) throw new Blocked('usage: remember.mjs "<instruction>" [--scope global|company:<slug>|role_family:<family>]');
  return args;
}

/** Company slugs memory already knows, so Jev picks an existing scope instead of inventing one. */
function knownCompanies(mem) {
  const slugs = new Set();
  const add = (scope) => {
    const parsed = parseScope(scope);
    if (parsed?.kind === "company") slugs.add(parsed.key);
  };
  for (const row of mem.preferences) for (const ov of row.overrides ?? []) add(ov?.scope);
  for (const row of mem.corrections) add(row?.scope);
  for (const row of mem.answers) add(row?.scope);
  for (const row of mem.drafts) if (row?.company) slugs.add(slugify(row.company));
  return [...slugs];
}

/** Concrete scopes — Jev selects one of these, it never names a new company. */
function scopeCriteria(mem) {
  const criteria = { global: "The instruction applies to every application from now on." };
  const families = resolvePreference(mem, "p.looking_for")?.value?.role_families ?? {};
  for (const family of Object.keys(families)) {
    criteria[`role_family:${family}`] = `The instruction applies only to ${String(family).replace(/_/g, " ")} applications.`;
  }
  for (const slug of knownCompanies(mem)) {
    criteria[`company:${slug}`] = `The instruction applies only to applications to ${slug}.`;
  }
  return withNone(criteria, "The instruction does not say which of these it applies to");
}

// ------------------------------------------------------------------- writing

function takenIds(rows) {
  return new Set(rows.map((row) => row?.id).filter((id) => typeof id === "string"));
}

async function writeFact(mem, instruction) {
  const id = mintId("facts", instruction, takenIds(mem.facts));
  await upsertRow("facts", { id, value: instruction, source: "user", updated: stamp() });
  return { status: "ready_to_submit", kind: "fact", id, scope: "global", note: "facts are global; a scoped statement is a preference" };
}

async function writePreference(mem, instruction, scope) {
  const id = mintId("preferences", instruction, takenIds(mem.preferences));
  const row = scope === "global"
    ? { id, value: instruction, source: "user", updated: stamp() }
    : { id, value: null, overrides: [{ scope, value: instruction, source: "user" }], source: "user", updated: stamp() };
  await upsertRow("preferences", row);
  return { status: "ready_to_submit", kind: "preference", id, scope };
}

async function writeCorrection(mem, instruction, scope) {
  const id = nextHandle("corrections", mem.corrections);
  await upsertRow("corrections", { id, when: new Date().toISOString(), scope, rule: instruction, source: "user" });
  return { status: "ready_to_submit", kind: "correction", id, scope };
}

/** A company-specific answer is always saved at company scope, never globally (PLAN §2.4). */
function forcedScope(draft, scope) {
  const companyish = draft.class === "why_us" || draft.class === "company_specific" || String(draft.canon ?? draft.qid ?? "").startsWith("q.company.");
  const slug = draft.company ? slugify(draft.company) : draft.application ? slugify(draft.application) : null;
  if (companyish && slug) return `company:${slug}`;
  return scope;
}

async function promoteDraft(mem, instruction, scope) {
  const handle = /\b([dc]\d+)\b/i.exec(instruction)?.[1]?.toLowerCase();
  if (!handle) return { status: "needs_user", kind: "promote_draft", question: "Which draft should I keep? Name its handle, e.g. \"keep d1\"." };
  const draft = mem.drafts.find((row) => String(row?.id ?? "").toLowerCase() === handle);
  if (!draft) return { status: "needs_user", kind: "promote_draft", question: `No draft ${handle} is saved. Which draft should I keep?` };

  const qid = draft.canon ?? draft.qid ?? null;
  const target = forcedScope(draft, scope);

  if (qid) {
    // Any saved answer for this question that is *not* the row we are about to write: if it already
    // says the same thing, adding a second one is noise (PLAN §2.4). Same-identity rows upsert.
    const targetKey = rowKey("answers", { qid, scope: target, family: draft.family });
    const rival = mem.answers.find((row) => row.qid === qid && row.kind !== "never" && rowKey("answers", row) !== targetKey);
    if (rival) {
      const { answers } = await systemOne({
        state: { saved_answer: rival.value ?? rival.variants ?? null, promoted_draft: draft.text },
        questions: { same: noul("`promoted_draft` says the same thing as `saved_answer`.") },
      });
      if ((answers.same?.noul ?? 0) >= 0.5) {
        return { status: "ready_to_submit", kind: "answer", id: rival.qid, scope: rival.scope ?? "global", duplicate_of: rival.qid, note: "an existing saved answer already says this; nothing added" };
      }
    }
    const kind = target.startsWith("company:") ? "company" : "narrative";
    await upsertRow("answers", { qid, kind, value: draft.text, scope: target, ...(draft.family ? { family: draft.family } : {}), source: "user", reviewed: true, updated: stamp() });
    return { status: "ready_to_submit", kind: "answer", id: qid, scope: target, from: draft.id };
  }

  const id = mintId("stories", draft.title ?? draft.text, takenIds(mem.stories), { namespace: "kept" });
  await upsertRow("stories", {
    id,
    title: draft.title ?? `kept from ${draft.application ?? "an application"}`,
    text: draft.text,
    tags: draft.tags ?? [],
    source: `draft:${draft.id}${draft.application ? `@${draft.application}` : ""}`,
    updated: stamp(),
  });
  return { status: "ready_to_submit", kind: "story", id, scope: target, from: draft.id };
}

// --------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mem = await loadMemory();

  // One request: what kind of row is this, and (unless the user said) which scope does it belong to.
  const questions = {
    kind: choice(
      "`instruction` is what the user just told the assistant to remember. Which kind of memory row does it become?",
      withNone(KINDS, "The instruction changes nothing in memory"),
    ),
  };
  if (!args.scope) {
    questions.scope = choice("Which scope does `instruction` apply to?", scopeCriteria(mem));
  }

  const { answers, ms, requests } = await systemOne({
    state: {
      instruction: args.instruction,
      saved: { facts: mem.facts.length, preferences: mem.preferences.length, answers: mem.answers.length, stories: mem.stories.length, drafts: mem.drafts.map((d) => d.id) },
    },
    questions,
  });
  log(`jev: ${requests} request(s), ${ms} ms`);

  const kind = answers.kind.choice;
  if (kind === NONE) {
    emit({ status: "needs_user", kind: NONE, confidence: answers.kind.confidence, question: "I could not tell what to save. Is this a fact, a preference, a correction, or a draft to keep?" });
    return;
  }

  let scope = args.scope;
  let scopeConfidence = null;
  if (!scope) {
    scopeConfidence = answers.scope.confidence;
    const stated = answers.scope.choice !== NONE && scopeConfidence >= GATES.askBelow;
    // The only confidence-driven ask. A preference or a correction *lives at* its scope, so a
    // guessed one is worse than one more question. A fact is global by nature, and a promoted
    // draft takes the draft's own scope — neither needs the user to answer this.
    if (!stated && (kind === "preference" || kind === "correction")) {
      emit({
        status: "needs_user",
        kind,
        confidence: answers.kind.confidence,
        scope_confidence: scopeConfidence,
        question: "Does that apply to every application, to one company, or to one role family? Re-run with --scope (e.g. --scope company:acme).",
      });
      return;
    }
    scope = stated ? parseScope(answers.scope.choice).text : "global";
  }

  const written = kind === "fact" ? await writeFact(mem, args.instruction)
    : kind === "preference" ? await writePreference(mem, args.instruction, scope)
    : kind === "correction" ? await writeCorrection(mem, args.instruction, scope)
    : await promoteDraft(mem, args.instruction, scope);

  emit({ ...written, confidence: answers.kind.confidence, ...(scopeConfidence == null ? {} : { scope_confidence: scopeConfidence }) });
}

main()
  .catch((err) => {
    if (err instanceof Blocked) {
      emit({ status: "blocked", reason: err.message });
      return;
    }
    log(err?.stack ?? String(err));
    process.exitCode = 1;
  })
  .finally(() => closeJevClient());
