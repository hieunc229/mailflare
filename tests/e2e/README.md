# Passkey browser tests

Install Chromium once with `npx playwright install chromium`, then run:

```sh
npm run test:e2e -- tests/e2e/passkeys.spec.ts
```

By default, Playwright starts the development server on port 3000 and refuses
to reuse an existing server. To explicitly select a running test instance:

```sh
PLAYWRIGHT_BASE_URL=http://localhost:3001 npm run test:e2e -- tests/e2e/passkeys.spec.ts
```

To keep your normal local database untouched, start a separate instance with
disposable storage, then target it with `PLAYWRIGHT_BASE_URL`:

```sh
MAILFLARE_TEST_STATE_PATH="$(mktemp -d)" npx vp dev --port 3002 --strictPort
```

On a clean instance the suite calls `POST /api/setup/prepare` once before the
first test, so the schema exists before the demo account is reset. The route
applies the bundled migrations and must answer 200, or 403 when an admin
already exists. A 503 means the server's setup checks are not met, for example
a missing `CF_TOKEN` in `.dev.vars`; the run fails instead of continuing
without a seeded account.

Use a disposable local instance: the tests reset `admin@example.com` before and
after each scenario, deleting its passkeys, sessions, and other account data.
They leave the demo password `demo-password-change-me` usable afterward. Do not
point them at an installation containing data you want to keep. Avoid concurrent
runs against the same instance or test-output directory.

The tests use Chromium's virtual authenticator; no physical security key is
needed. They cover desktop and mobile web, not native mobile applications.
