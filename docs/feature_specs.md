# Amazon Wishlist Tracker — Feature Specifications

> **Source of Truth for Expected Behavior**
> Last Updated: 2026-07-12

This document defines the expected behavior of all features in the Amazon Wishlist Tracker extension. It serves as the single source of truth for QA, testing, and AI Agents to verify functionality.

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
- **Auto-Sync:** Wishlists can be marked for "Auto-Sync," allowing the extension to periodically re-scrape the wishlist URL to pick up newly added or removed items.

### 1.3 Background Scraping Lifecycle
- **Normal Checking:** The extension runs a background job (`checkPricesAlarm`) every 5 minutes. It processes a small batch (cursor-based, max 30 items) of standard tracked items to avoid rate limits.
- **Priority Checking:** Items marked as "Priority" are checked more frequently via `checkPriorityPricesAlarm` (every 5 minutes, up to 5 items per batch).
- **Wishlist Checking:** Wishlist URLs are re-scraped every 15 minutes (`checkWishlistsAlarm`) to find new items and update prices.
- **Offscreen Document:** All scraping uses a hidden Chrome offscreen document to safely parse the Amazon HTML using native DOM APIs without triggering XSS risks.
- **Anti-Bot Backoff:** If Amazon returns a CAPTCHA or HTTP 429/503 Rate Limit, the extension triggers an exponential backoff circuit breaker (up to 24 hours) and pauses all scraping.

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

---

## 3. User Interface (UI)
### 3.1 Quick-Actions Popup (`popup.html`)
- **Purpose:** Fast interactions and status checks.
- **Features:** 
  - Shows context-aware tracking buttons (e.g., "Track This Product" if on an untracked Amazon page).
  - Displays the 3 most recently updated items with mini sparkline price charts.
  - Sparklines are damped (flat line if price variance is <1%) and color-coded (green for drops, red for rises).

### 3.2 Dashboard (`dashboard.html`)
- **Purpose:** Full data management and detailed analysis.
- **Features:**
  - Displays all tracked items in a grid/list.
  - Allows sorting (e.g., by Biggest Drop, Recently Added) and text searching.
  - Detailed product cards show explicit price histories, timestamps of previous scrapes, and native wishlist price-drop text.
  - "Sync Wishlist Now" button to manually trigger a batch update for a specific wishlist.

### 3.3 Options Page (`options.html`)
- **Purpose:** Global settings and data export.
- **Features:**
  - Configure global defaults: `Default Discount Alert (%)` and `Default Target Price`.
  - Configurable price history retention (e.g., 90 Days).
  - Export all raw tracking data to JSON.
  - Clear all price history.

---

## 4. Privacy & Data Storage
- **Local-Only:** All tracking data (`TRACKED_ITEMS`, `PRICE_HISTORY`) is saved strictly in `chrome.storage.local`.
- **No Cloud:** There is no external backend, no analytics tracking, and no data leaves the user's browser except for direct requests to Amazon domains.
- **Sync Storage:** Lightweight global preferences (like dashboard sort order and default alert thresholds) are stored in `chrome.storage.sync` to persist across the user's browser instances.
