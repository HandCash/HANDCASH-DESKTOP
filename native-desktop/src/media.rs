//! WebKitGTK microphone and camera for calls and QR scanning. WebKitGTK ships
//! with media streams and WebRTC off and denies every unanswered permission
//! request, so `getUserMedia` fails until both are wired here.
#![cfg(target_os = "linux")]

use gtk::prelude::*;
use webkit2gtk::{
    DeviceInfoPermissionRequest, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
    WebViewExt,
};
use wry::WebViewExtUnix;

/// True when `uri` is a page of the app itself, not any other site the view reaches.
fn is_app_page(uri: &str, ui_origin: &str) -> bool {
    let origin = ui_origin.trim_end_matches('/');
    uri == origin
        || uri
            .strip_prefix(origin)
            .is_some_and(|rest| rest.starts_with('/') || rest.starts_with('?') || rest.starts_with('#'))
}

/// Turn on media capture and answer mic, camera and device-label requests for app pages only.
pub fn attach(webview: &wry::WebView, ui_origin: &str) {
    let wk = webview.webview();
    if let Some(settings) = WebViewExt::settings(&wk) {
        settings.set_enable_media_stream(true);
        settings.set_enable_mediasource(true);
        settings.set_enable_webrtc(true);
        settings.set_media_playback_requires_user_gesture(false);
    }
    let origin = ui_origin.to_string();
    wk.connect_permission_request(move |view, request| {
        let media = request.is::<UserMediaPermissionRequest>()
            || request.is::<DeviceInfoPermissionRequest>();
        if !media {
            return false;
        }
        let on_app = view.uri().is_some_and(|uri| is_app_page(uri.as_str(), &origin));
        if on_app {
            request.allow();
        } else {
            request.deny();
        }
        true
    });
}

#[cfg(test)]
mod tests {
    use super::is_app_page;

    #[test]
    fn only_the_app_origin_counts() {
        let o = "http://localhost:5173";
        assert!(is_app_page("http://localhost:5173", o));
        assert!(is_app_page("http://localhost:5173/#/wallet", o));
        assert!(is_app_page("http://localhost:5173/index.html", o));
        assert!(!is_app_page("http://localhost:51730/", o));
        assert!(!is_app_page("http://localhost:5173.evil.test/", o));
        assert!(!is_app_page("https://example.com/", o));
    }
}
