## What is the issue?

_Link the issue and describe the problem in 1-2 sentences. Say who it affects and when._

> **Example:** Fixes #123. Replying to a message with several recipients drops everyone in Cc, so people on the thread stop receiving the conversation. Affects all users who use "Reply all".

## How does this PR resolve it?

_Summarise the approach and why you chose it over alternatives. No need to list every changed line. Point out anything a reviewer should look at closely: schema or migration changes, new env vars, behaviour changes for existing installs._

> **Example:** `buildReplyAll` now keeps `ccAddr` from the source message and removes the user's own address, instead of rebuilding the list from `toAddr` only. Went with this over a second query because the data is already loaded. No schema change.

## Steps to reproduce (optional)

_Bug fixes only. Skip for features and refactors. Give steps a reviewer can follow, then show the result before and after._

> **Example:**
> 1. On `main`, open a message sent To: a@x.com, Cc: b@x.com.
> 2. Click "Reply all". Cc is empty.
> 3. On this branch, Cc contains b@x.com.

## Demo

_Show the change working._

- **UI changes: a screenshot is required.** Use before/after if you changed existing UI. Add a short video for flows with several steps. Check dark mode and mobile width if the change touches layout.
- **API or backend changes:** a request/response, or a log snippet.
- **No visible change (docs, refactor, tests):** write "N/A" and say why.

> **Example (UI):** Before / After screenshots side by side, e.g. `![before](url) ![after](url)`
>
> **Example (API):**
> ```
> $ curl -H "Authorization: Bearer $KEY" /api/v1/messages?limit=1
> { "messages": [{ "id": "...", "ccAddr": "b@x.com" }] }
> ```

## How was it tested?

_List the checks you ran and what you verified by hand. State anything you could not test._

> **Example:**
> - `node --test tests/*.test.mjs` passes
> - `npx tsc --noEmit` passes
> - By hand in `npm run dev`: replied to a 3-recipient message, Cc kept and own address removed
> - Not tested: PostgreSQL/MySQL (no schema change)
