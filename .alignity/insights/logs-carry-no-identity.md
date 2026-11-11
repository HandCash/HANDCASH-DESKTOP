---
name: logs-carry-no-identity
when: writing a log line, changing log upload, or parsing logs in triage
if: src/wallet/logPrivacy.ts
---
Logs never carry identity relationships or transaction details: `logPrivacy.ts` (and its `electron/` twin, kept equal by test) pseudonymises hex ids per run, tags peers/handles/paymails, drops addresses, blobs and amounts (`[amt]`).
Triage regexes must accept `[amt]` and pseudonymised hex; never log display names in free text, since the scrubber cannot recognise them.
