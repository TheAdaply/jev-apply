# jev-apply

**A job-application skill with a memory.** Give it a résumé and a posting. It fills what your record supports, drafts grounded prose when you allow it, and leaves the rest open rather than guessing.

![Illustrated application: a saved story becomes a read-back form answer; unsupported fields remain open.](assets/application-sheet.svg)

## Give it to your CLI agent

In Codex, Claude Code, or another agent that can run shell commands, paste this:

```text
Set up TheAdaply/jev-apply for me.
Read SKILL.md and INSTALL.md.
Install the skill; run setup yourself.
Show me how to put my TypeSafe Jev
key in its private env file. Don't
ask me to paste any key in chat.
Learn from my résumé. Fill a job URL
I give you with --no-submit on every
run. Use your current CLI model for
grounded drafts unless I configure
a writer. Show me the filled form.
Ask only for facts, choices, or
attestations my record cannot
answer.
```

The agent follows [SKILL.md](SKILL.md) for the workflow and [INSTALL.md](INSTALL.md) for setup. You need **Node 20+, Google Chrome, and a [TypeSafe Jev key](https://console.typesafe.ai/keys)**. OpenAI is optional; the agent can draft from the model already running in your CLI. No personal data belongs in this repo.

## What happens to each field

**Jev matches** the form question to a saved fact, preference, story, or answer. **A writer drafts** only new prose supported by your material and the posting, when `p.auto_draft` is on: OpenAI, a named OpenAI-compatible model at a configured endpoint, or your CLI agent. **Playwright fills and reads back** every supported control.

Unknown personal facts, EEO choices, and policy attestations are **not model questions**. Your agent asks you when the exact answer is not on file. Drafts stay with that application unless you explicitly save them. Automatic submission is a separate opt-in; Lever always leaves Submit to you.

> [!NOTE]
> Experimental. Hosted Greenhouse, Ashby and Lever forms are supported; LinkedIn Easy Apply is not. Jev makes API calls, so this is not an offline tool.

## Evidence and boundaries

The [form evaluation and per-page results](bench/results/fresh-pages.md) describe a measured set, not a universal success rate. The runner reads back filled controls, keeps the browser tab open for review, and records `submitted` only after the ATS confirms it. Start with `--no-submit` until you have inspected a real form yourself.

## Build and inspect

`npm run check:syntax` checks parsing, not application behavior. The [CI workflow](.github/workflows/ci.yml) runs it after `npm ci`; `node eval/plan.test.mjs` uses private memory and makes live, paid Jev calls. Browser fixture checks live in `scripts/controls-smoke.mjs` and `scripts/submit-smoke.mjs`. Read [AGENTS.md](AGENTS.md) for contributor rules and [docs/PLAN.md](docs/PLAN.md) for decisions.

## License

[MIT](LICENSE) © 2026 TheAdaply.
