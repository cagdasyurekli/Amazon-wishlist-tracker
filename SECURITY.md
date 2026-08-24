# Security Policy

## Supported versions

Security fixes are maintained for the latest published release. Users should reproduce reports against the latest release or the current default branch and include the tested version or commit identifier.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use the repository's **Security** tab to submit a private vulnerability report when private reporting is enabled. If that option is unavailable, contact the maintainer privately through the publisher contact listed for the project and include only the minimum information needed to reproduce the issue.

Reports should describe the affected version, realistic attack path, user impact, and a minimal reproduction. Do not include real user wishlist contents, exported histories, credentials, cookies, or other personal data.

## System and scope

Amazon Wishlist Tracker is a local Manifest V3 Chrome extension with no developer-operated backend. This policy covers the manifest, service worker, offscreen parser, content scripts, popup, dashboard, options page, storage utilities, tests, and release artifacts in this repository.

Important assets are the user's tracked products and wishlist URLs, price history, alert thresholds, local export files, browser notification behavior, and the integrity of extension code executed with Amazon host permissions.

## Threat model and trust boundaries

- Amazon page HTML, scraped titles, prices, images, wishlist metadata, URLs, imported JSON-like values, and runtime messages must be treated as untrusted input.
- Extension pages and the service worker are privileged contexts. Data crossing from a content script or parsed Amazon document into these contexts must be validated and rendered safely.
- Network access is limited to the Amazon host patterns declared in `manifest.json`. Redirects, derived product URLs, and pagination URLs must not expand that boundary.
- Tracked items, histories, and operational scraper state remain in `chrome.storage.local`. Only lightweight preferences documented in `PRIVACY.md` use `chrome.storage.sync`.
- Dependency and preview tooling are development-only and must not introduce remote executable code into extension pages.

## Security invariants

- Extension HTML must not load remote scripts or styles. Production behavior is implemented by checked-in local source.
- Amazon-derived strings are inserted with safe DOM APIs such as `textContent`; they must not reach dynamic HTML execution sinks.
- Product and wishlist fetches fail closed unless the destination hostname matches a supported Amazon regional domain.
- User-controlled edits and removals, background price updates, and wishlist merges must not overwrite one another or resurrect deleted items.
- Partial, failed, rate-limited, or interrupted wishlist pagination must never be treated as a complete list and must never trigger removal reconciliation.
- Scraping remains bounded and serialized, respects persisted CAPTCHA/rate-limit backoff, and preserves resumable state across service-worker restarts.
- Export is an explicit user action. Clearing price history must require an in-context confirmation and must not delete tracked products.
- Manifest permissions, icon paths, version metadata, and packaged files must be validated before release.

## Reportable findings and severity context

Report vulnerabilities with a realistic path to cross-origin code execution, unsafe extension-page DOM execution, unauthorized storage mutation or deletion, sensitive local-data disclosure, host allowlist bypass, remote code loading, notification abuse, scraper behavior that defeats backoff, or update/package substitution.

Severity depends on reachability from attacker-controlled Amazon content or an untrusted URL, required user interaction, persistence across browser restarts, and impact on confidentiality, integrity, availability, or user trust. A green test alone is not proof that a security property holds.

## Out of scope

- Amazon site availability, markup changes, price accuracy, account behavior, and anti-bot policy are third-party behavior unless the extension handles them unsafely.
- Social engineering that requires a user to install a separately modified extension is not a vulnerability in the published extension.
- Reports that only recommend general hardening without a realistic broken invariant may be handled as product suggestions.

No additional finding classes or known vulnerabilities are owner-approved as accepted risk by this policy.

## Known limitations and compensating controls

Amazon markup and regional behavior can change without notice. Parser fixtures, strict host validation, sequential bounded requests, complete-only wishlist reconciliation, persisted backoff, local-only history storage, and the release validation script reduce risk but do not replace review of a stable release candidate.
