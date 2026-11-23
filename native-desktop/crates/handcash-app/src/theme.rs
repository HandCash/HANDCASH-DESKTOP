// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Exact 1:1 HandCash stylesheet & Omarchy theme token parity with
//! `src/main.tsx`, `src/styles/handcash.css`, `src/styles/layout-compact.css`,
//! `src/wallet/handcashTheme.ts`, and `src/wallet/omarchyTheme.ts`.

use aeon_ui::AeonMode;
use handcash_shell::omarchy_theme;

/// Desktop shell fill-height & titlebar drag chrome (chrome.css, scrollbars.css, and
/// consumer-shell.css are now provided natively by `aeon-ui 0.4.0` via `AeonThemeProvider`).
pub const AEON_ELECTRON_CSS: &str =
    include_str!("../../../../vendor/aeon-ui-engine/packages/panda/src/theme/electron.css");

/// The real HandCash Desktop stylesheets — rendered natively by Blitz/Stylo.
pub const HANDCASH_CSS: &str = include_str!("../../../../src/styles/handcash.css");
pub const LAYOUT_COMPACT_CSS: &str = include_str!("../../../../src/styles/layout-compact.css");

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AppearancePreference {
    #[default]
    System,
    Dark,
    Light,
}

impl AppearancePreference {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Dark => "dark",
            Self::Light => "light",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedTheme {
    pub mode: AeonMode,
    pub omarchy_name: Option<String>,
    pub bg: String,
    pub surface: String,
    pub surface_raised: String,
    pub border: String,
    pub text: String,
    pub muted: String,
    pub accent: String,
    pub accent_dim: String,
    pub danger: String,
    pub green: String,
    pub selection: String,
}

impl Default for ResolvedTheme {
    /// Classic HandCash OLED dark sheet (`HANDCASH_DARK_PALETTE`).
    fn default() -> Self {
        Self::dark_handcash()
    }
}

impl ResolvedTheme {
    pub fn dark_handcash() -> Self {
        Self {
            mode: AeonMode::Dark,
            omarchy_name: None,
            bg: "#000000".into(),
            surface: "#000000".into(),
            surface_raised: "#0c0c0c".into(),
            border: "#262626".into(),
            text: "#f4f4f5".into(),
            muted: "#a1a1aa".into(),
            accent: "#57ff97".into(),
            accent_dim: "rgba(87, 255, 151, 0.14)".into(),
            danger: "#f87171".into(),
            green: "#57ff97".into(),
            selection: "#171717".into(),
        }
    }

    pub fn light_handcash() -> Self {
        Self {
            mode: AeonMode::Light,
            omarchy_name: None,
            bg: "#fafbfa".into(),
            surface: "#ffffff".into(),
            surface_raised: "#f3f5f3".into(),
            border: "#e4e7e5".into(),
            text: "#141814".into(),
            muted: "#4a524c".into(),
            accent: "#0a3d22".into(),
            accent_dim: "rgba(10, 61, 34, 0.14)".into(),
            danger: "#dc2626".into(),
            green: "#0a3d22".into(),
            selection: "#eef1ef".into(),
        }
    }

    pub fn with_preference(&self, pref: AppearancePreference) -> Self {
        match pref {
            AppearancePreference::System => self.clone(),
            AppearancePreference::Dark => Self::dark_handcash(),
            AppearancePreference::Light => Self::light_handcash(),
        }
    }
}

pub fn read_resolved_theme() -> ResolvedTheme {
    let snap = omarchy_theme::read_omarchy_theme();
    let is_light = snap
        .get("colors")
        .and_then(|c| c.get("mode"))
        .and_then(|v| v.as_str())
        == Some("light");
    if is_light {
        ResolvedTheme::light_handcash()
    } else {
        ResolvedTheme::dark_handcash()
    }
}

fn hex_to_hsl_channels(hex: &str) -> String {
    let clean = hex.trim().trim_start_matches('#');
    if clean.len() != 6 {
        return "0 0% 0%".into();
    }
    let r = u8::from_str_radix(&clean[0..2], 16).unwrap_or(0) as f64 / 255.0;
    let g = u8::from_str_radix(&clean[2..4], 16).unwrap_or(0) as f64 / 255.0;
    let b = u8::from_str_radix(&clean[4..6], 16).unwrap_or(0) as f64 / 255.0;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    let (h, s) = if d.abs() < 1e-6 {
        (0.0, 0.0)
    } else {
        let s = d / (1.0 - (2.0 * l - 1.0).abs());
        let mut h = if (max - r).abs() < 1e-6 {
            ((g - b) / d) % 6.0
        } else if (max - g).abs() < 1e-6 {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        };
        h *= 60.0;
        if h < 0.0 {
            h += 360.0;
        }
        (h, s)
    };
    format!("{:.0} {:.1}% {:.1}%", h, s * 100.0, l * 100.0)
}

/// `"r, g, b"` channels for `rgba()`; falls back to HandCash green when `hex` is not `#rrggbb`.
fn hex_to_rgb_channels(hex: &str) -> String {
    let clean = hex.trim().trim_start_matches('#');
    let parse = |i: usize| u8::from_str_radix(clean.get(i..i + 2)?, 16).ok();
    match (clean.len(), parse(0), parse(2), parse(4)) {
        (6 | 8, Some(r), Some(g), Some(b)) => format!("{r}, {g}, {b}"),
        _ => "87, 255, 151".into(),
    }
}

/// Embossed outer shell, stage, and titlebar sheen matching `src/styles/handcash.css`
/// (`.app-shell[data-aeon-scope='app']`, `.app-shell > .stage`, `.app-shell > .titlebar.aeon-titlebar`).
/// Solid `--hc-bg` with the TS emboss shadows. TS layers a translucent sheen here, but Blitz/Vello
/// paints translucent gradient stops as a mid-gray wash, so no gradient is drawn.
fn shell_gradient_css(_t: &ResolvedTheme) -> String {
    let _ = hex_to_rgb_channels;
    r#"
.app-shell[data-aeon-scope="app"],
.app-shell[data-aeon-scope="app"] > .stage {
  background-color: var(--hc-bg);
  background-image: none;
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.28);
}
.app-shell[data-aeon-scope="app"] > .titlebar.aeon-titlebar {
  background-color: var(--hc-bg);
  background-image: none;
  border-bottom-color: hsl(var(--border));
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.28);
}
.wallet-nav-titlebar-pill,
.wallet-nav-actions-pill {
  background-color: var(--hc-bg);
  background-image: none;
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.28);
}
"#
    .to_string()
}

/// Generates `:root` + `[data-aeon-theme]` token overrides matching `applyBrandPalette`
/// plus `markOmarchyTheme` and `html[data-aeon-mode='light']` so `HANDCASH_CSS` renders 1:1
/// identically to the TS/React app inside Blitz/Stylo.
pub fn build_theme_override_css(t: &ResolvedTheme) -> String {
    let bg_hsl = hex_to_hsl_channels(&t.bg);
    let fg_hsl = hex_to_hsl_channels(&t.text);
    let card_hsl = hex_to_hsl_channels(&t.surface);
    let raised_hsl = hex_to_hsl_channels(&t.surface_raised);
    let border_hsl = hex_to_hsl_channels(&t.border);
    let muted_hsl = hex_to_hsl_channels(&t.muted);
    let sel_hsl = hex_to_hsl_channels(&t.selection);
    let green_hsl = hex_to_hsl_channels(&t.green);
    let danger_hsl = hex_to_hsl_channels(&t.danger);

    let dark_extra = format!(
        r#"
  color-scheme: dark;
  --hc-field: #080808;
  --hc-deep: {bg};
  --hc-glow: {bg};
  --hc-nav-select: #1a1a1a;
  --hc-nav-unselected: #000000;
  --hc-nav-chrome: #1a1a1a;
  --wallet-nav-select: #1a1a1a;
  --wallet-nav-unselected: #000000;
  --hc-nav-selected-ink: #fafafa;
  --wallet-nav-pill-radius: 999px;
  --hc-sunken-soft: rgba(0, 0, 0, 0.22);
  --hc-sunken: rgba(0, 0, 0, 0.28);
  --hc-sunken-strong: rgba(0, 0, 0, 0.38);
  --hc-hover: rgba(255, 255, 255, 0.045);
  --coin-bsv: #eab300;
  --coin-ltc: #3660a3;
  --coin-bch: #0ac18e;
  --coin-btc: #f7931a;
  --coin-doge: #c2a633;
  --coin-arc-usd: #2775ca;
"#,
        bg = t.bg,
    );

    let (primary_hsl, primary_fg_hsl, accent_deep, mode_extra) = if t.mode == AeonMode::Light {
        (
            fg_hsl.clone(),
            "0 0% 100%".to_string(),
            "#0a3d22",
            r#"
  color-scheme: light;
  --hc-brand: 148 72% 14%;
  --hc-glow: radial-gradient(ellipse 70% 50% at 50% -20%, rgba(10, 61, 34, 0.08), transparent 55%), radial-gradient(ellipse 40% 30% at 90% 100%, rgba(10, 61, 34, 0.04), transparent 50%), #fafbfa;
  --hc-nav-select: #eaedea;
  --hc-nav-unselected: #ffffff;
  --hc-nav-chrome: #eaedea;
  --wallet-nav-select: #eaedea;
  --wallet-nav-unselected: #ffffff;
  --wallet-nav-pill-radius: 999px;
  --hc-cta: #38cb7b;
  --hc-cta-ink: #0a120e;
  --hc-sunken-soft: rgba(20, 24, 20, 0.025);
  --hc-sunken: rgba(20, 24, 20, 0.035);
  --hc-sunken-strong: rgba(20, 24, 20, 0.055);
  --hc-field: #ffffff;
  --hc-hover: rgba(20, 24, 20, 0.035);
  --hc-deep: #ffffff;
  --hc-accent-deep: #0a3d22;
  --hc-accent: var(--hc-accent-deep);
  --hc-accent-2: var(--hc-accent-deep);
  --hc-accent-dim: rgba(10, 61, 34, 0.14);
  --hc-success: var(--hc-accent-deep);
  --hc-warn: #9a6700;
  --hc-error: #b91c1c;
  --hc-down: #dc2626;
  --hc-fail: #dc2626;
  --hc-shadow: 0 16px 36px -14px rgba(20, 24, 20, 0.1);
  --coin-bsv: #af8600;
  --coin-ltc: #345d9d;
  --coin-bch: #089f75;
  --coin-btc: #cf7507;
  --coin-doge: #a28a2b;
  --coin-arc-usd: #2775ca;
"#
            .to_string(),
        )
    } else {
        (
            hex_to_hsl_channels(&t.accent),
            "0 0% 8%".to_string(),
            "#57ff97",
            dark_extra,
        )
    };

    let shell_gradients = shell_gradient_css(t);

    format!(
        r#"
:root, [data-aeon-theme] {{
  --background: {bg_hsl};
  --foreground: {fg_hsl};
  --card: {card_hsl};
  --card-foreground: {fg_hsl};
  --popover: {raised_hsl};
  --popover-foreground: {fg_hsl};
  --primary: {primary_hsl};
  --primary-foreground: {primary_fg_hsl};
  --secondary: {raised_hsl};
  --secondary-foreground: {fg_hsl};
  --muted: {sel_hsl};
  --muted-foreground: {muted_hsl};
  --accent: {sel_hsl};
  --accent-foreground: {fg_hsl};
  --destructive: {danger_hsl};
  --border: {border_hsl};
  --input: {border_hsl};
  --ring: {primary_hsl};
  --hc-brand: {green_hsl};
  --hc-success: hsl(var(--hc-brand));
  --hc-accent-deep: {accent_deep};
  --hc-bg: {bg};
  --hc-bg-elevated: {surface_raised};
  --hc-surface: {surface};
  --hc-surface-2: {surface_raised};
  --hc-border: {border};
  --hc-text: {text};
  --hc-muted: {muted};
  --hc-accent: {accent};
  --hc-accent-2: {accent};
  --hc-accent-dim: {accent_dim};
  --hc-danger: {danger};
  --colors-aeon-bg: {bg};
  --colors-aeon-surface: {surface};
  --colors-aeon-surface-raised: {surface_raised};
  --colors-aeon-border: {border};
  --colors-aeon-text: {text};
  --colors-aeon-muted: {muted};
  --colors-aeon-accent: {accent};
  --colors-aeon-accent-dim: {accent_dim};
  --colors-aeon-danger: {danger};
  --aeon-bg: {bg};
  --aeon-surface: {surface};
  --aeon-surface-raised: {surface_raised};
  --aeon-border: {border};
  --aeon-text: {text};
  --aeon-muted: {muted};
  --aeon-accent: {accent};
  --aeon-accent-dim: {accent_dim};
  --aeon-danger: {danger};
  --aeon-font: 'Archivo', ui-sans-serif, system-ui, sans-serif;
  --aeon-font-display: 'Syncopate', 'Archivo', ui-sans-serif, sans-serif;
{mode_extra}
}}
html, body {{
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: var(--hc-glow, var(--hc-bg));
  color: var(--hc-text);
  font-family: var(--hc-font);
  overflow: hidden;
}}
[data-aeon-theme] {{
  width: 100%;
  height: 100vh;
  min-height: 100%;
  background: var(--hc-glow, var(--hc-bg));
  color: var(--hc-text);
  overflow: hidden;
}}
.hc-root[data-hc] {{
  width: 100%;
  height: 100%;
  max-height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}}
/* True panel surfaces matching TS handcash.css (solid surface card + 2px border, no fake tint gradients) */
.panel {{
  background-color: var(--hc-surface);
  background-image: none;
  border: var(--hc-border-w, 2px) solid var(--hc-border);
  border-radius: var(--hc-radius);
}}
.panel.wallet-hero {{
  background-color: var(--hc-bg);
  background-image: none;
}}
/* Per-chain balance tint matching TS handcash.css */
.balance-primary[data-chain="bsv"] {{ --coin-color: var(--hc-accent-deep); }}
.balance-primary[data-chain="btc"] {{ --coin-color: var(--coin-btc); }}
.balance-primary[data-chain="bch"] {{ --coin-color: var(--coin-bch); }}
.balance-primary[data-chain="ltc"] {{ --coin-color: var(--coin-ltc); }}
.balance-primary[data-chain="doge"] {{ --coin-color: var(--coin-doge); }}
.balance-primary[data-chain="arc_usd"],
.balance-primary[data-chain="arc-usd"] {{ --coin-color: var(--coin-arc-usd); }}
.brand-wordmark-svg {{
  display: block;
  color: var(--hc-text);
}}
/* Unified navigation pill & action bar (`src/styles/handcash.css` + unified-navigation-pill insight) */
.wallet-nav-bar-track {{
  background-color: var(--hc-nav-select);
  background-image: none;
}}
.wallet-nav-titlebar-pill .wallet-nav-tab:not([data-selected]):not([aria-selected="true"]),
.wallet-nav-bar-track .wallet-nav-tab:not([data-selected]):not([aria-selected="true"]) {{
  background-color: var(--hc-nav-unselected);
  color: var(--hc-muted);
}}
.wallet-nav-titlebar-pill .wallet-nav-tab[data-selected],
.wallet-nav-titlebar-pill .wallet-nav-tab[aria-selected="true"],
.wallet-nav-bar-track .wallet-nav-tab[data-selected],
.wallet-nav-bar-track .wallet-nav-tab[aria-selected="true"] {{
  background-color: transparent;
  color: var(--hc-nav-selected-ink, var(--hc-text));
}}
.wallet-nav-titlebar-pill .wallet-nav-tab[data-selected] > svg,
.wallet-nav-titlebar-pill .wallet-nav-tab[aria-selected="true"] > svg,
.wallet-nav-bar-track .wallet-nav-tab[data-selected] > svg,
.wallet-nav-bar-track .wallet-nav-tab[aria-selected="true"] > svg {{
  color: inherit;
}}
/* Docked WalletActionBar slots inside the unified pill */
.wallet-action-bar.wallet-action-bar--nav {{
  display: flex;
  flex-direction: row;
  align-items: stretch;
  width: 100%;
}}
.wallet-action-slot {{
  display: flex;
  flex: 1 1 0;
  min-width: 0;
}}
.wallet-action-slot--neutral > .wallet-nav-tab {{
  background-color: var(--hc-nav-unselected);
  color: var(--hc-muted);
}}
.wallet-action-slot--primary[data-highlighted] > .wallet-nav-tab {{
  background-color: var(--hc-cta, var(--hc-accent));
  color: var(--hc-cta-ink, #060a08);
}}
.wallet-action-slot--danger[data-highlighted] > .wallet-nav-tab {{
  background-color: var(--hc-danger);
  color: #ffffff;
}}
.wallet-nav-action-badge {{
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  margin-left: 4px;
  border-radius: 999px;
  background: var(--hc-accent);
  color: #060a08;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}}
.app-shell {{
  width: 100%;
  height: 100%;
  max-height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}}
.stage {{
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}}
.dashboard {{
  flex: 1 1 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}}
.dashboard-main {{
  min-height: 0;
  height: 100%;
  overflow: visible;
  display: flex;
  flex-direction: column;
}}
/* Base default: desktop mode (top action bar active; bottom mobile action bar & mobile ticker strip hidden) */
.wallet-nav-bar {{
  display: none;
}}
.compact-only-ticker {{
  display: none;
}}
.dashboard-side {{
  min-height: 0;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}}
/* Compact/Mobile responsive layout (`<= 820px`, matching `css_scope.rs` COMPACT_MEDIA) */
@media (min-width: 821px) {{
  .wallet-nav-bar {{
    display: none !important;
  }}
  .compact-only-ticker {{
    display: none !important;
  }}
}}
@media (max-width: 820px) {{
  .stage {{
    padding: 8px 10px 10px !important;
  }}
  .dashboard {{
    display: flex !important;
    flex-direction: column !important;
    grid-template-columns: minmax(0, 1fr) !important;
    gap: 8px !important;
  }}
  .dashboard-main {{
    flex: 1 1 0 !important;
    min-height: 0 !important;
    width: 100% !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 8px !important;
  }}
  .dashboard-side {{
    display: none !important;
  }}
  .compact-only-ticker {{
    display: block !important;
    flex: 0 0 auto;
    width: 100%;
  }}
  .wallet-hero-main {{
    flex-direction: column !important;
    align-items: stretch !important;
    gap: 8px !important;
  }}
  .wallet-actions {{
    width: 100% !important;
    display: flex !important;
    flex-direction: row !important;
    gap: 8px !important;
  }}
  .wallet-actions .btn {{
    flex: 35 1 0 !important;
    min-height: 40px !important;
    padding: 8px 10px !important;
  }}
  .wallet-actions .btn.wallet-action--swap {{
    flex-grow: 30 !important;
  }}
  .wallet-nav-titlebar-tabs {{
    display: none !important;
  }}
  .wallet-nav-bar {{
    display: flex !important;
    flex: 0 0 auto;
    width: auto;
    margin: 0 8px 8px;
  }}
  .wallet-nav-bar-track {{
    display: flex;
    flex-direction: row;
    align-items: stretch;
    width: 100%;
    min-height: 40px;
    border-radius: 12px;
    overflow: hidden;
  }}
  .wallet-nav-bar-track .wallet-nav-tab {{
    flex: 1 1 0;
    min-width: 0;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 4px 2px;
    border: 0;
    font-size: 11px;
    font-weight: 600;
  }}
  .wallet-nav-bar-track .wallet-nav-tab-label,
  .wallet-nav-bar-track .wallet-nav-tab-label-short {{
    display: none;
  }}
  .wallet-nav-bar-track[data-permission] .wallet-nav-tab-label-short {{
    display: block;
    font-size: 9px;
    line-height: 1.1;
  }}
}}
/* Mobile compact ticker strip & attached coin selector inside `WhatIsBsvPanel` */
.what-is-bsv--compact {{
  padding: 10px 14px 8px !important;
  min-height: 0 !important;
  height: auto !important;
}}
.bsv-slide--compact {{
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 12px !important;
  width: 100%;
  cursor: pointer;
}}
.bsv-slide--compact > .bsv-asset-row {{
  flex: 0 0 auto;
}}
.bsv-spark--compact {{
  flex: 1 1 0;
  max-width: 168px;
  height: 24px !important;
  margin: 0 auto !important;
}}
.bsv-compact-quote {{
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}}
.bsv-compact-quote > .bsv-price {{
  font-size: var(--hc-text-lg);
  line-height: 1.15;
}}
.bsv-compact-quote > .bsv-change {{
  font-size: var(--hc-text-2xs);
  line-height: 1.15;
}}
.bsv-carousel-dots {{
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin-top: 6px;
}}
.bsv-carousel-dots > button {{
  appearance: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  border: 0;
  padding: 0;
  background: var(--hc-border);
  cursor: pointer;
  transition: width 140ms ease, background-color 140ms ease;
}}
.bsv-carousel-dots > button[aria-current="true"] {{
  width: 14px;
  background: var(--hc-accent);
}}
.wallet-hero {{
  position: relative;
  z-index: 20;
  overflow: visible;
}}
.wallet-hero[data-menu-open="true"] {{
  z-index: 80;
  overflow: visible;
}}
.wallet-hero > .wallet-hero-head.connected-panel-head {{
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  width: 100%;
  overflow: visible;
}}
.wallet-hero[data-menu-open="true"] > .wallet-hero-head.connected-panel-head {{
  z-index: 80;
  overflow: visible;
}}
.wallet-hero[data-menu-open="true"] .wallet-hero-main {{
  pointer-events: none;
}}
.wallet-hero-identity-chrome {{
  margin-left: auto;
  overflow: visible;
}}
.fiat-currency-menu,
.ticker-coin-selector {{
  position: relative;
  overflow: visible;
}}
.ticker-coin-trigger {{
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--hc-text);
  font-family: var(--hc-font);
  font-size: var(--hc-text-xs);
  font-weight: 650;
  letter-spacing: 0.04em;
  cursor: pointer;
}}
.ticker-coin-trigger-mark,
.ticker-coin-option-mark {{
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}}
.ticker-coin-option-balance {{
  margin-left: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  font-family: var(--hc-mono);
  font-size: 11px;
}}
.ticker-coin-option-balance strong {{
  color: var(--hc-text);
  font-weight: 600;
}}
.ticker-coin-option-balance span {{
  color: var(--hc-muted);
  font-size: 10px;
}}
.wallet-account-dropdown {{
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  left: auto;
  z-index: 100;
  max-height: 360px;
  overflow-y: auto;
}}
.wallet-account-dropdown.fiat-currency-menu-dropdown,
.wallet-account-dropdown.ticker-coin-dropdown {{
  left: 0;
  right: auto;
  width: 260px;
  min-width: 240px;
  max-height: 320px;
  overflow-y: auto;
  z-index: 100;
}}
.wallet-nav-shell,
.wallet-nav,
.wallet-nav-stage,
.wallet-nav-panel,
.nav-child-stage,
.nav-child-body,
.nav-section-with-scroll,
.history-embedded {{
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}}
.nav-section-scroll-body,
.settings-scroll-body,
.history-list {{
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}}
.dashboard-side > .history-panel {{
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}}
/* Keep HandCash `.btn` / `.activity-row` spacing & palette authoritative over generic aeon-ui defaults */
[data-aeon-scope="button"][data-aeon-part="root"].btn {{
  font-family: var(--hc-font);
  border-radius: var(--hc-radius);
  padding: 10px 16px;
  min-height: 40px;
  font-size: var(--hc-text-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
}}
[data-aeon-scope="button"][data-aeon-part="root"].btn.btn-primary {{
  background-color: var(--hc-cta, var(--hc-accent));
  color: var(--hc-cta-ink, #060a08);
  border-color: transparent;
}}
[data-aeon-scope="button"][data-aeon-part="root"].btn.btn-ghost {{
  background-color: var(--hc-surface-2);
  color: var(--hc-text);
  border: 1px solid var(--hc-border);
}}
.wallet-actions [data-aeon-scope="button"][data-aeon-part="root"].btn {{
  background-color: var(--wallet-nav-unselected);
  color: var(--hc-text);
  border: 1px solid var(--hc-border);
}}
.wallet-actions [data-aeon-scope="button"][data-aeon-part="root"].btn:hover:not([data-disabled]),
.wallet-actions [data-aeon-scope="button"][data-aeon-part="root"].btn[aria-pressed="true"] {{
  background-color: var(--wallet-nav-select);
  border-color: var(--hc-accent);
}}
[data-aeon-scope="button"][data-aeon-part="root"].btn.btn-ghost:hover:not([data-disabled]) {{
  background-color: var(--hc-hover);
  border-color: var(--hc-accent);
}}
[data-aeon-scope="listRow"][data-aeon-part="root"].activity-row {{
  border: 0;
  border-bottom: 1px solid var(--hc-border);
  border-radius: 0;
  background-color: transparent;
  padding: 10px 12px;
}}
/* Blitz/Taffy compatibility: replace `display: contents` with explicit flex layout so
   side-column activity rows and wallet-nav slots never collapse or disappear. */
.wallet-nav-slot {{
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
}}
.dashboard-side > .history-panel .history-row {{
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  width: 100%;
}}
.dashboard-side > .history-panel .history-row > .history-icon-wrap {{
  flex-shrink: 0;
}}
.dashboard-side > .history-panel .history-row > .history-body {{
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 0;
  gap: 2px;
}}
.dashboard-side > .history-panel .history-row > .history-amount-block {{
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex-shrink: 0;
  gap: 2px;
}}
.dashboard-side > .history-panel .history-row .history-title {{
  color: var(--hc-text);
  font-size: var(--hc-text-sm);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}}
.dashboard-side > .history-panel .history-row .history-amount {{
  color: var(--hc-text);
  font-size: var(--hc-text-sm);
  font-weight: 600;
  white-space: nowrap;
}}
.dashboard-side > .history-panel .history-row .history-when {{
  color: var(--hc-muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}}
/* Collectables / Items page toolbar, issuer groups, selection boxes & details showcase */
.collectables-toolbar {{
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
  flex-shrink: 0;
}}
.collectables-search-field {{
  margin-bottom: 0;
}}
.collectables-filter-pills {{
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}}
.collect-items-section {{
  display: flex;
  flex-direction: column;
  gap: 14px;
}}
.collect-issuer-group {{
  display: flex;
  flex-direction: column;
  gap: 8px;
}}
.collect-issuer-head {{
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 4px;
}}
.collect-issuer-copy {{
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}}
.collect-issuer-title {{
  color: var(--hc-text);
  font-size: var(--hc-text-sm);
  font-weight: 650;
}}
.collect-issuer-meta {{
  color: var(--hc-muted);
  font-size: 11px;
}}
.collect-issuer-select-btn {{
  appearance: none;
  border: 1px solid var(--hc-border);
  border-radius: 999px;
  background: var(--hc-surface-2);
  color: var(--hc-muted);
  padding: 2px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}}
.collect-issuer-select-btn:hover {{
  color: var(--hc-text);
  border-color: var(--hc-accent);
}}
.collectable-card-inner {{
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
}}
.collectable-row-inner {{
  display: flex;
  flex-direction: row;
  align-items: center;
  width: 100%;
  padding-left: 10px;
}}
.collectable-select-box {{
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 4;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1.5px solid var(--hc-border);
  background: rgba(0, 0, 0, 0.65);
  color: #060a08;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
}}
.collectable-select-box--row {{
  position: static;
  flex-shrink: 0;
}}
.collectable-select-box.is-selected {{
  background: var(--hc-accent);
  border-color: var(--hc-accent);
  color: #060a08;
}}
.collectable-card.is-selected,
.collectable-row.is-selected {{
  border-color: var(--hc-accent);
}}
.collectable-details-showcase {{
  display: flex;
  justify-content: center;
  margin-bottom: 12px;
}}
.collectable-details-media {{
  width: min(240px, 100%);
  max-height: 240px;
  aspect-ratio: 1 / 1;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius);
}}
.collectable-details-subrow {{
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
}}
.collectable-auth-pill {{
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 650;
  border: 1px solid var(--hc-border);
  background: var(--hc-surface-2);
  color: var(--hc-muted);
}}
.collectable-auth-pill[data-tone="brc150"] {{
  border-color: var(--hc-accent);
  color: var(--hc-accent);
  background: var(--hc-accent-dim);
}}
.collection-grid {{
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
  gap: 12px;
}}
.collection-grid-card {{
  list-style: none;
  background: var(--hc-surface-2);
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius);
  overflow: hidden;
}}
.collection-grid-main {{
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  width: 100%;
  padding: 10px;
  background: transparent;
  border: 0;
  color: var(--hc-text);
  text-align: left;
  cursor: pointer;
}}
.collectable-media {{
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1 / 1;
  min-height: 92px;
  border-radius: 8px;
  background: var(--hc-field);
  color: var(--hc-muted);
  overflow: hidden;
}}
.collectable-img {{
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 8px;
  display: block;
}}
.collectable-media.collectable-media-sm {{
  width: 44px;
  height: 44px;
  min-height: 44px;
  flex-shrink: 0;
}}
.collection-grid-name {{
  color: var(--hc-text);
  font-size: var(--hc-text-sm);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}}
.collection-grid-host {{
  color: var(--hc-muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}}
.connected-app-list {{
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}}
.connected-app-row {{
  list-style: none;
  background: var(--hc-surface-2);
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius);
}}
.connected-app-main {{
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  color: var(--hc-text);
  text-align: left;
  cursor: pointer;
}}
.connected-app-body {{
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 0;
  gap: 2px;
}}
.connected-app-name {{
  color: var(--hc-text);
  font-size: var(--hc-text-sm);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}}
.connected-app-host {{
  color: var(--hc-muted);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}}
{shell_gradients}
"#,
        bg = t.bg,
        surface = t.surface,
        surface_raised = t.surface_raised,
        border = t.border,
        text = t.text,
        muted = t.muted,
        accent = t.accent,
        accent_dim = t.accent_dim,
        danger = t.danger,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_and_titlebar_carry_brand_gradients() {
        let css = build_theme_override_css(&ResolvedTheme::dark_handcash());
        assert!(css.contains("> .titlebar.aeon-titlebar {\n  background-color: var(--hc-bg);\n  background-image: none;"));
        assert!(css.contains(".app-shell[data-aeon-scope=\"app\"] > .stage {\n  background-color: var(--hc-bg);"));
        assert_eq!(hex_to_rgb_channels("#0a3d22"), "10, 61, 34");
        assert_eq!(hex_to_rgb_channels("oops"), "87, 255, 151");
    }
}
