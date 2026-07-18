# Handoff contract: browser testing

Binding when the handoff prompt names this file. The prompt supplies the checklist of steps; this file supplies everything else.

## Setup

- ADAPT: name your browser tooling and config (Playwright/Puppeteer setup, which browser channel, where the config lives).
- ADAPT: where the test site URL and credentials are documented. Never hardcode credentials into prompts or reports.

## Hard boundaries

- **Verification only.** A failing step gets its exact error text and a screenshot, then you MOVE ON. Diagnosis is a separate handoff the orchestrator dispatches afterwards.
- Do not change application settings. Do not complete real payments (reaching the checkout page is the pass condition). Do not delete or moderate content unless the prompt explicitly names a throwaway item and the allowed actions on it.
- Wait a few seconds after any action that triggers async work (webhooks, background jobs, external mirrors) before asserting the result.
- Only the browser: server-side state (database rows, external API state, logs) is verified by the orchestrator afterwards. Design your evidence so it can be correlated: URLs, timestamps, IDs.

## Return format

1. PASS/FAIL per checklist step, one-line observation each.
2. Screenshot path per step, stored with descriptive names.
3. Exact error text for any failure.
4. URLs/IDs of anything you created.
5. Unrelated anomalies you noticed (error banners, console errors, broken strings) as report-only observations. Never fix them, never investigate them.
