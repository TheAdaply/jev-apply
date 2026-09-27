<div align="center">

# jev-apply

**A job-application skill with a memory.** Give it a résumé and a posting. It fills what your record supports, drafts grounded prose when you allow it, and leaves the rest open rather than guessing.

<p align="center">
  <a href="https://github.com/theadaply/jev-apply/stargazers"><img src="https://img.shields.io/github/stars/theadaply/jev-apply?style=flat-square&logo=github" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://google.com/chrome"><img src="https://img.shields.io/badge/chrome-CDP%20Required-4285F4.svg?style=flat-square&logo=googlechrome&logoColor=white" alt="Chrome CDP"></a>
  <a href="https://typesafe.ai"><img src="https://img.shields.io/badge/TypeSafe%20AI-System%20One-000000.svg?style=flat-square" alt="TypeSafe AI"></a>
  <a href="https://console.typesafe.ai/keys"><img src="https://img.shields.io/badge/decider-Jev%201.13.0-ff69b4.svg?style=flat-square" alt="TypeSafe Jev"></a>
  <a href="AGENTS.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" alt="PRs Welcome"></a>
</p>

<br/>

[![Watch the 72-second walkthrough: saved answers, grounded prose, and a real local browser fill.](assets/jev-apply-demo-poster.png)](https://github.com/user-attachments/assets/53641047-2f50-42d1-bf18-0e3cf44d5b31)

*72 seconds · silent walkthrough · synthetic data · no application sent*

</div>

---

## Give it to your CLI agent

In Codex, Claude Code, or another CLI agent:

```text
Set up TheAdaply/jev-apply. Read SKILL.md and INSTALL.md; install it.
Show me where to enter my Jev key privately, not in chat. Learn my résumé.
Fill the job URL I give you with --no-submit on every run and rerun.
Use this CLI model for drafts grounded in my record unless I set a writer.
Show me the filled form; ask only for missing facts, choices or attestations.
```

The agent handles setup. You provide a [TypeSafe Jev key](https://console.typesafe.ai/keys)
privately—not in chat. Requires Node 20+ and Chrome; OpenAI is optional.

Experimental: hosted Greenhouse, Ashby, and Lever forms. No LinkedIn Easy Apply.
Personal facts, demographic choices, and policy attestations come from you.
Private memory stays on disk; model APIs receive request data and may incur costs.

[Agent guide](SKILL.md) · [Setup](INSTALL.md) · [Engineering](AGENTS.md) · [Measured results](bench/results/fresh-pages.md) · [MIT](LICENSE)
