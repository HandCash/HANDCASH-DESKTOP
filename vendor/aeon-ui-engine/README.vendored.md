# Vendored aeon-ui-engine

Pinned copy of **aeon-ui-engine 1.9.0, `panda-v2` at dc1ee9d** (`dc1ee9d74f5868bd74ffda17c88314a7b20a471f`) from `GenericCPU/aeon-ui` (private repo): its root docs, `tsconfig.base.json`, `packages/` and `scripts/`, including upstream's generated `packages/panda/styled-system` (Panda 2). The files match that commit, except that the root `package.json` drops upstream's `postinstall` link script.

Desktop CI installs via `file:vendor/aeon-ui-engine` so release builds do not need npm publish or GitHub cross-repo checkout.

1.9.0 is on npm and includes `Select.Positioner` `anchorRef` (the swap coin picker uses it), so Desktop can switch `package.json` back to the registry and delete this folder.
