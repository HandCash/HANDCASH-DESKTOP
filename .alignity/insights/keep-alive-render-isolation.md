---
name: keep-alive-render-isolation
when: changing wallet tab navigation or keeping panels mounted
if: src/components/WalletNav.tsx
---
Keep-alive panels need memo boundaries and stable props: hidden DOM alone does not stop parent-driven renders on every tab change.
Keep their own store/context subscriptions live; never trade display speed for stale spend authority.
