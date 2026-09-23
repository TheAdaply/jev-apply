// The last gate before the Submit click (PLAN §2.2 step 12, §2.6).
//
// Everything else in this repo decides what to *put* on a form. This module decides whether what
// is on the form may be *sent* — once, irreversibly, to a real employer. It is deliberately not a
// second planner: it never edits a Decision, never asks a model anything and never reads the
// network. It re-states the invariants of AGENTS.md as twelve refusals over the frozen record
// plus (when the runner has one) the live required-control snapshot and the submit button's own
// geometry, and every failure it reports names a row and one thing the user can do about it.
//
// Each rule exists because a graded round put a wrong value in front of a real employer, or came
// within one preference of doing so (docs/research/12…16, private/eval-shots/*):
//
//   sensitive_source        a demographic answer that did not come from `p.eeo` or from the user
//   policy_gate_source      an attestation ticked from anything but the `p.legal.*` row signed for it
//   draft_gates             a draft nobody checked answers the question it is sitting under
//   fact_from_writer        a fact about the user composed by the writer or lifted from a story
//   dependency_child_filled a conditional child answered while its parent says No, or says nothing
//   work_mode_as_location   "Remote" typed into a geocoder, which commits a city nobody named
//   prose_into_date_control prose in a date control: read back as text, committed as nothing
//   required_empty          a required control still empty when Submit is about to be clicked
//   readback_failed         a write the page never confirmed
//   sensitive_readback      a demographic value the page did not read back as the one written
//   name_split_blind        a first/last name split out of a full name while the user stated both
//   overlay_over_submit     something covering the Submit control, so a click lands on the overlay
//
// Shape: `preflight({decisions, questions, mem, live, submit}) → {ok, failures[], checked[],
// unchecked[]}`. Inputs are optional and a rule that cannot be evaluated is reported as
// `unchecked` rather than silently passing — "nothing to check here" and "nothing checked here"
// are different sentences, and only one of them is a reason to click Submit.
//
// Nothing personal is ever put in a failure message: rows are named by label and qid, sources and
// memory ids by name. A judgement about a value never transcribes it.

import { isWorkMode } from "../memory/derive.mjs";
import { getFact } from "../memory/resolve.mjs";
import { LOCATION_RE, conditionPolarity, yesNoOf } from "./resolve.mjs";

/** A date control takes a date: `YYYY-MM-DD`, the only thing every board's picker reads back. */
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `nameRow()`'s own wording for the mechanical split (src/plan/resolve.mjs). */
const NAME_SPLIT_RE = /name split from/i;
/** The two memory namespaces that may answer a protected characteristic and an attestation. */
const EEO_SOURCE_RE = /(^|[^a-z_.])p\.eeo\b/i;
const LEGAL_SOURCE_RE = /(^|[^a-z_.])p\.legal\./i;
/**
 * The one `sensitive`-classed row that is not a protected characteristic. `SENSITIVE_RE` claims a
 * pronouns field (src/schema/classes.mjs), but `pronounRow()` answers it from the volunteered
 * `f.identity.pronouns` fact when no `p.eeo` block carries one, and a phrase the user wrote on
 * their own CV is theirs to state — refusing that would hold every form with a pronouns field.
 */
const PRONOUN_FACT_RE = /^f\.identity\.pronouns\b/i;
/** The user answered it themselves — the one source both of those rows always accept. */
const USER = "user";
/** Classes whose answer is a datum about the user, not prose anybody may compose. */
const FACT_CLASSES = new Set(["identity", "circumstance"]);
/** Sources that composed their text rather than being told it. */
const COMPOSED = new Set(["writer", "story", "host"]);
/** Actions that put something on the form. `ask`/`skip` leave the control alone. */
const WRITES = new Set(["fill", "check", "draft"]);

const text = (v) => (v == null ? "" : String(v));
const clip = (s, n = 60) => (text(s).length > n ? `${text(s).slice(0, n - 1)}…` : text(s));
const named = (d) => `"${clip(d?.label ?? d?.qid ?? "(unnamed row)")}"`;

/** Does this Decision put a value on the form? */
export const writes = (d) => WRITES.has(d?.action) && (d?.value != null || d?.option != null);

/**
 * Did this row come from the one preference that is allowed to answer it — or from the user?
 *
 * Both halves of the provenance have to agree. `source` says which kind of store answered and
 * `why` says which row in it, and a Decision claiming `source:"story"` under a `why` naming
 * `p.eeo.gender` is not a demographic answered from the user's own statement: it is a story
 * wearing one. Either half alone is a rule that can be walked around.
 */
const fromPreference = (d, idRe) => d?.source === USER || (d?.source === "preference" && idRe.test(text(d?.why)));

/** The name rows, by the qid every adapter uses and by the label every board prints. */
const NAME_ROW_RE = /^(first|last|given|family|sur)[_ -]?name$/i;

const fail = (rule, d, message) => ({ rule, qid: d?.qid ?? null, label: clip(d?.label ?? ""), message });

// ─── the rules ────────────────────────────────────────────────────────────────────────────────
// `needs` names the inputs a rule cannot run without. Order is the order they are reported in:
// the two that answer something on the user's behalf first, then the composed text, then the
// mechanical ones, then the state of the page itself.

export const RULES = [
  {
    name: "sensitive_source",
    needs: [],
    run: ({ decisions }) =>
      decisions
        .filter((d) => d.class === "sensitive" && writes(d))
        .filter((d) => !fromPreference(d, EEO_SOURCE_RE) && !(d.source === "fact" && PRONOUN_FACT_RE.test(text(d.why))))
        .map((d) =>
          fail(
            "sensitive_source",
            d,
            `${named(d)} is a demographic row filled from "${text(d.source) || "nothing"}" — a protected characteristic is answered from your saved p.eeo or by you, so re-answer it with --answers or state p.eeo.`,
          ),
        ),
  },
  {
    name: "policy_gate_source",
    needs: [],
    run: ({ decisions }) =>
      decisions
        .filter((d) => d.class === "policy_gate" && writes(d))
        .filter((d) => !fromPreference(d, LEGAL_SOURCE_RE))
        .map((d) =>
          fail(
            "policy_gate_source",
            d,
            `${named(d)} is an attestation you sign, and it was answered from "${text(d.source) || "nothing"}" (${clip(d.why, 40) || "no reason recorded"}) — answer it yourself, and it is stored as the p.legal.* stance it is.`,
          ),
        ),
  },
  {
    name: "draft_gates",
    needs: [],
    run: ({ decisions }) =>
      decisions
        .filter((d) => d.action === "draft" && d.value != null)
        .map((d) => {
          const gates = d.gates ?? null;
          const kind = text(gates?.kind ?? d.draft_request?.kind);
          const missing = [];
          if (gates?.draft == null) missing.push("does this text answer the question");
          // `why_us` is exempt from the grounding gate by design (PLAN §2.2 step 10,
          // src/plan/draft.mjs): its grounding is the posting plus what the user says they are
          // looking for, and "does that material answer 'why us'?" is not a relevance judgement.
          if (gates?.grounding == null && kind !== "why_us") missing.push("is your saved material about this");
          if (!missing.length) return null;
          return fail(
            "draft_gates",
            d,
            `${named(d)} holds ${d.words ?? "a"} word${d.words === 1 ? "" : "s"} of written text with no relevance check on record (${missing.join("; ")}) — read it before you send it, or clear the row and answer it yourself.`,
          );
        })
        .filter(Boolean),
  },
  {
    name: "fact_from_writer",
    needs: [],
    run: ({ decisions }) =>
      decisions
        .filter((d) => FACT_CLASSES.has(d.class) && writes(d) && COMPOSED.has(text(d.source)))
        .map((d) =>
          fail(
            "fact_from_writer",
            d,
            `${named(d)} asks for a fact about you and holds text from the ${text(d.source)} — a fact is stated by you or it is asked, never composed; clear it and answer it with --answers.`,
          ),
        ),
  },
  {
    name: "dependency_child_filled",
    needs: ["questions"],
    run: ({ decisions, questions, byQid }) => {
      const out = [];
      for (const q of questions) {
        const dep = q?.dependency;
        if (!dep?.parent) continue;
        const child = byQid.get(q.qid);
        const parent = byQid.get(dep.parent);
        if (!child || !parent || !writes(child)) continue;
        if (parent.action !== "fill" && parent.action !== "check") {
          out.push(
            fail(
              "dependency_child_filled",
              child,
              `${named(child)} is only asked once ${named(parent)} is answered, and that row is still open — answer the parent first, or leave this one blank.`,
            ),
          );
          continue;
        }
        const wanted = conditionPolarity(q.label, dep.condition);
        if (!wanted) continue;
        const answered = yesNoOf(parent.option ?? parent.value);
        if (answered === wanted) continue;
        out.push(
          fail(
            "dependency_child_filled",
            child,
            `${named(child)} is only asked when ${named(parent)} is ${wanted}${answered ? `, and you answered ${answered}` : ", and that row states no Yes or No"} — clear this row before submitting.`,
          ),
        );
      }
      return out;
    },
  },
  {
    name: "work_mode_as_location",
    needs: [],
    run: ({ decisions }) =>
      decisions
        .filter((d) => writes(d) && LOCATION_RE.test(text(d.label)) && isWorkMode(d.option ?? d.value))
        .map((d) =>
          fail(
            "work_mode_as_location",
            d,
            `${named(d)} asks where you are and holds a work arrangement, not a place — a geocoder turns that into a city you never named; state f.identity.city and re-run.`,
          ),
        ),
  },
  {
    name: "prose_into_date_control",
    needs: ["questions"],
    run: ({ decisions, qByQid }) =>
      decisions
        .filter((d) => writes(d))
        .filter((d) => {
          const q = qByQid.get(d.qid);
          const isDate = q ? q.control === "date" || q.type === "date" : d.control === "date";
          return isDate && !ISO_DAY_RE.test(text(d.option ?? d.value));
        })
        .map((d) =>
          fail(
            "prose_into_date_control",
            d,
            `${named(d)} is a date control holding prose instead of a YYYY-MM-DD date — a picker reads that back as text and commits nothing; state f.identity.start_date or answer the row.`,
          ),
        ),
  },
  {
    name: "required_empty",
    // `required` on the row itself is the third input (B2): a record frozen after that landed is
    // gradable with no schema and no browser, which is what "required and empty" needed to stop
    // being a judgement call off a screenshot.
    needs: ["questions|live|required"],
    run: ({ decisions, qByQid, live }) => {
      // The live snapshot is the authority when there is one: it is the page's own reading of
      // every required control after the last write (src/plan/execute.mjs `inspect`).
      if (live) {
        return [
          ...(live.unfilled ?? []).map(({ row, decision }) =>
            fail("required_empty", decision ?? row, `${named(decision ?? row)} is required and still empty on the page — fill or answer it before Submit.`),
          ),
          ...(live.unknown ?? []).map((row) =>
            fail("required_empty", row, `${named(row)} is required, empty, and not in the plan — a follow-up appeared after the fill; re-run with --answers before Submit.`),
          ),
        ];
      }
      return decisions
        .filter((d) => {
          const q = qByQid.get(d.qid);
          const required = q ? q.required : d.required;
          if (!required || writes(d)) return false;
          // A conditional child its parent closed is not an empty required row: the form only
          // enforces it once the parent opens it.
          return !(q?.dependency?.parent && d.action === "skip");
        })
        .map((d) => fail("required_empty", d, `${named(d)} is required and the plan leaves it empty (${d.action}) — answer it before Submit.`));
    },
  },
  {
    name: "readback_failed",
    needs: [],
    run: ({ decisions }) =>
      decisions
        .filter((d) => d.readback && d.readback.ok === false)
        .map((d) =>
          fail(
            "readback_failed",
            d,
            `${named(d)} was written but the page never read it back (${d.readback.attempts ?? 1} attempt${d.readback.attempts === 1 ? "" : "s"}) — what you would submit is not what the plan says; check the tab.`,
          ),
        ),
  },
  {
    // B3. A sensitive row stores `observed: ""` by design — the redaction that protects the value
    // also erases the evidence that it landed, and `readback.ok` alone only says the widget
    // accepted *something*. `executeRows` now records an in-page verdict instead: did the control
    // read back as the value that was written? The value itself is still never recorded, and a
    // `false` verdict is a demographic answer nobody can prove — which is not a thing to submit.
    name: "sensitive_readback",
    needs: [],
    run: ({ decisions }) =>
      decisions
        .filter((d) => d.class === "sensitive" && writes(d) && d.readback?.observed_matches === false)
        .map((d) =>
          fail(
            "sensitive_readback",
            d,
            `${named(d)} is a demographic row the page read back as something other than what was written (the value itself is never recorded) — open the tab and check that block before Submit.`,
          ),
        ),
  },
  {
    name: "name_split_blind",
    needs: ["mem"],
    run: ({ decisions, mem }) => {
      const stated = ["f.identity.first_name", "f.identity.last_name"].filter((id) => getFact(mem, id)?.value != null);
      if (!stated.length) return [];
      return decisions
        .filter((d) => writes(d) && NAME_SPLIT_RE.test(text(d.why)) && (NAME_ROW_RE.test(text(d.qid)) || NAME_ROW_RE.test(text(d.label).replace(/\s+/g, "_"))))
        .map((d) =>
          fail(
            "name_split_blind",
            d,
            `${named(d)} was split out of your full name although you stated ${stated.join(" and ")} — re-plan this posting so the row uses the name you gave.`,
          ),
        );
    },
  },
  {
    // B12. Every rule above judges the *fill*; this one judges the button. A board's own cookie
    // card sits above the form in z-order, and a click on a covered control lands on the card:
    // the runner reports a click, the board never sees a submit. Geometry is a live-page fact,
    // so with no snapshot of the submit control this rule is `unchecked`, never passed.
    name: "overlay_over_submit",
    needs: ["submit"],
    run: ({ submit }) => {
      const covering = submit?.overlaps ?? [];
      if (!covering.length) return [];
      const row = { qid: null, label: submit.label || submit.text || "Submit" };
      const names = covering.map((o) => `"${clip(o.name ?? o.tag ?? "an element", 30)}"`).join(", ");
      return [
        fail(
          "overlay_over_submit",
          row,
          `${named(row)} is covered by ${names} — a click would land on the board's own overlay instead of the button; dismiss it in the tab and re-run.`,
        ),
      ];
    },
  },
];

/**
 * Refuse, or don't. Pure: it reads its inputs and returns a verdict.
 *
 * @param {object}   input
 * @param {object[]} input.decisions the plan, frozen or live
 * @param {object[]} [input.questions] the FormPlan's questions — `required`, `control`, `dependency`
 * @param {object}   [input.mem] the memory store, read for ids only
 * @param {object}   [input.live] `inspect()`'s required-control snapshot `{unfilled, unknown}`
 * @param {object}   [input.submit] `submitObstruction()`'s reading of the submit control:
 *                   `{label, overlaps:[{tag,name}]}` — geometry, never a value
 * @returns {{ok:boolean, failures:Array<{rule,qid,label,message}>, checked:string[],
 *            unchecked:Array<{rule:string, why:string}>}}
 */
export function preflight({ decisions = [], questions = [], mem = null, live = null, submit = null } = {}) {
  const ctx = {
    decisions: decisions.filter(Boolean),
    questions: questions ?? [],
    mem,
    live,
    submit,
    byQid: new Map((decisions ?? []).filter(Boolean).map((d) => [d.qid, d])),
    qByQid: new Map((questions ?? []).filter(Boolean).map((q) => [q.qid, q])),
  };
  const have = {
    questions: ctx.questions.length > 0,
    mem: Boolean(mem),
    live: Boolean(live),
    submit: Boolean(submit),
    // A record frozen before `required` was carried onto the row has none, and a rule that cannot
    // see the flag is unchecked rather than quietly passing (B2).
    required: ctx.decisions.some((d) => typeof d.required === "boolean"),
  };
  const failures = [];
  const checked = [];
  const unchecked = [];
  for (const rule of RULES) {
    // `a|b` = either input will do.
    const missing = rule.needs.filter((need) => !need.split("|").some((key) => have[key]));
    if (missing.length) {
      unchecked.push({ rule: rule.name, why: `no ${missing.join(" and no ")} given` });
      continue;
    }
    checked.push(rule.name);
    failures.push(...rule.run(ctx));
  }
  return { ok: failures.length === 0, failures, checked, unchecked };
}

/**
 * The gate as the runner uses it (`scripts/apply.mjs` step 12). Returns the verdict and, when it
 * refuses, exactly the object the runner hands back instead of a click — `settle()` turns that
 * into `blocked{reason:"preflight", failures}`.
 *
 * `clicked:false` is load-bearing: a refusal never reached the button, so the frozen record must
 * not claim an attempt and `priorSubmit()` must still say this posting is retryable. A preflight
 * that poisoned the double-submit guard would cost the user the application it was protecting.
 */
export function submitGate(input) {
  const report = preflight(input);
  if (report.ok) return { ok: true, report, refusal: null };
  return {
    ok: false,
    report,
    refusal: {
      ok: false,
      clicked: false,
      cause: "preflight",
      detail: report.failures[0].message,
      preflight: report,
    },
  };
}

/** One line per failure, for the runner's stderr log. */
export function preflightLines(report) {
  return report.failures.map((f) => `preflight: ${f.rule} — ${f.message}`);
}
