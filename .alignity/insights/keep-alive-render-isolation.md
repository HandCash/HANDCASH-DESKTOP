---
name: keep-alive-render-isolation
when: changing wallet tab navigation or keeping panels mounted
if: src/components/WalletNav.tsx
---
Keep-alive panels need memo boundaries and stable props; schedule first-visit mounts in the content transition, never with urgent tab feedback.
Hidden DOM does not stop renders; keep panel store/context subscriptions live and never trade display speed for stale spend authority.
