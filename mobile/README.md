# Open Chat — iPhone app and managed inference service

A working implementation of the supplied model-picker/chat design. Users get a guest allowance without an API key, can create an account and subscribe through Apple, or optionally supply their own OpenRouter key.

**Status:** Web production build and type checks pass. Backend tests exercise the real HTTP server against an explicitly fake local inference provider. No paid model request or Apple purchase has been made. The native simulator build now passes on this Mac; signing/device testing remains. The local desktop preview and model picker have been visually checked. This is source ready for integration and device testing, not an App Store release.

## What is included

- Svelte 5 mobile chat UI, model bottom sheet, new chats, history/search, per-chat model choice, Markdown/code/math, streaming, stop, copy, export, error states and responsive desktop layout.
- Guest accounts, email/password registration and login, server-side conversations, sign-out and account/data deletion.
- App-funded inference gateway. Provider credentials never enter the client bundle. Optional BYO OpenRouter key is not persisted by the server.
- Free and Plus message limits, per-user inference budgets, global spending ceiling, per-IP guest limits, request limits and one concurrent generation per user.
- StoreKit 2 iOS purchases, restore, subscription management and signed transaction verification using Apple's official server library. Entitlements are tied to the account UUID and reject purchase transfer/replay after revocation.
- Native WKWebView shell, HTTPS origin restriction, Keychain storage, native conversation export and offline connection screen.
- Xcode project, app icon, privacy manifest, Docker/Caddy HTTPS deployment configuration and automated tests.

## Relationship to HuggingChat

This is a fork of https://github.com/huggingface/chat-ui at commit `f4ed1956d3476a388756d7c2700b0aac6c77240e`.

The full upstream source remains in the repository. `mobile/` is a new focused consumer app and backend. It **directly imports** HuggingChat's Markdown pipeline (`src/lib/utils/marked.ts`, `markedLight.ts` and dependencies) and streaming adapter (`src/lib/server/endpoints/openai/openAIChatToTextGenerationStream.ts`). The consumer interface, SQLite account store, quota system and Apple bridge are new. It does not run HuggingChat's MongoDB/OIDC backend. This keeps the exact consumer scope without requiring a Hugging Face account. Apache 2.0 attribution and upstream LICENSE are retained. The temporary product name “Open Chat” can be replaced.

## Run locally

Use Node 24 LTS. From the repository root:

```sh
npm ci --ignore-scripts
npm run build --prefix mobile
cd mobile
cp .env.example .env
npm start
```

Open http://localhost:3001. The interface and accounts work without a provider key; sending explains that inference is not enabled. There are no simulated replies in the shipped app.

For a live local preview, run `npm run dev:local --prefix mobile` from the root and open http://127.0.0.1:5174. This starts both the backend (port 3001) and Vite with hot reload (port 5174), watches backend edits, and sets the matching request origin automatically. Stop both with Ctrl+C. No provider key is required to preview the UI and account flows.

Run `npm run backup --prefix mobile` to create a private, timestamped SQLite snapshot in `mobile/backups/`. It uses SQLite's online backup API and verifies database integrity. To restore, stop the service and use a verified backup at a **new** `DATABASE_PATH`; keep the old database and its WAL files together until the restore is confirmed. Copy backups to separate protected storage for disaster recovery.

## Enable included access

Set `OPENAI_API_KEY` in the server's environment to your funded OpenRouter key. Customers do not need to see or enter this key. The default provider is `https://openrouter.ai/api/v1`. Hugging Face's compatible router is supported too, but its model IDs must be configured separately; the included mapping uses OpenRouter IDs.

`model-map.json` maps all 13 names in the supplied chart to provider listings retrieved on 14 September 2026. Weight repositories were checked for 12 models through Hugging Face's model API, and Mistral Medium 3.5 through Mistral's official Hugging Face pages. `model-verification.json` records retrieved provider metadata and weight checks. No benchmark scores are presented as app performance claims, and availability is not proof that a live request will succeed.

Each mapping includes provider ID, published prompt/completion prices in USD per million tokens, weight repository, free-plan availability and optional reasoning effort. Price caps are sent to OpenRouter so routing cannot silently exceed those configured token prices. Published rates may change; run:

```sh
node --env-file=.env server/check-models.mjs
```

This validates catalogue IDs and checks published token prices against configured caps. It does not spend tokens or silently alter configuration. The latest read-only snapshot is in `provider-readiness.json`; Nemotron caps were updated on 16 September to US$0.625 input / US$3.125 output per million tokens, and Kimi input precision was corrected. Review prices and provider terms before launch. Several weight repositories use custom licenses; the verified flag confirms downloadable weights, not a legal certification. Calling hosted inference does not give users a download of the weights.

GLM Flash, DeepSeek Flash, Qwen 27B and gpt-oss are initially eligible for free managed access; other connected models are Plus-only. A personal key bypasses included allowances but still uses the curated model list, output cap and request limits. Change `free` flags as desired.

Reasoning labels in the reference are mapped to configured effort where possible (`xhigh` for GLM's max mode); limited output budgets and provider implementations do not guarantee benchmark-equivalent settings. There is no reasoning slider.

## Allowances and cost controls

Provisional defaults, to tune before selling subscriptions:

- Free: 10 messages per UTC day and US$0.10 nominal inference budget per UTC day.
- Plus: 200 messages per UTC day and US$10 nominal inference budget per UTC calendar month.
- Global: US$20 per UTC day.
- Maximum completion budget: 2,048 tokens, including provider-counted reasoning tokens.

These are configurable limits, not a proposed subscription price. Apple supplies the actual localized subscription price.

Each request atomically reserves a conservative input/output cost before calling the provider. Successful responses with usage information release the unused reservation, calculated at the configured price ceiling. If no usage arrives, the conservative reservation is kept. Requests rejected before a provider stream starts are refunded. Requests interrupted after generation starts can still cost money, so their reservation is retained unless usage data is available. Provider invoices can differ from these internal usage estimates. No “unlimited” access is promised.

The service stores budget units as integer USD microdollars. Message and spend resets use UTC. The global cap and IP limits also apply to disposable guest sessions. Behind a reverse proxy, trust only explicitly configured proxy addresses; the included Compose configuration uses a fixed Caddy address.

## iPhone build

On a Mac with Xcode 16 or newer:

1. Open `mobile/ios/OpenChat.xcodeproj`.
2. Select your Apple signing team. Set your unique bundle ID.
3. Set the `APP_URL` build setting to the deployed HTTPS origin. Set `PRODUCT_ID` to your App Store Connect subscription product ID.
4. Match the server's Apple settings to those values.
5. Build and run on an iPhone or simulator. Use Sandbox/TestFlight to verify the entire purchase lifecycle.

`project.yml` is also provided if you prefer XcodeGen. App configuration intentionally rejects the placeholder `.example` deployment URL and insecure HTTP. The app is a native shell around the hosted UI, not a complete rewrite in Swift. App Store acceptance has not been established.

Personal API keys use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. In a regular browser, personal keys live only in JavaScript memory and disappear on refresh. The server forwards a personal key in memory to OpenRouter and does not save it.

## Apple subscriptions

Create one monthly auto-renewable subscription in App Store Connect. Configure:

- `APPLE_BUNDLE_ID`, `APPLE_PRODUCT_ID` and production `APPLE_APP_ID`.
- `APPLE_ENVIRONMENT=Sandbox` on your sandbox backend; `Production` on production. Never share these databases or accept sandbox receipts in production.
- `APPLE_ROOT_CA_PATHS`: comma-separated local paths to Apple root CA certificate files obtained from https://www.apple.com/certificateauthority/ . Mount them read-only.
- `PRIVACY_URL`, `TERMS_URL` and `SUPPORT_EMAIL` for your actual business.
- App Store Server Notifications V2 endpoint: `https://YOUR_DOMAIN/api/apple/notifications`.

The app submits Apple's JWS, not a client-supplied “paid” flag. The server verifies signatures, environment and bundle ID with Apple's official library, validates the configured product and account token, and persists transaction state. Notifications handle renewed/expired/revoked transactions. Purchase completion is acknowledged to StoreKit only after the backend accepts it. Current entitlements are resubmitted after signed-in startup.

No purchase keys, certificates, developer account or merchant settings were supplied during this build. Those connections remain disabled until configured. Do not treat the signed-data unit tests as substitutes for real Apple sandbox tests.

## Deploy

Deploy the Node service to a host with Docker, persistent disk, DNS and ports 80/443 available:

```sh
cd mobile
cp .env.example .env
# Fill in .env securely; set APP_DOMAIN and matching https:// APP_ORIGIN.
# Set APPLE_ENVIRONMENT=Production for this production configuration.
mkdir -p apple-certs
docker compose -f compose.yml up -d --build
```

Caddy terminates HTTPS; the app is not exposed directly. SQLite persists in `chat-data`. Back up that volume with SQLite's backup facility. This is a single-instance deployment; do not run multiple independent databases behind a load balancer. The code does not upload anything automatically or provision a paid host.

## Tests and remaining launch work

```sh
npm run check --prefix mobile
npm run test --prefix mobile
npm run build --prefix mobile
npx playwright install chromium
npm run test:browser --prefix mobile
npm run test:runtime --prefix mobile
```

The container uses a separate locked runtime manifest in `mobile/runtime/`, containing only the provider SDK and Apple verification library. `test:runtime` installs that dependency set in a temporary directory, audits it, and runs the backend tests without access to the root dependency tree. It does not build a Docker image. The preserved upstream root dependency tree still has audit findings; it is build tooling/reference source, not the deployed runtime.

Tests cover atomic multi-bucket reservations, refunds, signed-transaction ownership/replay/revocation/expiry state, real HTTP session/chat flows, streaming, conversation isolation, registration, quota enforcement, invalid purchase input and deletion. The fake inference provider exists only inside the integration test.

Still required before production launch: live provider smoke tests with your key, Docker image/deployment verification (Docker is not installed on this Mac), physical-device keyboard/accessibility testing, Apple sandbox purchase/renewal/refund/restore testing, real business terms/privacy/support configuration, email transport and domain verification, monitoring/backups and App Store review. Text-file attachments, email verification and self-service password recovery are implemented and locally tested; images and web search remain deliberately disabled until their provider capability and billing controls are verified. Voice dictation depends on browser speech-recognition support; ads and arbitrary custom Hugging Face deployments are outside this text-chat scope.
