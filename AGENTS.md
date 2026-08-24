# AGENTS.md — Amazon Wishlist Tracker

## Product and documentation authority

This repository is a privacy-first Manifest V3 Chrome extension for tracking Amazon
product and public/shared wishlist prices. There is no backend or analytics service.

Read these sources in this order:

1. `AGENTS.md` for repository-wide engineering rules.
2. `docs/USER_MANUAL.md` for installation and user workflows.
3. `docs/feature_specs.md` for expected observable behavior. It is a contract to
   verify against code and tests, not proof that the implementation conforms.
4. The task-relevant heading in `docs/lessons_learned.md` for historical pitfalls.

`CLAUDE.md` and `GEMINI.md` are discovery pointers only; they do not add authority.
Do not load the entire lessons log when a relevant heading is enough.

## Repository map

- `manifest.json`: permissions, Amazon host allowlist, extension pages, and assets.
- `src/background/`: service-worker orchestration, alarms, scraping, notifications,
  and the offscreen parser bridge.
- `src/content/`: Amazon-page detection and the in-page tracking action.
- `src/popup/`: quick actions and highlights.
- `src/dashboard/`: tracked-item management, wishlist import/sync, filters, and charts.
- `src/options/`: alert defaults, history retention, export, and history clearing.
- `src/utils/storage.js`: storage areas, migration, merge, and serialization helpers.
- `src/__tests__/`: Jest parser/unit coverage and Puppeteer extension E2E coverage.
- `assets/`: manifest-referenced icons. Missing icons can prevent MV3 startup.

Execution contexts are isolated. Communicate through `chrome.runtime` messages and
`chrome.storage`; keep parsing of background-fetched HTML in the offscreen document.
The content script may inspect the visible Amazon page DOM for its in-page product and
wishlist flows.

## Setup and verification

Use the checked-in lockfile and project-local dependencies:

```bash
npm ci
npm test
npm run test:e2e
npm run visual:qa
```

There is no build step. Chrome loads the repository root directly as an unpacked
extension. `npm test` is the unit/parser gate; E2E loads the MV3 extension and checks
selected startup and UI contracts, but is not exhaustive browser acceptance.

Run `npm test` for every code change. Also run `npm run test:e2e` after changing the
manifest, icons, background startup, storage/message contracts, popup, dashboard,
options, or extension navigation. Add focused parser fixtures when Amazon markup,
price/stock detection, CAPTCHA/rate-limit handling, or wishlist pagination changes.
Visually exercise affected user flows for UI changes.

`npm run visual:qa` is a reproducible offline visual smoke check. It uses local
Puppeteer and synthetic extension storage only, writes ignored screenshots to
`artifacts/visual-qa/`, including previous-target warning and resolved states, and
must not navigate to Amazon or use real user data.

## Durable boundaries

- Network requests may target only the exact Amazon hosts allowed by `manifest.json`.
  Adding a permission, network destination, credential flow, or storage-area change
  requires explicit privacy and security review.
- Tracked items, wishlists, price history, and scrape state live in
  `chrome.storage.local`. Small preferences live in `chrome.storage.sync` and may
  follow the user's Chrome profile. Never describe all settings as local-only.
- Never request, store, or transmit Amazon credentials or session cookies. Background
  fetches intentionally operate without the user's Amazon session.
- Treat titles, sellers, prices, and all scraped strings as untrusted. Render them
  with `textContent` or safe DOM APIs, never string-built `innerHTML`.
- MV3 extension pages must not load remote scripts or CDNs.
- Preserve concurrent user edits: use the serialized storage helpers for user
  mutations and merge long-running scrape results into the latest collection. Never
  restore a stale whole-array snapshot after network work.
- Keep background scrape jobs serialized through the shared queue. Maintain bounded,
  sequential request pressure and the persisted backoff circuit breaker.
- Do not move DOM APIs into the service worker or remove the guarded CommonJS test
  export from the offscreen parser without updating both runtime and tests.

## Change workflow

Prefer the smallest testable change. For ambiguous architecture or trust decisions,
compare at least two viable options by user value, implementation cost, portability,
and residual risk; change direction when evidence invalidates an assumption.

When externally observable behavior, permissions, storage semantics, or supported
Amazon compatibility changes, update `docs/feature_specs.md` and relevant tests in the
same change. When setup, user workflows, privacy, or troubleshooting changes, update
`docs/USER_MANUAL.md` and the concise README entry point. Record only durable,
non-obvious lessons under the relevant heading in `docs/lessons_learned.md`; do not
append routine task history or use old lessons as current authority.

Do not commit, push, merge, publish, or broaden permissions unless the current user
request explicitly authorizes that action.
