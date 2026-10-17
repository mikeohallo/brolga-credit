# Security notes

Brolga Credit is a demonstration, not a product. It runs on one machine for one
operator, binds to `127.0.0.1` only, and keeps the Zepto token in `.env.local`,
which is never committed. There is no login of its own: anyone who can reach the
port can move money with the configured sandbox token, which is why the server
refuses to bind to anything but loopback.

## Reporting

Open a GitHub issue. There is no bug bounty and no SLA; this is a portfolio repo.

## Known advisories

Checked with `npm audit` on **18 October 2026**.

| Package | Severity | Where it sits | Reachable from the running app? | Status |
|---|---|---|---|---|
| `braces` 3.0.3 (via `micromatch` → `fast-glob` → `@next/eslint-plugin-next` → `eslint-config-next`) | high (stack-exhaustion denial of service on deeply nested glob patterns) | `devDependencies` only — the ESLint tool chain | No. It is not in the production bundle and nothing at run time evaluates glob patterns from user input. The only way to trigger it is to feed a hostile pattern to `npm run lint` on your own machine. | No patched version within the current `eslint-config-next` line. `npm audit`'s only "fix" is a major downgrade of the lint config, which is not taken. Re-reviewed on every dependency change; next scheduled look **18 November 2026**. |

Everything else reported by `npm audit` on that date is the same chain counted once
per hop (`micromatch`, `fast-glob`, `@next/eslint-plugin-next`, `eslint-config-next`).

## What the CI workflow does and does not do

`.github/workflows/ci.yml` runs the offline suite, the linter and the build on every
push. It holds no secrets, makes no Zepto calls (the suite blocks `fetch` and runs
against the mock), and deploys nothing. Running the app, in sandbox or mock mode, is
done by hand on the operator's machine — see `CLAUDE.md`.

## What is deliberately not here

No authentication, no database, no webhook consumer, no automatic retry on the Zepto
client (lost responses are reconciled, not retried blind), and no reconciliation
queue. These are discussed in the README.
