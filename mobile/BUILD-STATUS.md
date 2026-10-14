# Build status — 16 September 2026

**Local build approved for funded OpenRouter acceptance testing. Public/App Store release is not yet approved.** No paid inference requests were made during this verification.

## Verified

- Web production build passed; Svelte/TypeScript reported zero errors and warnings.
- All 12 backend/stream tests passed in a clean temporary installation using only deployment runtime dependencies. Tests use an explicitly fake provider and temporary databases.
- Browser acceptance passed at 1440px desktop and 390px phone widths: all 13 curated models, picker search, selection after reload, draft recovery, streamed reply, conversation rename and saved-history reopening; no page errors or horizontal overflow.
- Missing-provider browser check: useful error, preserved draft and no provider request.
- Xcode iPhone simulator Debug build passed with signing disabled. This is compilation evidence, not physical-device or purchase acceptance.
- All 13 configured OpenRouter IDs exist in the public catalogue. Published token prices are within the updated configured caps. Snapshot: `provider-readiness.json`. Catalogue checks do not prove successful inference or endpoint compatibility.
- Locked deployment runtime dependency audit: zero reported vulnerabilities. The upstream root dependency tree still has 11 production-labelled audit findings; it is excluded from the final runtime image.

## Completed in this pass

- Preserved the existing interface and curated picker.
- Fixed Unicode corruption when an incoming request splits a multibyte character across network chunks; added a real HTTP regression test.
- Added repeatable desktop/mobile browser acceptance and isolated-runtime checks.
- Changed Docker packaging to a separate runtime stage with only required backend dependencies and built assets; excluded environment files and backups from its build context, and created writable backup storage.
- Extended the provider checker to flag missing/invalid prices and caps below current published rates.
- Updated Nemotron caps from US$0.60 / US$2.40 to US$0.625 / US$3.125 per million input/output tokens; corrected Kimi input-price precision. Overall spend ceilings remain unchanged.
- Corrected local preview instructions to use the launcher's matching `127.0.0.1` origin.

## Required external acceptance

1. Fund/configure OpenRouter securely, then verify real streamed replies, follow-up context, cancellation, model-specific parameter compatibility and billed usage. No credentials should be pasted into chat.
2. Build/run the Docker image on a Docker host, deploy HTTPS, and verify persistent storage, backup/restore and monitoring. Docker is unavailable on this Mac; the isolated dependency/runtime tests passed, but the image itself has not been built here.
3. Configure business privacy/terms/support and production email delivery; test email delivery on the actual domain.
4. Configure Apple signing, deployment URL and subscription product; test physical-device behaviour and Sandbox purchase/restore/renewal/refund, then prepare App Store submission.

Image uploads and web search remain disabled until provider capabilities and non-token costs are controlled. Voice dictation depends on browser support. These are not included in the completed text-chat acceptance scope.

## Reproduce

From the repository root with Node 24:

```sh
npm run check --prefix mobile
npm run build --prefix mobile
npm run test --prefix mobile
npx playwright install chromium
npm run test:browser --prefix mobile
npm run test:runtime --prefix mobile
cd mobile
node server/check-models.mjs
```
