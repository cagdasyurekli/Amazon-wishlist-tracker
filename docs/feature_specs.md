# Amazon Wishlist Tracker — Feature Specifications

> **Source of Truth for Expected Behavior**
> Last Updated: 2026-08-25

This document defines the expected behavior of all features in the Amazon Wishlist Tracker extension. It serves as the single source of truth for QA, testing, and AI Agents to verify functionality.

---

## 1. Tracking & Scraping
### 1.1 Individual Product Tracking
- **Injection:** A "Track price" control is automatically injected onto supported Amazon product pages near the Buy Box inside a closed Shadow DOM. Only a genuine user activation on a matching HTTPS product page can add the item.
- **Current Tab Tracking:** Users can track the current Amazon product tab directly from the extension popup.
- **Validation:** The extension must validate that the URL matches an allowed Amazon regional domain (`.com`, `.com.tr`, `.nl`, `.de`, `.fr`, `.es`, `.it`, `.co.uk`).
- **Data Extracted:** The extension extracts the product ID (ASIN), title, bounded author names when Amazon exposes a product byline, current price, original price (if available), currency symbol, stock status, and product image.
- **Availability Classification:** Stock and wishlist-unavailable text is normalized and classified with unavailable wording taking precedence over available wording. English, Dutch, German, French, Spanish, Italian, and Turkish marketplace phrases are supported. Unrecognized product availability is not treated as verified in stock; wishlist rows retain their existing fallback unless an unavailable phrase is present.

### 1.2 Wishlist Tracking & Syncing
- **Import Flow:** Users can import a public/shared Amazon wishlist URL via the Dashboard or the Popup.
- **Wishlist Identity:** Wishlist IDs are bounded to one path segment of at most 64 ASCII alphanumeric, `_`, `-`, or `=` characters. The `=` character is required by observed Amazon Turkey list URLs and does not broaden the allowed host, scheme, path, or redirect policy.
- **Data Extracted:** Extracts all visible items from the wishlist, including native Amazon price-drop data (`wishlistPriceDropPercent`, `wishlistPriceWhenAdded`, `wishlistPriceDropAmount`, `wishlistPriceDropText`).
- **Visible-Tab Identity:** Manual sync can use a supported Amazon tab whose address is either the canonical list URL or Amazon's generic `/wishlist` route. A generic route is accepted only when the content script derives the same bounded list ID from the visible product rows; a mismatched or missing identity falls back to the background reader.
- **Keep List in Sync:** Wishlists can periodically add newly discovered products and stop tracking products removed from that wishlist. Products also tracked individually or through another wishlist are preserved.
- **Reconciliation Identity:** Destructive reconciliation requires a complete page bound to the requested wishlist by a matching list identifier or canonical document identity. Identity-less rows may be shown for non-destructive extraction but cannot authorize removals.
- **Concurrent Intent:** Final reconciliation rechecks the latest individual-tracking and multi-wishlist ownership state, so concurrent individual tracking or ownership by another wishlist is preserved. Background checks merge only their newly observed price samples into the latest local history instead of replacing concurrent samples, and automatic wishlist removal does not erase retained history.
- **Fast Safe Continuation:** A scheduled wishlist traversal reads at most 8 pages per worker wake. If more pages remain, a one-shot continuation resumes after about 60 seconds instead of waiting for the next 15-minute rotation. The rotating cursor advances between chunks so one large list cannot starve another. Continuations survive service-worker restarts, respect CAPTCHA backoff, and never reconcile removals until the full traversal completes.
- **Traversal Budgets:** A traversal is capped at 150 pages, 2,000 unique items, 32 MiB of HTML, six hours of resumable lifetime, and 12 MiB of persisted continuation state. Reaching a limit discards only the partial operational checkpoint; it never deletes tracked products or history.
- **Manual Import Bounds:** Visible-tab extraction and dashboard bulk import accept at most 2,000 bounded products in one operation, while the durable tracked collection is capped at 5,000. The existing 50-item selection pages and whole-list “Select All” behavior remain available for ordinary large lists, including the 784-item regression fixture.
- **Manual Background Coordination:** When no matching visible wishlist tab is available, Dashboard extraction is authorized only from the top-level Dashboard page and joins the same serialized scrape queue and persisted anti-bot backoff as scheduled checks. A partial set found before CAPTCHA/rate limiting may be reviewed non-destructively, but the UI must disclose the pause and its resume time.
- **Regional Identity:** A valid stored product URL keeps its own supported Amazon origin. Legacy wishlist records are upgraded only when their linked products establish one unambiguous Amazon origin. A region that cannot be resolved is marked for review, is excluded from automatic sync, and is resolved when the user imports the real wishlist URL again; the extension must not guess `.com`.

### 1.3 Background Scraping Lifecycle
- **Normal Checking:** Balanced Adaptive uses a one-shot `checkPricesAlarm`. It processes up to 8 due non-priority products sequentially, waits 1–2 seconds between requests, then schedules the next batch after at least 30 seconds. Unchecked products are immediately due.
- **Adaptive Tiers:** Products near a price/discount target are due after 10 minutes, recently volatile products after 15 minutes, stable products after 90 minutes, and unavailable products after 3 hours. Ordinary failures retry after 15 minutes. The dashboard shows each product's next check and cadence reason.
- **Priority Checking:** Priority items use a separate two-minute alarm and process up to 5 products per batch. They are excluded from standard batches.
- **Wishlist Checking:** One tracked wishlist is selected by a rotating cursor every 15 minutes (`checkWishlistsAlarm`). Background pagination is resumable and processes at most 8 pages per wake. Removals are reconciled only after a complete traversal; partial results never delete missing products.
- **Offscreen Document:** All scraping uses a hidden Chrome offscreen document to parse bounded Amazon HTML in an inert template. Remote scripts, frames, styles, and resource-loading attributes are neutralized; only allowlisted HTTPS Amazon image CDN URLs may reach the UI.
- **Network Bounds:** Product and wishlist requests accept only supported HTTPS Amazon URLs and same-identity redirects. HTML content type, 8 MiB per-response size, cumulative wishlist size, and end-to-end time are enforced through body parsing.
- **Navigation Safety:** Stored legacy Amazon product links are validated against their ASIN and upgraded from HTTP to canonical HTTPS before popup, dashboard, or notification navigation. Malformed, credentialed, lookalike, port-bearing, and identity-mismatched links are not opened.
- **Anti-Bot Backoff:** If Amazon returns a structurally verified CAPTCHA or HTTP 429/503 Rate Limit, the extension triggers an exponential backoff circuit breaker (up to 24 hours) and pauses all scraping. Freeform words alone do not activate the breaker.
- **Partial Backoff Continuation:** If a later wishlist page triggers CAPTCHA or rate limiting after earlier pages succeeded, the validated partial result and next-page cursor are retained while global backoff activates. Resumption continues from that cursor; the partial set never authorizes removals.
- **Recovery:** The standard alarm is one-shot and recreated after each batch. Startup checks and an alarm-handler `finally` block restore it if Chrome terminates a worker or a batch fails unexpectedly.

---

## 2. Notifications & Alerts
### 2.1 Target Price Alerts
- **Behavior:** Fires when an item's price drops to or below the user-defined `targetPrice`.
- **Anti-Spam:** Only fires on a downward transition. If the price remains below the target on subsequent checks, no duplicate alert is sent.
- **First Check:** The first successful price check records the baseline without alerting, even when the target is already met. A later downward crossing is required.

### 2.2 Target Discount Alerts
- **Behavior:** Fires when the discount (calculated against `originalPrice`, or via native `wishlistPriceDropPercent`) reaches or exceeds the `targetDiscountPercentage`.
- **Anti-Spam:** Only fires when crossing the threshold downward, or if the price drops *even further* after already crossing the threshold.
- **First Check:** The first successful price check records the baseline without alerting, even when the discount threshold is already met.

### 2.3 Restock Alerts
- **Behavior:** Fires when an item transitions strictly from "Out of Stock" to "In Stock".
- **Anti-Spam:** Does not fire on the very first scrape of a newly tracked item, even if it is currently in stock.

### 2.4 Purchased Text Safety
- **Behavior:** Amazon-derived "purchased" text is advisory and untrusted. It must never automatically remove a tracked product, delete price history, or send a destructive-state notification.

### 2.5 Extension Icon Badge
- **Behavior:** A red numerical badge on the extension icon displays the total number of tracked items that currently meet their discount or target price conditions.
- **Architecture:** Driven by a `chrome.storage.onChanged` listener. Instantly updates when settings change, items are deleted, or prices update.

### 2.6 Legacy Target Review
- **Behavior:** A valid currencyless `defaultTargetPrice` from an older build remains paused and visible until the user explicitly reviews it. A one-time notification and persistent Dashboard warning route to Extension Settings without treating the notice ID as a product.
- **Safe Copy:** Automatic copying is accepted only from the top-level Options page, only while the latest Sync `defaultTargetPrice` still exactly matches the reviewed value, only when every latest tracked item has the same known currency, and only when the latest count of products without a target matches the UI-time count. The tracked-item lock remains held through Sync acknowledgement: copied products are marked due now, then only the matching legacy field is removed from a freshly read settings object so unrelated current preferences are preserved. A changed Sync target, mixed/unknown currency, changed eligible count, or failed acknowledgement restores the exact pre-migration tracked collection before the lock is released.

---

## 3. User Interface (UI)
### 3.1 Quick-Actions Popup (`popup.html`)
- **Purpose:** Fast interactions and status checks.
- **Features:** 
  - Shows context-aware tracking buttons (e.g., "Track This Product" if on an untracked Amazon page).
  - Displays 3 compact highlights, prioritizing meaningful price drops and then recently updated products.
  - Shows current price and a green drop/red rise badge when the change from the durable tracking-start price is at least 0.5%. The baseline is captured before retention or low/high compaction can remove the original history sample and is preserved by backup v2.
  - Labels that comparison as “since tracking started” and exposes the start date when it is available. Legacy data without a recoverable start baseline is labeled as the earliest retained sample instead.
  - When one or more products meet a target, provides a dashboard link with the temporary `targetReached` filter.
  - Uses the Saved Signal navy/mint visual system on a neutral soft-slate canvas with accessible contrast, visible keyboard focus, and reduced-motion support. Popup height remains content-driven.
  - Opening wishlist import from the popup passes the supported `?import=` dashboard URL; the background authorizes that exact dashboard path with or without its query while rejecting other extension pages.

### 3.2 Dashboard (`dashboard.html`)
- **Purpose:** Full data management and detailed analysis.
- **Features:**
  - Displays all tracked items in a grid/list.
  - Allows persistent sorting, text searching by title, author name, ASIN, stock status, or target state, and filters for price drops, priority, stock, reached targets, and unchecked products. Existing products gain author metadata after a supported product-page track or successful background product refresh.
  - Accepts only allowlisted dashboard filter query values. A query-provided filter is temporary and does not overwrite the remembered preference unless the user changes the filter.
  - Progressively renders 50 products at a time with "Load More" pagination that preserves scroll position. Chart metadata and canvases are created only when charts are opened.
  - Wishlist selection shows at most 50 products per page while preserving selection across pages. “Select All” applies to the complete extracted wishlist, not only the visible page.
  - Detailed product cards show explicit price histories, timestamps of previous scrapes, and native wishlist price-drop text.
  - Target prices use an inline editor. Removal requires a second confirmation click that expires automatically.
  - "Sync Wishlist Now" button to manually trigger a batch update for a specific wishlist.
  - Blocking browser dialogs are not used. Validation, progress, failures, and mutation results appear in accessible inline status regions; actionable errors persist until the user takes another action.
  - Priority and history controls expose their live state through `aria-pressed` and `aria-expanded`. Moving into or out of wishlist selection and product details transfers and restores keyboard focus.
  - Escape returns from wishlist selection and product-details views while restoring focus to the initiating control; these views are not modal dialogs and do not trap focus.
  - Price display formats the numeric portion for the browser locale while preserving the stored currency symbol. History charts label their point count as stored samples, not fetches.
  - At high browser zoom or short viewport heights, the dashboard switches to document scrolling so toolbar controls, product actions, and wishlist import remain reachable without horizontal overflow.
  - Scheduler copy uses user language. A pending 60-second wishlist continuation is shown as the next wishlist sync when it occurs.
  - A pending legacy currencyless target displays a persistent warning that links to Extension Settings and disappears when the setting is acknowledged.

### 3.3 Options Page (`options.html`)
- **Purpose:** Global settings and local data backup/restore.
- **Features:**
  - Configure the global `Default Discount Alert (%)`. Target prices are configured per product to avoid applying one numeric value across different currencies.
  - Configurable strict price-history retention (30 days, 90 days, 1 year, or forever). Expired points are deleted; retained history keeps the newest seven days at source resolution, then daily low/high points through one year and monthly low/high points thereafter, subject to the 10,000-point per-product bound. A backup is additionally bounded to 500,000 total history points.
  - Export a version 2 JSON backup containing tracked products, compacted price history, tracked wishlists, supported preferences, and compaction metadata. Version 1 and unversioned valid backups remain restorable.
  - Validate an export with the same restore validator before download. Downloads use a local Blob URL rather than a data URI, remain under 32 MiB, and always produce a restorable payload. If export compaction was necessary, the status explains that older high-frequency samples were condensed.
  - Select and validate backups under a 32 MiB file limit, preview product/history/wishlist counts, and require an expiring second confirmation before replacement.
  - Restore only canonical supported Amazon URLs and allowlisted record fields. The Options page validates first; the background worker independently validates again and accepts the mutation only from the top-level Options page.
  - Queue restore behind in-flight scrape work, replace user-owned Local data under the tracked-item mutex, reset unfinished cursors while keeping imported products due for fresh checks, invalidate pre-restore history writers, preserve active CAPTCHA/rate-limit backoff, and restore the exact prior Local snapshot if the Sync settings write fails.
  - Clear all price history only after previously started scrape/import work has finished, so a pre-clear sample cannot reappear after the success message.
  - Explain that tracked items and price history stay on the device, lightweight preferences may use Chrome sync, backups contain shopping-interest data, restore replaces current local tracking data, and clearing history does not stop tracking.
  - Preserve an older currencyless global target until explicit acknowledgement. Offer a one-click copy only for a revalidated single-currency collection; otherwise direct the user to set per-product targets.
  - All Options and Dashboard preference changes are serialized by the background worker. The `PATCH_SETTINGS` runtime message accepts only the fields owned by its sending page and returns the resulting current settings, preventing concurrent view updates from overwriting each other.

---

## 4. Privacy & Data Storage
- **Local-Only:** All tracking data (`TRACKED_ITEMS`, `TRACKED_WISHLISTS`, `PRICE_HISTORY`) is saved strictly in `chrome.storage.local`.
- **No Developer Cloud:** There is no external backend or analytics tracking. Direct Amazon marketplace/image-CDN requests support product display and refreshes; lightweight preferences may also leave the device through Chrome Sync when the user enables it.
- **Sync Storage:** Lightweight global preferences (dashboard sort/filter and default discount threshold) are stored in `chrome.storage.sync` to persist across the user's browser instances.
