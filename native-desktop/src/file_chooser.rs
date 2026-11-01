//! WebKitGTK `<input type="file">` — wry does not wire `run-file-chooser`.
#![cfg(target_os = "linux")]

use gtk::prelude::*;
use webkit2gtk::{FileChooserRequestExt, WebViewExt};
use wry::WebViewExtUnix;

/// Attach an OS file dialog to the underlying WebKitGTK web view.
/// Returns true when the signal was connected.
pub fn attach(webview: &wry::WebView) -> bool {
    let wk = webview.webview();
    wk.connect_run_file_chooser(move |_view, request| {
        let request = request.clone();
        let multiple = request.selects_multiple();
        let dialog = gtk::FileChooserNative::new(
            Some("Open File"),
            None::<&gtk::Window>,
            gtk::FileChooserAction::Open,
            Some("_Open"),
            Some("_Cancel"),
        );
        dialog.set_select_multiple(multiple);
        if let Some(filter) = request.mime_types_filter() {
            dialog.add_filter(filter);
        }
        dialog.connect_response(move |dialog, response| {
            if response == gtk::ResponseType::Accept {
                let paths = dialog.filenames();
                let files: Vec<String> = paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                let refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
                request.select_files(&refs);
            } else {
                request.cancel();
            }
            dialog.destroy();
        });
        dialog.show();
        // We handled the request (dialog is async; select_files/cancel on response).
        true
    });
    true
}
