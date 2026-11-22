// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Entrypoint for `handcash-native` (100% pure-Rust Dioxus Native + Aeon UI desktop app).

use dioxus_native::{LogicalSize, WindowAttributes};
use handcash_app::{AppServices, HandCashApp};
use std::any::Any;
use std::sync::Arc;

fn main() {
    let services = AppServices::open_default().expect("initialize HandCash services");
    services.start_bridge();

    let ctx_services = Arc::clone(&services);
    let contexts: Vec<Box<dyn Fn() -> Box<dyn Any> + Send + Sync>> = vec![Box::new(move || {
        Box::new(Arc::clone(&ctx_services)) as Box<dyn Any>
    })];

    let window = WindowAttributes::default()
        .with_title("HandCash")
        .with_inner_size(LogicalSize::new(1120.0_f64, 760.0_f64));

    dioxus_native::launch_cfg(HandCashApp, contexts, vec![Box::new(window)]);
}
