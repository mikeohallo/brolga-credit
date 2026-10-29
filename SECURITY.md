# Security notes

Brolga Credit is a demonstration, not a product. It runs on one machine for one
operator, binds to `127.0.0.1` only, and keeps the Zepto token in `.env.local`,
which is never committed. There is no login of its own: anyone who can reach the
port can move money with the configured sandbox token, which is why the server
refuses to bind to anything but loopback.

## Reporting

Open a GitHub issue. There is no bug bounty and no SLA; this is a portfolio repo.

## Known advisories

Checked with `npm audit` on **29 October 2026**: no open advisories.

| Package | Severity | Where it sat | Reachable from the running app? | Status |
|---|---|---|---|---|
| `zod` < 4.6.6 (via `zod-validation-error` → `eslint-plugin-react-hooks` → `eslint-config-next`) | high (memory exhaustion while validating oversized constrained collections) | `devDependencies` only — the ESLint tool chain | No. Not in the production bundle; nothing at run time validates input with `zod`. | **Fixed 29 October 2026:** the lockfile moves `zod` to 4.6.7 (`npm audit fix`, one package, no other change). |
| `braces` 3.0.3 (via `micromatch` → `fast-glob` → `@next/eslint-plugin-next` → `eslint-config-next`) | high (stack-exhaustion denial of service on deeply nested glob patterns) | `devDependencies` only — the ESLint tool chain | No. | **Gone by 29 October 2026:** no longer reported by `npm audit` on the current lockfile (the lint config line moved on). Kept here as the record of the 18 October review. |

Next scheduled look **18 November 2026**, and on every dependency change.

## The investigator's model key

The Payments Exception Investigator (`scripts/investigate-*.mjs`, `src/lib/investigator/`)
calls a hosted model with a key read from `BROLGA_INVESTIGATOR_KEY` in `.env.local`
(or from the file `BROLGA_ENV_FILE` names). The key is used server-side only, is never
printed or written, and never reaches the browser. The offline suite blocks the network
and proves (T57) that the model path cannot be reached from the tests. The model sees
only a synthetic case file and its output never changes a loan, a payment or a state.

## What the CI workflow does and does not do

`.github/workflows/ci.yml` runs the offline suite, the linter and the build on every
push. It holds no secrets, makes no Zepto calls (the suite blocks `fetch` and runs
against the mock), and deploys nothing. Running the app, in sandbox or mock mode, is
done by hand on the operator's machine — see `CLAUDE.md`.

## What is deliberately not here

No authentication, no database, no webhook consumer, no automatic retry on the Zepto
client (lost responses are reconciled, not retried blind), and no reconciliation
queue. These are discussed in the README.
