<div align="center">

# jev-apply

**A job-application skill with a memory.** Give it a résumé and a posting. It fills what your record supports, drafts grounded prose when you allow it, and leaves the rest open rather than guessing.

<p align="center">
  <a href="https://github.com/theadaply/jev-apply/stargazers"><img src="https://img.shields.io/github/stars/theadaply/jev-apply?style=flat-square&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/theadaply/jev-apply/network/members"><img src="https://img.shields.io/github/forks/theadaply/jev-apply?style=flat-square&logo=github" alt="GitHub forks"></a>
  <a href="https://github.com/theadaply/jev-apply/issues"><img src="https://img.shields.io/github/issues/theadaply/jev-apply?style=flat-square&logo=github" alt="GitHub issues"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node.js-%E2%89%A520.0-339933.svg?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js"></a>
  <a href="https://google.com/chrome"><img src="https://img.shields.io/badge/chrome-CDP%20Required-4285F4.svg?style=flat-square&logo=googlechrome&logoColor=white" alt="Chrome CDP"></a>
  <a href="https://typesafe.ai"><img src="https://img.shields.io/badge/TypeSafe%20AI-System%20One-000000.svg?style=flat-square" alt="TypeSafe AI"></a>
  <a href="https://console.typesafe.ai/keys"><img src="https://img.shields.io/badge/decider-Jev%201.13.0-ff69b4.svg?style=flat-square" alt="TypeSafe Jev"></a>
  <a href="AGENTS.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" alt="PRs Welcome"></a>
</p>

<br/>

![Illustrated application: a saved story becomes a read-back form answer; unsupported fields remain open.](assets/application-sheet.svg)

</div>

---

## Give it to your CLI agent

In Codex, Claude Code, or another agent that can run shell commands, paste this:

```text
Set up TheAdaply/jev-apply.
Read SKILL.md and INSTALL.md.
Install and configure it.
Show me where to enter my Jev
key privately, not in chat.
Learn my résumé. Fill a URL
I give you, with --no-submit
on every run and rerun.
Use this CLI model for drafts
grounded in my record unless
I set a writer.
Show me the filled form. Ask
only for missing facts,
choices or attestations.
```

The agent follows [SKILL.md](SKILL.md) for the workflow and [INSTALL.md](INSTALL.md) for setup. You need **Node 20+, Google Chrome, and a [TypeSafe Jev key](https://console.typesafe.ai/keys)**. OpenAI is optional; the agent can draft from the model already running in your CLI. No personal data belongs in this repo.

---

## TypeSafe AI Jev System One Motion Engine

![TypeSafe AI Jev System One Decision Pipeline](assets/typesafe-jev-animation.svg)

`jev-apply` uses [TypeSafe AI's Jev model (`jev-1.13.0`)](https://typesafe.ai/blog/introducing-system-one-models-and-jev)—a System One AI model optimized for **parallel sampling**, **zero type errors**, and **70ms–500ms calibrated decision latency**. Unstructured candidate state enters the decider, and structured probabilistic decisions return without hallucination risk.

---

## Tech Stack & Ecosystem

### Languages & Runtimes
<p>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js"></a>
  <a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript"><img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript"></a>
  <a href="https://yaml.org"><img src="https://img.shields.io/badge/YAML-CB171E?style=for-the-badge&logo=yaml&logoColor=white" alt="YAML"></a>
  <a href="https://graphql.org"><img src="https://img.shields.io/badge/GraphQL-E10098?style=for-the-badge&logo=graphql&logoColor=white" alt="GraphQL"></a>
</p>

### AI Infrastructure & Decision Engine
<p>
  <a href="https://typesafe.ai"><img src="https://img.shields.io/badge/TypeSafe_AI-000000?style=for-the-badge&logo=ai&logoColor=white" alt="TypeSafe AI"></a>
  <a href="https://typesafe.ai/blog/introducing-system-one-models-and-jev"><img src="https://img.shields.io/badge/Jev_1.13.0-FF69B4?style=for-the-badge&logo=cpu&logoColor=white" alt="Jev Model"></a>
  <a href="https://openai.com"><img src="https://img.shields.io/badge/OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white" alt="OpenAI"></a>
  <a href="AGENTS.md"><img src="https://img.shields.io/badge/Claude_Code-D97706?style=for-the-badge&logo=anthropic&logoColor=white" alt="Claude Code"></a>
</p>

### Automation, Testing & DevTools
<p>
  <a href="https://playwright.dev"><img src="https://img.shields.io/badge/Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white" alt="Playwright"></a>
  <a href="https://google.com/chrome"><img src="https://img.shields.io/badge/Google_Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Google Chrome"></a>
  <a href="https://git-scm.com"><img src="https://img.shields.io/badge/Git-F05032?style=for-the-badge&logo=git&logoColor=white" alt="Git"></a>
  <a href="https://github.com/features/actions"><img src="https://img.shields.io/badge/GitHub_Actions-2088FF?style=for-the-badge&logo=githubactions&logoColor=white" alt="GitHub Actions"></a>
  <a href="https://npmjs.com"><img src="https://img.shields.io/badge/npm-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="npm"></a>
</p>

---

## Architecture & Technical System Design

### System Component Architecture

```mermaid
flowchart TD
  classDef agent fill:#161b22,stroke:#1f6feb,stroke-width:1.5px,color:#c9d1d9
  classDef runner fill:#161b22,stroke:#8957e5,stroke-width:1.5px,color:#c9d1d9
  classDef storage fill:#161b22,stroke:#238636,stroke-width:1.5px,color:#c9d1d9
  classDef service fill:#161b22,stroke:#388bfd,stroke-width:1.5px,color:#c9d1d9

  HostAgent["Host Agent<br/>(Claude Code / Codex)"]:::agent
  CoreRunner["Runner Subsystem<br/>(scripts/apply.mjs)"]:::runner
  SchemaFetcher["Schema Fetcher<br/>(REST / GraphQL)"]:::service
  Planner["Planner & Normalizer<br/>(FormPlan)"]:::service
  JevAPI["TypeSafe Jev Decider<br/>(jev-1.13.0 API)"]:::service
  WriterAPI["Writer Engine<br/>(OpenAI / Host Model)"]:::service
  ExecEngine["Playwright CDP Executor<br/>(DOM Readback)"]:::service
  LocalStorage["Private Local Storage<br/>(~/.config/jev-apply/)"]:::storage
  LocalChrome["Dedicated Google Chrome<br/>(CDP Session)"]:::service
  ATSBoard["ATS Target Form<br/>(Greenhouse / Ashby / Lever)"]:::service

  HostAgent -->|Execute scripts/*.mjs| CoreRunner
  CoreRunner <-->|Read / Write State| LocalStorage
  CoreRunner --> SchemaFetcher
  CoreRunner --> Planner
  Planner -->|Canonical Choice Matching| JevAPI
  Planner -->|Grounded Essay Generation| WriterAPI
  CoreRunner --> ExecEngine
  ExecEngine -->|Attach via CDP| LocalChrome
  LocalChrome -->|Fill & Read Back DOM| ATSBoard
```

---

## Data Isolation & Privacy Storage Architecture

No candidate data, personal history, or credentials belong in this repository. All sensitive state is stored strictly under `~/.config/jev-apply/` with `0700` permissions.

```mermaid
flowchart LR
  classDef repo fill:#161b22,stroke:#1f6feb,stroke-width:1.5px,color:#c9d1d9
  classDef private fill:#161b22,stroke:#238636,stroke-width:1.5px,color:#c9d1d9

  subgraph Repository["Git Workspace (Public / Open Source)"]
    RepoFiles["Codebase & Scripts<br/>(Zero Personal Data / Secrets)"]:::repo
  end

  subgraph HomeConfig["~/.config/jev-apply/ (0700 Private Directory)"]
    Env["env<br/>(API Keys & Credentials)"]:::private
    Memory["memory/<br/>(facts, preferences, answers)"]:::private
    Docs["documents/<br/>(Résumé PDFs & links)"]:::private
    Apps["applications/<br/>(decisions.json, trace.jsonl)"]:::private
    Pipe["pipeline/<br/>(pipeline.yaml queue)"]:::private
    Profile["profile/<br/>(Chrome CDP session)"]:::private
  end

  RepoFiles -->|Reads configuration from| HomeConfig
```

---

## What happens to each field

**Jev matches** the form question to a saved fact, preference, story, or answer. **A writer drafts** only new prose supported by your material and the posting, when `p.auto_draft` is on: OpenAI, a named OpenAI-compatible model at a configured endpoint, or your CLI agent. **Playwright fills and reads back** every supported control.

Unknown personal facts, EEO choices, and policy attestations are **not model questions**. Your agent asks you when the exact answer is not on file. Drafts stay with that application unless you explicitly save them. Automatic submission is a separate opt-in; Lever always leaves Submit to you.

> [!NOTE]
> Experimental. Hosted Greenhouse, Ashby and Lever forms are supported; LinkedIn Easy Apply is not. Jev makes API calls, so this is not an offline tool.

### Platform Support Summary

| ATS Platform | Support Status | Schema Fetch | Submission Mode | Notes |
| :--- | :---: | :--- | :--- | :--- |
| **Greenhouse** | <img src="https://img.shields.io/badge/Supported-238636?style=flat-square" alt="Supported"> | REST API / DOM | Auto / Manual (`p.auto_submit`) | Direct field resolution |
| **Ashby** | <img src="https://img.shields.io/badge/Supported-238636?style=flat-square" alt="Supported"> | GraphQL API | Auto / Manual (`p.auto_submit`) | Native component support |
| **Lever** | <img src="https://img.shields.io/badge/Supported-238636?style=flat-square" alt="Supported"> | DOM Parsing | Manual Only | Always stops before hCaptcha challenge |
| **LinkedIn Easy Apply** | <img src="https://img.shields.io/badge/Excluded-DA3633?style=flat-square" alt="Excluded"> | N/A | N/A | Excluded per LinkedIn ToS §8.2 |

---

## The Four-Status Return Contract

`scripts/apply.mjs` outputs exactly one JSON object on `stdout` and exits `0` across all four operational outcomes:

| Status | Trigger Condition | Output Payload Summary |
| :--- | :--- | :--- |
| <img src="https://img.shields.io/badge/submitted-238636?style=flat-square" alt="submitted"> | Form filled, `p.auto_submit` resolved true, and ATS confirmation detected. | `{ slug, confirmation: { detected, text, url, screenshot }, filled, usage }` |
| <img src="https://img.shields.io/badge/ready__to__submit-1F6FEB?style=flat-square" alt="ready_to_submit"> | All fields resolved, `p.auto_submit` off/unset or ATS is Lever. | `{ slug, filled, summary: "ready for user review", usage }` |
| <img src="https://img.shields.io/badge/needs__user-D97706?style=flat-square" alt="needs_user"> | Unresolved facts, attestations, or agent draft items remaining. | `{ questions: [ { qid, label, options, remember_as, why } ] }` |
| <img src="https://img.shields.io/badge/blocked-DA3633?style=flat-square" alt="blocked"> | Unsupported ATS, captcha boundary, or unconfirmed submit. | `{ reason, detail, screenshot }` |

---

## CLI Command Reference (5 Core Verbs)

![Five Core Verbs & End-to-End Pipeline Motion](assets/jev-pipeline-animation.svg)

| Verb | Command | Function & Behavior |
| :--- | :--- | :--- |
| **1. Learn** | `node scripts/learn.mjs --resume cv.pdf --links <urls>` | Onboards background, extracts facts/stories, and outputs onboarding gaps. |
| **2. Apply** | `node scripts/apply.mjs --url <posting-url> --no-submit` | Fetches schema, plans decisions with Jev, drafts prose, and fills form via CDP. |
| **3. Remember** | `node scripts/remember.mjs "<verbatim-user-instruction>"` | Classifies and persists standing preferences or corrections into memory. |
| **4. Scan** | `node scripts/scan.mjs` / `node scripts/pipeline.mjs list` | Scans tracked company job boards, scores candidate fit, and updates pipeline. |
| **5. Queue** | `node scripts/apply.mjs --queue 5` | Plans N applications in parallel, fills tabs, and returns deduplicated questions. |

---

## Evidence and boundaries

The [form evaluation and per-page results](bench/results/fresh-pages.md) describe a measured set, not a universal success rate. The runner reads back filled controls, keeps the browser tab open for review, and records `submitted` only after the ATS confirms it. Start with `--no-submit` until you have inspected a real form yourself.

---

## Build and inspect

`npm run check:syntax` checks parsing, not application behavior. The [CI workflow](.github/workflows/ci.yml) runs it after `npm ci`; `node eval/plan.test.mjs` uses private memory and makes live, paid Jev calls. Browser fixture checks live in `scripts/controls-smoke.mjs` and `scripts/submit-smoke.mjs`. Read [AGENTS.md](AGENTS.md) for contributor rules and [docs/PLAN.md](docs/PLAN.md) for decisions.

---

## License

[MIT](LICENSE) © 2026 TheAdaply.





