# CLAUDE.md — HandCash Desktop

Guidance for Claude Code in this repository. Cursor agents also follow `.cursor/rules/*.mdc` and `AGENTS.md`.

## Enforce

1. **Aeon UI is the only UI stack** — `aeon-ui-engine` / `@aeon-ui/*`, XState machines in `src/machines/`, `data-aeon-*` projection, brand via `applyBrandPalette`. Details: `.cursor/rules/aeon-ui.mdc`.
2. **BRC-100 / BSVA bridge** — ports 2121/3321, `electron/httpServer.ts`, `src/wallet/brc100Handler.ts`, permissions, HandCash migrate methods. Keep contract mirrored with items-market. Details: `.cursor/rules/brc100-bsva.mdc`.
3. **Wallet layers** — Refresh = chain ingest; BRC-39 = history replica of toolbox IndexedDB. Do not conflate. SSoT: `src/wallet/layers.ts`. Remittance ≠ latch state; messagebox ≠ custody — see `docs/wallet-p2p-messagebox.md`.

## Upstream Aeon

Shared primitives live in `~/AeonUI`. Fix/extend the engine there, publish/bump `aeon-ui-engine`, then consume here. Do not fork Aeon compounds inside Desktop.

## Out of scope here

items-market uses Tailwind/shadcn — do not port that stack into Desktop.
