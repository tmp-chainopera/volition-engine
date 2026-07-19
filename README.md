# Volition Engine · 愿力引擎

[![English](https://img.shields.io/badge/lang-English-2ea44f?style=for-the-badge)](README.md)&nbsp;[![中文](https://img.shields.io/badge/lang-中文-lightgrey?style=for-the-badge)](README.zh.md)

![Volition Notebook](English.png)

> Turn an agent from *ask-and-answer* into *it proactively drives the things you truly care about*.

## What is this

Express an idea in chat and you **charge it with a little power** — we call it *will* (愿力).

The more you bring it up and the more you care, the more charge it builds. Cross a threshold and the agent flips from passive replies to **proactive mode**: it gathers information, matches resources, and drives the thing toward done — on its own. Stop mentioning it and the charge quietly leaks away, so it cools down and stops. **It spends effort only on what you keep caring about.**

## Will, like electricity

| | In real life | In the system |
|---|---|---|
| 🔌 Charge | You express / reinforce an idea | That thing's will goes up |
| 🔋 Self-discharge | You haven't mentioned it for a while | Will decays over time (the idea naturally fades) |
| 🔥 Ignite | You genuinely want to do it | Enough charge → the agent goes proactive and starts working for you |
| ⚡ Draw | It keeps running for you | Running draws power; when it's low it auto-stops |

## What it does for you

- **Proactively advances several things at once**, auto-ordering them by how much you care — no manual priority juggling.
- **One dashboard shows what it's doing right now** — which thing is progressing, how far, how much energy it's burning.
- **Multiple workspaces**: each notebook is isolated; the engine advances them in parallel in the background.
- **Real-world actions — spending, ordering, sending messages — always ask for your approval first.** It never touches your money or resources on its own.
- **The notes and docs you jot down are its working brief** — write them and it adjusts its next step accordingly.
- **Always aligned with what you actually mean**; if it drifts, it comes back to confirm with you instead of plowing ahead wrong.

## Quick start

```bash
cd demo
node server.mjs          # open http://localhost:5179
```

- The judgment/chat layer runs on your **Claude Code subscription** by default (no API key), or can switch to the **Anthropic API**.
- Full deployment (prerequisites, both billing modes, data layout, security, troubleshooting): **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Learn more

- [Deployment guide — docs/DEPLOY.md](docs/DEPLOY.md) — how to install, configure, and troubleshoot.
- [Design — docs/DESIGN.md](docs/DESIGN.md) — full mechanics: how will is computed, ignited, and kept from drifting.
- [Frontend — docs/FRONTEND.md](docs/FRONTEND.md) — what the dashboard looks like and how notes steer it.

> **A locally-deployable open-source project** — self-host it, bring your own Claude credentials (subscription or API key); all data stays on your machine.
