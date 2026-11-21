//! Clipboard text + image writes and WebView screenshot capture.
//!
//! Wayland note: prefer `wl-copy` when `WAYLAND_DISPLAY` is set because wl-copy
//! forks a daemon that serves the selection after the call returns. Fall back
//! to a process-long `arboard::Clipboard` handle on X11 / Windows / missing wl-copy.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::borrow::Cow;
use std::io::{Cursor, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;

pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

pub struct ClipboardState {
    /// Kept for the life of the process so Wayland/X11 paste clients can still
    /// fetch the last copy (arboard serves the selection while this lives).
    inner: Mutex<Option<arboard::Clipboard>>,
}

impl Default for ClipboardState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl ClipboardState {
    pub fn write_text(&self, text: &str) -> Result<(), String> {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() && wl_copy("text/plain;charset=utf-8", text.as_bytes()).is_ok() {
            return Ok(());
        }
        let mut slot = self
            .inner
            .lock()
            .map_err(|e| format!("clipboard lock: {e}"))?;
        if slot.is_none() {
            *slot = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
        }
        slot.as_mut()
            .expect("clipboard slot just set")
            .set_text(text.to_owned())
            .map_err(|e| e.to_string())
    }

    pub fn write_image_base64(&self, mime: &str, base64_data: &str) -> Result<(), String> {
        if !mime.to_ascii_lowercase().starts_with("image/") {
            return Err("Invalid image type".into());
        }
        if base64_data.is_empty() {
            return Err("Invalid image data".into());
        }
        let raw = B64
            .decode(base64_data.as_bytes())
            .map_err(|_| "Invalid image data".to_string())?;
        if raw.is_empty() || raw.len() > MAX_IMAGE_BYTES {
            return Err("Invalid image size".into());
        }
        let (width, height, rgba, png_bytes) = decode_image_to_rgba_and_png(mime, &raw)?;
        self.write_image_rgba_and_png(width, height, &rgba, png_bytes.as_deref())
    }

    pub fn write_image_rgba_and_png(
        &self,
        width: usize,
        height: usize,
        rgba: &[u8],
        png_bytes: Option<&[u8]>,
    ) -> Result<(), String> {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            if let Some(png) = png_bytes {
                if wl_copy("image/png", png).is_ok() {
                    return Ok(());
                }
            } else if let Ok(png) = encode_rgba_to_png(width as u32, height as u32, rgba) {
                if wl_copy("image/png", &png).is_ok() {
                    return Ok(());
                }
            }
        }
        let mut slot = self
            .inner
            .lock()
            .map_err(|e| format!("clipboard lock: {e}"))?;
        if slot.is_none() {
            *slot = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
        }
        let img = arboard::ImageData {
            width,
            height,
            bytes: Cow::Borrowed(rgba),
        };
        slot.as_mut()
            .expect("clipboard slot just set")
            .set_image(img)
            .map_err(|e| e.to_string())
    }
}

fn wl_copy(mime: &str, data: &[u8]) -> Result<(), String> {
    let mut child = Command::new("wl-copy")
        .arg("--type")
        .arg(mime)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("wl-copy: {e}"))?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "wl-copy: no stdin".to_string())?;
        stdin
            .write_all(data)
            .map_err(|e| format!("wl-copy write: {e}"))?;
    }
    let status = child.wait().map_err(|e| format!("wl-copy wait: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("wl-copy exited {status}"))
    }
}

type DecodedImage = (usize, usize, Vec<u8>, Option<Vec<u8>>);

fn decode_image_to_rgba_and_png(mime: &str, raw: &[u8]) -> Result<DecodedImage, String> {
    // Fast path: PNG bytes via `image` crate (works on both Windows and Linux).
    if let Ok(img) = image::load_from_memory_with_format(raw, image::ImageFormat::Png) {
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        return Ok((w as usize, h as usize, rgba.into_raw(), Some(raw.to_vec())));
    }

    // Linux fallback: GDK-Pixbuf decodes JPEG, WebP, GIF, BMP, SVG, etc.
    #[cfg(target_os = "linux")]
    {
        if let Ok((w, h, rgba, png)) = decode_with_gdk_pixbuf(raw) {
            return Ok((w, h, rgba, Some(png)));
        }
    }

    // Generic `image` fallback (supports whatever formats are enabled in `image`).
    if let Ok(img) = image::load_from_memory(raw) {
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        let raw_rgba = rgba.into_raw();
        let png = if mime.eq_ignore_ascii_case("image/png") {
            Some(raw.to_vec())
        } else {
            encode_rgba_to_png(w, h, &raw_rgba).ok()
        };
        return Ok((w as usize, h as usize, raw_rgba, png));
    }

    Err("Could not decode image".into())
}

#[cfg(target_os = "linux")]
fn decode_with_gdk_pixbuf(raw: &[u8]) -> Result<(usize, usize, Vec<u8>, Vec<u8>), String> {
    use gtk::gdk_pixbuf::prelude::*;
    use gtk::gdk_pixbuf::PixbufLoader;

    let loader = PixbufLoader::new();
    loader.write(raw).map_err(|e| e.to_string())?;
    loader.close().map_err(|e| e.to_string())?;
    let pb = loader
        .pixbuf()
        .ok_or_else(|| "empty pixbuf".to_string())?;
    let pb = if pb.has_alpha() {
        pb
    } else {
        pb.add_alpha(false, 0, 0, 0)
            .map_err(|_| "add_alpha failed".to_string())?
    };
    let w = pb.width() as usize;
    let h = pb.height() as usize;
    let rowstride = pb.rowstride() as usize;
    let src = unsafe { pb.pixels() };
    let mut rgba = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        let row = &src[y * rowstride..y * rowstride + w * 4];
        rgba.extend_from_slice(row);
    }
    let png = pb
        .save_to_bufferv("png", &[])
        .map_err(|e| e.to_string())?;
    Ok((w, h, rgba, png))
}

pub fn encode_rgba_to_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    image::write_buffer_with_format(
        &mut out,
        rgba,
        width,
        height,
        image::ColorType::Rgba8,
        image::ImageFormat::Png,
    )
    .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// Convert premultiplied ARGB32 (native little-endian BGRA) Cairo pixel rows into
/// straight RGBA8 bytes.
#[cfg(any(target_os = "linux", test))]
pub fn cairo_argb32_to_rgba(width: usize, height: usize, stride: usize, src: &[u8]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        let row = &src[y * stride..y * stride + width * 4];
        for px in row.as_chunks::<4>().0 {
            // On little-endian CPUs, Cairo ARGB32 is stored in memory as [B, G, R, A].
            let b = px[0];
            let g = px[1];
            let r = px[2];
            let a = px[3];
            if a == 0 {
                rgba.extend_from_slice(&[0, 0, 0, 0]);
            } else if a == 255 {
                rgba.extend_from_slice(&[r, g, b, 255]);
            } else {
                let alpha = a as u16;
                let ur = ((r as u16) * 255 / alpha).min(255) as u8;
                let ug = ((g as u16) * 255 / alpha).min(255) as u8;
                let ub = ((b as u16) * 255 / alpha).min(255) as u8;
                rgba.extend_from_slice(&[ur, ug, ub, a]);
            }
        }
    }
    rgba
}

/// Paint any Cairo `Surface` (X11, Wayland, or ImageSurface) into a fresh RGBA buffer
/// and optional scaled JPEG/PNG encoding.
#[cfg(target_os = "linux")]
pub fn cairo_surface_to_rgba(surface: &gtk::cairo::Surface) -> Result<(usize, usize, Vec<u8>), String> {
    use gtk::cairo::{Context, Format, ImageSurface};

    // Determine logical pixel extents via an image surface copy when possible.
    let (w, h) = if let Ok(img) = ImageSurface::try_from(surface.clone()) {
        (img.width(), img.height())
    } else {
        // Fallback: query clip extents after painting onto a recording-compatible path.
        // WebKitGTK snapshots are ImageSurfaces on GTK3/Wayland/X11; guard dimensions safely.
        return Err("unsupported snapshot surface".into());
    };
    if w <= 0 || h <= 0 {
        return Err("Capture was empty".into());
    }
    let mut img = ImageSurface::create(Format::ARgb32, w, h).map_err(|e| e.to_string())?;
    {
        let ctx = Context::new(&img).map_err(|e| e.to_string())?;
        ctx.set_source_surface(surface, 0.0, 0.0)
            .map_err(|e| e.to_string())?;
        ctx.paint().map_err(|e| e.to_string())?;
    }
    img.flush();
    let stride = img.stride() as usize;
    let data = img.data().map_err(|e| e.to_string())?;
    let rgba = cairo_argb32_to_rgba(w as usize, h as usize, stride, &data);
    Ok((w as usize, h as usize, rgba))
}

#[cfg(target_os = "linux")]
pub fn capture_webview_screenshot<F>(
    webview: &wry::WebView,
    clipboard: std::sync::Arc<ClipboardState>,
    app_version: String,
    on_done: F,
) where
    F: FnOnce(Result<(u64, String), String>) + 'static,
{
    use gtk::gio;
    use std::time::{SystemTime, UNIX_EPOCH};
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
    use wry::WebViewExtUnix;

    let wk = webview.webview();
    wk.snapshot(
        SnapshotRegion::Visible,
        SnapshotOptions::NONE,
        gio::Cancellable::NONE,
        move |res| {
            let outcome = (|| -> Result<(u64, String), String> {
                let surface = res.map_err(|e| e.to_string())?;
                let (w, h, rgba) = cairo_surface_to_rgba(&surface)?;
                let png = encode_rgba_to_png(w as u32, h as u32, &rgba)?;
                clipboard.write_image_rgba_and_png(w, h, &rgba, Some(&png))?;
                let at = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                Ok((at, app_version))
            })();
            on_done(outcome);
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_decodes_png_round_trip() {
        let rgba = vec![
            255, 0, 0, 255, // red
            0, 255, 0, 255, // green
            0, 0, 255, 255, // blue
            255, 255, 255, 128, // semi-transparent white
        ];
        let png = encode_rgba_to_png(2, 2, &rgba).expect("encode");
        let (w, h, decoded, out_png) =
            decode_image_to_rgba_and_png("image/png", &png).expect("decode");
        assert_eq!((w, h), (2, 2));
        assert_eq!(decoded, rgba);
        assert!(out_png.is_some());
    }

    #[test]
    fn converts_cairo_argb32_bgra_to_rgba() {
        // BGRA little-endian: B=10, G=20, R=30, A=255
        let src = [10u8, 20, 30, 255, 0, 0, 0, 0];
        let rgba = cairo_argb32_to_rgba(2, 1, 8, &src);
        assert_eq!(rgba, vec![30, 20, 10, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn rejects_invalid_image_inputs() {
        let cb = ClipboardState::default();
        assert!(cb.write_image_base64("text/plain", "AAAA").is_err());
        assert!(cb.write_image_base64("image/png", "").is_err());
        assert!(cb.write_image_base64("image/png", "not-valid-base64!!!").is_err());
    }
}
