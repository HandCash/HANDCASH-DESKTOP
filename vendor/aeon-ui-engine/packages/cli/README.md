# @aeon-ui/cli

AI-optimized CLI for Aeon UI.

```bash
npx aeon-ui init
npx aeon-ui migrate
```

## `init`

Injects:

- `.cursor/rules/aeon-ui.mdc` — always-on Cursor rule
- `aeon.cursorrules.md` / `aeon.system-prompt.md` — paste into any agent
- `aeon.schemas/` — deterministic JSON schemas per component
- `src/components/AeonStarter.tsx` — minimal Field + Button scaffold
- `AEON_AI.md` — next steps

Use `--force` to overwrite.

## `migrate`

Scans for known local workarounds (preview-window machine, file dropzone, sonner bridge, etc.) and writes `AEON_MIGRATION_CHECKLIST.md`.

```bash
npx aeon-ui migrate          # write checklist
npx aeon-ui migrate --check  # print findings only
```
