use dioxus::prelude::*;
use handcash_app::icons::ChainMark;

#[test]
fn balance_symbols_have_paths_without_disc_backplates() {
    for coin in ["btc", "bch", "ltc", "doge", "arc-usd"] {
        let html = dioxus_ssr::render_element(rsx! {
            ChainMark { coin: coin, size: 22, symbol_only: true }
        });
        assert!(html.contains("chain-mark-glyph"), "{coin}: {html}");
        assert!(!html.contains("<circle"), "{coin}: {html}");
        assert!(!html.contains("#ffffff"), "{coin}: {html}");
    }
}

#[test]
fn ticker_marks_keep_their_disc_backplates() {
    let html = dioxus_ssr::render_element(rsx! {
        ChainMark { coin: "btc", size: 22 }
    });
    assert!(html.contains("<circle"));
    assert!(html.contains("#ffffff"));
}
