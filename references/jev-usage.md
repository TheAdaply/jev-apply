# Jev usage

How `src/jev/client.mjs` and `src/jev/gates.mjs` actually call TypeSafe AI's Jev
(`api.typesafe.ai/v1/systemone`, model pinned to `jev-1.13.0` in `src/config.mjs`). Jev only ever
*selects* — it never writes text, and it never guesses.

## Question builders

```js
import { choice, noul, score, withNone, NONE } from "../src/jev/client.mjs";

choice(instructions, criteria);   // → { type: "choice", instructions, criteria }
noul(instructions, criteria?);    // → { type: "noul", instructions, ...(criteria && { criteria }) }
score(instructions, levels);      // → { type: "score", instructions, criteria: levels }
withNone(criteria, description?); // criteria + { none_of_these: description }
```

## The `none_of_these` invariant

Every `choice` question carries an explicit `none_of_these` exit (`withNone()` adds it). "Nothing
we saved answers this" is always reachable; a Select is never allowed to fall back to its first
option. `validateAnswer()` enforces this on every response, not just on the request shape.

## Answer validation (`validateAnswer`)

Runs on every answer before it reaches a `Decision`; a failure throws `JevValidationError({id,
reason})`, not a silent best-effort:
- `choice` ∈ the criteria keys sent.
- `probabilities` keys are exactly the criteria keys; they sum to `1 ± 0.02`.
- `argmax(probabilities) === choice`.

## Request limits and the token-budget splitter

- **255 options** per Choice — a 256th choice is a 400 `"Too many choices."` from the API
  (`MAX_CHOICES`).
- **56,000 tokens** per request (`MAX_REQUEST_TOKENS`) — 64k is the hard API cap; 56k leaves
  headroom for the request envelope and estimator error.
- **Estimator**: `chars / 3.5` per string/JSON blob, plus **30 tokens per option** (choice
  criteria, score levels, or noul's two descriptions) — measured, not a guess (see the estimator's
  doc comment for provenance).
- `planRequests(state, questions)` bin-packs `questions` into as few requests as fit under the
  budget, each resending the full shared `state`; a form with more open questions than one request
  can hold splits into parallel calls and the answers are merged. `systemOne()`'s `requests` count
  in a plan's output is how many HTTP calls that took.

## Errors

- `JevAuthError` (401) — the key is missing, wrong, or revoked.
- `JevBadRequest` (400/422) — malformed request: too many choices, oversize state
  (`max_tokens_exceeded`), bad shape.
- `JevValidationError` — an answer that does not satisfy the contract above.

## Confidence gates (`src/jev/gates.mjs` — the only place thresholds live)

```js
export const GATES = { askBelow: 0.5, checkGap: 0.15 };
```

`gate({ choice, confidence, probabilities })` → `"fill" | "check" | "ask"`:
1. `choice === none_of_these` (or missing) → `ask`.
2. `confidence < 0.5` → `ask`.
3. `runnerUpGap` (top probability minus the best alternative) `< 0.15` → `check` (filled, but shown
   to the user for review).
4. Otherwise → `fill`.

These two numbers are starting points (PLAN §2.2 step 7 / M0-b); if they change, they change only
in `gates.mjs` — nowhere else imports a threshold constant.
