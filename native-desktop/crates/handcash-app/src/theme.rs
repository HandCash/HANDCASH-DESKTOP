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
    if snap.get("detected").and_then(|v| v.as_bool()) != Some(true) {
        return ResolvedTheme::default();
    }
    let Some(c) = snap.get("colors") else {
        return ResolvedTheme::default();
    };
    let get = |k: &str, fallback: &str| -> String {
        c.get(k)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback)
            .to_string()
    };
    let mode_str = get("mode", "dark");
    let mode = if mode_str == "light" {
        AeonMode::Light
    } else {
        AeonMode::Dark
    };
    let name = get("name", "Omarchy");
    let accent = get(
        "accent",
        if mode == AeonMode::Light {
            "#0a3d22"
        } else {
            "#57ff97"
        },
    );
    let green = get("green", &accent);
    let danger = get("red", "#f87171");
    let selection = get("selection", "#292e42");
    if mode == AeonMode::Light {
        let bg = get("background", "#fafbfa");
        let dark_bg = get("darkBackground", "#f3f5f3");
        ResolvedTheme {
            mode,
            omarchy_name: Some(name),
            bg,
            surface: "#ffffff".into(),
            surface_raised: dark_bg,
            border: selection.clone(),
            text: get("brightForeground", "#141814"),
            muted: get("lightForeground", "#4a524c"),
            accent_dim: format!("{accent}24"),
            accent,
            danger,
            green,
            selection,
        }
    } else {
        let bg = get("darkerBackground", "#000000");
        ResolvedTheme {
            mode,
            omarchy_name: Some(name),
            bg,
            surface: get("background", "#000000"),
            surface_raised: get("lighterBackground", "#0c0c0c"),
            border: selection.clone(),
            text: get("brightForeground", "#f4f4f5"),
            muted: get("lightForeground", "#a1a1aa"),
            accent_dim: format!("{accent}2e"),
            accent,
            danger,
            green,
            selection,
        }
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

/// Brand glow for the app shell background and embossed sheen for the top bar,
/// matching `src/styles/handcash.css` (`body` `--hc-glow` and `.titlebar.aeon-titlebar`).
fn shell_gradient_css(t: &ResolvedTheme) -> String {
    let brand = hex_to_rgb_channels(&t.green);
    let (top, corner) = if t.mode == AeonMode::Light {
        (0.08, 0.04)
    } else {
        (0.11, 0.06)
    };
    format!(
        r#"
.app-shell[data-aeon-scope="app"] {{
  background-color: var(--hc-bg);
  background-image: radial-gradient(ellipse 72% 48% at 50% -18%, rgba({brand}, {top}), transparent 58%), radial-gradient(ellipse 46% 34% at 92% 104%, rgba({brand}, {corner}), transparent 52%);
}}
.app-shell[data-aeon-scope="app"] > .stage {{
  background-color: transparent;
  background-image: none;
}}
.app-shell[data-aeon-scope="app"] > .titlebar.aeon-titlebar {{
  background-color: var(--hc-bg);
  background-image: linear-gradient(180deg, rgba(255, 255, 255, 0.09), transparent 45%, rgba(0, 0, 0, 0.12));
}}
"#
    )
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
  --hc-field: color-mix(in srgb, {surface} 82%, #000000);
  --hc-deep: {bg};
  --hc-glow: radial-gradient(ellipse 72% 48% at 50% -18%, rgba(87, 255, 151, 0.11), transparent 58%), radial-gradient(ellipse 46% 34% at 92% 104%, rgba(56, 203, 123, 0.06), transparent 52%), {bg};
  --hc-nav-select: color-mix(in srgb, var(--hc-text, #f4f4f5) 14%, #000000);
  --hc-nav-unselected: color-mix(in srgb, var(--hc-bg, #000000) 88%, var(--hc-text, #f4f4f5));
  --hc-nav-chrome: var(--hc-nav-select);
  --wallet-nav-select: var(--hc-nav-select);
  --wallet-nav-unselected: var(--hc-nav-unselected);
  --wallet-nav-pill-radius: 999px;
  --hc-sunken-soft: rgba(0, 0, 0, 0.22);
  --hc-sunken: rgba(0, 0, 0, 0.28);
  --hc-sunken-strong: rgba(0, 0, 0, 0.38);
  --hc-hover: rgba(255, 255, 255, 0.045);
"#,
        surface = t.surface,
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
  --hc-nav-select: color-mix(in srgb, var(--hc-text, #141814) 7%, #eef1ef);
  --hc-nav-unselected: #ffffff;
  --hc-nav-chrome: var(--hc-nav-select);
  --wallet-nav-select: var(--hc-nav-select);
  --wallet-nav-unselected: var(--hc-nav-unselected);
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
  --hc-accent-dim: color-mix(in srgb, var(--hc-accent-deep) 14%, transparent);
  --hc-success: var(--hc-accent-deep);
  --hc-warn: #9a6700;
  --hc-error: #b91c1c;
  --hc-down: #dc2626;
  --hc-fail: #dc2626;
  --hc-shadow: 0 16px 36px -14px rgba(20, 24, 20, 0.1);
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
/* Authentic pill sheen, bevel & inverted selector track effects matching TS handcash.css */
.wallet-nav-titlebar-pill,
.wallet-nav-actions-pill,
.status-pill {{
  background-image: linear-gradient(180deg, rgba(255, 255, 255, 0.09), transparent 48%, rgba(0, 0, 0, 0.14));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}}
.wallet-nav-titlebar-pill .wallet-nav-tab[data-selected],
.wallet-nav-titlebar-pill .wallet-nav-tab[aria-selected="true"] {{
  background: transparent;
  color: var(--hc-text);
}}
.panel.wallet-hero {{
  background-image: radial-gradient(ellipse 80% 70% at 25% 0%, rgba(87, 255, 151, 0.06), transparent 62%), linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 42%);
}}
.panel.what-is-bsv {{
  background-image: radial-gradient(ellipse 90% 60% at 80% 0%, rgba(234, 179, 0, 0.06), transparent 58%), linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent 45%);
}}
/* Keep compact/narrow windows clean: stack main above side and hide duplicate side activity. */
@media (max-width: 860px) {{
  .dashboard {{
    display: flex;
    flex-direction: column;
    gap: 8px;
  }}
  .dashboard-main {{
    flex: 1 1 0;
    min-height: 0;
  }}
  .dashboard-side {{
    flex: 0 0 auto;
    height: auto;
  }}
  .dashboard-side > .history-panel {{
    display: none;
  }}
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
.dashboard-side {{
  min-height: 0;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
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
  justify-content: space-between;
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
.fiat-currency-menu {{
  overflow: visible;
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
.wallet-account-dropdown.fiat-currency-menu-dropdown {{
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
  background-color: transparent;
  color: var(--hc-text);
  border: 1px solid var(--hc-border);
}}
[data-aeon-scope="button"][data-aeon-part="root"].btn.btn-ghost:hover:not([data-disabled]) {{
  background-color: var(--hc-hover);
  border-color: var(--hc-accent);
}}
[data-aeon-scope="listRow"][data-aeon-part="root"].activity-row {{
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--hc-border) 55%, transparent);
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
        assert!(css.contains("> .titlebar.aeon-titlebar {\n  background-color: var(--hc-bg);\n  background-image: linear-gradient("));
        assert!(css.contains("rgba(87, 255, 151, 0.11)"));
        assert_eq!(hex_to_rgb_channels("#0a3d22"), "10, 61, 34");
        assert_eq!(hex_to_rgb_channels("oops"), "87, 255, 151");
    }
}
