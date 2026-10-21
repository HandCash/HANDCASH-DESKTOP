# Vendored aeon-ui-engine

Pinned copy of **`panda-v2` at 729e024** (`729e024e67265838f2bfb9a153bd5ead72ddafe2`) from `GenericCPU/aeon-ui` (private repo): its root docs, `tsconfig.base.json`, `packages/` and `scripts/`, including upstream's generated `packages/panda/styled-system` (Panda 2). Apart from the local fixes below, the files match that commit.

Desktop CI installs via `file:vendor/aeon-ui-engine` so release builds do not need npm publish or GitHub cross-repo checkout. The root `package.json` here drops upstream's `postinstall` link script and the demo app from `test`.

npm `aeon-ui-engine@1.8.0` lacks `Select.Positioner` `anchorRef` (the swap coin picker uses it). Switch `package.json` back to the registry once a release includes it, then delete this folder.

## Local fixes to send upstream

- `react/src/radio-group`: `RadioGroupRootProps` extends div attributes, so `aria-label` type-checks (the root already spread them).
- `react/src/tabs`: a controlled `Tabs.Root` (`value` set) now reports clicks through `onValueChange`; before, clicks changed only machine state the controlled value ignored. Root also accepts div attributes.

