---
name: wallet-summary-display-only
when: caching or paging wallet display balances
if: src/wallet/walletSummary.ts
---
Treat identity/chain summaries as stale display projections, never spend authority; revalidate with bounded keyset pages outside UI/send waits.
Fence all pages and pending-change credit against runtime changes and local writes before publishing; never renew a cache timestamp on selection.
