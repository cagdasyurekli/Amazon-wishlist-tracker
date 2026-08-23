# Amazon Wishlist Tracker

Amazon Wishlist Tracker is a Manifest V3 Chrome extension that tracks prices and
stock for individual Amazon products and public/shared wishlists. It runs without a
backend or analytics service.

Tracked products, wishlists, price history, and scrape state stay in the local Chrome
profile. Small preferences use `chrome.storage.sync` and may follow the user's Chrome
profile when browser sync is enabled.

## Features

- Track individual products on supported Amazon marketplaces.
- Import selected items from public/shared wishlists and optionally keep a list in sync.
- Set per-product target prices and a default discount alert threshold.
- Prioritize up to 10 products for more frequent checks.
- Search, sort, filter, inspect price history, and review next-check status.
- Receive target, discount, restock, and purchased-item notifications.
- Export tracked items and history as JSON and configure history retention.

Supported marketplaces: `amazon.com`, `amazon.co.uk`, `amazon.de`, `amazon.fr`,
`amazon.es`, `amazon.it`, and `amazon.nl`.

## Install and use

There is no build step. Open `chrome://extensions/`, enable **Developer mode**, choose
**Load unpacked**, and select this repository root—the directory containing
`manifest.json`.

For first use, common workflows, safe updates, privacy details, limitations, and
troubleshooting, read the [User Manual](docs/USER_MANUAL.md).

## Development

Install the lockfile-defined dependencies and run both verification layers:

```bash
npm ci
npm test
npm run test:e2e
npm run visual:qa
```

`npm test` runs the Jest unit/parser suite. `npm run test:e2e` launches Chromium,
loads the unpacked extension, and checks selected startup and UI contracts. Source
files are executed directly by Chrome.

`npm run visual:qa` is an offline visual smoke check. It loads only the unpacked
extension, seeds synthetic extension storage, fails on console errors, and writes
popup, dashboard, and Options screenshots under ignored `artifacts/visual-qa/`. The
dashboard/Options captures include both a synthetic previous-target warning state and
its resolved state. The command does not open Amazon pages or scrape live data.

Architecture in brief:

- `src/background/`: alarms, scraping orchestration, notifications, and offscreen parsing.
- `src/content/`: Amazon-page detection and the in-page tracking action.
- `src/popup/`, `src/dashboard/`, `src/options/`: user interfaces.
- `src/utils/storage.js`: local/sync storage boundaries and safe update helpers.
- `docs/feature_specs.md`: expected behavior for QA.

AI coding tools must start with [AGENTS.md](AGENTS.md). Model-specific files are only
discovery pointers; repository rules and documentation authority live in `AGENTS.md`.
