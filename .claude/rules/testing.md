# Testing pyramid (always)

Protect production: **unit → integration → E2E**. Cheaper models run checks via `test-runner`; planner fixes root cause.

## What to test

| Layer | Scope | Examples |
|---|---|---|
| **Unit** | Pure logic, one class/function | Calculations, validators, mappers, cubits (mocked IO) |
| **Integration** | API + DB, repos, jobs | Laravel `Feature/*`, Nest e2e, Flutter repo tests with fakes |
| **E2E** | User journeys | Playwright (`smoke.mjs`), Flutter `integration_test`, device POC scripts |

Do not unit-test every widget pixel. Use `visual-qa` for layout.

## Commands (pick what this repo has)

| Stack | Unit / integration | E2E / smoke |
|---|---|---|
| Laravel (`ttakka-apis`, dashboards API) | `php artisan test` | Feature suites named in repo README |
| React/Vite | `npm test`, `npm run build` | Playwright if configured |
| Flutter | `flutter test` | `integration_test/` on tablets/phones per deploy skill |
| Nest/Node | `npm test` | API e2e in `test/` |

Never call real payment gateways, SMS, or production DB from tests. Mock external APIs.

## Before push

1. Run the repo’s fastest relevant suite for touched code.
2. On release paths: full integration suite + smoke for that app.
3. **Never** delete or skip tests to get green.
