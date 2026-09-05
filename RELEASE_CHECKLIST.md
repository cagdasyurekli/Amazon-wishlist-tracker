# Release Checklist

Use this reusable checklist for one stable candidate. Treat every box as pending for each release. A green check does not authorize a version bump, push, tag, GitHub release, or Chrome Web Store submission.

## Prepare one final candidate

- [ ] Integrate the candidate into a real Git worktree and review the complete diff, including binary icon changes.
- [ ] Finish the code, documentation, and review fixes before the full local gate.
- [ ] Update `manifest.json`, `package.json`, and `package-lock.json` to the same final version, then move the relevant `CHANGELOG.md` entries from **Unreleased** to the dated release section.
- [ ] Run `npm ci --no-audit` from the lockfile with the repository's supported Node.js version and record the Node, npm, Puppeteer, and Chrome versions used. The final `release:check` owns the dependency audit.
- [ ] Confirm the candidate does not skip tests, weaken assertions, or include unrelated changes.
- [ ] Confirm no credentials, exports, real wishlist data, browser profiles, `.agents/`, `.remember/`, or local editor settings are tracked.
- [ ] Read back `README.md`, `SECURITY.md`, `PRIVACY.md`, `CHANGELOG.md`, `CHROMEWEBSTORE.md`, and the license against actual runtime behavior.

Focused checks run while preparing the candidate may be reused only while their relevant files and environment remain unchanged. After an edit, rerun the check that owns the changed bytes or contract. Do not repeat unrelated successful checks unless their evidence became stale.

## Risk-based manual QA

Run manual QA on each changed user-facing surface. The automated suites remain the primary regression gates, while manual work covers visual quality and accessibility behavior they cannot judge.

| Change trigger | Manual acceptance evidence |
|---|---|
| Popup, dashboard, options, or in-page control | Exercise the affected flow with keyboard navigation and inspect the relevant light/dark, narrow-width, 200% zoom, long-content, error, and destructive-confirmation states. Confirm affected text and focus-indicator contrast meets WCAG AA. Select only the contexts the change can affect. |
| Shared styles, colors/themes, extension navigation, manifest behavior, or Puppeteer/Chrome dependency | Broaden the smoke across popup, dashboard, options, in-page control, extension startup, and navigation between surfaces. Check for clipped content, horizontal overflow, missing focus, and console/page errors; confirm shared text and focus-indicator contrast meets WCAG AA in both themes. |
| Focus management, accessible names, ARIA state, live regions, or status announcements | Use keyboard-only navigation and a human screen reader on the affected flow. Confirm logical reading/tab order, visible focus, restored focus, announced state, announced success/error messages, and WCAG AA text/focus contrast. |
| Logo or manifest icon | Inspect the Chrome toolbar and extensions page in light/dark themes plus the affected extension surfaces. Confirm the mark remains recognizable and unclipped at declared sizes. |
| Amazon content-script injection | Perform a read-only smoke on a supported product page and confirm the control appears and responds only to a genuine user action. Do not record account or product data. |

`npm run visual:qa` is an offline visual smoke. It writes five synthetic screenshots after checking a small set of required DOM states and fails on captured console or page errors. It does not compare pixels, assess layout quality, test a screen reader, or measure contrast, so inspect affected screenshots and complete the applicable manual checks above.

For the current source distribution, use a human screen reader on any changed flow that affects semantics, focus, or announcements; automated checks are not a substitute for that assessment. A dedicated full-product screen-reader pass remains recommended for any future Chrome Web Store project and is outside the current source-release scope.

## Independent review and Amazon compatibility

- [ ] Complete an independent security review on the stable candidate. Resolve or explicitly disposition every reportable finding; automated suite results alone do not establish security acceptance.
- [ ] For Amazon markup or wishlist-pagination changes, run the stable candidate against a public, non-secret wishlist from the affected marketplace. Record only sanitized counts, completion state, byte/page bounds, and stop reason; never product names or list IDs. Keep this bounded live canary out of deterministic CI.

## Final local gate

- [ ] After version/changelog edits and all review fixes, run `npm run release:check` once on the final candidate with registry access and retain the output.
- [ ] Confirm the gate passed dependency auditing, release metadata and assets, lint, unit/parser behavior, scraper continuation and source-policy contracts, focused security behavior including genuine-click enforcement, MV3 startup/UI contracts, and the offline visual smoke.
- [ ] Confirm the dependency audit has no high- or critical-severity findings. `audit:deps` intentionally blocks at `high`; a historical zero-vulnerability result does not create a stricter release threshold.
- [ ] Confirm critical behaviors applicable to the change, including host and sender validation, serialized storage updates, bounded/backed-off scraping, complete-only destructive wishlist reconciliation, real-versus-synthetic click handling, timeout/cleanup behavior, and extension startup/navigation.
- [ ] Load the exact final directory as an unpacked extension in an isolated real-Chrome test profile and verify the displayed version, toolbar icon, popup, dashboard, options, and background service worker.

The local result belongs to the recorded local Node/Puppeteer/Chrome environment. The GitHub CI result belongs to the exact pushed commit on a clean Linux runner; do not substitute or directly compare one for the other.

## Authorized publication sequence

- [ ] Obtain separate authorization before pushing, tagging, publishing a GitHub release, or changing repository visibility.
- [ ] Push the reviewed candidate and wait for CI and CodeQL to succeed on the exact commit.
- [ ] Check for tag and release collisions, create an annotated tag, and publish the stable GitHub release without overwriting an existing release.
- [ ] Read back the tag target, release metadata, repository visibility, default branch, license, private vulnerability reporting, and public privacy/support URLs.
- [ ] Keep Chrome Web Store listing assets, contact fields, submission, and rollout outside the source-release flow unless separately authorized. Source installation through Chrome's **Load unpacked** flow remains the current distribution path.

## Historical v1.4.5 evidence

Version 1.4.5 is a completed historical release, not a pre-checked template for later candidates. Its release commit and annotated tag resolve to `8d301cb54495316eb4170e43ed4ba89e3a02d4f3`; the [clean Linux CI run](https://github.com/cagdasyurekli/Amazon-wishlist-tracker/actions/runs/33545767398) and [GitHub source release](https://github.com/cagdasyurekli/Amazon-wishlist-tracker/releases/tag/v1.4.5) record that candidate's remote verification and publication. That CI run reported zero dependency vulnerabilities, which is historical evidence rather than the acceptance threshold for future candidates. Chrome Web Store publication was not performed.
