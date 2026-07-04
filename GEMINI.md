# GEMINI.md

This file provides guidance to Gemini when working with code in this repository.

## Repository Overview & Guidelines

This is a Manifest V3 Chrome extension for tracking Amazon wishlist items and product prices locally. **Privacy is a core feature**: there is no backend, all state lives in `chrome.storage`, and network calls must ONLY go to Amazon hosts.

### Important Context & Rules

1. **Read `docs/lessons_learned.md`**: Before making changes to scraping logic, storage, or UI architectures, you MUST read the lessons learned doc. Any new architectural decisions, bug fixes for edge cases, or UX patterns must be recorded there.
2. **Read `AGENTS.md`**: This contains the core repository guidelines and rules.
3. **No Scratch Files**: Keep the root directory clean. If you need temporary files, use your artifact scratch space. A cleanup occurred on 2026-07-04 that deleted outdated test scripts from the root directory.
4. **Testing**: 
   - `npm test` runs the jsdom unit tests.
   - `npm run test:e2e` runs the Puppeteer UI tests.
5. **No External CDNs**: Do not introduce any external CDN scripts into the UI (e.g., popup, dashboard) due to Content Security Policy restrictions in MV3.

When modifying this repository, ensure you adhere to the project's design philosophy: local-only, clean UX, and minimal permissions.
