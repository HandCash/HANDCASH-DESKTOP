---
name: idb-recovery-before-operation
when: recovering a closed wallet IndexedDB connection
if: packages/wallet-engine/src/storage/StorageIdb.ts
---
Reopen the same database before a manager operation starts; never replay its callback or writes after failure, and never reopen explicitly destroyed storage.
Invalidate display-page revisions when replacing a connection; a failed pending-change display read is unavailable, not zero.
