# Diagnostic upload security — 7 November 2026

## Confirmed exposure and current fix

This supersedes the automatic-upload conclusions in `gateway-privacy-assessment.md` **for current source only**, not installed applications. Baseline: Desktop 6fb34548; changes here are staged, not released. Unrelated pairing/UI edits were not modified.

- Commit ed4da2fa already removed raw-log boot, five-minute, background, failure and recovered-session uploads. Startup only captures locally; Settings Send logs remains explicit.
- A separate transaction telemetry sender remained: enqueue scheduled a flush after 750 ms and session work explicitly flushed. It POSTed JSON to `DEFAULT_BRC_CLOUD_BASE_URL/v1/telemetry/events`, normally `https://brc-cloud.bcryderman.workers.dev`, using public-identity/signature headers. Data included flow/stage, timestamps, durations, provider/blocker, request/trace IDs, transaction-id prefix, platform/version. Signing locally did not transmit the root private key, encrypt the body or establish diagnostic consent.
- This patch makes scheduled and explicit telemetry flushes network-free. Bounded local traces and duration estimates remain; manual logs may include trace lines.
- Manual log uploads now require HTTPS without URL credentials, reject redirects, omit browser credentials/referrer, and redact the **assembled** payload, including restored entries and Electron shell tails. Token/API-key/cookie/seed field names and Bearer credentials receive additional pattern redaction.
- The legacy Electron raw-file upload IPC now refuses uploads, removing the parallel unredacted/HTTP-capable route. Settings uses the shared sender.
- Tests use synthetic markers and intercepted fetch only. No logs were sent, credentials inspected, or collection added.

## Payload, consent and encryption boundaries

Manual uploads still contain potentially sensitive wallet data: amounts/balances, origins, transaction identifiers, identity-bearing URLs, stack traces and runtime information, plus user-agent, platform/version/time. Renderer ring: 800 entries capped at 4,000 characters each; persisted tail normally 350 entries; shell tail requested at 96,000 bytes.

Label-based redaction is **not a guarantee** against unlabelled or differently encoded secrets, multiline values, personal information, or financial metadata. No actual key/token leak was established. Manual Send logs is a user action, not an assurance the complete payload is safe; users should review logs before sending. URL clearing is still not a persistent opt-out: the next getter provisions a random bucket. That getter no longer causes an automatic network send.

HTTPS protects transport, not against the receiving operator. The body is text, not end-to-end or client-side encrypted. Source writes raw bodies into R2; no application-layer storage encryption was found in the inspected handler. Provider disk encryption, deployed configuration, backups and operational access remain unverified. Durable renderer logs and Electron files also have no demonstrated application-layer encryption in these paths.

## Server coordination and remaining requirements

Read-only coordination with BRC-CLOUD chat cmw5zm6h5bn (314): local commit 1ecea23 changes `src/logs.js` so GET/DELETE requires `isAdmin`; dashboard has its separately authorized reader. POST/PUT ingestion remains unauthenticated for released-client compatibility. **Bucket IDs are routing labels, not authorization**, even when random, and may appear in source. No new client upload-auth header is required by this local contract.

Chat 314 reports the change is not deployed and production previously allowed anonymous listing; this audit made no production requests to independently confirm present behavior. Public ingestion still permits poisoning/storage abuse if a bucket is known. Local retention is latest 30 uploads per bucket, not age-based expiry. Earlier source audit found conditional dashboard facts/verdict persistence and TypeSafe dispatch; raw deletion does not establish deletion of derivatives. Actual deployment, admin access, provider/edge logs, retention and third-party activation need authorized verification.

Read-only Mobile chat cmw4kv8ia4 (242) could not establish the released 0.1.777 Desktop SHA or installed build. Local Mobile bridge returns the renderer ring for readLogs and refuses its own uploadLogs; this does not verify the released artifact or rule out native routes not examined here. The local repository had no v0.1.777 tag. Do not claim these fixes protect the phone until artifact provenance, normal signed release delivery and device installation are verified.

No publishing/deployment occurred. Required separately: approve and deploy server access controls; verify anonymous read/delete denial with synthetic data and authorized admin access; define time-based retention and derived-data deletion; release the shared client changes through Desktop/Mobile update routes; verify installed builds and real-device network silence for boot, idle, background, failure and restart. History backup metadata and non-diagnostic wallet traffic are separate paths, not disabled by this patch.

## Verification

29 focused tests passed across logShip, logShipPrivacy, appLogRedaction, appLog and transactionTelemetry. Both renderer and Electron TypeScript checks and git diff --check passed. Tests prove local behavior, not deployed receipt, historical leakage or device installation.
