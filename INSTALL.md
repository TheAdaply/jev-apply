# Installing jev-apply (agent-facing)

For a host agent (Claude Code, Codex, …) setting this skill up for a user the first time. See
`README.md` for the short version and `SKILL.md` for the five verbs a user speaks to it.

## 1. Get the code

```
git clone https://github.com/theadaply/jev-apply.git && cd jev-apply && npm install
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

```
TYPESAFE_API_KEY=…
```

This is the only credential jev-apply cannot run without. `loadEnv()` in `src/config.mjs` reads
this file at process start and fails fast, naming any variable still missing plus its signup URL.
Re-run `node scripts/install.mjs` to confirm it is present. Never place a key under the repo, in a
script argument, a prompt, or a tool output.

## 4. Choose how the few drafted sentences get written

Optional — jev-apply runs without any of this. Add at most one to the same `env` file:

```
OPENAI_API_KEY=sk-…                          # OpenAI writes the paragraph
JEV_APPLY_WRITER_URL=http://127.0.0.1:11434/v1   # a server you run (Ollama/llama.cpp/LM Studio) writes it
JEV_APPLY_WRITER_MODEL=<model name>              # required alongside JEV_APPLY_WRITER_URL
```

With neither set, `apply.mjs` detects that no writer model is configured and, running inside
Claude Code or Codex, hands the paragraph's prompt, grounding, and word limit back to the host
agent as a `needs_user` item of kind `draft` — see `SKILL.md` for exactly how to answer one.
`node scripts/writer-smoke.mjs --detect` prints which backend a given environment resolves to
without making a call.

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
node scripts/jev-smoke.mjs             # Jev reachable: prints a 3-option choice + latency
node scripts/writer-smoke.mjs --detect # which writer backend is active, if any
node scripts/install.mjs               # confirms the private directory + the Jev key are present
```
