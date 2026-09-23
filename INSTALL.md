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
`applications/`, `pipeline/`, `profile/`) and reports which keys are still missing. It never
creates, overwrites, or prints `~/.config/jev-apply/env` itself.

## 3. Put keys in `~/.config/jev-apply/env`

One `KEY=VALUE` per line, then `chmod 600 ~/.config/jev-apply/env`:

```
TYPESAFE_API_KEY=…
OPENAI_API_KEY=…
```

Never place either key under the repo, in a script argument, a prompt, or a tool output.
`loadEnv()` in `src/config.mjs` reads this file at process start and fails fast, naming any
variable still missing plus its signup URL. Re-run `node scripts/install.mjs` to confirm both are
present.

## 4. Register the skill with the host agent

```
npx skills add theadaply/jev-apply
```

or symlink the clone in:

```
ln -s "$(pwd)" ~/.claude/skills/jev-apply
ln -s "$(pwd)" ~/.agents/skills/jev-apply
```

## 5. First run

```
node scripts/learn.mjs --resume cv.pdf --resume other.pdf --links https://linkedin.com/in/…,https://github.com/…
```

The onboarding pass — see `SKILL.md` verb 1 for the response shape and the day-1 questions to
relay. `--resume` may repeat for more than one résumé; `--links` takes a comma-separated list.
`node scripts/learn.mjs --seed <dir>` imports a prepared seed instead, on a fresh install.

## Sanity checks

```
node scripts/jev-smoke.mjs     # Jev reachable: prints a 3-option choice + latency
node scripts/install.mjs       # confirms the private directory + both keys are present
```
