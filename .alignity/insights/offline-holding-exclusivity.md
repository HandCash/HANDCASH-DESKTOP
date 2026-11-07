---
name: offline-holding-exclusivity
when: changing or verifying multi-device signing exclusion
if: src/wallet/accountMoveMachine.ts
---
Offline local holding plus forced takeover does not prove exclusive signing; never label it strict concurrency protection without an enforceable handoff/fencing protocol.
Changing offline-spend or forced-take policy needs an explicit decision; keep holding and stale-runtime guards intact meanwhile.
