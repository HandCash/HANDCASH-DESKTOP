---
name: shared-helpers
when: writing error text, waits, deadlines or hex conversion in src/
---
Use `errorText` (wallet/errorText.ts), `sleep`/`withTimeout`/`timeoutSignal` (wallet/timing.ts), `hexToBytes`/`bytesToHex` (wallet/hexBinary.ts); never define a local copy.
`src/sharedHelpers.test.ts` enforces this; a different behaviour gets a different name (`ethHexToBytes`, `nextDelayMs`).
