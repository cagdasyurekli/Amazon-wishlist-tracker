# Amazon Wishlist Tracker

A privacy-first Manifest V3 Chrome extension that tracks Amazon product and wishlist prices without an external application backend.

## What it does

- Tracks products from supported Amazon regions: `.com`, `.co.uk`, `.de`, `.fr`, `.es`, `.it`, and `.nl`.
- Imports public or shared wishlists and can keep their product membership in sync.
- Uses bounded adaptive price checks, a separate priority queue, and anti-bot backoff.
- Shows timestamped price history, availability, targets, and Amazon wishlist price-drop metadata.
- Sends local Chrome notifications for configured price, discount, and restock conditions.

## Privacy model

Tracked products, wishlist URLs, price history, and scraper state are stored in `chrome.storage.local`. Lightweight preferences such as dashboard sort/filter choices and the default discount threshold use `chrome.storage.sync` and may therefore be synchronized by Chrome when the user enables browser sync.

The extension has no analytics SDK, advertising SDK, account system, or developer-operated backend. It makes direct requests from the browser to the supported Amazon domains to refresh product and wishlist information. See [PRIVACY.md](PRIVACY.md) for the complete data flow and deletion guidance.

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the repository directory.
5. Pin **Amazon Wishlist Tracker** from Chrome's extensions menu if desired.

There is no production build step; Chrome executes the checked-in extension source directly.

## Use

- On a supported Amazon product page, open the extension and choose **Track This Product**.
- On a public/shared wishlist, choose **Import This Wishlist**, or paste its URL into the dashboard.
- Use the dashboard to search, filter, inspect history, set per-product target prices, prioritize checks, and manage tracked items.
- Enable **Keep List in Sync** only when new and removed wishlist membership should be reconciled automatically. Items tracked independently or by another wishlist are preserved.

## Development and verification

Requirements: Node.js 20 or newer and a locally available Chrome/Chromium supported by Puppeteer.

```bash
npm ci
npm test -- --runInBand
npm run test:scraper-contract
npm run test:e2e
```

Before preparing a public release candidate, run:

```bash
npm run audit:deps
npm run release:check
```

`release:check` audits dependencies, validates manifest references, icon dimensions/transparency, package/manifest/lockfile version parity, production dependency absence, local extension assets, unit tests, scraper continuation contracts, Chrome E2E tests, and `git diff --check` when executed in a Git worktree. The dependency-audit step requires current registry access.

## Architecture

- `src/background/`: MV3 service worker scheduling, serialized scrape jobs, notifications, and offscreen parsing orchestration.
- `src/background/offscreen.html`: local DOM parsing surface used because service workers do not provide `DOMParser`.
- `src/content/`: Amazon page detection, visible wishlist extraction, and the in-page tracking action.
- `src/popup/`: bounded quick-actions popup.
- `src/dashboard/`: full list, wishlist, history, target, filter, and priority management.
- `src/options/`: global preferences, local JSON export, and price-history deletion.
- `src/__tests__/`: parser, scheduler-contract, and real Chromium extension tests.

## Public project guidance

- Security policy and reporting: [SECURITY.md](SECURITY.md)
- Privacy and data lifecycle: [PRIVACY.md](PRIVACY.md)
- Release history: [CHANGELOG.md](CHANGELOG.md)
- Stable-candidate acceptance: [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)
- Contributions and local verification: [CONTRIBUTING.md](CONTRIBUTING.md)
- Chrome Web Store preparation checklist: [CHROMEWEBSTORE.md](CHROMEWEBSTORE.md)

Amazon and the Amazon logo are trademarks of Amazon.com, Inc. or its affiliates. This independent project is not affiliated with or endorsed by Amazon.
