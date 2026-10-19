# Model roles: Sonnet runs, Opus decides (hard rule)

Hassan Gomaa, 2026-10-19. Applies to every repo under `~/Projects` (Mac) and `D:\Projects`
(Windows), to the global Claude config (`~/.claude/`), and to local and remote (cloud)
Claude sessions. Works together with `delegation.md` (lanes and helpers) and `testing.md`.

> الوكلاء: 2 Sonnet بيشغلوا السكريبتات · Opus بيقرر ويراجع
> Agents: 2 × Sonnet run the scripts · Opus decides and reviews

| Role | Model | Does |
|---|---|---|
| 🛠️ Runner | **Sonnet** (Haiku for light read-only work: search, logs, summaries, test runs) | builds, runs scripts, scans, tests; reports counts and failures back |
| 🧠 Decider / QA | **Opus** (the main session) | plans, picks scope, approves every write to a shared environment, reviews each agent's result against the code/data before anything is reported or shipped |

## Rules

1. **Up to 2 Sonnet agents at a time**, each with disjoint files, an explicit
   "done means", and hard limits (what it must not write, push, send or unlock).
2. **Decisions stay with Opus.** An agent reports; it never decides to commit, push,
   deploy, sync to a client environment, unlock, email or post. Opus commits only the
   agent's paths after reviewing the diff.
3. **Opus re-checks before reporting.** At least one independent spot check of an
   agent's key claim (a test run, a count, a file, a live endpoint) before it is
   repeated to Hassan. A green gate is not proof the output is right.
4. **Status messages name the split**, Arabic then English:
   `الوكلاء: 2 Sonnet بيشغلوا السكريبتات · Opus بيقرر ويراجع`
5. **Token discipline:** search and summarise with Haiku/Sonnet; never paste large
   logs or files into the main session — ask for the conclusion.
6. Repo rules on secrets, production protection, email send gate, Telegram via Ziad,
   and syncing verified work to GitHub `main` still apply unchanged.
