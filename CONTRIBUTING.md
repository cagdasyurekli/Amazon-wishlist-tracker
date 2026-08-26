# Contributing

Thank you for helping improve Amazon Wishlist Tracker.

## Before changing code

Read `AGENTS.md`, `docs/feature_specs.md`, and `docs/lessons_learned.md`. Keep the extension local-first, avoid remote executable code, preserve the Amazon hostname allowlist, and treat scraped page content as untrusted.

Product behavior changes must update `docs/feature_specs.md`. Significant scraper, storage, scheduling, security, or UI lessons should be recorded in `docs/lessons_learned.md`.

## Local checks

```bash
npm ci
npm test -- --runInBand
npm run test:scraper-contract
npm run test:e2e
```

Before proposing a release candidate:

```bash
npm run audit:deps
npm run release:check
```

Add parser fixtures when Amazon markup changes. UI changes should cover keyboard behavior, light/dark appearance, narrow layouts, destructive-action confirmation, and large tracked lists.

## Pull requests

Keep changes focused. Include a concise summary, tests run, risk or privacy implications, and screenshots for visible UI changes. Do not include real wishlists, exports, credentials, cookies, or personal data in fixtures, logs, screenshots, or issues.

Report suspected vulnerabilities privately according to `SECURITY.md`.

## Issues and support

Use the repository's issue chooser so bug reports, feature requests, and support
questions collect the right evidence. Search existing issues first and keep each issue
focused on one problem or proposal. General installation and usage questions belong in
the support form; suspected product defects belong in the bug form.

Never use a public issue for a suspected security vulnerability or private shopping
data. Follow `SECURITY.md` for private reporting.
