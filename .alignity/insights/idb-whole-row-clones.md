---
name: idb-whole-row-clones
when: reading, counting or scanning wallet outputs in IndexedDB storage
if: packages/wallet-engine/src/storage/StorageIdb.ts
---
IndexedDB clones every row a value cursor touches whole on the UI thread, remittance included (up to 384 KB): 3,000 item rows cost 1.8 s per walk. Never walk a basket for a total or a skip; resume after the last row, count by index keys or reuse a count fenced by the write revision.
