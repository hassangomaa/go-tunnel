# Delegation lanes and workflow (always)

The main session (planner) **plans, decides and reviews**. Helpers in `.claude/agents/` **do the work** (orchestrator–worker). Say the lane first.

## Step 0: pick the lane

| Lane | Examples | Who builds |
|---|---|---|
| 🟢 **Small** | Typo, copy, 1–2 file tweak | Planner directly |
| 🟡 **Medium** | Bug across a few files, new field | `implementer` from a short plan |
| 🔴 **Large** | Feature, payments, auth, permissions | Full workflow below |

**Always 🔴:** sign-in, secrets, permissions, payments, PII, production deploy, cross-ecosystem Telegram.

## Helpers

| Agent | Model | Job |
|---|---|---|
| `Explore` | haiku | Find code (read-only) |
| `summarizer` | haiku | Summarise logs/docs (read-only) |
| `researcher` | sonnet | Official docs + web brief |
| `implementer` | sonnet | Builds 🟡🔴 plans |
| `test-runner` | haiku | Runs checks, failures only |
| `visual-qa` | sonnet | Desktop + phone UI check |
| `seo-a11y-auditor` | sonnet | Public pages audit (read-only) |

## Workflow (🔴 high risk — production apps)

| Step | Who | What |
|---|---|---|
| 1 | Owner | Describes the idea |
| 2 | Planner | Lane + plan |
| 3 | `researcher` | If new integration |
| 4 | `implementer` | Build (🟢: planner) |
| 5 | `test-runner` | Unit + integration checks per `testing.md` |
| 6 | `visual-qa` | If UI changed |
| 7 | Planner | Review + security on 🔴 |
| 8 | Owner | Approve → push → deploy per repo RUNBOOK |
