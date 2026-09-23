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
import { ID_CATALOGUE, mintId, nextHandle, parseScope, rowKey, stamp } from "../src/memory/schema.mjs";
import { yesNoOf } from "../src/plan/resolve.mjs";

class Blocked extends Error {}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (line) => process.stderr.write(`${line}\n`);

const KINDS = {
  fact: "The instruction states a personal fact about the user — something an application form could ask for, such as a name, a date, a number, a school, or work authorization.",
  preference: "The instruction states how the user wants applications answered from now on — salary, notice period, locations, which résumé, what to say or avoid.",
  correction: "The instruction corrects or forbids something an application previously said or did.",
  promote_draft: "The instruction tells the assistant to keep a draft or answer from an application — it names a handle such as d1 or c1.",
};

const USAGE = 'usage: remember.mjs "<instruction>" [--scope global|company:<slug>|role_family:<family>] [--id <memory id>] [--dry-run]';

function parseArgs(argv) {
  const args = { instruction: null, scope: null, id: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--scope") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Blocked("--scope needs a value (global | company:<slug> | role_family:<family>)");
      if (!parseScope(value)) throw new Blocked(`bad scope ${JSON.stringify(value)} — use global, company:<slug>, or role_family:<family>`);
      args.scope = parseScope(value).text;
      i += 1;
    } else if (flag === "--id") {
      // The answer to the `needs_user` this script emits when it cannot tell which saved row an
      // instruction belongs to: the user names the row and no selection is made at all.
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Blocked("--id needs a memory id (f.… for a fact, p.… for a preference)");
      if (!/^[fp]\.[a-z0-9_.]+$/i.test(value)) throw new Blocked(`bad id ${JSON.stringify(value)} — facts start f. and preferences start p.`);
      args.id = value;
      i += 1;
    } else if (flag === "--dry-run") {
      args.dryRun = true;
    } else if (flag === "--help" || flag === "-h") {
      throw new Blocked(USAGE);
    } else if (flag.startsWith("--")) {
      throw new Blocked(`unknown flag ${flag}`);
    } else if (args.instruction === null) {
      args.instruction = flag;
    } else {
      throw new Blocked("one instruction at a time; quote it as a single argument");
    }
  }
  if (!args.instruction?.trim()) throw new Blocked(USAGE);
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

/**
 * The ids an instruction may belong to: the catalogue every resolver rule actually reads
 * (`src/memory/schema.mjs ID_CATALOGUE`) plus the ids already in the store, so a second statement
 * about the same thing updates one row instead of minting a parallel one. An existing row that
 * the catalogue does not name is described by its own id words — the only thing about it that is
 * safe to send and enough to recognise it by.
 *
 * Without this, "I currently live in <city>" minted `f.user.i_currently_live_in_<city>`: a
 * perfectly valid row that `locationFact()`, `identityRow()` and every form rule ignore for ever
 * (round-2 review, N8).
 */
const MAX_IDS = 200;

function idCriteria(mem) {
  const criteria = {};
  for (const [id, entry] of Object.entries(ID_CATALOGUE)) criteria[id] = entry.what;
  for (const row of [...mem.facts, ...mem.preferences]) {
    const id = row?.id;
    if (typeof id !== "string" || criteria[id] || Object.keys(criteria).length >= MAX_IDS) continue;
    criteria[id] = `A row already saved under this id, about: ${id.split(".").slice(1).join(" ").replace(/_/g, " ")}.`;
  }
  return withNone(criteria, "None of these is what the instruction is about — it needs an id of its own");
}

// ------------------------------------------------------------------- writing

function takenIds(rows) {
  return new Set(rows.map((row) => row?.id).filter((id) => typeof id === "string"));
}

/** `upsertRow`, unless this is a dry run — then nothing touches disk and the row is only reported. */
async function put(section, row, dryRun) {
  if (!dryRun) await upsertRow(section, row);
}

// A catalogue id holds the *value*, not the sentence that stated it: `f.identity.city` filled
// verbatim would type "I currently live in Lisbon, Portugal" into a geocoder. The lead-ins below
// are removed deterministically — nothing is rephrased and no model writes here — and only for an
// id the catalogue names. A sentence none of them fits, and every minted id, is stored exactly as
// the user said it.
const LEAD_RE =
  /^\s*(?:i\s*(?:'m|\u2019m|\s+am)?\s*(?:currently\s+|now\s+)?(?:live|living|reside|residing|based|located)\s+(?:in|at|near|out\s+of)\s+|my\s+[\w .'\u2019-]{2,40}?\s+(?:is|are)\s+|(?:it|that)\s*(?:'s|\u2019s|\s+is)\s+|please\s+use\s+)/i;

const statedValue = (instruction) => {
  const trimmed = String(instruction ?? "").replace(LEAD_RE, "").replace(/\s*[.;]\s*$/, "").trim();
  return trimmed || String(instruction ?? "").trim();
};

/**
 * The value a catalogue id takes. `text` holds the user's own words; `yes_no` holds a plain
 * stance and refuses anything else, because `validateRow` refuses it too and a `p.legal.*` row
 * that states neither would leave an attestation asked on every form for no visible reason.
 * @returns {{value:string}|{needs:string}}
 */
function catalogueValue(id, instruction) {
  const shape = ID_CATALOGUE[id]?.shape ?? "text";
  if (shape !== "yes_no") return { value: statedValue(instruction) };
  const stance = yesNoOf(instruction);
  return stance ? { value: stance } : { needs: `${id} holds a plain Yes or No. Say which — "yes, I am" or "no, I am not".` };
}

async function writeFact(mem, instruction, { id = null, dryRun = false } = {}) {
  const target = id ?? mintId("facts", instruction, takenIds(mem.facts));
  const value = id ? catalogueValue(id, instruction) : { value: instruction };
  if (value.needs) return { status: "needs_user", kind: "fact", id: target, question: value.needs };
  await put("facts", { id: target, value: value.value, source: "user", updated: stamp() }, dryRun);
  return { status: "ready_to_submit", kind: "fact", id: target, scope: "global", note: "facts are global; a scoped statement is a preference" };
}

async function writePreference(mem, instruction, scope, { id = null, dryRun = false } = {}) {
  const target = id ?? mintId("preferences", instruction, takenIds(mem.preferences));
  const stated = id ? catalogueValue(id, instruction) : { value: instruction };
  if (stated.needs) return { status: "needs_user", kind: "preference", id: target, question: stated.needs };
  const row = scope === "global"
    ? { id: target, value: stated.value, source: "user", updated: stamp() }
    : { id: target, value: null, overrides: [{ scope, value: stated.value, source: "user" }], source: "user", updated: stamp() };
  await put("preferences", row, dryRun);
  return { status: "ready_to_submit", kind: "preference", id: target, scope };
}

async function writeCorrection(mem, instruction, scope, { dryRun = false } = {}) {
  const id = nextHandle("corrections", mem.corrections);
  await put("corrections", { id, when: new Date().toISOString(), scope, rule: instruction, source: "user" }, dryRun);
  return { status: "ready_to_submit", kind: "correction", id, scope };
}

/** A company-specific answer is always saved at company scope, never globally (PLAN §2.4). */
function forcedScope(draft, scope) {
  const companyish = draft.class === "why_us" || draft.class === "company_specific" || String(draft.canon ?? draft.qid ?? "").startsWith("q.company.");
  const slug = draft.company ? slugify(draft.company) : draft.application ? slugify(draft.application) : null;
  if (companyish && slug) return `company:${slug}`;
  return scope;
}

async function promoteDraft(mem, instruction, scope, { dryRun = false } = {}) {
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
    await put("answers", { qid, kind, value: draft.text, scope: target, ...(draft.family ? { family: draft.family } : {}), source: "user", reviewed: true, updated: stamp() }, dryRun);
    return { status: "ready_to_submit", kind: "answer", id: qid, scope: target, from: draft.id };
  }

  const id = mintId("stories", draft.title ?? draft.text, takenIds(mem.stories), { namespace: "kept" });
  await put(
    "stories",
    {
      id,
      title: draft.title ?? `kept from ${draft.application ?? "an application"}`,
      text: draft.text,
      tags: draft.tags ?? [],
      source: `draft:${draft.id}${draft.application ? `@${draft.application}` : ""}`,
      updated: stamp(),
    },
    dryRun,
  );
  return { status: "ready_to_submit", kind: "story", id, scope: target, from: draft.id };
}

// --------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mem = await loadMemory();

  // One request: what kind of row is this, which saved id does it belong to, and (unless the user
  // said) which scope. Three judgments, one call — Jev selects all three and writes none of them.
  const questions = {
    kind: choice(
      "`instruction` is what the user just told the assistant to remember. Which kind of memory row does it become?",
      withNone(KINDS, "The instruction changes nothing in memory"),
    ),
  };
  if (!args.id) {
    questions.id = choice(
      "Which saved memory row is `instruction` about? Pick the id whose description states the same thing the instruction states.",
      idCriteria(mem),
    );
  }
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

  // Which id this belongs to. The id is the more specific judgment — it names the section too —
  // so a chosen `p.…` files a "fact" as the preference it is. `none_of_these` at a confidence the
  // gate accepts means the instruction genuinely needs a new row; below the gate it means nobody
  // knows, and that is a question for the user, never a guess (AGENTS.md).
  let id = args.id;
  let idConfidence = null;
  const catalogued = kind === "fact" || kind === "preference";
  if (!id && catalogued) {
    idConfidence = answers.id.confidence;
    const picked = answers.id.choice;
    if (picked !== NONE && idConfidence >= GATES.askBelow) id = picked;
    else if (idConfidence < GATES.askBelow) {
      const bucket = kind === "fact" ? "facts" : "preferences";
      const minted = mintId(bucket, args.instruction, takenIds(mem[bucket]));
      emit({
        status: "needs_user",
        kind,
        id: `new:${minted}`,
        confidence: answers.kind.confidence,
        id_confidence: idConfidence,
        question: `I could not tell which saved row that belongs to. Re-run with --id ${minted} to keep it as a new row, or --id <existing id> to update one.`,
      });
      return;
    }
  }
  const section = id ? (id.startsWith("p.") ? "preference" : "fact") : kind;

  let scope = args.scope;
  let scopeConfidence = null;
  if (!scope) {
    scopeConfidence = answers.scope.confidence;
    const stated = answers.scope.choice !== NONE && scopeConfidence >= GATES.askBelow;
    // The only other confidence-driven ask. A preference or a correction *lives at* its scope, so
    // a guessed one is worse than one more question. A fact is global by nature, and a promoted
    // draft takes the draft's own scope — neither needs the user to answer this.
    if (!stated && (section === "preference" || kind === "correction")) {
      emit({
        status: "needs_user",
        kind: section,
        ...(id ? { id } : {}),
        confidence: answers.kind.confidence,
        ...(idConfidence == null ? {} : { id_confidence: idConfidence }),
        scope_confidence: scopeConfidence,
        question: "Does that apply to every application, to one company, or to one role family? Re-run with --scope (e.g. --scope company:acme).",
      });
      return;
    }
    scope = stated ? parseScope(answers.scope.choice).text : "global";
  }

  const opts = { id, dryRun: args.dryRun };
  const written = section === "fact" ? await writeFact(mem, args.instruction, opts)
    : section === "preference" ? await writePreference(mem, args.instruction, scope, opts)
    : kind === "correction" ? await writeCorrection(mem, args.instruction, scope, opts)
    : await promoteDraft(mem, args.instruction, scope, opts);

  if (args.dryRun) {
    log("dry run — nothing written");
    log(`  id: ${written.id}`);
    log(`  scope: ${written.scope ?? scope}`);
  }
  emit({
    ...written,
    ...(args.dryRun ? { dry_run: true } : {}),
    confidence: answers.kind.confidence,
    ...(idConfidence == null ? {} : { id_confidence: idConfidence }),
    ...(scopeConfidence == null ? {} : { scope_confidence: scopeConfidence }),
  });
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
