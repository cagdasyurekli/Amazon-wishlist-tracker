# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Manifest V3 Chrome extension that tracks price/stock for Amazon products across several locales (`.com`, `.co.uk`, `.de`, `.fr`, `.es`, `.it`, `.nl`), including whole-wishlist import/sync. **Privacy-first: there is no backend.** All state lives in `chrome.storage` — never add network calls to anything but Amazon hosts.

*Note (2026-07-04): Root-level scratch files have been cleaned up and a professional `README.md` was added as the primary human entry point to this project.*

## Commands

- `npm test` / `npm run test:unit` — run the jsdom unit suite (excludes the E2E test).
- `npm run test:e2e` — Puppeteer headless test that loads the unpacked extension (covers popup, dashboard, wishlist bulk-sync). Runs under `NODE_OPTIONS=--experimental-vm-modules` with `--runInBand` to handle Puppeteer's ESM (via dynamic `import('puppeteer')`).
- `npm test -- src/__tests__/scraper.test.js` — run a single test file.
- `npm test -- -t "thousands separator"` — run tests matching a name.

**Popup UI preview harness** (verify any popup change visually): start the `popup-preview` server from `.claude/launch.json` (static server on port 8917) and open `/preview/`. It renders the real `popup.html/js/css` with `chrome.*` mocked and seeded fixtures (`preview/mock-chrome.js`); `?empty=1` shows the empty state, `?fail=1` simulates a missing content script, and `?tab=product|product-tracked|wishlist|wishlist-tracked|amazon-home|other` drives the current-tab context. The harness iframe sizes itself from popup content like a real popup (a fixed-height frame once masked a `100vh` collapse bug). Dev-only — never reference `preview/` from the manifest.

There is no build step or linter; source is loaded directly by Chrome. To run the extension manually, load the repo root as an unpacked extension at `chrome://extensions` (Developer Mode). All manifest-referenced icons (`assets/icon*.png`) must stay checked in — missing icons stop the MV3 service worker from registering and make E2E failures look like harness bugs.

## Architecture

The data flow is **scrape → parse (offscreen) → store → render**, with isolated execution contexts that only communicate via `chrome.runtime` messages and `chrome.storage`:

1. **Service worker** (`src/background/background.js`) — the orchestrator. Three `chrome.alarms` drive scraping: `checkPricesAlarm` (15 min, round-robin slice of `ITEMS_PER_ALARM`=5 via persisted `scrapeCursor`), `checkPriorityPricesAlarm` (5 min, only items with `isPriority`, own `priorityScrapeCursor`), and `checkWishlistsAlarm` (6 h, re-scrapes tracked wishlists; with `autoSync` it also adds new wishlist items). **All scrape jobs are serialized through `enqueueScrapeJob()`** — the alarms regularly coincide and concurrent jobs clobber each other's bulk writes; any new background job that writes `trackedItems` must go through this queue. Scrapes run **sequentially** with 2–5s jitter; the slice-per-alarm design keeps runs short enough to finish before MV3 tears the worker down. Message handlers: `ADD_TRACKED_ITEM` (the single place that validates the Amazon host and applies `settings.defaultDiscount` to new items — don't move item creation off this path without re-wiring it), `CHECK_IF_TRACKED`, `EXTRACT_WISHLIST` (paginated background scrape), and `BULK_ADD_TRACKED_ITEMS` (wishlist import/sync merge). Key behaviors:
   - **Batched persistence**: items mutate in memory during a run and are written **once** at the end — item array via `saveTrackedItems()`, run-state keys in a single `setStorageItems()` call. Do not reintroduce per-item writes inside the loop.
   - **Persisted back-off circuit-breaker** (generic — `BACKOFF_ERRORS` covers `CAPTCHA_BLOCKED` and `RATE_LIMITED`), because in-memory flags don't survive worker teardown. On a back-off error the run aborts and `activateBackoff()` sets `captchaBackoffUntil` / `captchaBackoffAttempts` (exponential, base 1h, capped 24h) in local storage; every scrape job returns early while back-off is active and `clearBackoff()` resets after a clean run. (The storage *key strings* keep the `captcha…` prefix to avoid orphaning existing data; the JS identifiers are generic.)
   - **Alert guards**: `processScrapeResult` skips history/price alerts when `result.price == null`, and the restock alert only fires on an explicit `wasInStockPreviously === false` transition (not on first observation).

2. **Scraper** (`src/background/scraper.js`) — does the `fetch` (no DOM APIs in an MV3 worker) and hands raw HTML to the offscreen document. `scrapeAmazonProduct(url)` validates the host against the Amazon allowlist, uses an `AbortController` timeout (15s → `FETCH_TIMEOUT` error), and maps HTTP 429/503 to `RATE_LIMITED` (which feeds the back-off). `scrapeAmazonWishlist(url)` follows pagination (`nextPageUrl`, max 150 pages, stops after 3 empty/duplicate pages) and broadcasts `WISHLIST_IMPORT_PROGRESS` for UI progress. Both manage the offscreen document lifecycle; the worker closes it after each job so an idle SW doesn't keep a DOM page alive.

3. **Offscreen document** (`src/background/offscreen.{html,js}`) — the **only** place with `DOMParser`. `parseAmazonHtml()` (product pages) and `parseAmazonWishlist()` (wishlist pages, incl. Amazon's native "price dropped X%" metadata) handle messages filtered by `message.target === 'offscreen'`. The file is dual-purpose: loaded as a plain script in the offscreen page **and** `require`d by Jest via the CommonJS shim at the bottom — keep that shim and keep the file framework-free.

4. **Content script** (`src/content/content.js`) — injected on Amazon pages. Injects the "Track Price" button (marks it already-tracked via `CHECK_IF_TRACKED`), sends `ADD_TRACKED_ITEM` on click (it does **not** write storage directly), answers the popup/dashboard's `TRACK_CURRENT_PAGE` and `EXTRACT_VISIBLE_WISHLIST` messages. Amazon renders the buy box asynchronously, so a `MutationObserver` (self-disconnecting, 15s timeout) re-attempts injection. Its `parsePrice`/`extractCurrency` are **intentionally duplicated** from the offscreen parser — content scripts can't `import` without a bundler this project doesn't have; keep the copies in sync.

5. **Popup** (`src/popup/`) — a **quick-actions surface, not a list** (a real user with 784 items proved a full list doesn't fit a 400×600 popup): item count, a context-aware current-tab action, the 3 most recently updated items, and a "View All" button into the dashboard. The tab action must never offer to track a non-Amazon page, an already-tracked product, or a tracked wishlist — untracked products get "Track This Product", untracked wishlists get "Import This Wishlist" (deep-link `dashboard.html?import=<url>`), tracked ones get a passive "✓ Already tracking…" line. **Popup CSS heights must be content-driven — never `100vh`**, which is circular in an extension popup and collapses the layout. All outcomes surface through the inline status banner (no blocking dialogs; price-drop badges are green — a drop is good for a shopper). The header's 📊 button is the primary dashboard entry point (E2E-guarded — don't remove it).

6. **Dashboard** (`src/dashboard/`) — the full management surface (opened via the popup 📊 button): sorting (persisted as `settings.dashboardSort`), search, priority toggles (⭐, max 10), detailed axis-labelled charts, and the wishlist import flow — it first tries `EXTRACT_VISIBLE_WISHLIST` from an open wishlist tab, falling back to the background `EXTRACT_WISHLIST` paginated scrape, then saves via `BULK_ADD_TRACKED_ITEMS` and records the wishlist (with `autoSync` flag) in `trackedWishlists`.

7. **Options** (`src/options/`) — `historyRetentionDays` (drives pruning) and `defaultDiscount` (applied in the background, §1), data export, clear-history.

Everywhere: untrusted scraped strings (title, seller) must be rendered via `textContent`, never `innerHTML`. Price history renders on plain `<canvas>` — do **not** reintroduce a charting library (MV3's `script-src 'self'` CSP blocks CDNs, and a previously vendored Chart.js was removed as dead weight). Prices render via the shared `formatPrice(price, currency)` from `storage.js`.

### Storage model (`src/utils/storage.js`)

All storage goes through this wrapper. Area choice matters because of `chrome.storage.sync` quotas (8 KB/key):
- `trackedItems`, `trackedWishlists` → **`local`**. `getTrackedItems()` transparently migrates the legacy `sync` copy to `local` on first read.
- `priceHistory`, `lastScrapeTime`, `scrapeCursor`, `priorityScrapeCursor`, `captchaBackoffUntil`, `captchaBackoffAttempts` → **`local`**.
- `settings` → **`sync`** (small, benefits from cross-device sync).

Helpers: `setStorageData(key, value, area)` for single keys, `setStorageItems(values, area)` for multi-key single-call writes. `saveTrackedItem()` and `removeTrackedItem()` are serialized through a shared promise-chain mutex (`withSaveLock`); the background jobs instead use `saveTrackedItems()` (one bulk write) under the scrape-job queue. `prunePriceHistory()` reads `settings.historyRetentionDays` (default `"30"`, `"forever"` skips), keeps points newer than the cutoff and thins older data to one point/day. The manifest requests `unlimitedStorage`.

## Conventions specific to this repo

- **`docs/lessons_learned.md` is the shared knowledge base across agents (AGY, Claude, Codex). Read it before changing scraping, storage, or extension architecture, and append findings there rather than fixing silently** — it carries severity-tagged decisions, the QA-accepted risks (e.g. `BULK_ADD_TRACKED_ITEMS` writes outside the mutex, dashboard still uses `prompt()`), and open issues (request volume / IP-ban risk).
- **A feature without an entry point doesn't exist.** When adding a page or flow, wire its navigation in the same change and add an E2E assertion for it (the dashboard shipped unreachable once).
- **Amazon DOM is volatile.** Price selectors live as an ordered list in `parseAmazonHtml`; when one breaks, add the new selector to the front and add a fixture-based test rather than rewriting logic.
- **Price parsing** must handle both US (`1,299.99`) and EU (`1.299,95`) conventions — the decimal separator is the last `.`/`,` followed by 1–2 trailing digits.
- **Stock detection** relies on substring matching where positives can hide inside negatives (`available` inside `unavailable`, `available from these sellers`). Negative phrases must veto a positive match.
- **Cross-context messaging:** never fire-and-forget a `chrome.tabs.sendMessage` / `chrome.runtime.sendMessage` behind a fixed `setTimeout`. Await the response, check `chrome.runtime.lastError` (a missing content script is the common case — surface it to the user), and confirm the outcome in the surface the user is looking at. Async `onMessage` handlers must `return true` to keep the channel open.
- **Don't land tests for planned-but-unbuilt UI** — a red suite that "will pass later" hides real regressions.
