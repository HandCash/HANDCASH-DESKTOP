// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Side-by-side entrypoint for `handcash-aeon`: the same `HandCashApp` component tree
//! as `handcash-native`, rendered by aeon-native (Taffy + Parley + Vello, no Blitz/Stylo).
//!
//! Blitz (`handcash-native`) remains the default, packaged renderer. This binary is
//! opt-in for parity work: `cargo run -p handcash-app --features aeon --bin handcash-aeon`.
//! The workspace development patch supplies the CSS-capable upstream candidate.
//! Parser success is not screen parity; Blitz stays default until native review passes.

use dioxus::prelude::VirtualDom;
use handcash_app::{AppServices, HandCashApp};
use std::io::Write;
use std::sync::Arc;

fn install_crash_log() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let dir = std::env::var_os("XDG_STATE_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/state")))
            .map(|base| base.join("handcash"));
        if let Some(dir) = dir {
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("handcash-aeon-crash.log"))
            {
                let _ = writeln!(file, "{info}\n{}", std::backtrace::Backtrace::force_capture());
            }
        }
        default_hook(info);
    }));
}

fn main() {
    install_crash_log();
    let services = AppServices::open_default().expect("initialize HandCash services");
    services.start_bridge();

    let dom = VirtualDom::new(HandCashApp);
    dom.provide_root_context(Arc::clone(&services));

    aeon_native::run_virtual_dom(
        dom,
        aeon_native::AeonAppConfig {
            title: "HandCash (aeon-native)".to_string(),
            width: 1120.0,
            height: 760.0,
            ..Default::default()
        },
    );
}
