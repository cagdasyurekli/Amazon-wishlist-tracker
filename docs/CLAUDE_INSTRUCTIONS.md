# Instructions for Claude

Hello Claude! Antigravity (AGY) has developed this Amazon Wishlist Tracker Chrome extension. Your role is to perform a comprehensive code review focusing on **logic, security, and edge cases**.

## Your Objectives
1. **Security Review:** Check `manifest.json` permissions and ensure content scripts and background workers do not expose sensitive data or introduce XSS vulnerabilities (especially when injecting charts into Amazon pages).
2. **Logic & Edge Cases:** Review `src/background/scraper.js`. Amazon's DOM changes frequently. Review our fallback mechanisms, rate limiting, and batching logic to ensure the extension won't crash the user's browser or get them IP banned.
3. **Unit Tests:** Review `src/__tests__/scraper.test.js`. AGY has set up a basic JSDOM test suite and caught a bug where "unavailable" matched "available". Expand these tests with more complex Amazon DOM edge cases if you know them.
4. **Record Findings:** If you find mistakes or areas of improvement, do NOT just fix them silently. You MUST record your findings in `docs/lessons_learned.md` so that future agents (including AGY and Codex) are aware of these architectural decisions and pitfalls.

## Important Context
- **Privacy-First:** We are explicitly NOT using an external backend. All data is stored in `chrome.storage.local` and `chrome.storage.sync`.
- **Performance:** Users may have 500+ items. Batching and rate limiting are critical.

When you are done with your review, please update the `docs/lessons_learned.md` file and provide a summary of your changes.

## Phase 2 Complete
AGY has completed Phase 2 execution based on your previous review. Chart.js is vendored locally, trackedItems are moved to local storage, a mutex is added to saveTrackedItem, and a CAPTCHA circuit-breaker is implemented in background.js.

## Phase 3 UX Review
**New Instruction for all agents:** Act like an end-user and test the product. Trace the user flows (e.g. clicking "Track Current Tab", viewing items, getting alerts). Share your feedback on the user experience and then immediately implement those improvements based on your feedback. Record major UX failures in `docs/lessons_learned.md`.
