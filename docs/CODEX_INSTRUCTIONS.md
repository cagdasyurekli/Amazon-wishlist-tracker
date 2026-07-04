# Instructions for Codex

Hello Codex! Antigravity (AGY) has developed this Amazon Wishlist Tracker Chrome extension. Your role is to perform a comprehensive code review focusing on **performance, modern JavaScript practices, and UI/UX efficiency**.

## Your Objectives
1. **Performance & Memory Management:** Review `src/background/background.js` and `src/background/scraper.js`. Ensure that DOM parsers are correctly garbage-collected and that `chrome.storage` is not being overwhelmed with excessive reads/writes.
2. **Modern Web Practices:** Ensure the popup and options UI (`src/popup/`, `src/options/`) use modern HTML5/CSS3. Ensure the CSS uses efficient selectors and modern styling (glassmorphism, dark mode) as defined in our premium design goals.
3. **E2E Testing (Crucial Task):** AGY deferred the End-to-End testing. Your job is to set up Puppeteer for testing the Chrome Extension headlessly. Note: Puppeteer heavily uses ES modules which may conflict with Jest's default CommonJS behavior. You will need to resolve this (e.g., via Babel or dynamic imports) and write a test that loads the extension.
4. **Record Findings:** If you find inefficiencies or anti-patterns, do NOT just fix them silently. You MUST record your findings in `docs/lessons_learned.md` so that future agents are aware of these architectural rules.

## Important Context
- **Resource Constraints:** Chrome extensions must be lightweight. The background script is a Service Worker and will terminate when idle. Ensure state is properly managed.
- **UI Aesthetics:** The extension must look premium. Do not sacrifice visual quality, but ensure animations and charts are highly optimized.

When you are done with your review, please update the `docs/lessons_learned.md` file and provide a summary of your changes.

## Phase 2 Complete
AGY has completed Phase 2 execution based on your previous review. Chart.js is vendored locally, trackedItems are moved to local storage, a mutex is added to saveTrackedItem, and a CAPTCHA circuit-breaker is implemented in background.js.

## Phase 3 UX Review
**New Instruction for all agents:** Act like an end-user and test the product. Trace the user flows (e.g. clicking "Track Current Tab", viewing items, getting alerts). Share your feedback on the user experience and then immediately implement those improvements based on your feedback. Record major UX failures in `docs/lessons_learned.md`.
