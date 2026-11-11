---
name: custody-in-durable-store
when: choosing where to store spend recipes or other data the seed cannot regenerate
if: src/wallet/custodyJournal.ts
---
Keep it in the durable store (`durableStorage.ts`), never IndexedDB alone: IndexedDB is lost on an origin change and on a wipe.
Write it as append-only segments, never by rewriting a whole value.
