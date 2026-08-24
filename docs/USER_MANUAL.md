# Amazon Wishlist Tracker — User Manual

## 1. What the extension does

Amazon Wishlist Tracker is a locally installed Chrome extension for monitoring prices
and stock on supported Amazon product pages. You can track one product at a time or
import selected products from a public/shared Amazon wishlist. The extension records
price history, shows upcoming checks, and can notify you when a target is reached.

The extension is not an Amazon service. It does not place orders, change wishlists, or
sign in to an Amazon account.

Supported marketplaces:

- `amazon.com`
- `amazon.co.uk`
- `amazon.de`
- `amazon.fr`
- `amazon.es`
- `amazon.it`
- `amazon.nl`

## 2. Before you install

### Source provenance for unpacked installs

The canonical source repository is
`https://github.com/cagdasyurekli/Amazon-wishlist-tracker.git`. Unpacked source has
no release signature or checksum in this repository. If someone supplies an expected
commit, verify that commit before loading the extension; otherwise treat the source as
unverified and inspect it before use.

You need:

- Desktop Google Chrome or a compatible Chromium browser that supports unpacked
  Manifest V3 extensions.
- A trusted copy of this repository, including `manifest.json` and `assets/icon*.png`.
- Permission to enable **Developer mode** in the browser.

Node.js is not required to use the extension. It is needed only for development and
automated tests.

Important limitations before you begin:

- Wishlist import is intended for a public/shared wishlist that Amazon makes visible
  in the open page or to a logged-out request. Never give this extension your Amazon
  password, cookie, or another credential.
- Background requests intentionally do not use your signed-in Amazon session. Prices,
  sellers, availability, or wishlist visibility can therefore differ from the page
  you see while signed in.
- Amazon can change its page markup or temporarily block automated requests. The
  extension pauses rather than increasing request pressure when it detects a CAPTCHA
  or rate limit.

## 3. Install the unpacked extension

1. Keep the complete repository in a stable folder. Do not select only `src/`.
2. In Chrome, open `chrome://extensions/`.
3. Turn on **Developer mode**.
4. Select **Load unpacked**.
5. Choose the repository root—the folder containing `manifest.json`.
6. Confirm that **Amazon Wishlist Tracker** appears without an error badge.
7. Open Chrome's Extensions menu and pin Amazon Wishlist Tracker for quick access.

If Chrome reports a missing icon, manifest, or service-worker error, see
[Troubleshooting](#13-troubleshooting) before tracking products.

## 4. First-run check

1. Open the extension from the toolbar.
2. Select the **↗** button (accessible name: **Open dashboard**). The dashboard
   should open in a tab.
3. Select the gear icon to open **Extension Settings**.
4. Return to a supported Amazon product page and reload that tab once after a new
   installation. This lets the content script attach to a page that was already open.

The initial empty state is normal. Price history appears only after a successful price
check records a sample.

## 5. Track one product

### From the extension popup

1. Open a product detail page on a supported Amazon marketplace.
2. Open Amazon Wishlist Tracker from the toolbar.
3. Select **Track This Product**.
4. Wait for the inline success message. The popup remains the source of truth for
   whether the request succeeded or the item was already tracked.

### From the Amazon page

1. Open a supported product detail page.
2. Find **Track price** near the product buying area.
3. Select it and watch the button state: **Adding…** while the request is in
   progress, **Tracking price** after the extension confirms tracking, or
   **Try again** if it fails. The in-page control does not show a separate
   “Already Tracking” state.

If the action is missing, allow the page to finish loading and reload the tab. Amazon
renders some buying controls asynchronously, and pages opened before installation do
not have the content script until they are reloaded.

## 6. Import a public/shared wishlist

The most reliable import starts with the wishlist open in a Chrome tab.

1. Open the public/shared Amazon wishlist.
2. Open the extension. Select **Import This Wishlist**, or open the dashboard and
   select **Track This Wishlist**.
3. You can also paste a supported wishlist URL into **Shared Amazon wishlist URL** and
   select **Import Wishlist**.
4. In **Select Items**, keep or clear the products you want. Use **Select All** when
   helpful.
5. Decide whether to enable **Keep this list in sync automatically**.
6. Select **Confirm Tracking** and wait for the completion message.

**Keep List in Sync** lets periodic complete wishlist scans add newly discovered
products and stop tracking products removed from that wishlist. A product is preserved
when it is also tracked individually or belongs to another tracked wishlist. Partial or
interrupted wishlist scans do not remove missing products.

To refresh a wishlist manually, keep its Amazon tab open, open the dashboard, and
select **Sync Wishlist Now**. The button reports reading, product-count, saving, and
success or failure states. Reload the Amazon tab if the dashboard says it cannot read
the wishlist.

## 7. Use the dashboard

Open the dashboard with the **↗** button (accessible name: **Open dashboard**) in the
popup.

### Find and organize products

- **Search** matches product title, ASIN (Amazon Standard Identification Number), status, target information, and other visible
  item metadata.
- **Sort** supports Recently Added, Price: Low to High, Price: High to Low, and
  Discount %. The selection is remembered as a lightweight Chrome preference.
- **Filter** supports All items, Price drops, Priority, Out of stock, Target reached,
  and Not checked yet.
- Large result sets render 50 products at a time. Select **Load More** to see the next
  group without intentionally returning to the top.

### Review one product

- Select the product title to open its Amazon page.
- Select **View all entries** for current price, stock, target, wishlist discount
  information, and timestamped history.
- Select **History** for one product or **Expand Visible Histories** for all currently
  rendered products.
- Read **Last checked**, **Next check**, and the next-check summary as scheduling
  information, not a guaranteed wall-clock promise.

### Set or clear a target price

1. Select **Set target** on the product card.
2. Enter a positive price in that product's displayed currency.
3. Select **Save**. Select **Cancel** to discard the edit.
4. To clear the target, leave the input empty and select **Save**.

Target prices are per product so a single number is never applied across currencies.
Changing a target makes that item due for a new check.

### Use Priority Tracking

Select **Fast checks** to add a product to the priority queue; the pressed state means
it is active. Select it again to return to adaptive standard checks. Up to 10 products
can be priority items at once.

### Remove a product

1. Select **Remove**.
2. While the button says **Confirm remove**, select it again.

The confirmation expires after a few seconds. Removal stops tracking that product; it
does not remove anything from Amazon.

If **Keep List in Sync** remains enabled for a wishlist that still contains the
product, a later complete sync can add it again. Remove it from that Amazon wishlist or
re-import the list with **Keep List in Sync** cleared before removing it locally.

## 8. Understand checks and pauses

Standard products use an adaptive queue. Current scheduling tiers are approximately:

- Near a target: 10 minutes.
- Recently changing price: 15 minutes.
- Stable price: 90 minutes.
- Unavailable product: 3 hours.
- Ordinary retry after a failed check: 15 minutes.

A standard batch processes up to eight due products sequentially. Priority items use a
separate two-minute queue and process up to five products per batch. Wishlist work is
scheduled every 15 minutes, rotating through tracked lists and processing a bounded
number of pages per wake.

These are scheduling targets, not guarantees. Chrome can suspend a Manifest V3 service
worker, the browser may be closed, the computer may sleep, network access can fail, and
Amazon may delay or block requests.

When Amazon returns a CAPTCHA or rate-limit response, the dashboard shows a pause
banner with an expected resume time. Backoff begins at about one hour, doubles after
repeated blocks, and is capped at 24 hours. Let the pause expire; repeatedly forcing
sync does not make the result more reliable.

## 9. Alerts and the toolbar badge

Chrome notifications can report:

- A price reaching or crossing a product's target.
- A discount reaching the configured threshold.
- A tracked product changing from out of stock to in stock.
- After an upgrade, a one-time notice that a previous currencyless global target is
  paused and must be reviewed in **Extension Settings**.

Repeated checks do not intentionally send the same unchanged threshold alert.
Selecting a price, discount, or restock notification opens the tracked Amazon
product. Selecting the previous-target upgrade notice opens **Extension
Settings** instead.

The red toolbar badge is the number of tracked products that currently meet either a
target-price or discount condition. It is not the total tracked-product count and does
not mean every product was checked recently.

Notifications also depend on Chrome and operating-system notification permissions.

## 10. Settings and data tools

Open **Extension Settings** with the gear icon.

### Default Discount Alert (%)

Enter a whole number from 1 to 99. It supplies the discount threshold when a product
does not have a more specific value. Clear the field to remove the default.

### Keep Price History

Choose 30 Days, 90 Days, 1 Year, or Forever. Cleanup occurs during later background
maintenance; changing the setting is not a promise that every expired point disappears
immediately.

### Export Data (JSON)

Select **Export Data (JSON)** to download `saved_signal_backup.json`. It contains the
tracked product records, price history, and export time. Treat the file as private: it
can contain product titles, URLs, targets, and shopping-interest history.

The current extension has no JSON import/restore command. Export is useful for review
and safekeeping, but it is not an in-product restore guarantee.

### Clear Price History

1. Select **Clear Price History**.
2. While the button says **Confirm Clear History**, select it again.

This deletes recorded price-history points but keeps tracked products. There is no undo
inside the extension. Export first if you need a record. A background check that
finishes later can record a new sample; clearing history does not pause tracking.
A failed storage write leaves the button available for another attempt.

## 11. Privacy and permissions

The extension has no external backend and no analytics tracker. Its network permission
is limited to the supported Amazon marketplaces listed in this manual.

Data areas:

- `chrome.storage.local`: tracked products, tracked wishlists, price history, scrape
  cursors/state, Amazon backoff state, and a small opaque marker that prevents the same
  previous-target upgrade notice from repeating.
- `chrome.storage.sync`: small preferences such as alert defaults and dashboard view
  choices. These may sync through Chrome when browser sync is enabled.

Manifest permissions are used as follows:

- **storage / unlimitedStorage**: retain tracked products and price history.
- **alarms**: schedule background checks.
- **notifications**: show price, discount, restock, and migration-review alerts.
- **offscreen**: parse Amazon HTML with DOM APIs unavailable to the service worker.
- **tabs**: identify relevant open Amazon tabs and open extension/product pages.
- **Amazon host permissions**: read supported product and wishlist pages.

The extension does not need or request your Amazon password. Do not add credentials to
a bug report, exported example, or AI prompt.

## 12. Update, reload, and uninstall

### Update or reload a local copy

1. You may export data for review or safekeeping before a major update. The current UI
   cannot restore the JSON, so it is not a recovery backup.
2. Replace or update the repository files without moving `manifest.json` away from the
   selected root folder.
3. Open `chrome://extensions/`.
4. Select **Reload** on Amazon Wishlist Tracker.
5. Reload any already-open Amazon product or wishlist tabs.
6. Open **Extension Settings**. If you see **Review a previous target price**,
   resolve it before relying on target alerts: use the offered copy only when the
   listed products safely share one known currency, or choose **Acknowledge without
   copying** and set targets per product in the Dashboard. Old global target alerts
   stay paused while that review is pending because their currency is unknown.
7. Open the dashboard and confirm tracked products are still visible.

Do not select a different folder during an update unless you intend Chrome to treat it
as another unpacked extension installation.

### Uninstall

1. Export any data you want to retain for review or safekeeping; it cannot be restored
   by this version.
2. Open `chrome://extensions/`.
3. Select **Remove** for Amazon Wishlist Tracker and confirm.

Removing an extension can remove its Chrome storage. The exported JSON remains on disk,
but this version has no built-in restore command.

## 13. Troubleshooting

### Chrome will not load the extension

- Select the repository root containing `manifest.json`, not `src/`.
- Confirm `assets/icon16.png`, `assets/icon48.png`, and `assets/icon128.png` exist.
- Open the extension's **Errors** or service-worker inspection link on
  `chrome://extensions/` and record the exact error without credentials.

### Track This Product or Track Price is missing

- Confirm the page is a product detail page on a supported Amazon domain.
- Reload the Amazon tab after installing or reloading the extension.
- Let the buying area finish rendering, then reopen the popup.
- If the popup reports a missing content script, reload the tab and try once more.

### Wishlist import or sync fails

- Confirm the URL is a supported Amazon wishlist URL and the list is public/shared.
- Open the wishlist in a normal Chrome tab and reload it before selecting **Sync
  Wishlist Now**.
- Check for Amazon CAPTCHA/rate-limit messages and wait for the displayed backoff.
- A private or account-only list may not be readable because background requests do not
  use your Amazon session.

### A price or alert looks wrong or stale

- Review **Last checked**, **Next check**, and any pause banner.
- Open the Amazon product page and compare region, seller, currency, shipping, coupon,
  Prime-only, and signed-in pricing. The extension may see a logged-out offer.
- Keep Chrome running long enough for the next scheduled check.
- Confirm Chrome and operating-system notifications are allowed.

### Price history is empty

The first successful check creates the first timestamped sample. A newly tracked item,
an unavailable price, a sleeping browser, or active backoff can delay that sample.

## 14. Quick reference

| Goal | Where | Action |
|---|---|---|
| Track one product | Amazon product page or popup | **Track price** or **Track This Product** |
| Import a wishlist | Popup or dashboard | **Import This Wishlist**, **Track This Wishlist**, or paste URL + **Import Wishlist** |
| Refresh a tracked wishlist | Dashboard with the list open | **Sync Wishlist Now** |
| Open all products | Popup | **↗** (**Open dashboard**) |
| Set a target | Dashboard product card | **Set target** → price → **Save** |
| Prioritize a product | Dashboard product card | **Fast checks** |
| Inspect history | Dashboard product card | **History** or **View all entries** |
| Remove a product | Dashboard product card | **Remove** → **Confirm remove** |
| Export data | Extension Settings | **Export Data (JSON)** |
| Clear history | Extension Settings | **Clear Price History** → **Confirm Clear History** |
| Reload after update | Chrome extensions page | `chrome://extensions/` → **Reload** |
