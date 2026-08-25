# Privacy Policy

Last updated: 2026-08-25

Amazon Wishlist Tracker is a browser extension that tracks Amazon products and wishlists without a developer-operated backend, analytics service, advertising service, or extension account.

## Data stored locally

The extension stores the following data in `chrome.storage.local` on the user's browser profile:

- Product identifiers, titles, Amazon URLs, displayed images, current/original prices, currencies, availability, and wishlist price-drop metadata.
- Wishlist identifiers and URLs selected by the user.
- Price history, target prices, source membership, priority state, last/next check metadata, pagination checkpoints, anti-bot backoff state, and an opaque local generation marker that prevents pre-clear/restore work from repopulating history.

This data is not sent to the developer.

## Preferences synchronized by Chrome

Lightweight global preferences use `chrome.storage.sync`, including the default discount threshold, history-retention choice, and dashboard sort/filter preferences. If Chrome Sync is enabled, Google may synchronize those preferences between the user's Chrome profiles under Google's own terms. Product lists, wishlist URLs, and price history are not intentionally stored in `chrome.storage.sync`.

## Network requests

To perform its single purpose, the extension makes direct requests from the user's browser to the supported Amazon regional domains declared in `manifest.json`. The dashboard may also load a product image from an exact HTTPS Amazon image-CDN allowlist after the URL passes host and path validation. Amazon receives those marketplace and image requests and may process network identifiers under Amazon's policies. The extension does not send tracked data to a developer server or unrelated third party.

The content script reads product and wishlist information already displayed on supported Amazon pages. Background requests do not intentionally attach Amazon session credentials.

## Notifications and backups

Chrome notifications are generated locally when a configured price, discount, or restock condition is met.

**Export Data (JSON)** creates an unencrypted local download containing tracked items, price history, tracked wishlists, supported preferences, and export metadata. The user controls that file after download and should protect or delete it as appropriate.

**Restore Backup** reads a user-selected JSON file locally in the extension. The file is not uploaded to the developer or another service. After validation and an explicit two-step confirmation, restore replaces the corresponding Chrome extension data and preferences. Active Amazon CAPTCHA/rate-limit backoff is operational safety state and is preserved rather than imported or cleared.

## Retention and deletion

The selected history-retention setting removes expired price-history points during maintenance. Users can clear all price history from the options page without deleting tracked products. A confirmed clear waits behind previously started scrape/import work before deleting the history, while later tracking may record new samples. Individual products can be removed from the dashboard. Uninstalling the extension removes its Chrome-managed extension storage; previously downloaded JSON exports are separate files and must be deleted by the user.

## Permissions

- `storage` and `unlimitedStorage`: store tracked products, histories, settings, and bounded operational state.
- `alarms`: schedule adaptive product checks, priority checks, and resumable wishlist sync.
- `notifications`: show local price and availability alerts.
- `offscreen`: parse Amazon HTML with DOM APIs unavailable to an MV3 service worker.
- `tabs`: identify supported open Amazon product/wishlist tabs and communicate with their content scripts.
- Amazon host permissions: read supported pages and fetch current product/wishlist information directly from Amazon.

## Changes

Material changes to data collection, destinations, permissions, retention, or backup behavior must update this policy before release. Chrome Web Store distribution is not part of the current product scope.

Amazon and the Amazon logo are trademarks of Amazon.com, Inc. or its affiliates. This independent project is not affiliated with or endorsed by Amazon.
