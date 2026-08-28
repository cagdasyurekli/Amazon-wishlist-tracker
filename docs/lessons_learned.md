# Agent Lessons Learned & Knowledge Base

This document is a living record of mistakes made, bugs encountered, and architectural decisions established during the development of the Amazon Wishlist Tracker extension.

**All AI Agents (AGY, Claude, Codex) MUST review this file before making changes, and MUST append any new findings here to prevent future agents from making the same mistakes.**

Severity legend: 🔴 critical (will break for real users / risk of ban) · 🟠 high · 🟡 medium · 🟢 minor / note.

---

## 0H. Security Boundaries Without Product Regressions (Codex, 2026-08-24)

- 🔴 **Freeform marketplace text is not an authority signal.** CAPTCHA and purchased words can appear in titles, descriptions, or injected row text. CAPTCHA requires both semantic and structural challenge evidence; purchased text must never delete a product/history or cause a destructive-state notification.
- 🔴 **A successful HTTP status is not a complete wishlist.** Login pages, generic shells, interstitials, duplicate pages, and incomplete markup are `indeterminate`. Only a structurally identified terminal wishlist page may authorize missing-item reconciliation.
- 🟠 **Network bounds must cover the body and parser, not only response headers.** Keep the timeout active through streamed body consumption and offscreen parsing; enforce HTTPS host/identity-preserving redirects, HTML content type, per-page bytes, traversal bytes/items/pages/time, and persisted-state size.
- 🟠 **Continuation fairness is part of availability.** Persist cumulative counters, advance the wishlist cursor after every partial chunk, and schedule the next continuation after about 60 seconds. A large or hostile list must not starve other lists; budget exhaustion discards only partial operational state.
- 🟠 **Security gates need positive compatibility proof.** Alongside malicious fixtures, cover all supported Amazon storefronts, regional image CDNs, realistic lazy-image wishlist markup, an existing-item tracking flow, a genuine browser click, large-list UI, and restart recovery. A rejected synthetic event does not prove the real user path still works.
- 🟠 **A structural CAPTCHA signal must be challenge-owned.** A seller title and image alt can repeat the same CAPTCHA phrase and must not activate global backoff. Require a real captcha input or a captcha-action form containing its marker image; a standalone image marker is never enough.
- 🟠 **Bound every ingress, not just scheduled work.** Background continuation budgets do not protect visible-tab extraction or dashboard bulk messages. Cap rows, fields, message items, and the durable collection while keeping the 784-item and whole-list selection regressions green.
- 🟡 **Legacy URL cleanup belongs at every navigation sink.** Old stored HTTP Amazon links may predate strict fetch validation. Bind the URL to the stored ASIN, upgrade only a valid supported Amazon product path to HTTPS, and suppress everything else before popup/dashboard/notification navigation.
- 🟡 **Remote HTML parsing must remain resource-inert.** Neutralize scripts, frames, links, styles, and fetch-capable attributes before parsing, use a restrictive offscreen CSP, and keep only allowlisted HTTPS Amazon image URLs. Unknown image hosts should lose the image rather than the tracked product.
- 🟡 **Legacy Sync cleanup is a verified migration.** Write tracked items locally, read back and compare the durable copy, then remove the Sync key. Residual cleanup must be idempotent, including when the valid local collection is an empty array.
- 🟡 **Availability must fail safely across locales.** Normalize marketplace wording and test every supported locale; evaluate unavailable phrases before available phrases so a negative phrase containing a positive substring cannot produce a false in-stock result.
- 🟡 **A marketplace addition crosses several allowlists.** Supporting `amazon.com.tr` requires the exact HTTPS manifest/content-script pattern, canonical/background/offscreen host validation, localized availability phrases, currency normalization, and positive product/wishlist regressions. Updating only the manifest produces partial, misleading support.
- 🟡 **Real wishlist IDs may contain `=` padding.** A live Amazon Turkey list used a bounded 20-character ID with one `=` character, so `[a-z0-9_-]` rejected an otherwise valid canonical list. Keep `=` inside the bounded single-segment ID grammar across URL parsing, offscreen identity checks, bulk ownership, backup validation, and test doubles; never loosen slash, host, scheme, port, or redirect validation with it.
- 🟡 **The selected wishlist is not always present in the address bar.** Amazon.nl can render a signed-in list at the generic `/wishlist` route. Visible-tab sync must bind that page to the requested list through the bounded `colid` carried by its product rows before accepting any extracted items; URL-only matching silently discards the authenticated page and falls back to an unauthenticated background fetch.
- 🔴 **A visible wishlist DOM is not a complete wishlist.** Amazon.nl initially mounts only about 10 rows even when the list contains hundreds of products. Never let a successful visible-tab response short-circuit the bounded background paginator; visible rows are an identity-bound partial fallback, not proof of completeness.
- 🟡 **History compaction is data preservation, not deletion.** Keep recent raw samples, represent older windows with actual low/high timestamps, make compaction idempotent, and validate an export with the same restore contract before offering it for download.

---

## 0G. Saved Signal UI, Accessibility & Wishlist Continuation (Codex, 2026-08-24)

- 🟠 **Runtime accessibility state must follow visual state.** A static `aria-pressed="false"` or `aria-expanded="false"` in a template becomes misleading as soon as JavaScript toggles priority/history. Initialize attributes from item/application state and update them in the same branch that updates the visible control. Global history expansion is limited to 10 visible cards so the lazy-chart performance guarantee is not silently discarded.
- 🟠 **Large import selection is a separate scale boundary.** Progressive rendering of the tracked-product list does not protect the wishlist selection view. The selection flow now mounts at most 50 products per page, stores selection in a model-level index set, and makes “Select All” operate across every extracted product. Do not infer selected products only from mounted checkboxes.
- 🟡 **View changes require explicit focus transfer.** Wishlist selection and product details are hidden page regions, not visual-only overlays. Opening a region moves focus to its heading; closing it restores focus to the initiating control. Emoji-only buttons have accessible names, and chart canvases are paired with textual price/timestamp evidence.
- 🟡 **Blocking dialogs hide recoverable context.** Dashboard validation, extraction, selection, and storage failures now use inline `status`/`alert` regions. Actionable errors persist, failed storage mutations restore controls, and user input remains available for correction. Do not reintroduce `alert()`, `prompt()`, or `confirm()` into extension UI flows.
- 🟡 **Trust copy must match the storage boundary.** Tracked items and price history are local; only lightweight preferences may use Chrome sync. Export copy names the sensitive fields, clear-history copy says tracking continues, and scheduler copy avoids batch-size jargon.
- 🟡 **Wishlist continuation must be both fast and deletion-safe.** A partial 8-page scheduled traversal now requests a one-shot continuation after about 60 seconds, self-heals after service-worker startup, and defers to CAPTCHA backoff. Never perform missing-item reconciliation until the traversal is complete.
- 🟢 **Saved Signal is a utility, not a sales surface.** Popup, dashboard, options, and the in-page Track price control use a restrained navy/mint local asset system with accessible contrast, visible focus, disabled states, and reduced-motion behavior. Keep scripts/fonts/icons local and keep the popup height content-driven.

---

## 0F. Repository Cleanup & Documentation (Antigravity, 2026-07-04)

- 🟢 **Cleaned up root directory:** Removed scratch scripts (`test_*.js`, `*.har`, `*.html`) that cluttered the root. The actual test suite lives in `src/__tests__/`.
- 🟢 **Standardized documentation:** Added `README.md` as the primary human entry point, and created `GEMINI.md` to establish AI agent guidelines alongside `CLAUDE.md` and `AGENTS.md`. Agents should read these files to understand the repository structure and constraints.

---

## 0. Phase 2 Re-Review (Claude, 2026-06-27)

AGY reported Phase 2 complete: "Chart.js vendored locally, trackedItems moved to local storage, mutex added to `saveTrackedItem`, CAPTCHA circuit-breaker added." Verified each claim against the code — two are solid, two need follow-up:

- 🔴 **The `saveTrackedItem` mutex deadlocked on the first call (Claude, FIXED).** The implementation did `saveMutex = prevMutex.then(() => resolve)` inside `new Promise(resolve => …)`. The `.then` callback *returned* the `resolve` function instead of *calling* it, so the awaited promise never settled. **Fix:** rewrote it as a proper promise-chain mutex (`const run = saveMutex.then(work); saveMutex = run.catch(()=>{}); return run;`). The same lock now backs `updateTrackedItems()`, which applies batch merges to the latest collection. **Lesson:** a promise-chain mutex must invoke its resolver, survive rejected work, and cover every read-modify-write path.

- 🟠 **CAPTCHA circuit-breaker persistence (Codex, FIXED).** The Phase 2 breaker initially used only an in-memory service-worker flag, which resets after MV3 idle termination and provides no cross-run protection. `background.js` now persists `captchaBackoffUntil` and `captchaBackoffAttempts` in `chrome.storage.local`, skips alarms while backoff is active, and applies exponential backoff capped at 24 hours. Lesson: service-worker safety state must survive worker restarts.

- 🟠 **Unused vendored Chart.js dead weight (Codex, FIXED).** AGY vendored Chart.js after Codex replaced popup charts with a local sparkline renderer, leaving `../utils/chart.js` loaded but unused. The popup no longer loads Chart.js and the vendored file was removed. Keep the sparkline unless the product requires richer interactive charting.

- ✅ **`trackedItems` in `chrome.storage.local` + `unlimitedStorage` — confirmed correct.** Storage area moved to `local` with legacy-sync migration in `getTrackedItems()`, and `unlimitedStorage` was added to the manifest, which resolves the earlier 10 MB local-quota risk (§2). Content and UI writes route through background/storage helpers; scheduled results are merged through `updateTrackedItems()`.

---

## 0B. Phase 3 UX Review (Claude, 2026-06-27)

Traced the real end-user flows (Track Current Tab, in-page Track Price button, viewing items, editing/removing, alerts, options). Major UX failures found and the fixes applied:

- 🔴 **"Track Current Tab" gave zero feedback and could silently no-op (Claude, FIXED).** The popup sent `TRACK_CURRENT_PAGE` to the content script then called `setTimeout(window.close, 1000)` unconditionally. Problems: (a) the only success cue was the *in-page* button changing — invisible to someone looking at the popup; (b) if the content script wasn't in the page (non-product Amazon page, or tab opened before install), `chrome.tabs.sendMessage` failed with an unread `chrome.runtime.lastError` and the popup still closed as if it worked; (c) the new item never appeared without reopening the popup. **Fix:** the content script's `TRACK_CURRENT_PAGE` handler now returns the add result; the popup shows an inline status banner (success/exists/error), checks `lastError` to detect a missing content script and tells the user to reload the tab, and re-renders the list on success instead of blind-closing. **Lesson:** never fire-and-forget a cross-context extension message behind a fixed timeout — await the response, handle `lastError`, and confirm in the surface the user is actually looking at.
- *Pending: Record any specific CSS selectors that change frequently on Amazon.*
- *Pending: Record any CAPTCHA avoidance strategies that worked or failed.*

- 🟠 **The "Default Discount Alert (%)" option was dead code (Claude, FIXED).** `settings.defaultDiscount` was written by the Options page but never read anywhere, so configuring it did nothing — items were created with no `targetDiscountPercentage` and the discount alert in `processScrapeResult` never fired. **Fix:** the background `ADD_TRACKED_ITEM` handler now reads the setting and applies it to newly tracked items. **Lesson:** a setting that doesn't change behavior is worse than no setting — it erodes trust. Audit each option for an actual consumer.

- 🟠 **In-page "Track Price" button frequently never appeared, and failures left it stuck (Claude, FIXED).** `injectTrackButton()` ran once at `document_idle`, but Amazon renders the buy box asynchronously, so on many product pages the button was simply absent (a discoverability dead end). It also had no error branch — a failed add left the button unchanged. **Fix:** added a `MutationObserver` (self-disconnecting, 15s safety timeout) so the button is injected once the buy box appears, plus explicit button states (`Adding…` → `✅ Tracking` / `✅ Already Tracking` / `⚠️ Try Again`).

- 🟡 **Popup edit/remove could clobber concurrent background price updates (Claude, FIXED).** Both handlers mutated the `items` array captured at popup open and wrote the *whole* array back via `setStorageData`. If a scheduled scrape updated prices after the popup opened, saving stale data overwrote the fresh prices. **Fix:** added a serialized `removeTrackedItem(id)` to `storage.js` and switched the edit handler to the mutex-guarded `saveTrackedItem({ id, targetPrice })` (single-item merge), so popup writes no longer overwrite the full array. This also gives the previously-unused `saveTrackedItem` mutex real callers. Edit input is now validated (rejects non-positive / non-numeric) and `prompt` cancel is respected.

- 🟡 **Empty 80px grey chart box on freshly added items (Claude, FIXED).** New items have no history, so `renderSparkline` returned early leaving a blank box. **Fix:** show a "No price history yet — first check runs hourly." placeholder until data exists, which also sets the expectation that prices update on a schedule (not instantly).

Codex follow-up fixes from the same UX pass:
- 🟡 **Currency ambiguity (Codex, FIXED).** Prices now persist a currency symbol when it is visible in the page/scrape text, and popup/alert copy formats prices with that symbol. Continue treating currency as display metadata; numeric comparisons remain number-only.
- 🟢 **Notification body click (Codex, FIXED).** Both notification button clicks and notification body clicks now open the tracked Amazon item. Users expect the whole notification to be actionable.
- 🟢 **Options changes saved silently (Codex, FIXED).** The options page now shows a small status message after saving default discount, saving history retention, exporting data, or clearing history.
- 🟡 **Wishlist native price-drop metadata (Codex, FIXED).** Amazon wishlist rows can include user-facing text such as `Price dropped 8% (was €11.98 when added to List)`. Do not rely only on recomputing discounts from `originalPrice`; preserve `wishlistPriceDropPercent`, `wishlistPriceWhenAdded`, `wishlistPriceDropAmount`, and `wishlistPriceDropText` during wishlist import/sync and render both percentage and amount in dashboard cards/details.
- 🟡 **Price-drop visibility must be independent of sorting (Codex, FIXED).** The discount sort is only an ordering control; it must never be the gate that makes `Price dropped X% / amount (was Y when added to List)` visible. Treat Amazon's native wishlist drop fields as authoritative item metadata and render them in cards/details whenever present, even if the current computed `originalPrice > currentPrice` comparison is missing, stale, or rounded differently.
- 🟢 **Dashboard list controls are user preferences (Codex, FIXED).** Sort order, filters, and similar controls change how users navigate large tracked lists. Persist lightweight UI preferences such as the selected sort in `chrome.storage.sync` and restore them before the first render so reloads, dashboard reopens, and extension restarts do not reset the user's workflow.

---

## 0C. Popup UI Redesign + UX Review Loop (Claude, 2026-07-02)

Redesigned the popup and iterated against a live browser preview until it passed a UX-expert critique. Decisions future agents must not regress:

- **Preview harness** — `preview/index.html` + `preview/mock-chrome.js` render the *real* `popup.html/js/css` in a plain browser tab by injecting a `chrome.*` mock (`?empty=1` for empty state, `?fail=1` for messaging failure). Serve the repo root (`.claude/launch.json`, port 8917) and open `/preview/`. **Never reference these files from the manifest**; they are dev-only. Use this harness to visually verify any popup change.
- 🔴 **Sparklines must be drawn *after* the card is appended to the DOM.** A detached canvas measures 0×0, so the 1×1 bitmap stretches into a solid orange block. `loadAndRender()` calls `renderSparkline` post-append — keep it that way.
- 🟠 **Stable prices must not zigzag.** Min/max y-normalization amplifies ±¢ noise into drama. `renderSparkline` widens the domain to ±5% of the midpoint when the real range is <1% of the price, so flat prices draw flat. Don't remove this damping.
- **Price-drop = green.** The change badge (`▼ x% since tracking started`) uses green for drops and red for rises — a drop is *good news* for a shopper (inverse of finance conventions). Baseline is the earliest finite history point; badge hides under 0.5% change.
- **No blocking dialogs.** Target price edits use an inline editor (Enter saves, Esc cancels, empty save clears the target) — `prompt()` is banned in the popup. Removal is a two-step ✕ → "Confirm?" button that auto-reverts after 3s — no `confirm()`.
- **Search appears only at ≥6 items** (`SEARCH_MIN_ITEMS`) so small lists aren't cluttered; a "No matches" state covers empty filter results.
- **Meta-row stability**: `.last-checked` has `margin-left: auto` so it stays pinned right when the target chip is swapped for the editor. UI copy must be user-language ("first check runs automatically soon"), not scheduler internals.

Open UX backlog (non-blocking): sort options for large lists (e.g. biggest drop first), options-page visual alignment with the new card style, currency-aware `Intl.NumberFormat` formatting.

---

## 0D. QA Pass (Claude, 2026-07-02)

Full QA sweep after the dashboard/wishlist features landed: unit suite, Puppeteer E2E, popup functional matrix in the preview harness, and a cross-context contract audit. Four defects found and fixed:

- 🔴 **The dashboard was unreachable (FIXED).** Nothing referenced `src/dashboard/dashboard.html` — no popup button, no options link, nothing in the manifest. The extension's largest feature (wishlist import, sorting, priority tracking, charts) could only be opened by typing the `chrome-extension://` URL. Added a 📊 button in the popup header (`chrome.tabs.create` + `chrome.runtime.getURL`) and an E2E assertion so it can't silently vanish again. **Lesson: when adding a new page, wire its entry point in the same change — a feature without a path to it doesn't exist for users.**
- 🔴 **Recurring lost updates from overlapping alarms (FIXED).** `checkPriorityPricesAlarm` (5 min) and `checkPricesAlarm` (15 min) coincide every 15 minutes; both read-modify-write the whole `trackedItems` array and the last `saveTrackedItems()` discarded the other job's updates. All scrape jobs (batch/priority/wishlist) are now chained through `enqueueScrapeJob()` in background.js — **any new background job that writes trackedItems must go through this queue.**
- 🟠 **Wishlist autoSync was dead on a fresh tracker (FIXED).** `runWishlistCheckBatch()` returned early when `trackedItems` was empty — but an autoSync wishlist is exactly what populates the first items. The guard now only requires tracked wishlists.
- 🟠 **E2E asserted a popup that doesn't exist (FIXED).** The popup test expected title "Amazon Tracker Quick Actions" / h1 "Amazon Tracker" — no such popup was ever committed; the real popup is the UX-approved "Tracked Items" design. Assertions now match the actual product. **Lesson: don't land tests for planned-but-unbuilt UI; a red suite that "will pass later" hides real regressions.**

Verified green after fixes: 22/22 unit, 4/4 E2E (real Chrome, extension loaded), 14-point popup interaction matrix + failure path (`?fail=1`) + empty state in the harness, zero console errors.

Resolved in the 2026-07-12 scale pass: bulk adds now use the tracked-items update lock, dashboard mutations are routed through the service worker, and target editing is inline. Remaining accepted risk: the `tabs` permission is required for wishlist-tab detection and may receive extra Web Store review scrutiny.

---

## 0E. Popup → Quick-Actions Redesign (Claude, 2026-07-02, from real-user feedback at 784 items)

A user screenshot with 784 tracked items showed the popup collapsed to a sliver (one truncated card). Two causes, both fixed:

- 🔴 **`height: 100vh` collapses in a real extension popup (FIXED).** The popup viewport derives its height *from content*, so `100vh` is circular and the layout imploded in production. **Never use viewport-relative heights in popup CSS — heights must be content-driven.** The preview harness masked this because its iframe had a fixed 600px height; the harness now sizes the frame from the popup's `scrollHeight` (capped at 600px) so this class of bug is visible again.
- 🔴 **Rendering the full list (784 cards + sparklines) in a 400×600 popup doesn't scale (FIXED).** The popup is now a **quick-actions surface**: item count, context-aware current-tab action, the 3 most recently updated items, and a "View All N Items" button into the dashboard. The full list/search/edit UI lives only in the dashboard.
- **Context-aware track offer** (user requirement — do not regress): the popup offers to track the current tab **only** when it's an untracked Amazon product ("Track This Product") or an untracked wishlist ("Import This Wishlist", deep-links to `dashboard.html?import=<url>`). Already-tracked products/wishlists show a passive "✓ Already tracking…" line; Amazon non-product pages get a hint; **non-Amazon pages get no tracking UI at all**. Harness scenarios: `?tab=product|product-tracked|wishlist|wishlist-tracked|amazon-home|other`.

Verified: all six tab contexts in the harness, add-flow state transition, 22/22 unit, 4/4 E2E, zero console errors.

---

## 0F. Scale, Scheduling & Dashboard Safety (Codex, 2026-07-12)

- 🔴 **Long scrape snapshots must not replace live user state (FIXED).** Alarm jobs previously wrote their entire pre-scrape `trackedItems` snapshot after network work completed, which could resurrect a removed item or overwrite a target/priority edit made during the scrape. All UI mutations now go through service-worker messages, giving tracked-item writes one serialized owner. Batch persistence uses `updateTrackedItems()` and merges only scraper-owned fields into the latest collection; explicit user fields remain authoritative and deletions are not resurrected.
- 🔴 **Thirty sequential requests exceeded a safe MV3 event budget (FIXED).** A 30-item batch combined with 15-second timeouts and 2–5-second jitter could approach ten minutes. Standard batches now process at most 8 non-priority items per one-shot adaptive wake. Priority products are excluded from the standard queue so they are not fetched twice.
- 🟠 **A safe batch can still produce an unusably slow fixed cycle (FIXED).** Eight products every five minutes made 780 products take about 8.1 hours. Balanced Adaptive now schedules the next standard batch 30 seconds after completion while due work remains, uses 1–2-second sequential jitter, and assigns per-product next-due tiers (10m near target, 15m volatile, 90m stable, 3h unavailable). Use one-shot alarms for continuous queues; recurring alarms create either idle gaps or overlapping work.
- 🟠 **One-shot schedulers need self-healing (FIXED).** A fired one-shot alarm disappears before work begins. The alarm handler checks in `finally` that a successor exists, startup recreates missing or legacy recurring alarms, and CAPTCHA backoff schedules the next wake at the persisted resume time. Never rely on an in-memory timer or only the happy path to continue tracking.
- 🟠 **Wishlist removals require source ownership and complete pagination (FIXED).** Imported items now carry `wishlistIds`; explicitly tracked products carry `trackedIndividually`. Auto-sync removes only a missing wishlist association and deletes the product only when no source remains. Partial or failed pagination results never trigger removals. Legacy records without source metadata are preserved.
- 🟠 **Large dashboards must progressively render (FIXED).** Search/sort previously rebuilt all 784 cards and hidden chart metadata. The dashboard now renders 50 products at a time, provides focused filters, persists sort/filter preferences, and creates chart metadata/canvas pixels only when a visible chart opens.
- 🟡 **Destructive actions and edits stay in context (FIXED).** Dashboard target editing now uses an inline form, product removal requires an expiring second click, and clearing all history uses the same two-step confirmation. Do not reintroduce `prompt()`/`confirm()` for routine extension UI.
- 🟡 **Global numeric target prices are invalid across currencies (FIXED).** One setting cannot safely mean €5, £5, and $5. Target prices are per product; a legacy global value must not be applied or silently deleted. Keep it paused until explicit review, and offer copying only after a latest-state, single-known-currency check under the tracked-item lock. Global percentage discounts remain currency-independent.
- 🔴 **A settings page snapshot is not migration authority (FIXED).** Chrome Sync may change while Options remains open. Bind legacy migration and acknowledgement to the top-level Options page, re-read the latest Sync target before applying, and delete only a still-matching legacy field from a fresh settings object. Rewriting the page-load settings object can apply a stale target and erase unrelated remote preferences; the real-Chromium race test must remain.
- 🔴 **Cross-area migrations need compensation under the owning lock (FIXED).** Applying targets in Local storage and acknowledging a legacy field in Sync are two writes, so Sync rejection after the first write can leave a half-migration. Keep the tracked-item mutex until the Sync finalizer succeeds; on any finalizer exception, restore the exact pre-update collection before releasing the lock. Test the real storage helper as well as the background caller with an injected failure.
- 🟠 **A successful storage write is the commit point; readback transport failure is not rollback authority (FIXED).** After Sync acknowledgement resolves, a separate verification read can still fail transiently. Rolling Local targets back at that point loses the reviewed value from both areas. Preserve the committed migration on readback transport failure, while still rolling back when the Sync write itself fails or a successful read shows the legacy field remains.
- 🟠 **Partial wishlist success and anti-bot failure can coexist (FIXED).** A later page may produce a safe partial item set plus a resume cursor and a CAPTCHA/rate-limit result. Preserve the cursor and accumulated items while activating backoff; do not collapse the result into either “ordinary partial success” or “failed first page,” and never reconcile removals from it.
- 🟡 **Retention labels must match deletion behavior (FIXED).** “Keep Price History: 30 Days” now deletes points older than 30 days. Downsampling old points forever is a different policy and must not be presented as retention.

---

## 1. Scraping & Network

- **Stock Status Parsing Bug (AGY):** The string `available` is often used by Amazon to indicate stock (e.g. "available to ship"), but it is also a substring of "Currently unavailable." Always check `!text.includes('unavailable')` when checking for stock strings.

- 🔴 **Price thousands-separator bug (Claude, FIXED).** The original parser did `replace(/[^\d.,]/g,'').replace(',', '.')`. This corrupts any price ≥ 1000:
  - US `"$1,299.99"` → `"1,299.99"` → `"1.299.99"` → `parseFloat` → **`1.299`**.
  - EU `"1.299,95"` → `"1.299.95"` → **`1.299`**.
  - `.replace(',', '.')` also only replaces the *first* comma, so `"1.234.567,89"` was hopeless.
  - **Fix:** introduced `parsePrice()` in [offscreen.js](../src/background/offscreen.js). It decides the decimal separator as whichever of `.`/`,` appears last *and* is followed by 1–2 trailing digits; everything else of that kind is stripped as a thousands grouping. A grouped integer with no decimal part (`"1,234,567"`) is parsed whole. Covered by new tests in [scraper.test.js](../src/__tests__/scraper.test.js).
  - **Pitfall left open:** prices with 3 decimal places (rare, some fuel/unit prices) are treated as integers. Acceptable for retail; revisit if a locale needs it.
  - ✅ **Codex follow-up:** [content.js](../src/content/content.js) now uses the same decimal/thousands parsing approach for the visual fallback price. Keep parser behavior aligned between content and offscreen code; if shared modules become available for content scripts, consolidate the duplicate helper.

- 🟠 **CAPTCHA detection was title-only (Claude, FIXED).** Amazon does not always change `<title>` on the bot interstitial. Detection now also scans the body for challenge phrases ("type the characters you see", "enter the characters you see", "we just need to make sure you're not a robot"). New regression test added.

- 🔴 **CAPTCHA/rate-limit circuit-breaker back-off (Codex, FIXED).** When `scrapeAmazonProduct` returns `CAPTCHA_BLOCKED` or `RATE_LIMITED` (HTTP 429/503), `background.js` aborts the remaining run and persists exponential backoff in local storage.

- 🟠 **Request volume for 500+ item lists (Codex, MITIGATED).** Standard scraping remains sequential and bounded to 8 products per wake, with persistent per-item due times and global CAPTCHA/rate-limit backoff. Increasing throughput must come from shorter gaps between bounded batches and adaptive prioritization, not hundreds of concurrent requests.

- 🟠 **Fetch timeout (Codex, FIXED).** `scrapeAmazonProduct` now wraps Amazon fetches in an `AbortController` timeout (~15 s) and returns `FETCH_TIMEOUT` instead of letting a hung request block the whole batch indefinitely.

- 🟡 **Cross-origin fetch sends no cookies (NOTE).** Background-worker `fetch` to Amazon is cross-origin, so default `credentials: 'same-origin'` means the user's session cookies are **not** sent. Good for the privacy-first stance, but it means we scrape logged-out pages, which are more aggressively CAPTCHA-gated and may show different prices/availability than the user sees. Document this expectation; do not "fix" it by sending credentials without a privacy review.

- 🟢 **`salesRank` is declared but never extracted** in `parseAmazonHtml` (always `null`), yet `background.js` reads `result.salesRank`. Either implement extraction or drop the field.

- 🟢 **Selector fragility.** Amazon rotates price containers frequently. The current ordered list lives in `priceSelectors` in [offscreen.js](../src/background/offscreen.js). When a selector dies, add the new one to the *front* of the list and add a fixture-based test rather than editing logic. Known-good-as-of-this-review IDs: `#corePrice_feature_div`, `#corePriceDisplay_desktop_feature_div`, legacy `#priceblock_ourprice` / `#priceblock_dealprice`, and `.reinventPricePriceToPayMargin .a-offscreen`.

- 🟠 **Selector-list order is not fallback priority.** `querySelector('preferred, fallback')` returns the earliest matching element in document order. Amazon.nl places an image-only product link before its named wishlist title link, so visible extraction silently dropped every row when the combined selector chose the empty link. Use explicit `preferred || fallback` queries when semantic priority matters, and keep a fixture where the image link precedes the title.

- 🟢 **Amazon DOM variants added (Codex, FIXED).** Parser coverage now includes `#apex_desktop`, split `.a-price-whole`/`.a-price-fraction` prices without `.a-offscreen`, "Usually ships..." as orderable, and "not available" as a negative availability phrase. Keep adding fixture-style tests for every selector change.

## 2. Chrome Extension Architecture

- 🔴 **Chart.js CDN in MV3 popup (Codex, FIXED).** [popup.html](../src/popup/popup.html) previously loaded Chart.js from `cdn.jsdelivr.net`, which MV3 extension-page CSP blocks and which adds supply-chain/startup cost. [popup.js](../src/popup/popup.js) now uses a tiny local canvas sparkline renderer for price history. Rule: never load remote scripts in an MV3 extension; bundle local code only when the richer dependency is truly needed.

- 🔴 **`trackedItems` in `chrome.storage.sync` (Codex, FIXED).** `sync` limits include `QUOTA_BYTES_PER_ITEM = 8192`, `QUOTA_BYTES = 102400`, and write-rate caps. The entire list was one key, so larger wishlists could exceed per-key limits and scheduled batch writes could hit quotas. The canonical item list now lives in `chrome.storage.local`, settings remain in sync, and `getTrackedItems()` migrates the legacy sync key on first local read.

- 🔴 **Read-modify-write race in batched scrapes (Codex, FIXED).** Scheduled scraping mutates a snapshot in memory, then uses `updateTrackedItems()` to merge scraper-owned fields into the latest collection. Never restore whole stale snapshots after network work; they can overwrite user edits or resurrect deletions.

- 🟠 **MV3 service-worker lifetime vs. long scrape loops (Codex, FIXED).** The background worker now processes only a few items per alarm and persists `scrapeCursor` in local storage. This keeps each run short enough for MV3 and lets the next alarm resume from the next item.

- 🟡 **Local storage growth (Codex, MITIGATED).** `unlimitedStorage` is now requested, which removes the earlier 10 MB local quota issue. Still cap and prune history because large histories slow popup reads and canvas rendering even when storage quota permits them.

- 🟡 **`popup.js` active-tab URL guard (Codex, FIXED).** `activeTab.url.includes('amazon.')` could throw when `url` was undefined. The popup now uses optional chaining before checking the Amazon host hint.

- 🟢 **`offscreen.js` message contract (Codex, FIXED).** `handleMessages` used to be `async` while also calling `sendResponse` and returning `true`, which Chrome treats inconsistently. The listener is now synchronous. Keep offscreen parser responses synchronous unless a real async operation is introduced, and return `true` only when the channel must stay open.
- 🟢 **Offscreen parser lifecycle (Codex, FIXED for batches).** Service workers cannot use `DOMParser`, so the offscreen document remains the right parsing home. Create it lazily, guard concurrent creation with a shared promise, and close it after `runPriceCheckBatch()` finishes so the DOM-capable page and parsed document memory are eligible for cleanup.

- 🟢 **`module.exports` shim in `offscreen.js`.** The file is both a classic content-style script (loaded via `<script>` in `offscreen.html`) and a CommonJS module for Jest. Keep the `typeof module !== 'undefined'` guard; do not convert to ESM without updating both the HTML include and the test `require`.

## 3. Security & Privacy

- 🟢 **Manifest permissions are appropriately minimal** (`storage`, `alarms`, `notifications`, `offscreen` + Amazon host permissions). No `tabs`, `<all_urls>`, `scripting`, or `webRequest`. Keep it this way — do not add `tabs` just to read a URL; host permissions already expose the URL for Amazon tabs.

- 🟢 **No XSS sink found in the chart/UI path (GOOD — keep it that way).** The popup renders titles/prices with `.textContent` and draws history into a `<canvas>` (currently via the local `renderSparkline`); there is no `innerHTML`/`insertAdjacentHTML` with scraped data. **Rule for future chart-injection-into-Amazon-pages work:** scraped strings (title, seller, price) are *untrusted*. Inject only via `textContent`/DOM APIs or a sanitizer — never string-concatenate them into `innerHTML`. The current content script only injects a static button, which is fine.

- 🟡 **Host validation before background fetch/add (Codex, FIXED).** `scrapeAmazonProduct` and the background `ADD_TRACKED_ITEM` message path now validate the URL hostname against the supported Amazon domains before persisting or fetching. Keep this guard if import/restore features are added later.

- 🟢 **Exported backup is plain JSON via a data: URL** ([options.js](../src/options/options.js)). Fine for privacy-first/local-only, but note it contains the full tracked list + history; if encryption or a warning is ever wanted, that's the spot.

## 3A. UI & UX Performance

- 🟢 **Glassmorphism fallbacks (Codex):** Premium blur effects should include `@supports` fallbacks for browsers without `backdrop-filter`. Keep reduced-motion rules in popup/options CSS so hover transforms and future animations do not harm accessibility or paint performance.
- 🟢 **Sparkline rendering (Codex):** Popup chart canvases should be sized with `devicePixelRatio` and rendered locally. Avoid tooltip-heavy chart libraries for tiny history previews unless the product explicitly needs interactive analytics.

- 🟡 **Wishlist rows must refresh from the visible Amazon tab when available (Codex, FIXED).** Amazon wishlist pages can show multiple editions/copies of the same title, and native row metadata such as `Price dropped 8% (was €11.98 when added to List)` may only be visible in the logged-in rendered page. Dashboard sync now asks the content script for visible wishlist rows before falling back to background fetches, and bulk merges update `currentPrice`, `currency`, and `inStock` for existing items. Do not collapse user-visible wishlist context by title; key updates by product ASIN and preserve row metadata such as `wishlistItemId` and wishlist price-drop fields.

- 🟡 **Long-running wishlist actions need visible progress (Codex, FIXED).** Wishlist import/sync can read multiple pages, wait on anti-bot jitter, and then save hundreds of items. Never leave the dashboard on a static label such as `Syncing...`; update the button/status with phases like reading, products found, saving, and completion/failure.

- 🟡 **Keep primary wishlist actions outside the product scroll region (Codex, FIXED).** Large wishlists can contain hundreds of tracked cards. The dashboard should keep header controls and the footer action bar visible while only the product list scrolls, so actions like `Sync Wishlist Now` do not require scrolling to the bottom of the page.

- 🟡 **Price charts must expose timestamp and value context (Codex, FIXED).** A sparkline without sample timestamps or price labels is not trustworthy for a tracker. Dashboard chart cards show the latest stored price/time, low/high prices, stored-sample count, start/end timestamp labels, and recent timestamp/price sample rows. Render canvases only after the chart is visible/attached; hidden or detached canvases measure as 0px and produce blank stretched charts. Flat histories (same price across samples) still need a centered line plus explicit sample rows.

- 🟡 **Large tracked lists need filter-first navigation (Codex, FIXED).** With hundreds of products, users should not rely on scroll alone. Keep dashboard search visible in the header, show filtered counts (`N of total`), and debounce search input so storage reads/renders do not fire on every keystroke.

- 🟡 **Tracking schedules need visible freshness cues (Codex, FIXED).** Users should not have to infer whether background tracking is alive. The dashboard now shows the next normal price check, priority check, wishlist sync, and each item’s last checked timestamp. Preserve these cues when changing alarms or dashboard layout.

- 🟠 **Manual wishlist sync must count as a real fetch (Codex, FIXED).** The dashboard sync path used `BULK_ADD_TRACKED_ITEMS`, which merged current fields but did not update `lastChecked` or append `priceHistory`, so the UI stayed stale and charts showed only `1 fetch`. Any successful manual/scheduled wishlist sync with a finite price must update item freshness and append a history sample, even when the price is unchanged.

- 🟠 **Scheduled price batches must not be blocked by recent manual sync (Codex, FIXED).** The regular `checkPricesAlarm` path skipped any item checked in the last 12 hours, so after a manual wishlist sync all scheduled alarms could wake up and advance the cursor without fetching or recording chart history. The cursor and `ITEMS_PER_ALARM` limit already control request volume; do not add broad freshness skips that make visible "next check" times lie. Alarms are also self-healed on install, startup, and service-worker load.

- 🟡 **Dashboard pagination must preserve scroll position (Antigravity, 2026-07-22, FIXED).** Clicking "Load more" in `dashboard.js` previously called `renderItems()`, which wiped out `itemList.innerHTML` and reset `#item-list` scroll position to 0, sending the user back to the beginning of the page. `renderItems()` now saves `itemList.scrollTop` and restores it via `requestAnimationFrame` on pagination/re-renders, while explicit filter/sort/search changes reset scroll to top.

## 4. Alerts & Business Logic (`background.js`)

- 🟠 **First-run restock spam (Codex, FIXED).** Restock alerts now fire only on an explicit `false → true` transition. The first observation records `wasInStockPreviously` without notifying.

- 🟠 **Null price history/alerts (Codex, FIXED).** `processScrapeResult` now skips price history and price-based alerts when `result.price == null`, while still recording stock/check metadata.

- 🔴 **First-run discount and target alerts silently skipped (FIXED).** The guard `previousPrice > currentPrice` silently skipped alerts when `previousPrice` was `null` (the very first run). If a user imported a wishlist of already-discounted items, they never received an alert. **Fix:** Changed the guard to `(previousPrice == null || previousPrice > currentPrice)` so that the very first successful check correctly fires alerts if thresholds are already met.
- 🟡 **First-check alert policy was later tightened intentionally.** The product contract now treats the first successful price as a baseline and suppresses target and discount notifications until a later downward move. Keep the regression test and feature specification aligned with this deliberate anti-noise behavior; do not reintroduce the earlier `previousPrice == null` alert path as an incidental cleanup.

- 🔴 **Badge discount logic ignored native wishlist drops (FIXED).** The badge logic previously manually calculated discounts using `(original - current) / original`. However, items imported from wishlists sometimes only expose `wishlistPriceDropPercent` and not a raw original price. **Fix:** Badge calculation and popup alerts now fall back to reading `wishlistPriceDropPercent` if a manual calculation yields 0 or fails.

- 🟢 **Decoupled Badge Architecture.** Initially, the red extension badge count was manually updated at the end of each scraping batch job. This meant changes made in the Options page or Dashboard syncs left the badge stale until the next alarm. **Fix:** The badge logic is now driven purely by a `chrome.storage.onChanged` listener in `background.js` watching `TRACKED_ITEMS` and `SETTINGS`. This guarantees the badge instantly reflects the actual data state "no matter what", eliminating the need to sprinkle `updateBadgeCount()` calls throughout the codebase.

- 🟢 **`prunePriceHistory` per-day logic is correct** (the `daySeen` set is re-scoped per item and points are stored chronologically), but uses local-timezone `toDateString()` — consistent within a device, may differ across synced devices. Minor.

---

## How to extend the test suite

Tests live in [scraper.test.js](../src/__tests__/scraper.test.js) and run under `jsdom` against the real `parseAmazonHtml`/`parsePrice`. When Amazon's DOM changes:
1. Capture the new HTML snippet as a fixture string.
2. Add a test asserting the expected `price`/`inStock`/`soldByAmazon`.
3. Only then adjust selectors/logic so the test goes green — this keeps regressions like the "$1,299.99 → 1.299" bug from coming back.

Current coverage: CAPTCHA (title + body), standard parse, US & EU thousands separators, currency extraction, grouped integers, junk input, missing price, split whole/fraction prices, `apex_desktop` price, "Only N left", "Usually ships", "Available from these sellers" false-positive, "not available" false-positive, "Temporarily out of stock", third-party seller, and selector precedence.

## E2E testing rules

- **Puppeteer with Jest CommonJS (Codex):** Keep Chrome extension E2E tests in [extension.e2e.test.js](../src/__tests__/extension.e2e.test.js). Use dynamic `import('puppeteer')` inside the Jest test and run it with `NODE_OPTIONS=--experimental-vm-modules` to avoid Puppeteer's ESM/CommonJS friction.
- **Separate unit and browser tests (Codex):** `npm test` is intentionally unit-only and sandbox-friendly. Run `npm run test:e2e` for headless Chrome extension loading with `--disable-extensions-except` and `--load-extension`.
- **Manifest assets are test prerequisites (Codex):** Keep every manifest-referenced icon checked in. Missing `assets/icon*.png` files prevented the MV3 service worker from appearing in Puppeteer and made the failure look like a test harness issue.

# 2026-08-25: every producer must share the destructive-data coordinator

- A manual network action is still a scrape job. Dashboard wishlist extraction must join the same queue, persisted backoff, anti-bot disposition, and offscreen cleanup as alarm-driven work.
- A storage mutex is local to one extension JavaScript context. Route destructive cross-context actions such as clearing history through the background coordinator, keep the clear under the storage mutex, and advance a persisted generation across clear/restore so UI round trips that started earlier cannot append afterward.
- E2E assertions should prefer durable completion state over a transient disabled/loading frame; faster browser releases can legitimately complete before the next Puppeteer round trip.
# 2026-08-24: security controls must preserve authorized query-bearing extension flows

- Comparing an extension sender URL as a raw string rejected the legitimate popup-to-dashboard `?import=` flow. Authorize the canonical extension origin and exact page path, then validate the message payload independently.
- A complete remote snapshot is still stale by persistence time. Destructive wishlist reconciliation must re-evaluate current user-owned fields inside the serialized storage update; automatic remote reconciliation should not delete retained price history.
- Wishlist-shaped rows prove parseability, not list identity. Only matching list identifiers or strong document-level canonical identity may authorize complete-state reconciliation.
- A serialized tracked-item merge does not protect a separately stored history snapshot. Background checks now persist only the samples they appended through the shared storage mutex, so a delayed scrape cannot replace a newer manual-sync sample with an older whole-object snapshot.

# 2026-08-24: backup restore is a privileged replacement transaction

- Treat every backup file as untrusted even when it was created by this extension. Enforce file/count/value bounds, canonical Amazon identity checks, and explicit field allowlists before any storage write.
- Options-page validation improves feedback but is not an authorization boundary. Revalidate in the background worker and accept restore messages only from the exact top-level Options page.
- A restore spans Local user data and Sync preferences, so queue it behind in-flight scrape work, serialize it with tracked-item writes, batch the Local replacement, drop imported scheduler deadlines, preserve active anti-bot backoff, and roll back the exact prior Local snapshot when the Sync write fails. Follow-up alarm or badge maintenance must not turn a committed restore into a misleading failure response.
