# HandCash Desktop — agent instructions

**Audience:** Cursor, Claude Code, Copilot, and other coding agents.  
**Product:** Official HandCash Desktop wallet (BETA) — self-custodial BRC-100 bridge + Aeon UI.

## North stars

1. **UI = Aeon** — single source of truth. Machines first, then projection. See `.cursor/rules/aeon-ui.mdc`.
2. **Protocol = BRC-100 / BSVA** — local HTTP bridge, origin permissions, mirrored migrate contract. See `.cursor/rules/brc100-bsva.mdc`.

## Read first

| Topic | Path |
|-------|------|
| Aeon consumer rules | `.cursor/rules/aeon-ui.mdc` |
| BRC / migrate rules | `.cursor/rules/brc100-bsva.mdc` |
| Aeon engine (upstream) | `~/AeonUI/AGENTS.md` |
| App overview | `README.md` |
| Versioning / releases | `VERSIONING.md` |

## Do not

- Add a second UI framework (Tailwind, shadcn, MUI, …).
- Invent a non–BRC-100 connect path for web apps.
- Change migrate APIs without updating `items-market` `src/lib/brc100/*` and docs.

## Commands

```bash
npm run dev          # Vite + Electron
npm run launch:mac   # packaged Mac local run
npm run launch       # packaged Linux local run (Linux host)
npm run package:mac
# Linux AppImage: push tag vX.Y.Z → GitHub Actions Release Linux
```
