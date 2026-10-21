# Vendored aeon-ui-engine

Pinned copy of **aeon-ui-engine 1.10.0, `panda-v2` at bfbb0c8** (`bfbb0c8265a9bf9a59b41c1e1f856420f80d3fdd`) from `GenericCPU/aeon-ui` (private repo): its root docs, `tsconfig.base.json`, `packages/` and `scripts/`, including upstream's generated `packages/panda/styled-system` (Panda 2). The files match that commit, except that the root `package.json` drops upstream's `postinstall` link script.

Desktop CI installs via `file:vendor/aeon-ui-engine` so release builds do not need npm publish or GitHub cross-repo checkout.

1.10.0 adds `createAeonStore` (`@aeon-ui/primitives`) and the React hooks `useAeonSelector` and `useAeonQuery`. Once 1.10.0 is on npm, Desktop can switch `package.json` back to the registry and delete this folder.
