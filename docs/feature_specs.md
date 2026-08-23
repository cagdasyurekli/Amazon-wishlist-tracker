# Amazon Wishlist Tracker — Feature Specifications

> **Expected-Behavior Contract**
> Last Updated: 2026-08-23

This document defines expected observable behavior for the Amazon Wishlist Tracker extension. Verify conformance against current source and tests; this document is not implementation evidence by itself.

---

## 1. Tracking & Scraping
### 1.1 Individual Product Tracking
- **Injection:** A "👀 Track Price" button is automatically injected onto supported Amazon product pages near the Buy Box.
- **Current Tab Tracking:** Users can track the current Amazon product tab directly from the extension popup.
- **Validation:** The extension must validate that the URL matches an allowed Amazon regional domain (`.com`, `.nl`, `.de`, `.fr`, `.es`, `.it`, `.co.uk`).
- **Data Extracted:** The extension extracts the product ID (ASIN), title, current price, original price (if available), currency symbol, stock status, and product image.

### 1.2 Wishlist Tracking & Syncing
- **Import Flow:** Users can import a public/shared Amazon wishlist URL via the Dashboard or the Popup.
- **Data Extracted:** Extracts all visible items from the wishlist, including native Amazon price-drop data (`wishlistPriceDropPercent`, `wishlistPriceWhenAdded`, `wishlistPriceDropAmount`, `wishlistPriceDropText`).
- **Keep List in Sync:** Wishlists can periodically add newly discovered products and stop tracking products removed from that wishlist. Products also tracked individually or through another wishlist are preserved.

### 1.3 Background Scraping Lifecycle
- **Normal Checking:** Balanced Adaptive uses a one-shot `checkPricesAlarm`. It processes up to 8 due non-priority products sequentially, waits 1–2 seconds between requests, then schedules the next batch after at least 30 seconds. Unchecked products are immediately due.
- **Adaptive Tiers:** Products near a price/discount target are due after 10 minutes, recently volatile products after 15 minutes, stable products after 90 minutes, and unavailable products after 3 hours. Ordinary failures retry after 15 minutes. The dashboard shows each product's next check and cadence reason.
- **Priority Checking:** Priority items use a separate two-minute alarm and process up to 5 products per batch. They are excluded from standard batches.
- **Wishlist Checking:** One tracked wishlist is selected by a rotating cursor every 15 minutes (`checkWishlistsAlarm`). Background pagination is resumable and processes at most 8 pages per wake. Removals are reconciled only after a complete traversal; partial results never delete missing products.
- **Serialized Background Work:** Background wishlist extraction, manual imports/syncs, scheduled scrape jobs, retention pruning, and destructive history clearing share one queue so request pressure stays sequential and concurrent operations preserve the latest tracked-item fields and intended history state.
- **Offscreen Document:** All scraping uses a hidden Chrome offscreen document to safely parse the Amazon HTML using native DOM APIs without triggering XSS risks.
- **Anti-Bot Backoff:** If Amazon returns a CAPTCHA or HTTP 429/503 Rate Limit, including after earlier pages of a resumable wishlist traversal succeeded, the extension preserves those partial pages and resume cursor, triggers an exponential backoff circuit breaker (up to 24 hours), and pauses all scraping.
- **Recovery:** The standard alarm is one-shot and recreated after each batch. Startup checks and an alarm-handler `finally` block restore it if Chrome terminates a worker or a batch fails unexpectedly.

---

## 2. Notifications & Alerts
### 2.1 Target Price Alerts
- **Behavior:** Fires when an item's price drops to or below the user-defined `targetPrice`.
- **Anti-Spam:** Only fires on a downward transition. If the price remains below the target on subsequent checks, no duplicate alert is sent.

### 2.2 Target Discount Alerts
- **Behavior:** Fires when the discount (calculated against `originalPrice`, or via native `wishlistPriceDropPercent`) reaches or exceeds the `targetDiscountPercentage`.
- **Anti-Spam:** Only fires when crossing the threshold downward, or if the price drops *even further* after already crossing the threshold.

### 2.3 Restock Alerts
- **Behavior:** Fires when an item transitions strictly from "Out of Stock" to "In Stock".
- **Anti-Spam:** Does not fire on the very first scrape of a newly tracked item, even if it is currently in stock.

### 2.4 Purchased Item Alerts
- **Behavior:** If an imported wishlist item is detected as "Purchased", the extension sends an alert, removes its price history, and stops tracking it.

### 2.5 Extension Icon Badge
- **Behavior:** A red numerical badge on the extension icon displays the total number of tracked items that currently meet their discount or target price conditions.
- **Architecture:** Driven by a `chrome.storage.onChanged` listener. Instantly updates when settings change, items are deleted, or prices update.

### 2.6 Previous Global Target Upgrade Notice
- **Behavior:** When Chrome starts or the extension upgrades with a valid, unacknowledged legacy global target, it sends one Chrome notification explaining that old global target alerts are paused because their currency is unknown. Its button and body open **Extension Settings**.
- **Anti-Spam & Recovery:** A local opaque marker prevents repeat notices for the same legacy value, clears after acknowledgement, and permits a changed legacy value to be surfaced once. Notification permission or API failures do not interrupt startup; the Dashboard warning remains the actionable fallback.

---

## 3. User Interface (UI)
### 3.1 Quick-Actions Popup (`popup.html`)
- **Purpose:** Fast interactions and status checks.
- **Features:** 
  - Shows context-aware tracking buttons (e.g., "Track This Product" if on an untracked Amazon page).
  - Displays 3 compact highlights, prioritizing meaningful price drops and then recently updated products.
  - Shows current price and a green drop/red rise badge when the change from the first recorded price is at least 0.5%.

### 3.2 Dashboard (`dashboard.html`)
- **Purpose:** Full data management and detailed analysis.
- **Features:**
  - Displays all tracked items in a grid/list. If initial storage or schedule reads fail, a sanitized visible error includes a Retry control; saved data is not changed.
  - Allows persistent sorting, text searching, and filters for price drops, priority, stock, reached targets, and unchecked products.
  - Progressively renders 50 products at a time with "Load More" pagination that preserves scroll position. Chart metadata and canvases are created only when charts are opened.
  - Detailed product cards show explicit price histories, timestamps of previous scrapes, and native wishlist price-drop text.
  - Target prices use an inline editor. Removal requires a second confirmation click that expires automatically.
  - Failed target, priority, or removal mutations keep their controls usable, preserve the last persisted value, and show an inline retry message.
  - A persistent warning appears while a previous global target remains: it explains that old global target alerts are paused because currency is unknown and provides **Open Extension Settings**. It hides immediately after the legacy value is migrated or acknowledged, and a retryable recovery state replaces it if settings cannot be read.
  - "Sync Wishlist Now" button to manually trigger a batch update for a specific wishlist.

### 3.3 Options Page (`options.html`)
- **Purpose:** Global settings and data export.
- **Features:**
  - Configure the global `Default Discount Alert (%)`. Target prices are configured per product to avoid applying one numeric value across different currencies. A legacy global target remains visible until the user explicitly acknowledges it; it can be copied only after an explicit user action when at least one tracked product exists, every current product has a non-empty currency, and all currencies match. The background rechecks that predicate and the expected eligible count before changing anything. During an upgrade, users must resolve **Review a previous target price** before relying on target alerts.
  - Configurable strict price-history retention (30 days, 90 days, 1 year, or forever). Expired points are deleted.
  - Export all raw tracking data to `amazon_tracker_export.json` for review and safekeeping. This version has no import or restore flow, so exports are not recovery backups.
  - Clear all price history through the serialized background queue so an in-flight scrape cannot restore deleted samples; failures leave the two-step control usable.

---

## 4. Privacy & Data Storage
- **Local-Only:** All tracking data (`TRACKED_ITEMS`, `PRICE_HISTORY`) is saved strictly in `chrome.storage.local`.
- **No Product Cloud:** There is no extension backend or analytics service. Tracking data and history are not sent to a product backend or Chrome sync; price requests go directly to supported Amazon domains. An explicit user export writes a local JSON file that this version cannot restore.
- **Sync Storage:** Small preferences (dashboard sort/filter, default discount threshold, and any unacknowledged legacy target value) use `chrome.storage.sync` and may follow the user's Chrome profile. Tracked products and price history do not sync.
