# Amazon Wishlist Tracker

A privacy-first Manifest V3 Chrome extension to track Amazon product and wishlist prices locally. All data stays on your machine, with no external backend or tracking.

## Key Features

- **Local Storage**: All your tracked items, price history, and settings are saved securely in your browser using `chrome.storage.local`.
- **Wishlist Sync**: Easily import entire Amazon wishlists and keep track of price drops across multiple items.
- **Price History Charts**: View interactive sparkline charts of price trends right in the extension popup and detailed charts in the dashboard.
- **Restock Alerts**: Get notified when an out-of-stock item you're tracking becomes available again.
- **Priority Tracking**: Mark items as priority for more frequent background scraping.
- **Multi-region Support**: Works with `.com`, `.co.uk`, `.de`, `.fr`, `.es`, `.it`, and `.nl` Amazon domains.

## Installation

Because this is a locally-developed extension without a build step, you can load it directly into Chrome:

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle switch in the top right corner).
3. Click the **Load unpacked** button.
4. Select the directory containing this repository.
5. The extension will appear in your toolbar. Pin it for quick access!

## Usage

- **Track a Product**: Navigate to any Amazon product page. Click the extension icon and select "Track This Product".
- **Import a Wishlist**: Navigate to an Amazon wishlist page. Click the extension icon and select "Import This Wishlist", or use the `Sync Wishlist` feature in the dashboard.
- **Dashboard**: Click the "View All" button in the popup to open the Dashboard. Here you can search, filter, view detailed price history, and manage your tracked items.

## Development

There is no build step. The source code is executed directly.

### Running Tests

To run the test suite, you need Node.js installed.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run unit tests (uses jsdom, no browser needed):
   ```bash
   npm test
   ```
3. Run E2E tests (launches headless Chromium via Puppeteer to test extension UI):
   ```bash
   npm run test:e2e
   ```

### Architecture Overview

- **Service Worker (`src/background/`)**: Manages alarms and orchestrates scraping jobs. Persists data to `chrome.storage`.
- **Offscreen Document (`src/background/offscreen.html`)**: Used solely for its `DOMParser` capability to parse Amazon HTML safely in the background.
- **Content Scripts (`src/content/`)**: Injected into Amazon pages to detect products/wishlists and inject the native "Track Price" button.
- **Popup & Dashboard (`src/popup/`, `src/dashboard/`)**: The user interfaces for managing tracked items.

## AI Agent Guidelines

If you are an AI assistant (Claude, Gemini, Codex, etc.) working on this repository, please read the following files before making changes:
- `AGENTS.md`
- `GEMINI.md`
- `CLAUDE.md`
- `docs/lessons_learned.md`
