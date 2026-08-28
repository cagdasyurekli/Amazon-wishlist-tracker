# Changelog

All notable changes to this project are documented here. Versions follow semantic versioning.

## [Unreleased]

## [1.4.2] - 2026-08-28

### Fixed

- Manual sync now recognizes Amazon's signed-in generic `/wishlist` route and accepts its visible products only after their bounded `colid` matches the tracked wishlist, avoiding the failing unauthenticated background fallback.

## [1.4.1] - 2026-08-28

### Fixed

- Visible Amazon.nl wishlist sync now prefers the named product-title link over an earlier image-only link, preventing every rendered row from being discarded before the safe background fallback.

## [1.4.0] - 2026-08-26

### Added

- Amazon Turkey (`amazon.com.tr`) product-page, popup, background-fetch, and public/shared wishlist support.
- Turkish availability classification and Turkish lira price normalization across visible-page and offscreen parsing.
- Reproducible 16px and 32px browser-icon generation from size-specific SVG sources.
- Dashboard search by bounded author names extracted from Amazon product bylines, including multiple contributors.

### Changed

- Wishlist identity validation accepts bounded `=` characters observed in Amazon Turkey list IDs while retaining the existing HTTPS, host, path, redirect, and length restrictions.

### Security

- Amazon Turkey wishlist pages without a strong document-level list identity remain non-destructive: visible products can be imported or updated, but missing-item reconciliation stays fail-closed.
- Chrome Web Store publication remains outside this source release; no Amazon credentials, session cookies, backend, analytics, or remote scripts were added.

## [1.3.0] - 2026-08-26

### Added

- Regional English, Dutch, German, French, Spanish, and Italian availability classification shared by visible-page and offscreen parsing.
- Bounded price-history compaction with seven days of raw samples, daily low/high samples through one year, monthly low/high samples thereafter, and a durable tracking-start baseline.
- Backup format v2 with compaction metadata, unresolved wishlist-region state, restore-validator parity, a 32 MiB limit, and Blob URL downloads while retaining v1 and unversioned restore support.
- Sender-scoped `PATCH_SETTINGS` updates, locale-aware price formatting, Escape/focus restoration, a temporary target-reached dashboard filter, and correctness-focused ESLint gating.

### Changed

- Product and wishlist identity now use canonical Amazon helpers and preserve each supported regional origin instead of rewriting URLs through the first wishlist domain.
- Options, Dashboard, restore, legacy settings migration, and wishlist mutations now pass through serialized background/storage boundaries that preserve concurrent edits.
- Retained chart counts describe stored samples, and popup price-change copy distinguishes an exact tracking-start baseline from the earliest retained legacy sample.
- The local development baseline is Node.js 22.13 or newer.

### Fixed

- Negative availability phrases take precedence over misleading positive substrings across supported locales.
- Ambiguous legacy wishlist regions remain fail-closed without guessing `.com`, visibly request review, and resume automatic sync only after the real URL is supplied.
- First successful checks establish alert state without notifying when a target was already met.
- Temporary dashboard filter links no longer overwrite or reapply after the user chooses a persistent filter.
- Operation-deadline body timeouts retain the correct `max_elapsed` stop reason across timer-resolution differences on CI hosts.

### Security

- Backup export is validated through the same canonical restore boundary and bounded before download.
- Settings and wishlist mutation messages enforce top-level page ownership and field/value allowlists.
- Amazon permissions, network destinations, and storage areas remain unchanged.

## [1.2.1] - 2026-08-25

### Changed

- Raised the development and CI baseline to Node.js 22.12+, upgraded Puppeteer to 25.8.0, and moved the pinned checkout/setup-node actions to v7.
- Manual background wishlist reads now share the same serialized queue, persisted anti-bot pause, and offscreen-parser cleanup as scheduled checks.
- Price-history clearing now waits behind every already-started scrape or wishlist import that can append history.

### Fixed

- Partial manual wishlist results now preserve their safe items while disclosing CAPTCHA/rate-limit pause state and resume time.
- Restore E2E coverage now verifies durable completion state instead of racing a transient disabled button.

### Security

- Dashboard-only wishlist extraction and Options-only history clearing are authorized at the service-worker boundary.
- A confirmed history clear can no longer be followed by a stale sample from work that started before the clear.

## [1.2.0] - 2026-08-24

### Added

- Versioned JSON backups now include tracked products, price history, tracked wishlists, and supported preferences.
- Extension Settings can validate, preview, and restore a backup after an expiring two-step replacement confirmation.
- Public-repository CI, dependency update automation, issue forms, pull-request guidance, support information, and community standards.

### Security

- Backup files are treated as untrusted input at both the Options page and background-worker boundaries, with strict count, URL, identity, price, timestamp, and settings allowlists.
- Restore writes run under the tracked-item mutex, reset transient scrape state, and restore the previous Local snapshot if the Chrome Sync preference write fails.

## [1.1.0] - 2026-08-24

### Added

- Balanced adaptive price checking with visible cadence and next-check information.
- Resumable, bounded wishlist pagination with safe continuation scheduling.
- Dashboard filters, progressive 50-item rendering, and preserved list position.
- Inline per-product target editing and expiring two-step destructive confirmations.
- Public security, privacy, contribution, and release-validation documentation.
- Saved Signal logo and a cohesive navy/mint interface across the popup, dashboard, options, and in-page control.
- Dedicated security regression coverage for network parsing, storage migration, user intent, and bounded wishlist continuation.
- Explicit legacy-target review with one-time notification, persistent Dashboard warning, and latest-state single-currency migration.
- A reproducible synthetic visual-QA command covering popup, dashboard, settings, and resolved migration states.

### Changed

- Priority checking uses a separate two-minute queue.
- Wishlist sync reconciles removals only after a complete traversal and preserves products owned by another source.
- Popup highlights prioritize meaningful price changes while the dashboard owns full-list analysis.
- Global numeric target prices were replaced by per-product targets. Existing currencyless values remain paused until the user safely copies or acknowledges them.
- Price-history retention now strictly deletes expired entries.
- Large wishlist selection is paged at 50 items, while tracked-list rendering, charts, focus, and ARIA state remain responsive at hundreds of products.
- Wishlist continuation advances fairly between lists and resumes unfinished work after about 60 seconds, including after a browser restart.
- Popup, dashboard, and settings canvases use a calmer neutral soft-slate background while retaining the Saved Signal navy/mint identity and light/dark contrast.
- Short dashboard viewports use normal document scrolling so controls and wishlist import remain reachable at 200% browser zoom.

### Security

- Scrape jobs and tracked-item mutations are serialized to prevent stale writes and item resurrection.
- CAPTCHA and rate-limit backoff persists across Manifest V3 service-worker restarts.
- Release validation checks local extension assets, icon properties, metadata parity, and remote-code references.
- Amazon requests are HTTPS-only, redirect-bound, content-type checked, streamed under byte/time budgets, and parsed without loading remote subresources.
- CAPTCHA and wishlist-completeness decisions require structural evidence; partial or indeterminate pages never trigger removal reconciliation.
- Product tracking requires a genuine user action bound to the active product tab; legacy tracked items migrate from Sync only after durable local readback.
- Untrusted purchased text is never allowed to delete a tracked item or its history.
- Seller-controlled CAPTCHA words and image labels cannot trigger backoff without challenge-owned form/input evidence.
- Visible wishlist extraction, bulk import messages, stored navigation URLs, and the durable collection now have explicit validation and size limits.
- Wishlist completion is bound to a matching list or canonical document identity before removals are allowed.
- Final wishlist reconciliation preserves concurrent individual-tracking decisions and does not delete retained price history.
- Background checks merge newly observed price samples into the latest history so concurrent manual-sync samples are not lost.
- Popup-launched `?import=` dashboard sessions remain authorized without broadening bulk-import access to other extension pages.
- Later-page CAPTCHA/rate-limit results retain bounded wishlist continuation state while activating global backoff.
- Legacy-target copy and acknowledgement are bound to the top-level Options page and latest Chrome Sync value, preserving unrelated preferences when another browser updates settings.

## [1.0.0] - 2026-07-04

- Initial published release.
