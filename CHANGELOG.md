# Changelog

All notable changes to this project are documented here. Versions follow semantic versioning.

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
