# Chrome Web Store Listing — Amazon Wishlist Tracker

> Last Updated: 2026-08-23
>
> Draft listing copy only. For installation and current product behavior, use
> `docs/USER_MANUAL.md` and verify claims against source/tests.

## Store Listing

**Extension Name**
Amazon Wishlist Tracker


**Short Description**
Premium Amazon price and stock tracker with history charts and smart alerts.


**Detailed Description**
Amazon Wishlist Tracker is a privacy-first, powerful tool that automatically tracks prices, stock availability, and price drops for any product on Amazon directly from your browser. 

Features:
- Import selected products from public/shared Amazon wishlists and optionally keep the list in sync
- Monitor individual products directly from any Amazon product page
- View detailed price history sparklines to know if you're getting a good deal
- Receive automatic notifications for price drops and restocks
- Support for multiple Amazon regions (.com, .nl, .de, .fr, .es, .it, .co.uk)
- Privacy-focused: tracked products and price history stay in the local Chrome profile. Small preferences (such as dashboard view and discount settings) may use Chrome sync when enabled; tracked products and history do not sync. No product backend, analytics collection, or external account is required.

How to use:
1. Navigate to any Amazon product page and click the "👀 Track Price" button.
2. Alternatively, open a public/shared Amazon wishlist and click "Track This Wishlist" in the Dashboard to select items for import.
3. Open the extension popup for highlights, or the Dashboard for the full list, targets, filters, and price-history charts.
4. Set up custom discount alerts and sit back while the extension checks prices in the background.

Privacy Note:
Your tracked products and price history stay in the local Chrome profile and do not
sync. Small preferences, such as dashboard view and discount settings, may use Chrome
sync when browser sync is enabled. The extension fetches price data directly from
supported Amazon domains and has no product backend or analytics service.


**Category**
Shopping


**Single Purpose**
Tracks Amazon product prices and wishlists locally to alert you of price drops and restocks.


**Primary Language**
English


## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | 🟡 Needs check | `assets/icon128.png` |
| Screenshot 1 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 4 | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 5 | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile | 440×280 | ⬜ Not created | |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |


### Screenshot Notes
- **Screenshot 1**: Show the extension popup open with tracked-item highlights.
- **Screenshot 2**: Show the Dashboard importing a large wishlist with the "Price dropped" badges visible.
- **Screenshot 3**: Show the "👀 Track Price" button injected into an Amazon product page.
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
| `*://*.amazon.com/*` (and EU regions) | host_permissions | Required to fetch real-time price and stock data directly from Amazon domains on the user's behalf. |


## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes


## Privacy Policy

**Privacy Policy URL** 
*Recommendation: Host a privacy-policy page that says tracked products and history stay
local; only small preferences may use Chrome sync when the user enables browser sync;
and price requests go directly to supported Amazon domains. Do not claim that all data
is local-only or that nothing can sync.*


## Distribution

**Visibility**: Public
**Regions**: All regions
**Pricing**: Free


## Developer Info

**Publisher Name** 
[Your Name]

**Contact Email** 
[Your Email]

**Support URL / Email** 
[Your Link]

**Homepage URL** 
[Your Link]


## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.0 | 2026-07-04 | Initial Release | Draft |
