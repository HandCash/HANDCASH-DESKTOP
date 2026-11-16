---
name: activity-async-owner
when: reading or merging Activity across asynchronous work or account switches
if: src/wallet/appActivity.ts
---
Capture identity/index/network before awaiting and pass that owner through Activity export/merge; never resolve the destination from the later active account.
Filter live actions for display by their starting account without cancelling or removing signed background work.
