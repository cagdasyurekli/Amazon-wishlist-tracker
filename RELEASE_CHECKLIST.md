# Release Checklist

Use this checklist on one stable candidate. A green local check does not authorize a version bump, public repository change, tag, release, or Chrome Web Store submission.

## Before the version bump

- [x] Integrate the candidate into a real Git worktree and review the complete diff, including binary icon changes.
- [x] Confirm `git diff --check` passes; the release validator runs this automatically in a Git worktree.
- [x] Run `npm ci` from the lockfile on Node.js 22.13 or newer.
- [x] Run `npm run release:check` with registry access and retain the terminal output. Required evidence is zero reported audit vulnerabilities, manifest/icon/metadata validation, 70 unit tests, 4 wishlist scraper contracts, 3 wishlist source-policy contracts, 90 focused security tests, 1 real-Chrome intent test, 18 Chromium E2E tests, and the synthetic five-screenshot visual QA passing.
- [x] Complete the independent security review on the same candidate and resolve or explicitly disposition every reportable finding. Do not infer acceptance from the automated test count.
- [x] For Amazon markup or pagination compatibility changes, run the final candidate against a public, non-secret wishlist from the affected marketplace. Record only sanitized counts, completion state, byte/page bounds, and stop reason; never product names or list IDs. Keep this external canary out of deterministic CI.
- [x] Confirm no credentials, exports, real wishlist data, browser profiles, `.agents/`, `.remember/`, or local editor settings are tracked.
- [x] Read back `README.md`, `SECURITY.md`, `PRIVACY.md`, `CHANGELOG.md`, `CHROMEWEBSTORE.md`, and the license against actual runtime behavior.

## Risk-based UI acceptance matrix

| Surface | Required contexts | Acceptance evidence |
|---|---|---|
| Popup | Supported product tab, supported wishlist tab, unsupported tab, empty state, and more than three tracked products | Correct primary action in each context; no clipped content or horizontal overflow; at most three highlights; every interactive control has an accessible name and visible keyboard focus. |
| Dashboard | Empty, price drop, unavailable product, mixed currencies, 75 items, and 784 items | Correct summaries and badges; 50-item progressive rendering; filter/sort persistence; chart lazy rendering; scroll position preserved; no console/page errors. |
| Dashboard sizing | 360px narrow viewport and a desktop viewport | No document or list horizontal overflow; long titles, prices, targets, and buttons remain usable at 200% zoom. |
| Options | Defaults, saved settings, export, malformed/unsafe/valid backup selection, stale candidate replacement, expired restore confirmation, confirmed restore, first clear-history activation, expired confirmation, and confirmed deletion | Export disclosure is accurate; restore previews bounded canonical data; both destructive confirmations expire; restore replacement and history clearing preserve their documented invariants; keyboard activation works; success/error status is announced. |
| Accessibility | Popup, dashboard, and options with keyboard only; one screen-reader pass; light and dark system themes | Logical tab and reading order; focus never disappears or becomes trapped; stateful controls announce `aria-pressed`/`aria-expanded`; status messages are announced; text and focus contrast pass WCAG AA. |
| Logo and icons | Chrome toolbar on light/dark themes, extensions page, popup header, dashboard, options, and 128px store preview | The mark is recognizable at 16px; no opaque square or clipped edges; manifest and action icons load at 16/32/48/128px; screenshots show the final candidate. |

Automated evidence covers the large-list, narrow-width, 200% zoom, accessible-name, stateful ARIA, popup-bound, destructive-confirmation, service-worker restart, manifest loading, and icon file contracts. Independent light/dark visual and contrast review plus a read-only real Amazon product-page injection smoke test are complete. A dedicated human screen-reader pass is recommended for any future store-distribution project, but Chrome Web Store distribution is not part of this source release.

## Version bump and stable-candidate rerun

- [x] Change `manifest.json`, `package.json`, and `package-lock.json` from `1.4.4` to `1.4.5` together.
- [x] Move the relevant `CHANGELOG.md` entries from **Unreleased** to a dated `1.4.5` section.
- [x] Run `npm run release:check` again after the version bump on the final same-candidate tree; retain the output before push and tag creation.
- [x] Load that exact directory as an unpacked extension in an isolated real-Chrome test profile and verify the extension ID, displayed version, toolbar icon, popup, dashboard, options, and background service worker.

## Public repository readiness

- [x] Obtain separate authorization before changing repository visibility, pushing, tagging, or publishing a release.
- [x] After a public-visibility change, read back repository visibility, default branch, license, private vulnerability reporting, and the public privacy/support URLs.

## Distribution scope

- [x] Chrome Web Store submission, listing assets, contact fields, and rollout are explicitly out of scope by product-owner decision on 2026-08-24.
- [x] Source installation through Chrome's **Load unpacked** flow remains documented and tested.
