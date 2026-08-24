## Summary

Describe the user-visible or maintenance outcome and why it is needed.

## Verification

- [ ] `npm test -- --runInBand`
- [ ] Relevant focused security or scraper-contract tests
- [ ] `npm run test:e2e` for manifest, background, or UI behavior changes
- [ ] `npm run visual:qa` for visible UI changes
- [ ] `docs/feature_specs.md` updated for any behavior change

## Safety and privacy

- [ ] No credentials, browser profiles, real wishlists, exports, or personal data are included.
- [ ] New permissions, hosts, storage behavior, and network flows are documented.
- [ ] Amazon-derived text is rendered with safe DOM APIs and is not trusted as user intent.

## Screenshots

Add before/after screenshots for visible UI changes, or write “Not applicable.”
