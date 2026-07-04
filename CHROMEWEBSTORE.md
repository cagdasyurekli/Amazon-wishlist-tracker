# Chrome Web Store Listing — Amazon Wishlist Tracker

> Last Updated: 2026-07-04

## Store Listing

**Extension Name**
Amazon Wishlist Tracker


**Short Description**
Premium Amazon price and stock tracker with history charts and smart alerts.


**Detailed Description**
Amazon Wishlist Tracker is a privacy-first, powerful tool that automatically tracks prices, stock availability, and price drops for any product on Amazon directly from your browser. 

Features:
- Track entire Amazon Wishlists with a single click
- Monitor individual products directly from any Amazon product page
- View detailed price history sparklines to know if you're getting a good deal
- Receive automatic notifications for price drops and restocks
- Support for multiple Amazon regions (.com, .nl, .de, .fr, .es, .it, .co.uk)
- 100% Privacy-focused: All tracking data and price history is stored entirely locally on your device. No cloud syncing, no data collection, and no external accounts required.

How to use:
1. Navigate to any Amazon product page and click the "👀 Track Price" button.
2. Alternatively, open your Amazon Wishlist and click "Track This Wishlist" in the extension Dashboard to import all items at once.
3. Open the extension popup to view your tracked items, current prices, and visual price histories.
4. Set up custom discount alerts and sit back while the extension checks prices in the background.

Privacy Note:
Your data is yours. This extension operates completely locally. It fetches price data directly from Amazon to your browser. No data is ever sent to third-party servers.

Support:
If you find this tool helpful, consider supporting the developer via the options menu!


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
- **Screenshot 1**: Show the extension popup open with a list of tracked items and price history sparklines.
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
*Recommendation: Host a simple text page on GitHub Pages or Notion stating that "Amazon Wishlist Tracker stores all data locally and transmits absolutely no personal information or tracking data to any third parties."*


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

