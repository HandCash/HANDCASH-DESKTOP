//! Native Save dialogs for wallet backups (`saveBackupFile`) and images (`saveImageFile`).
//!
//! Parity with `electron/backupFile.ts` and `electron/main.ts`:
//! - Backup writes use atomic temp + fsync + rename + byte-for-byte readback verification.
//! - Disk-full errors return a clear user-facing message.
//! - Canceling the dialog writes nothing and returns `saved: false` / `canceled: true`.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BACKUP_BYTES: usize = 256 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

pub struct ParsedBackup {
    pub filename: String,
    pub bytes: Vec<u8>,
}

impl std::fmt::Debug for ParsedBackup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParsedBackup")
            .field("filename", &self.filename)
            .field("bytes_len", &self.bytes.len())
            .finish()
    }
}

pub struct ParsedImage {
    pub filename: String,
    pub ext: String,
    pub bytes: Vec<u8>,
}

impl std::fmt::Debug for ParsedImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParsedImage")
            .field("filename", &self.filename)
            .field("ext", &self.ext)
            .field("bytes_len", &self.bytes.len())
            .finish()
    }
}

pub fn parse_backup_params(params: &Value) -> Result<ParsedBackup, String> {
    let filename = params
        .get("filename")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Invalid backup payload".to_string())?;
    let bytes_b64 = params
        .get("bytesBase64")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Invalid backup payload".to_string())?;
    let bytes = B64
        .decode(bytes_b64.as_bytes())
        .map_err(|_| "Invalid backup payload".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_BACKUP_BYTES {
        return Err("Invalid backup payload".into());
    }
    Ok(ParsedBackup {
        filename: sanitize_filename(filename),
        bytes,
    })
}

pub fn parse_image_params(params: &Value) -> Result<ParsedImage, String> {
    let filename = params
        .get("filename")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Invalid filename".to_string())?;
    let mime = params
        .get("mime")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Invalid image type".to_string())?;
    if !mime.to_ascii_lowercase().starts_with("image/") {
        return Err("Invalid image type".into());
    }
    let base64_data = params
        .get("base64")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Invalid image data".to_string())?;
    let bytes = B64
        .decode(base64_data.as_bytes())
        .map_err(|_| "Invalid image data".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("Invalid image size".into());
    }
    let safe_name = sanitize_filename(filename);
    let ext = Path::new(&safe_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "png".to_string());
    Ok(ParsedImage {
        filename: safe_name,
        ext,
        bytes,
    })
}

fn sanitize_filename(name: &str) -> String {
    name.replace(['/', '\\'], "-")
}

/// Write a backup atomically and read it back byte-for-byte before reporting saved.
pub fn write_backup_verified(target: &Path, bytes: &[u8]) -> Value {
    match write_file_atomic(target, bytes, true) {
        Ok(()) => match fs::read(target) {
            Ok(written) if written == bytes => json!({
                "ok": true,
                "saved": true,
                "path": target.to_string_lossy(),
                "bytes": written.len(),
            }),
            Ok(_) => json!({
                "ok": false,
                "error": "The saved file did not match the backup. Save it again.",
            }),
            Err(e) => json!({
                "ok": false,
                "error": friendly_io_error(&e, "The backup could not be verified."),
            }),
        },
        Err(e) => json!({
            "ok": false,
            "error": friendly_io_error(&e, "The backup could not be saved."),
        }),
    }
}

pub fn write_image_to_path(target: &Path, bytes: &[u8]) -> Value {
    match write_file_atomic(target, bytes, false) {
        Ok(()) => json!({
            "ok": true,
            "path": target.to_string_lossy(),
        }),
        Err(e) => json!({
            "ok": false,
            "error": friendly_io_error(&e, "The image could not be saved."),
        }),
    }
}

fn write_file_atomic(target: &Path, bytes: &[u8], restrictive_mode: bool) -> std::io::Result<()> {
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid file path"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(".{file_name}.tmp-{}-{nonce}", std::process::id()));

    let write_res = (|| -> std::io::Result<()> {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        #[cfg(unix)]
        if restrictive_mode {
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        #[cfg(not(unix))]
        let _ = restrictive_mode;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    #[cfg(unix)]
    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

fn friendly_io_error(err: &std::io::Error, fallback: &str) -> String {
    if is_disk_full(err) {
        return "The disk is full. Nothing was saved.".into();
    }
    let msg = err.to_string();
    if msg.is_empty() {
        fallback.to_string()
    } else {
        msg
    }
}

fn is_disk_full(err: &std::io::Error) -> bool {
    if err.kind() == std::io::ErrorKind::StorageFull {
        return true;
    }
    match err.raw_os_error() {
        #[cfg(unix)]
        Some(28) => true, // ENOSPC
        #[cfg(windows)]
        Some(112) => true, // ERROR_DISK_FULL
        _ => false,
    }
}

/// Show a native Save dialog on Linux (async GTK `FileChooserNative`).
#[cfg(target_os = "linux")]
pub fn show_save_dialog<F>(title: &str, default_name: &str, filter_ext: Option<&str>, on_pick: F)
where
    F: FnOnce(Option<PathBuf>) + 'static,
{
    use gtk::prelude::*;

    let dialog = gtk::FileChooserNative::new(
        Some(title),
        None::<&gtk::Window>,
        gtk::FileChooserAction::Save,
        Some("_Save"),
        Some("_Cancel"),
    );
    dialog.set_do_overwrite_confirmation(true);
    dialog.set_current_name(default_name);
    if let Some(ext) = filter_ext {
        let img_filter = gtk::FileFilter::new();
        img_filter.set_name(Some(&format!("Image (*.{ext})")));
        img_filter.add_pattern(&format!("*.{ext}"));
        dialog.add_filter(img_filter);

        let all_filter = gtk::FileFilter::new();
        all_filter.set_name(Some("All files"));
        all_filter.add_pattern("*");
        dialog.add_filter(all_filter);
    }

    let cb = std::cell::RefCell::new(Some(on_pick));
    dialog.connect_response(move |dlg, resp| {
        let picked = if resp == gtk::ResponseType::Accept {
            dlg.filename()
        } else {
            None
        };
        dlg.destroy();
        if let Some(f) = cb.borrow_mut().take() {
            f(picked);
        }
    });
    dialog.show();
}

/// Show a native Save dialog on Windows via Win32 `GetSaveFileNameW`.
#[cfg(target_os = "windows")]
pub fn show_save_dialog<F>(title: &str, default_name: &str, filter_ext: Option<&str>, on_pick: F)
where
    F: FnOnce(Option<PathBuf>) + 'static,
{
    on_pick(win32_save_file_dialog(title, default_name, filter_ext));
}

#[cfg(target_os = "windows")]
fn win32_save_file_dialog(title: &str, default_name: &str, filter_ext: Option<&str>) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    #[repr(C)]
    #[allow(non_snake_case)]
    struct OpenFileNameW {
        lStructSize: u32,
        hwndOwner: isize,
        hInstance: isize,
        lpstrFilter: *const u16,
        lpstrCustomFilter: *mut u16,
        nMaxCustFilter: u32,
        nFilterIndex: u32,
        lpstrFile: *mut u16,
        nMaxFile: u32,
        lpstrFileTitle: *mut u16,
        nMaxFileTitle: u32,
        lpstrInitialDir: *const u16,
        lpstrTitle: *const u16,
        Flags: u32,
        nFileOffset: u16,
        nFileExtension: u16,
        lpstrDefExt: *const u16,
        lCustData: isize,
        lpfnHook: isize,
        lpTemplateName: *const u16,
        pvReserved: *mut core::ffi::c_void,
        dwReserved: u32,
        FlagsEx: u32,
    }

    #[link(name = "comdlg32")]
    extern "system" {
        fn GetSaveFileNameW(ofn: *mut OpenFileNameW) -> i32;
    }

    const OFN_OVERWRITEPROMPT: u32 = 0x0000_0002;
    const OFN_NOCHANGEDIR: u32 = 0x0000_0008;
    const OFN_PATHMUSTEXIST: u32 = 0x0000_0800;

    let mut file_buf = vec![0u16; 4096];
    let default_w: Vec<u16> = OsString::from(default_name).encode_wide().collect();
    let copy_len = default_w.len().min(file_buf.len() - 1);
    file_buf[..copy_len].copy_from_slice(&default_w[..copy_len]);

    let title_w: Vec<u16> = OsString::from(title)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let filter_str = match filter_ext {
        Some(ext) => format!("Image (*.{ext})\0*.{ext}\0All files (*.*)\0*.*\0\0"),
        None => "All files (*.*)\0*.*\0\0".to_string(),
    };
    let filter_w: Vec<u16> = filter_str.encode_utf16().collect();
    let def_ext_w: Option<Vec<u16>> = filter_ext.map(|ext| {
        OsString::from(ext)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    });

    let mut ofn = OpenFileNameW {
        lStructSize: std::mem::size_of::<OpenFileNameW>() as u32,
        hwndOwner: 0,
        hInstance: 0,
        lpstrFilter: filter_w.as_ptr(),
        lpstrCustomFilter: std::ptr::null_mut(),
        nMaxCustFilter: 0,
        nFilterIndex: 1,
        lpstrFile: file_buf.as_mut_ptr(),
        nMaxFile: file_buf.len() as u32,
        lpstrFileTitle: std::ptr::null_mut(),
        nMaxFileTitle: 0,
        lpstrInitialDir: std::ptr::null(),
        lpstrTitle: title_w.as_ptr(),
        Flags: OFN_OVERWRITEPROMPT | OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST,
        nFileOffset: 0,
        nFileExtension: 0,
        lpstrDefExt: def_ext_w
            .as_ref()
            .map(|v| v.as_ptr())
            .unwrap_or(std::ptr::null()),
        lCustData: 0,
        lpfnHook: 0,
        lpTemplateName: std::ptr::null(),
        pvReserved: std::ptr::null_mut(),
        dwReserved: 0,
        FlagsEx: 0,
    };

    let ok = unsafe { GetSaveFileNameW(&mut ofn) };
    if ok == 0 {
        return None;
    }
    let end = file_buf.iter().position(|&c| c == 0).unwrap_or(file_buf.len());
    Some(PathBuf::from(OsString::from_wide(&file_buf[..end])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_write_verifies_bytes_and_sanitizes_name() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-dialog-backup-{stamp}"));
        fs::create_dir_all(&dir).unwrap();

        let parsed = parse_backup_params(&json!({
            "filename": "dir/wallet\\backup.brc39",
            "bytesBase64": B64.encode(b"backup-contents-12345"),
        }))
        .expect("parse");
        assert_eq!(parsed.filename, "dir-wallet-backup.brc39");

        let target = dir.join(&parsed.filename);
        let res = write_backup_verified(&target, &parsed.bytes);
        assert_eq!(res["ok"], Value::Bool(true));
        assert_eq!(res["saved"], Value::Bool(true));
        assert_eq!(res["bytes"], json!(parsed.bytes.len()));
        assert_eq!(fs::read(&target).unwrap(), parsed.bytes);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn image_save_validates_mime_and_writes() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-dialog-img-{stamp}"));
        fs::create_dir_all(&dir).unwrap();

        assert!(parse_image_params(&json!({
            "filename": "pic.png",
            "mime": "text/html",
            "base64": B64.encode(b"nope"),
        }))
        .is_err());

        let parsed = parse_image_params(&json!({
            "filename": "art.png",
            "mime": "image/png",
            "base64": B64.encode(b"\x89PNG\r\n\x1a\n"),
        }))
        .expect("parse");
        assert_eq!(parsed.ext, "png");
        let target = dir.join(&parsed.filename);
        let res = write_image_to_path(&target, &parsed.bytes);
        assert_eq!(res["ok"], Value::Bool(true));
        assert_eq!(fs::read(&target).unwrap(), parsed.bytes);

        let _ = fs::remove_dir_all(dir);
    }
}
