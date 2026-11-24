---
name: unified-navigation-pill
when: changing navigation pill depth or selection styling
---
The action bar is an inverted pill: the outer pill carries the opaque obsidian `--hc-select-3d` bevel (no translucent white stops or white inset box-shadows, which Blitz paints gray); the section label/crumbs and selected tab stay transparent on it as one continuous surface, while unselected tabs sit on top as flat black plates with rounded end-caps (`calc(var(--wallet-nav-pill-radius) - 2px)`).
Dropdown panels stay black with `--hc-select-3d` selected rows and Send/Swap/Receive use `--hc-select-3d` when selected/pressed — always respecting the existing border-radius of each control instead of forcing `border-radius: 0`.
