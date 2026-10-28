# HandCash thin Linux shell

Implemented in [`../native-desktop/`](../native-desktop/) (Rust + WebKitGTK via wry).
On `linux`, `npm run dev` / `npm run dev:native` builds and launches that binary.

System packages (Debian/Ubuntu-ish): `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, build-essential, curl, wget, file,
`libssl-dev`, `libxdo-dev` (clipboard).
