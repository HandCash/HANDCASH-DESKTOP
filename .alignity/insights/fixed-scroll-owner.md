---
name: fixed-scroll-owner
when: styling the wallet nav stage, a keep-alive slot or any scroll container
---
A container's display and overflow never depend on :has() of which child is visible; every section and child panel owns its scroller.
Flipping .wallet-nav-stage between scroller and flex on tab switch was the persistent switch/scroll lag (fixed in 1caf5804).
