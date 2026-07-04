# Repository Guidelines

## Project Structure & Module Organization

This repository is a Manifest V3 Chrome extension for tracking Amazon product and wishlist prices. `manifest.json` declares permissions, content scripts, extension pages, the background service worker, and icons. Runtime code lives in `src/`: `background/` handles alarms, scraping, notifications, and offscreen parsing; `content/` runs on Amazon pages; `dashboard/` contains the main tracked-items and wishlist import UI; `popup/` provides quick actions; `options/` manages settings and data tools; `utils/storage.js` centralizes Chrome storage helpers. Tests live in `src/__tests__/`, assets in `assets/`, and architectural notes in `docs/lessons_learned.md`.

## Build, Test, and Development Commands

- `npm test`: runs Jest unit tests and skips browser E2E tests.
- `npm run test:unit`: explicit alias for the unit suite.
- `npm run test:e2e`: launches Chromium with Puppeteer, loads the unpacked extension, and verifies extension UI behavior.

There is no build step; load this directory directly in Chrome as an unpacked extension.

## Coding Style & Naming Conventions

Use modern JavaScript with two-space indentation, `const`/`let`, small helpers, and explicit async error handling. Extension pages use ES modules where imported helpers are needed; Jest tests remain CommonJS-compatible. Prefer DOM APIs and `textContent` for scraped data. Avoid `innerHTML` unless content is static and trusted. Use descriptive lowercase filenames such as `background.js`, `scraper.js`, and `dashboard.js`.

## Testing Guidelines

Name tests `*.test.js`; reserve `*.e2e.test.js` for Puppeteer/Chromium coverage. Add parser fixtures when Amazon DOM behavior changes, especially for price, availability, CAPTCHA, wishlist pagination, or native price-drop text. Run `npm test` before normal changes. Run `npm run test:e2e` after touching `manifest.json`, popup/dashboard/options UI, background startup, icons, or extension loading behavior.

## Commit & Pull Request Guidelines

No Git history is available in this checkout. Use short imperative commit messages, for example `Preserve wishlist price-drop metadata`. Pull requests should include a summary, tests run, linked issue/task, and screenshots for UI changes.

## Agent-Specific Instructions

Read `docs/lessons_learned.md` before changing scraper, storage, dashboard, UI, security-sensitive paths, or E2E behavior. Record major findings there instead of fixing architectural pitfalls silently.
