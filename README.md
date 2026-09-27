# jev-apply

**Fill job applications from what you've already told your agent.**

[![Watch the 72-second walkthrough: saved answers, grounded prose, and a real local browser fill.](assets/jev-apply-demo-poster.png)](https://github.com/user-attachments/assets/53641047-2f50-42d1-bf18-0e3cf44d5b31)

*72 seconds · silent walkthrough · synthetic data · no application sent*

Give it your résumé and a posting. It reuses saved answers, drafts grounded prose
when you allow it, and fills the form for you to review. Missing personal details
stay questions—not guesses.

## Give it to your CLI agent

In Codex, Claude Code, or another CLI agent:

```text
Set up TheAdaply/jev-apply.
Follow SKILL.md.
Use INSTALL.md for setup.
Learn my résumé. Fill a URL
I give you, --no-submit on
every run and rerun.
Draft from saved material
with this CLI model unless
I configure another writer.
Show me the form; ask for
missing facts and choices.
```

The agent handles setup. You provide a [TypeSafe Jev key](https://console.typesafe.ai/keys)
privately—not in chat. Requires Node 20+ and Chrome; OpenAI is optional.

Experimental: hosted Greenhouse, Ashby, and Lever forms. No LinkedIn Easy Apply.
Personal facts, demographic choices, and policy attestations come from you.
Private memory stays on disk; model APIs receive request data and may incur costs.

[Agent guide](SKILL.md) · [Setup](INSTALL.md) · [Engineering](AGENTS.md) · [Measured results](bench/results/fresh-pages.md) · [MIT](LICENSE)
