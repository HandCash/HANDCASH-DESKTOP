---
name: read-only-before-signing
when: changing shared vault account selection or preparing Desktop and Mobile releases
---
Both devices must view every account read-only; selection must not move ownership, only an explicit signing action may do so automatically.
The menu's VIEW is view-only (`accountView.ts`, cached snapshot); a send from a view runs `takeViewedAccountForSpend` (move, switch, merge) and fails closed. Never remove holding guards or open a non-holder signing Toolbox to simulate read-only access. BRC-100/items/market signing has not been audited for spend-from-view.
