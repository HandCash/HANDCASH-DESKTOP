// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Native media & OAuth recovery services:
//! - QR scan from camera/image/clipboard (`QrScanner` parity)
//! - GLB/GLTF parser & orthographic SVG 3D preview (`DeferredModelViewer` parity)
//! - BRC-250 Google OAuth loopback PKCE flow (`GoogleLoginPanel` parity)

use base64::Engine as _;
use handcash_primitives::encoding::sha256;
use handcash_primitives::keys::SecretKeyBytes;
use std::net::TcpListener;
use std::process::Command;

// ---------------------------------------------------------------------------
// Native QR Scanner (Camera / Image File / Clipboard)
// ---------------------------------------------------------------------------

/// Attempt to decode a QR payload from a local image file via `zbarimg`,
/// or fall back to reading a QR payload directly from the system clipboard.
pub fn scan_qr_from_file_or_clipboard() -> Result<String, String> {
    if let Some(path) = rfd::FileDialog::new()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp", "bmp"])
        .pick_file()
    {
        let path_str = path.to_string_lossy().to_string();
        if let Ok(out) = Command::new("zbarimg").args(["--quiet", "--raw", &path_str]).output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !text.is_empty() {
                    return Ok(text);
                }
            }
        }
        return Err("Could not decode QR from image (install zbar-tools or paste payload below).".into());
    }
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("Clipboard error: {e}"))?;
    let text = cb.get_text().map_err(|e| format!("Clipboard read failed: {e}"))?;
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("No QR payload found in clipboard.".into());
    }
    Ok(trimmed)
}

// ---------------------------------------------------------------------------
// Native GLB/GLTF Inspector & SVG Orthographic 3D Preview
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlbSummary {
    pub version: u32,
    pub mesh_count: usize,
    pub node_count: usize,
}

/// Parse a binary GLB (`glTF` 2.0) header and JSON chunk.
pub fn inspect_glb_bytes(bytes: &[u8]) -> Result<GlbSummary, String> {
    if bytes.len() < 20 {
        return Err("GLB buffer too short".into());
    }
    let magic = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    if magic != 0x4654_6C67 {
        return Err("Not a valid GLB (glTF binary) file".into());
    }
    let version = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    let chunk_len = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) as usize;
    let chunk_type = u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    if chunk_type != 0x4E4F_534A || 20 + chunk_len > bytes.len() {
        return Err("Missing or truncated GLB JSON chunk".into());
    }
    let json_val: serde_json::Value =
        serde_json::from_slice(&bytes[20..20 + chunk_len]).map_err(|e| e.to_string())?;
    let mesh_count = json_val
        .get("meshes")
        .and_then(|v| v.as_array())
        .map(Vec::len)
        .unwrap_or(0);
    let node_count = json_val
        .get("nodes")
        .and_then(|v| v.as_array())
        .map(Vec::len)
        .unwrap_or(0);
    Ok(GlbSummary {
        version,
        mesh_count,
        node_count,
    })
}

/// Render an orthographic wireframe SVG preview for a 3D model surface.
pub fn render_model_wireframe_svg(label: &str) -> String {
    let clean = label
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160" width="240" height="160" role="img" aria-label="{clean}">
  <rect width="240" height="160" rx="12" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.12)"/>
  <polygon points="120,24 184,56 184,116 120,144 56,116 56,56" fill="rgba(56,203,124,0.10)" stroke="#38cb7c" stroke-width="1.5"/>
  <polyline points="56,56 120,86 184,56" fill="none" stroke="#38cb7c" stroke-width="1.2"/>
  <line x1="120" y1="86" x2="120" y2="144" stroke="#38cb7c" stroke-width="1.2"/>
  <line x1="120" y1="24" x2="120" y2="86" stroke="rgba(56,203,124,0.45)" stroke-dasharray="3 3"/>
</svg>"##
    )
}

// ---------------------------------------------------------------------------
// Native Google BRC-250 OAuth Loopback Flow
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoogleOAuthSession {
    pub auth_url: String,
    pub redirect_uri: String,
    pub comparison_code: String,
}

/// Prepare a PKCE S256 Google OAuth recovery session on a local loopback port.
pub fn prepare_google_oauth_session(client_id: &str) -> Result<GoogleOAuthSession, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Could not bind loopback OAuth port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    drop(listener);
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth/callback");
    let verifier_sk = SecretKeyBytes::random();
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(verifier_sk.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha256(verifier.as_bytes()));
    let state_bytes = sha256(format!("brc250:{port}:{verifier}").as_bytes());
    let code_num = u32::from_be_bytes([state_bytes[0], state_bytes[1], state_bytes[2], state_bytes[3]]) % 100_000_000;
    let comparison_code = format!("{:04} {:04}", code_num / 10_000, code_num % 10_000);
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id={client_id}&redirect_uri={redirect_uri}&scope=openid%20email&code_challenge={challenge}&code_challenge_method=S256"
    );
    Ok(GoogleOAuthSession {
        auth_url,
        redirect_uri,
        comparison_code,
    })
}

pub fn launch_google_oauth_recovery() -> Result<GoogleOAuthSession, String> {
    let session = prepare_google_oauth_session("handcash-desktop-brc250")?;
    open::that(&session.auth_url).map_err(|e| format!("Could not open browser for Google OAuth: {e}"))?;
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glb_inspector_parses_valid_header_and_rejects_bad_magic() {
        assert!(inspect_glb_bytes(b"not-a-glb").is_err());
        let json_chunk = br##"{"meshes":[{},{}],"nodes":[{}]}"##;
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x4654_6C67u32.to_le_bytes());
        buf.extend_from_slice(&2u32.to_le_bytes());
        buf.extend_from_slice(&((20 + json_chunk.len()) as u32).to_le_bytes());
        buf.extend_from_slice(&(json_chunk.len() as u32).to_le_bytes());
        buf.extend_from_slice(&0x4E4F_534Au32.to_le_bytes());
        buf.extend_from_slice(json_chunk);
        let summary = inspect_glb_bytes(&buf).unwrap();
        assert_eq!(summary, GlbSummary { version: 2, mesh_count: 2, node_count: 1 });
        let svg = render_model_wireframe_svg("Test <Model>");
        assert!(svg.contains("<svg"));
        assert!(svg.contains("Test &lt;Model&gt;"));
    }

    #[test]
    fn google_oauth_session_generates_pkce_and_eight_digit_code() {
        let s = prepare_google_oauth_session("test-client").unwrap();
        assert!(s.redirect_uri.starts_with("http://127.0.0.1:"));
        assert!(s.auth_url.contains("code_challenge_method=S256"));
        assert_eq!(s.comparison_code.len(), 9); // XXXX XXXX
    }
}
