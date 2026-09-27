# Installing jev-apply (agent-facing)

For a host agent (Claude Code, Codex, …) setting this skill up for a user the first time. See
`README.md` for the short version and `SKILL.md` for the five verbs a user speaks to it.

## 1. Get the code

```
git clone https://github.com/theadaply/jev-apply.git && cd jev-apply && npm ci
```

Node ≥ 20 required. Dependencies: `@typesafe-ai/sdk`, `playwright` (library only — no browsers to
download), `openai`, `yaml`, `pdf-parse`.

## 2. Create the private data directory

```
node scripts/install.mjs
```

Idempotent. Creates `~/.config/jev-apply/` (`0700`: `config.json`, `memory/`, `documents/`,
`applications/`, `pipeline/`, `profile/`), reports which required key is still missing, and prints
which of the three writing options (below) is currently active. It never creates, overwrites, or
prints `~/.config/jev-apply/env` itself.

## 3. Put the Jev key in `~/.config/jev-apply/env`

One `KEY=VALUE` per line, then `chmod 600 ~/.config/jev-apply/env`:

`.env.example` lists credential and writer variable names; put real values only in the private
file, never in the repository.

```
TYPESAFE_API_KEY=…
```

This is the only credential jev-apply cannot run without. `loadEnv()` in `src/config.mjs` reads
this file at process start and fails fast, naming a missing variable and its signup URL.
Re-run `node scripts/install.mjs` to check for a nonempty value; it does not authenticate.
`node scripts/jev-smoke.mjs` makes a live Jev request to verify the key. Never put a key in
the repo, a script argument, a prompt, or a tool output.

## 4. Choose who writes grounded new prose

Optional — Jev still needs its TypeSafe key, but the writer needs no second key when your CLI
agent handles drafts. Three choices, in priority order when configured:

```text
OPENAI_API_KEY=…                        # OpenAI Responses API; JEV_APPLY_WRITER_MODEL is optional
JEV_APPLY_WRITER_URL=https://api.example.com/v1
JEV_APPLY_WRITER_MODEL=<model name>     # an OpenAI-compatible chat-completions endpoint
JEV_APPLY_WRITER_KEY=…                  # only if that endpoint requires a bearer key
```

An unkeyed loopback server such as `http://127.0.0.1:11434/v1` also works with URL + model.
Remote endpoints require HTTPS; only loopback may use HTTP. Put keys only in the private `env`
file, not in a prompt or command line. A URL set for this run (or paired with its own key) wins
over a stored OpenAI key. A model name with `OPENAI_API_KEY` selects that OpenAI model for all
writer calls. A compatible endpoint must support OpenAI-style chat completions; its cost is
reported as unknown, not free.

With no writer configured, `apply.mjs` hands a `kind:"draft"` item to the **CLI agent** in its
`needs_user` payload. The agent writes it from the supplied grounding and passes it back through
`--answers`; the user is not asked to author it. Personal facts, EEO choices and policy
attestations still come from the user, never from any model. See [SKILL.md](SKILL.md) for the
handoff. `node scripts/writer-smoke.mjs --detect` reports the selected backend without making a
call or showing credentials.

## 5. Register the skill with the host agent

```
npx skills add theadaply/jev-apply
```

or symlink the clone in:

```
ln -s "$(pwd)" ~/.claude/skills/jev-apply
ln -s "$(pwd)" ~/.agents/skills/jev-apply
```

## 6. First run

```
node scripts/learn.mjs --resume cv.pdf [--resume other.pdf] --links https://linkedin.com/in/…,https://github.com/…
```

The onboarding pass — see `SKILL.md` verb 1 for the response shape and the day-1 questions to
relay. `--resume` may repeat for more than one résumé; `--links` takes a comma-separated list.
Without a writer model configured, résumé reading falls back to a deterministic extractor (name,
contacts, and one story per bullet line) — no OpenAI key is required to onboard.
`node scripts/learn.mjs --seed <dir>` imports a prepared seed instead, on a fresh install.

## Sanity checks

```
node scripts/jev-smoke.mjs             # live paid Jev choice; verifies key and network
node scripts/writer-smoke.mjs --detect # which writer backend is active, if any
node scripts/install.mjs               # private directory + nonempty Jev key value (no API call)
```
