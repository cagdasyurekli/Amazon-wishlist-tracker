# Chrome Web Store Listing — Amazon Wishlist Tracker

> Last Updated: 2026-08-24
>
> Distribution decision: Chrome Web Store publication is not planned and is outside
> the active product/release scope. This file is retained only as historical planning
> context; none of its incomplete listing assets or contact fields are release blockers.

## Store Listing

**Extension Name**
Amazon Wishlist Tracker


**Short Description**
Track Amazon product and wishlist prices locally with history, targets, and smart alerts.


**Detailed Description**
Amazon Wishlist Tracker is an independent, privacy-first Chrome extension that tracks supported Amazon product and wishlist prices directly from your browser.

Features:
- Import public/shared Amazon wishlists and optionally keep product membership in sync
- Monitor individual products directly from any Amazon product page
- View timestamped price history and recent fetch values in the dashboard
- Receive automatic notifications for price drops and restocks
- Set per-product target prices and prioritize selected products
- Support for multiple Amazon regions (.com, .nl, .de, .fr, .es, .it, .co.uk)
- No developer backend, analytics SDK, advertising SDK, or extension account

How to use:
1. Navigate to any Amazon product page and click the "Track price" button.
2. Alternatively, open a public/shared Amazon Wishlist and choose "Import This Wishlist" to review and import its items.
3. Open the dashboard to search, filter, inspect price history, and manage targets or priorities.
4. Configure discount alerts and let bounded background checks refresh due products.

Privacy Note:
Tracked products, wishlist URLs, price history, and scraper state are stored in Chrome local extension storage. Lightweight preferences use Chrome Sync when enabled. The browser sends direct refresh requests to supported Amazon domains; there is no developer-operated backend or analytics service. JSON export is an explicit local download containing product and history data. See `PRIVACY.md` for the complete disclosure.

Amazon and the Amazon logo are trademarks of Amazon.com, Inc. or its affiliates. This independent project is not affiliated with or endorsed by Amazon.


**Category**
Shopping


**Single Purpose**
Tracks Amazon product prices and wishlists locally to alert you of price drops and restocks.


**Primary Language**
English


## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 transparent PNG | ✅ Validated locally | `assets/icon128.png` |
| Screenshot 1 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 4 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 5 | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile | 440×280 | ⬜ Not created | |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |


### Screenshot Notes
- **Screenshot 1**: Show the bounded quick-actions popup with three product highlights.
- **Screenshot 2**: Show the Dashboard importing a large wishlist with the "Price dropped" badges visible.
- **Screenshot 3**: Show the "Track price" button injected into an Amazon product page.
- **Screenshot 4**: Show the options page highlighting the privacy-first local storage settings.


## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Required to save the user's tracked items, price history, and extension settings locally on their device. |
| `unlimitedStorage` | permissions | Required to store long-term historical price data points for the user's tracked items without hitting the standard 5MB browser quota. |
| `alarms` | permissions | Required to schedule background checks for price updates and restocks without keeping the extension active in memory. |
| `notifications` | permissions | Required to alert the user immediately when a tracked item drops in price or comes back in stock. |
| `offscreen` | permissions | Required to accurately parse Amazon's product and wishlist HTML in the background using DOM APIs not available in service workers. |
| `tabs` | permissions | Required to determine if the user is currently viewing an Amazon wishlist to offer contextual import features. |
| `https://*.amazon.com/*` (and supported EU HTTPS regions) | host_permissions | Required to fetch real-time price and stock data directly from Amazon domains on the user's behalf. |


## Privacy & Data Use

### Data Collection

**Does the developer collect user data?** No. Direct Amazon requests and optional Chrome preference sync are disclosed in `PRIVACY.md`.

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes


## Privacy Policy

**Privacy Policy URL**
Use the public repository URL for `PRIVACY.md` after the repository is published. Verify the final URL before store submission.


## Distribution

**Visibility**: Public after separately approved publication

**Regions**: Supported Amazon regions only

**Pricing**: Free


## Developer Info

**Publisher Name**
Cagdas Yurekli

**Contact Email**
Required before submission; do not publish with a placeholder.

**Support URL / Email**
Required before submission; use a public support route that does not expose security reports.

**Homepage URL**
Use the public repository URL after readback verification.


## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.0 | 2026-07-04 | Initial release | Released |
| 1.1.0 | 2026-08-24 | Adaptive sync, scale, UI, logo, privacy and security hardening | GitHub source public; Chrome Web Store not submitted |
| 1.2.0 | 2026-08-24 | Validated backup restore and public-repository automation | GitHub source release only; Chrome Web Store not submitted |
| 1.2.1 | 2026-08-25 | Scrape coordination, partial-result safety, and history-clear ordering | GitHub source release only; Chrome Web Store not submitted |
| 1.3.0 | 2026-08-26 | Regional availability, canonical identity, compacted history, backup v2, and serialized settings | GitHub source release only; Chrome Web Store not submitted |
