// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Exact SVG icons ported 1:1 from `src/components/icons.tsx` and `public/brand/handcash-mark-green.svg`.

use base64::Engine as _;
use dioxus::prelude::*;
use std::sync::OnceLock;

pub const HANDCASH_MARK_SVG: &str =
    include_str!("../../../../public/brand/handcash-mark-green.svg");
const HANDCASH_MARK_GREEN_PNG: &[u8] =
    include_bytes!("../../../../public/brand/handcash-mark-green.png");

fn handcash_mark_png_data_uri() -> &'static str {
    static URI: OnceLock<String> = OnceLock::new();
    URI.get_or_init(|| {
        let b64 = base64::engine::general_purpose::STANDARD.encode(HANDCASH_MARK_GREEN_PNG);
        format!("data:image/png;base64,{b64}")
    })
}

#[component]
pub fn HandCashBrandMark(#[props(default = 28)] size: u32) -> Element {
    let _ = handcash_mark_png_data_uri;
    rsx! {
        svg {
            class: "brand-logo-mark",
            view_box: "0 0 128 128",
            width: "{size}",
            height: "{size}",
            fill: "none",
            role: "img",
            "aria-label": "HandCash",
            rect { x: "0", y: "0", width: "128", height: "128", rx: "24", fill: "#000000" }
            g { fill: "#38E58B",
                path { d: "M64 20 A44 44 0 0 0 64 108 L64 96 A32 32 0 0 1 64 32 Z" }
                path { d: "M64 20 A44 44 0 0 1 64 108 L64 96 A32 32 0 0 0 64 32 Z" }
                circle { cx: "64", cy: "64", r: "12" }
                rect { x: "64", y: "57", width: "36", height: "14", rx: "1" }
            }
        }
    }
}

/// Wide geometric Syncopate Bold `HANDCASH` vector wordmark matching `src/components/BrandLogo.tsx`
/// and `src/assets/brand/handcash-wordmark.svg` in Blitz without requiring remote Google Fonts.
#[component]
pub fn HandCashWordmarkSvg() -> Element {
    rsx! {
        svg {
            class: "brand-wordmark-svg",
            view_box: "0 0 184 16",
            width: "142",
            height: "13",
            fill: "currentColor",
            "aria-hidden": "true",
            // H
            path { d: "M0 1h3.4v5.3h10.2V1H17v14h-3.4V9.3H3.4V15H0V1z" }
            // A
            path { d: "M29.2 1h4.2l8.4 14h-3.8l-1.8-3.1H26.4L24.6 15h-3.7L29.2 1zm-1.1 8.1h6.4L31.3 3.8l-3.2 5.3z" }
            // N
            path { d: "M45.6 1h3.6l10.2 9.8V1h3.4v14h-3.4L49 5v10h-3.4V1z" }
            // D
            path { d: "M68.2 1h10.4c4.5 0 7.4 2.7 7.4 7s-2.9 7-7.4 7H68.2V1zm3.4 3v8h6.8c2.6 0 4.1-1.5 4.1-4s-1.5-4-4.1-4h-6.8z" }
            // C
            path { d: "M97.8 15.2c-5 0-8.2-2.9-8.2-7.2S92.8.8 97.8.8h8.8v3.1h-8.5c-3 0-4.9 1.6-4.9 4.1s1.9 4.1 4.9 4.1h8.5v3.1h-8.8z" }
            // A
            path { d: "M118.4 1h4.2l8.4 14h-3.8l-1.8-3.1h-9.8L113.8 15h-3.7l8.3-14zm-1.1 8.1h6.4l-3.2-5.3-3.2 5.3z" }
            // S
            path { d: "M134.5 11.9h9.8c1.5 0 2.3-.5 2.3-1.4 0-.8-.7-1.3-2.2-1.4l-5.3-.3c-3.4-.2-5.2-1.6-5.2-4 0-2.5 2.1-4 5.8-4h9.4v3h-9.2c-1.5 0-2.4.5-2.4 1.3 0 .8.7 1.2 2.3 1.3l5.2.3c3.5.2 5.2 1.6 5.2 4.1 0 2.6-2.1 4.2-5.9 4.2h-9.8v-3.1z" }
            // H
            path { d: "M155.4 1h3.4v5.3H169V1h3.4v14H169V9.3h-10.2V15h-3.4V1z" }
        }
    }
}

#[component]
pub fn BsvLogoMark(#[props(default = 32)] size: u32) -> Element {
    rsx! {
        svg {
            class: "bsv-logo is-shown",
            view_box: "0 0 32 32",
            width: "{size}",
            height: "{size}",
            fill: "none",
            circle { cx: "16", cy: "16", r: "15", fill: "#EAB300" }
            path {
                d: "M17.3 9.2V7h-1.8v2.1h-1.4V7h-1.8v2.2H9.6v1.9h1.2c.6 0 .8.3.8.8v8.2c0 .5-.2.8-.8.8H9.6v1.9h2.7V25h1.8v-2.1h1.4V25h1.8v-2.2c2.5-.2 4.1-1.4 4.1-3.6 0-1.6-.9-2.8-2.4-3.3 1.1-.5 1.8-1.5 1.8-2.8 0-2-1.4-3.5-3.5-3.9zm-3.2 2h2.1c1.1 0 1.8.6 1.8 1.6s-.7 1.6-1.8 1.6h-2.1v-3.2zm2.5 9.6h-2.5v-3.5h2.5c1.3 0 2.1.7 2.1 1.8 0 1.1-.8 1.7-2.1 1.7z",
                fill: "#111111",
            }
        }
    }
}

#[component]
pub fn CoinGlyphIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg {
            view_box: "0 0 24 24",
            width: "{size}",
            height: "{size}",
            fill: "currentColor",
            path { d: "M14.2 6.8V5h-1.5v1.7h-1.2V5H10v1.8H7.8v1.5h1c.5 0 .7.2.7.7v6.1c0 .5-.2.7-.7.7h-1v1.5H10V19h1.5v-1.7h1.2V19h1.5v-1.8c2-.2 3.3-1.2 3.3-2.9 0-1.3-.7-2.2-1.9-2.6.9-.4 1.4-1.2 1.4-2.2 0-1.6-1.1-2.5-2.8-2.7zm-2.7 1.6h1.7c.9 0 1.4.5 1.4 1.3s-.5 1.3-1.4 1.3h-1.7V8.4zm2 7.5h-2v-2.8h2c1 0 1.7.5 1.7 1.4 0 .9-.7 1.4-1.7 1.4z" }
        }
    }
}

#[component]
pub fn ScanQrIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M3 3h6v2H5v4H3V3zm12 0h6v6h-2V5h-4V3zM3 15h2v4h4v2H3v-6zm16 4v-4h2v6h-6v-2h4z" }
        }
    }
}

#[component]
pub fn LockIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" }
        }
    }
}

#[component]
pub fn SendIcon(#[props(default = 22)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" }
        }
    }
}

#[component]
pub fn ReceiveIcon(#[props(default = 22)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z" }
        }
    }
}

#[component]
pub fn SwapIcon(#[props(default = 22)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M7 2 11.5 9H9v8H5V9H2.5zM17 22l-4.5-7H15V7h4v8h2.5z" }
        }
    }
}

#[component]
pub fn BackIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" }
        }
    }
}

#[component]
pub fn ExpandMoreIcon(
    #[props(default = 16)] size: u32,
    #[props(default = String::new())] class: String,
) -> Element {
    rsx! {
        svg {
            class: "{class}",
            view_box: "0 0 24 24",
            width: "{size}",
            height: "{size}",
            fill: "currentColor",
            path { d: "M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z" }
        }
    }
}

#[component]
pub fn CopyIcon(#[props(default = 14)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" }
        }
    }
}

#[component]
pub fn CheckIcon(
    #[props(default = 17)] size: u32,
    #[props(default = String::new())] class: String,
) -> Element {
    rsx! {
        svg {
            class: "{class}",
            view_box: "0 0 24 24",
            width: "{size}",
            height: "{size}",
            fill: "currentColor",
            path { d: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" }
        }
    }
}

#[component]
pub fn ActivityIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M23 8c0 1.1-.9 2-2 2a1.7 1.7 0 0 1-.51-.07l-3.56 3.55c.05.16.07.34.07.52 0 1.1-.9 2-2 2s-2-.9-2-2c0-.18.02-.36.07-.52l-2.55-2.55c-.16.05-.34.07-.52.07s-.36-.02-.52-.07l-4.55 4.56c.05.16.07.33.07.51 0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2c.18 0 .35.02.51.07l4.56-4.55C8.02 9.36 8 9.18 8 9c0-1.1.9-2 2-2s2 .9 2 2c0 .18-.02.36-.07.52l2.55 2.55c.16-.05.34-.07.52-.07s.36.02.52.07l3.55-3.56A1.7 1.7 0 0 1 19 8c0-1.1.9-2 2-2s2 .9 2 2z" }
        }
    }
}

#[component]
pub fn AppsIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg {
            view_box: "0 0 24 24",
            width: "{size}",
            height: "{size}",
            fill: "none",
            stroke: "currentColor",
            stroke_width: "2",
            stroke_linecap: "round",
            stroke_linejoin: "round",
            path { d: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" }
            path { d: "m3.27 6.96 8.73 5.05 8.73-5.05M12 22.08V12" }
        }
    }
}

#[component]
pub fn CollectablesIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M16 9h3l-5 7M10 9h4l-2 8M5 9h3l2 7M15 4h2l2 3h-3M11 4h2l1 3h-4M7 4h2L8 7H5M6 2 2 8l10 14L22 8l-4-6H6z" }
        }
    }
}

#[component]
pub fn FriendsIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" }
        }
    }
}

#[component]
pub fn PersonAddIcon(#[props(default = 24)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" }
        }
    }
}

#[component]
pub fn IdentityIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" }
        }
    }
}

#[component]
pub fn SettingsIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.455.455 0 0 0-.59.22L2.74 9.29a.48.48 0 0 0-.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 15.6 12 3.6 3.6 0 0 1 12 15.6z" }
        }
    }
}

#[component]
pub fn EyeIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" }
        }
    }
}

#[component]
pub fn EyeOffIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" }
        }
    }
}

#[component]
pub fn EncryptIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" }
        }
    }
}

#[component]
pub fn DownloadIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" }
        }
    }
}

#[component]
pub fn RefreshIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" }
        }
    }
}

#[component]
pub fn PaletteIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" }
        }
    }
}

#[component]
pub fn MonitorIcon(#[props(default = 16)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h6v2H8v2h8v-2h-2v-2h6c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z" }
        }
    }
}

#[component]
pub fn DarkModeIcon(#[props(default = 16)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z" }
        }
    }
}

#[component]
pub fn AddIcon(#[props(default = 16)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" }
        }
    }
}

#[component]
pub fn EditIcon(#[props(default = 16)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" }
        }
    }
}

#[component]
pub fn CloseIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" }
        }
    }
}

#[component]
pub fn FilterIcon(#[props(default = 16)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z" }
        }
    }
}

#[component]
pub fn ViewGridIcon(#[props(default = 16)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z" }
        }
    }
}

#[component]
pub fn FingerprintIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M17.81 4.47c-.08 0-.16-.02-.23-.06C15.66 3.42 14 3 12.01 3c-1.98 0-3.86.47-5.57 1.41-.24.13-.54.04-.68-.2-.13-.24-.04-.55.2-.68C7.82 2.52 9.86 2 12.01 2c2.13 0 3.99.47 6.03 1.52.25.13.34.43.21.67-.09.18-.26.28-.44.28zM3.5 9.72c-.1 0-.2-.03-.29-.09-.23-.16-.28-.47-.12-.7.99-1.4 2.25-2.5 3.75-3.27C9.98 4.04 14 4.03 17.15 5.65c1.5.77 2.76 1.86 3.75 3.25.16.22.11.54-.12.7-.23.16-.54.11-.7-.12-.9-1.26-2.04-2.25-3.39-2.94-2.87-1.47-6.54-1.47-9.4.01-1.36.7-2.5 1.7-3.4 2.96-.08.14-.23.21-.39.21zm6.25 12.07c-.13 0-.26-.05-.35-.15-.87-.87-1.34-1.43-2.01-2.64-.69-1.23-1.05-2.73-1.05-4.34 0-2.97 2.54-5.39 5.66-5.39s5.66 2.42 5.66 5.39c0 .28-.22.5-.5.5s-.5-.22-.5-.5c0-2.42-2.09-4.39-4.66-4.39-2.57 0-4.66 1.97-4.66 4.39 0 1.44.32 2.77.93 3.85.64 1.15 1.08 1.64 1.85 2.42.19.2.19.51 0 .71-.11.1-.24.15-.37.15zm7.17-1.85c-1.19 0-2.24-.3-3.1-.89-1.49-1.01-2.38-2.65-2.38-4.39 0-.28.22-.5.5-.5s.5.22.5.5c0 1.41.72 2.74 1.94 3.56.71.48 1.54.71 2.54.71.24 0 .64-.03 1.04-.1.27-.05.53.13.58.41.05.27-.13.53-.41.58-.57.11-1.07.12-1.21.12zM14.91 22c-.04 0-.09-.01-.13-.02-1.59-.44-2.63-1.03-3.72-2.1-1.4-1.39-2.17-3.24-2.17-5.22 0-1.62 1.38-2.94 3.08-2.94 1.7 0 3.08 1.32 3.08 2.94 0 1.07.93 1.94 2.08 1.94s2.08-.87 2.08-1.94c0-3.77-3.25-6.83-7.25-6.83-2.84 0-5.44 1.58-6.61 4.03-.39.81-.59 1.76-.59 2.8 0 .78.07 2.01.67 3.61.1.26-.03.55-.29.64-.26.1-.55-.04-.64-.29-.49-1.31-.73-2.61-.73-3.96 0-1.2.23-2.29.68-3.24 1.33-2.79 4.28-4.6 7.51-4.6 4.55 0 8.25 3.51 8.25 7.83 0 1.62-1.38 2.94-3.08 2.94s-3.08-1.32-3.08-2.94c0-1.07-.93-1.94-2.08-1.94s-2.08.87-2.08 1.94c0 1.71.66 3.31 1.87 4.51.95.94 1.86 1.46 3.27 1.85.27.07.42.35.35.61-.05.23-.26.38-.47.38z" }
        }
    }
}

#[component]
pub fn ViewListIcon(#[props(default = 16)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" }
        }
    }
}

#[component]
pub fn FireIcon(#[props(default = 16)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z" }
        }
    }
}

#[component]
pub fn LightModeIcon(#[props(default = 16)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58a.996.996 0 0 0-1.41 0 .996.996 0 0 0 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37a.996.996 0 0 0-1.41 0 .996.996 0 0 0 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0a.996.996 0 0 0 0-1.41l-1.06-1.06zm1.06-10.96a.996.996 0 0 0 0-1.41.996.996 0 0 0-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36a.996.996 0 0 0 0-1.41.996.996 0 0 0-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z" }
        }
    }
}

#[component]
pub fn InfoIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" }
        }
    }
}

#[component]
pub fn LaunchIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" }
        }
    }
}

#[component]
pub fn FileIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M6 2h7l5 5v15H6V2zm7 1.5V8h4.5L13 3.5zM8 12v2h8v-2H8zm0 4v2h6v-2H8z" }
        }
    }
}

#[component]
pub fn CodeIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z" }
        }
    }
}

#[component]
pub fn VolumeUpIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" }
        }
    }
}

#[component]
pub fn SystemUpdateIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M17 1.01 7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14zm-4.2-5.78v1.75L18 12l-5.2-3.47v1.75H9v3.5h3.8z" }
        }
    }
}

#[component]
pub fn DevicesIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z" }
        }
    }
}

#[component]
pub fn ScreenshotIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M20 3H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4v2h8v-2h4c1.1 0 1.99-.9 1.99-2L22 5c0-1.1-.9-2-2-2zm0 14H4V5h16v12z" }
        }
    }
}

#[component]
pub fn WarningIcon(#[props(default = 20)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 24 24", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" }
        }
    }
}

/// Litecoin glyph (no disc), the `ltc` case of TS `CoinGlyphIcon`
/// (`cryptocurrency-icons`, CC0; see `src/assets/brand/ATTRIBUTION.md`).
#[component]
pub fn LtcGlyphIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 32 32", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M10.427 19.214L9 19.768l.688-2.759 1.444-.58L13.213 8h5.129l-1.519 6.196 1.41-.571-.68 2.75-1.427.571-.848 3.483H23L22.127 24H9.252z" }
        }
    }
}

/// Arc USD glyph (no disc), the `arc-usd` case of TS `CoinGlyphIcon`.
#[component]
pub fn ArcUsdGlyphIcon(#[props(default = 18)] size: u32) -> Element {
    rsx! {
        svg { view_box: "0 0 32 32", width: "{size}", height: "{size}", fill: "currentColor",
            path { d: "M20.022 18.124c0-2.124-1.28-2.852-3.840-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.707.364 2.011 1.275a.458.458 0 00.427.303h.975a.416.416 0 00.427-.425v-.06a3.04 3.04 0 00-2.743-2.489V9.142c0-.243-.183-.425-.487-.486h-.915c-.243 0-.426.182-.487.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.778 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.06-.242-.244-.364-.427-.364h-1.036a.416.416 0 00-.426.425v.06c.243 1.518 1.219 2.61 3.230 2.914v1.457c0 .242.183.425.487.485h.915c.243 0 .426-.182.487-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z" }
            path { d: "M12.892 24.497c-4.754-1.7-7.192-6.98-5.424-11.653.914-2.55 2.925-4.491 5.424-5.402.244-.121.365-.303.365-.607v-.85c0-.242-.121-.424-.365-.485-.061 0-.183 0-.244.06a10.895 10.895 0 00-7.13 13.717c1.096 3.4 3.717 6.01 7.13 7.102.244.121.488 0 .548-.243.061-.06.061-.122.061-.243v-.85c0-.182-.182-.424-.365-.546zm6.46-18.936c-.244-.122-.488 0-.548.242-.061.061-.061.122-.061.243v.85c0 .243.182.485.365.607 4.754 1.7 7.192 6.98 5.424 11.653-.914 2.55-2.925 4.491-5.424 5.402-.244.121-.365.303-.365.607v.85c0 .242.121.424.365.485.061 0 .183 0 .244-.06a10.895 10.895 0 007.13-13.717c-1.096-3.46-3.778-6.07-7.13-7.162z" }
        }
    }
}

/// TS `CHAIN_GLYPHS` (cryptocurrency-icons, CC0) for the disc marks.
const CHAIN_GLYPH_LTC: &str = "M10.427 19.214L9 19.768l.688-2.759 1.444-.58L13.213 8h5.129l-1.519 6.196 1.41-.571-.68 2.75-1.427.571-.848 3.483H23L22.127 24H9.252z";
const CHAIN_GLYPH_BCH: &str = "M21.207 10.534c-.776-1.972-2.722-2.15-4.988-1.71l-.807-2.813-1.712.491.786 2.74c-.45.128-.908.27-1.363.41l-.79-2.758-1.711.49.805 2.813c-.368.114-.73.226-1.085.328l-.003-.01-2.362.677.525 1.83s1.258-.388 1.243-.358c.694-.199 1.035.139 1.2.468l.92 3.204c.047-.013.11-.029.184-.04l-.181.052 1.287 4.49c.032.227.004.612-.48.752.027.013-1.246.356-1.246.356l.247 2.143 2.228-.64c.415-.117.825-.227 1.226-.34l.817 2.845 1.71-.49-.807-2.815a65.74 65.74 0 001.372-.38l.802 2.803 1.713-.491-.814-2.84c2.831-.991 4.638-2.294 4.113-5.07-.422-2.234-1.724-2.912-3.471-2.836.848-.79 1.213-1.858.642-3.3zm-.65 6.77c.61 2.127-3.1 2.929-4.26 3.263l-1.081-3.77c1.16-.333 4.704-1.71 5.34.508zm-2.322-5.09c.554 1.935-2.547 2.58-3.514 2.857l-.98-3.419c.966-.277 3.915-1.455 4.494.563z";
const CHAIN_GLYPH_BTC: &str = "M23.189 14.02c.314-2.096-1.283-3.223-3.465-3.975l.708-2.84-1.728-.43-.69 2.765c-.454-.114-.92-.22-1.385-.326l.695-2.783L15.596 6l-.708 2.839c-.376-.086-.746-.17-1.104-.26l.002-.009-2.384-.595-.46 1.846s1.283.294 1.256.312c.7.175.826.638.805 1.006l-.806 3.235c.048.012.11.03.18.057l-.183-.045-1.13 4.532c-.086.212-.303.531-.793.41.018.025-1.256-.313-1.256-.313l-.858 1.978 2.25.561c.418.105.828.215 1.231.318l-.715 2.872 1.727.43.708-2.84c.472.127.93.245 1.378.357l-.706 2.828 1.728.43.715-2.866c2.948.558 5.164.333 6.097-2.333.752-2.146-.037-3.385-1.588-4.192 1.13-.26 1.98-1.003 2.207-2.538zm-3.95 5.538c-.533 2.147-4.148.986-5.32.695l.95-3.805c1.172.293 4.929.872 4.37 3.11zm.535-5.569c-.487 1.953-3.495.96-4.47.717l.86-3.45c.975.243 4.118.696 3.61 2.733z";
const CHAIN_GLYPH_DOGE: &str = "M13.248 14.61h4.314v2.286h-4.314v4.818h2.721c1.077 0 1.958-.145 2.644-.437.686-.291 1.224-.694 1.615-1.21a4.4 4.4 0 00.796-1.815 11.4 11.4 0 00.21-2.252 11.4 11.4 0 00-.21-2.252 4.396 4.396 0 00-.796-1.815c-.391-.516-.93-.919-1.615-1.21-.686-.292-1.567-.437-2.644-.437h-2.721v4.325zm-2.766 2.286H9v-2.285h1.482V8h6.549c1.21 0 2.257.21 3.142.627.885.419 1.607.99 2.168 1.715.56.724.977 1.572 1.25 2.543.273.971.409 2.01.409 3.115a11.47 11.47 0 01-.41 3.115c-.272.97-.689 1.819-1.25 2.543-.56.725-1.282 1.296-2.167 1.715-.885.418-1.933.627-3.142.627h-6.549v-7.104z";
const CHAIN_GLYPH_ARC_USD: [&str; 2] = ["M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.707.364 2.011 1.275a.458.458 0 00.427.303h.975a.416.416 0 00.427-.425v-.06a3.04 3.04 0 00-2.743-2.489V9.142c0-.243-.183-.425-.487-.486h-.915c-.243 0-.426.182-.487.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.778 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.06-.242-.244-.364-.427-.364h-1.036a.416.416 0 00-.426.425v.06c.243 1.518 1.219 2.61 3.23 2.914v1.457c0 .242.183.425.487.485h.915c.243 0 .426-.182.487-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z", "M12.892 24.497c-4.754-1.7-7.192-6.98-5.424-11.653.914-2.55 2.925-4.491 5.424-5.402.244-.121.365-.303.365-.607v-.85c0-.242-.121-.424-.365-.485-.061 0-.183 0-.244.06a10.895 10.895 0 00-7.13 13.717c1.096 3.4 3.717 6.01 7.13 7.102.244.121.488 0 .548-.243.061-.06.061-.122.061-.243v-.85c0-.182-.182-.424-.365-.546zm6.46-18.936c-.244-.122-.488 0-.548.242-.061.061-.061.122-.061.243v.85c0 .243.182.485.365.607 4.754 1.7 7.192 6.98 5.424 11.653-.914 2.55-2.925 4.491-5.424 5.402-.244.121-.365.303-.365.607v.85c0 .242.121.424.365.485.061 0 .183 0 .244-.06a10.895 10.895 0 007.13-13.717c-1.096-3.46-3.778-6.07-7.13-7.162z"];

/// Disc + glyph chain mark — mirrors TS `LitecoinIcon` / `BitcoinIcon` / … (`data-chain-mark`).
#[component]
pub fn ChainMark(coin: String, #[props(default = 18)] size: u32) -> Element {
    let glyphs: Vec<&'static str> = match coin.as_str() {
        "ltc" => vec![CHAIN_GLYPH_LTC],
        "bch" => vec![CHAIN_GLYPH_BCH],
        "btc" => vec![CHAIN_GLYPH_BTC],
        "doge" => vec![CHAIN_GLYPH_DOGE],
        "arc-usd" => CHAIN_GLYPH_ARC_USD.to_vec(),
        _ => Vec::new(),
    };
    rsx! {
        svg {
            view_box: "0 0 32 32",
            width: "{size}",
            height: "{size}",
            "aria-hidden": "true",
            "focusable": "false",
            "data-chain-mark": "{coin}",
            circle { cx: "16", cy: "16", r: "16", class: "chain-mark-disc" }
            for d in glyphs {
                path { class: "chain-mark-glyph", d: "{d}" }
            }
        }
    }
}

/// TS `TickerCoinMark`: the BSV logo for `bsv`, otherwise the disc chain mark.
#[component]
pub fn TickerCoinMark(coin: String, #[props(default = 18)] size: u32) -> Element {
    if coin == "bsv" {
        return rsx! { BsvLogoMark { size } };
    }
    rsx! { ChainMark { coin, size } }
}
