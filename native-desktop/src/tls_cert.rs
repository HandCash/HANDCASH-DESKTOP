//! Self-signed localhost X.509 v3 certificate generator & PEM persistence for the
//! local BRC-100 HTTPS bridge (`https://127.0.0.1:2121` & `https://[::1]:2121`).
//!
//! Pure Rust (ring P-256 + DER encoder + rustls): works identically on Linux
//! and Windows with zero OpenSSL or Node dependency.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
use rustls::ServerConfig;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct LocalTlsMaterial {
    pub cert_der: Vec<u8>,
    pub key_der: Vec<u8>,
    #[cfg(test)]
    pub cert_path: PathBuf,
}

/// Load a valid persisted localhost cert (containing the `::1` SAN) from
/// `<userData>/certs/server.{crt,key}`, or generate and persist a fresh P-256 cert.
pub fn load_or_create_cert(user_data_dir: &Path) -> Result<LocalTlsMaterial, String> {
    let cert_dir = user_data_dir.join("certs");
    let cert_path = cert_dir.join("server.crt");
    let key_path = cert_dir.join("server.key");

    if cert_path.is_file() && key_path.is_file() {
        if let (Ok(cert_pem), Ok(key_pem)) = (
            fs::read_to_string(&cert_path),
            fs::read_to_string(&key_path),
        ) {
            if let (Some(cert_der), Some(key_der)) =
                (parse_pem(&cert_pem, "CERTIFICATE"), parse_private_key_pem(&key_pem))
            {
                if cert_has_ipv6_loopback_san(&cert_der)
                    && build_server_config(&cert_der, &key_der).is_ok()
                {
                    return Ok(LocalTlsMaterial {
                        cert_der,
                        key_der,
                        #[cfg(test)]
                        cert_path,
                    });
                }
            }
        }
    }

    fs::create_dir_all(&cert_dir).map_err(|e| format!("create certs dir: {e}"))?;
    #[cfg(unix)]
    let _ = fs::set_permissions(&cert_dir, fs::Permissions::from_mode(0o700));

    let (cert_der, key_der) = generate_self_signed_p256()?;
    let cert_pem = encode_pem("CERTIFICATE", &cert_der);
    let key_pem = encode_pem("PRIVATE KEY", &key_der);

    fs::write(&cert_path, &cert_pem).map_err(|e| format!("write server.crt: {e}"))?;
    fs::write(&key_path, &key_pem).map_err(|e| format!("write server.key: {e}"))?;
    #[cfg(unix)]
    {
        let _ = fs::set_permissions(&cert_path, fs::Permissions::from_mode(0o600));
        let _ = fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600));
    }

    Ok(LocalTlsMaterial {
        cert_der,
        key_der,
        #[cfg(test)]
        cert_path,
    })
}

pub fn build_server_config(cert_der: &[u8], key_der: &[u8]) -> Result<Arc<ServerConfig>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cert = CertificateDer::from(cert_der.to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der.to_vec()));
    let cfg = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("tls protocol versions: {e}"))?
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .map_err(|e| format!("tls single cert: {e}"))?;
    Ok(Arc::new(cfg))
}

/// Checks whether the DER certificate carries an IPv6 loopback (`::1`) SAN entry
/// (context-specific primitive tag `0x87`, length `0x10`, 15 zero bytes + `0x01`).
pub fn cert_has_ipv6_loopback_san(cert_der: &[u8]) -> bool {
    const IPV6_LOOPBACK_SAN: [u8; 18] = [
        0x87, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ];
    cert_der
        .windows(IPV6_LOOPBACK_SAN.len())
        .any(|w| w == IPV6_LOOPBACK_SAN)
}

fn generate_self_signed_p256() -> Result<(Vec<u8>, Vec<u8>), String> {
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng)
        .map_err(|_| "failed to generate P-256 keypair".to_string())?;
    let key_pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng)
        .map_err(|_| "failed to load generated P-256 keypair".to_string())?;
    let pub_bytes = key_pair.public_key().as_ref();

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(1_700_000_000);
    let not_before = now_secs.saturating_sub(3600);
    let not_after = now_secs.saturating_add(2 * 365 * 86_400);

    // OIDs:
    // ecdsa-with-SHA256: 1.2.840.10045.4.3.2
    let oid_ecdsa_sha256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
    // id-ecPublicKey: 1.2.840.10045.2.1
    let oid_ec_pubkey = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
    // prime256v1 (secp256r1): 1.2.840.10045.3.1.7
    let oid_p256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

    let sig_alg = der_seq(&[der_oid(&oid_ecdsa_sha256)]);

    // Version v3 = [0] EXPLICIT INTEGER 2
    let version = der_explicit(0, &der_int_u64(2));
    // Positive serial number from current time + non-zero high byte guard.
    let serial = der_int_u64(now_secs | 1);

    // Subject / Issuer DN: CN=localhost, O=HandCash BRC100, OU=Desktop Wallet
    let dn = der_seq(&[
        der_rdn(&[0x55, 0x04, 0x03], "localhost"),
        der_rdn(&[0x55, 0x04, 0x0a], "HandCash BRC100"),
        der_rdn(&[0x55, 0x04, 0x0b], "Desktop Wallet"),
    ]);

    // Validity (UTCTime)
    let validity = der_seq(&[der_utctime(not_before), der_utctime(not_after)]);

    // SubjectPublicKeyInfo
    let spki_alg = der_seq(&[der_oid(&oid_ec_pubkey), der_oid(&oid_p256)]);
    let spki = der_seq(&[spki_alg, der_bit_string(pub_bytes, 0)]);

    // Extensions [3] EXPLICIT SEQUENCE OF Extension
    // 1. basicConstraints (2.5.29.19): CA=FALSE (empty SEQUENCE)
    let ext_bc = der_extension(&[0x55, 0x1d, 0x13], false, &der_seq(&[]));
    // 2. keyUsage (2.5.29.15): digitalSignature (bit 0 = 0x80, 7 unused bits)
    let ext_ku = der_extension(&[0x55, 0x1d, 0x0f], false, &der_bit_string(&[0x80], 7));
    // 3. extKeyUsage (2.5.29.37): serverAuth (1.3.6.1.5.5.7.3.1)
    let ext_eku = der_extension(
        &[0x55, 0x1d, 0x25],
        false,
        &der_seq(&[der_oid(&[0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01])]),
    );
    // 4. subjectAltName (2.5.29.17): DNS:localhost, IP:127.0.0.1, IP:::1
    let san_dns = der_tlv(0x82, b"localhost");
    let san_ipv4 = der_tlv(0x87, &[127, 0, 0, 1]);
    let san_ipv6 = der_tlv(
        0x87,
        &[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    );
    let ext_san = der_extension(
        &[0x55, 0x1d, 0x11],
        false,
        &der_seq(&[san_dns, san_ipv4, san_ipv6]),
    );

    let extensions = der_explicit(3, &der_seq(&[ext_bc, ext_ku, ext_eku, ext_san]));

    let tbs = der_seq(&[
        version,
        serial,
        sig_alg.clone(),
        dn.clone(),
        validity,
        dn,
        spki,
        extensions,
    ]);

    let sig = key_pair
        .sign(&rng, &tbs)
        .map_err(|_| "failed to sign self-signed cert".to_string())?;
    let cert_der = der_seq(&[tbs, sig_alg, der_bit_string(sig.as_ref(), 0)]);
    Ok((cert_der, pkcs8.as_ref().to_vec()))
}

fn der_tlv(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 6);
    out.push(tag);
    let len = body.len();
    if len < 128 {
        out.push(len as u8);
    } else if len <= 0xff {
        out.push(0x81);
        out.push(len as u8);
    } else if len <= 0xffff {
        out.push(0x82);
        out.push((len >> 8) as u8);
        out.push((len & 0xff) as u8);
    } else {
        out.push(0x83);
        out.push((len >> 16) as u8);
        out.push(((len >> 8) & 0xff) as u8);
        out.push((len & 0xff) as u8);
    }
    out.extend_from_slice(body);
    out
}

fn der_seq(items: &[Vec<u8>]) -> Vec<u8> {
    let mut body = Vec::new();
    for item in items {
        body.extend_from_slice(item);
    }
    der_tlv(0x30, &body)
}

fn der_set(items: &[Vec<u8>]) -> Vec<u8> {
    let mut body = Vec::new();
    for item in items {
        body.extend_from_slice(item);
    }
    der_tlv(0x31, &body)
}

fn der_explicit(tag_num: u8, inner: &[u8]) -> Vec<u8> {
    der_tlv(0xa0 | tag_num, inner)
}

fn der_oid(oid_bytes: &[u8]) -> Vec<u8> {
    der_tlv(0x06, oid_bytes)
}

fn der_int_u64(val: u64) -> Vec<u8> {
    let be = val.to_be_bytes();
    let first_non_zero = be.iter().position(|&b| b != 0).unwrap_or(7);
    let mut bytes = Vec::with_capacity(9);
    if be[first_non_zero] & 0x80 != 0 {
        bytes.push(0);
    }
    bytes.extend_from_slice(&be[first_non_zero..]);
    der_tlv(0x02, &bytes)
}

fn der_bit_string(data: &[u8], unused_bits: u8) -> Vec<u8> {
    let mut body = Vec::with_capacity(data.len() + 1);
    body.push(unused_bits);
    body.extend_from_slice(data);
    der_tlv(0x03, &body)
}

fn der_octet_string(data: &[u8]) -> Vec<u8> {
    der_tlv(0x04, data)
}

fn der_rdn(oid: &[u8], value: &str) -> Vec<u8> {
    der_set(&[der_seq(&[der_oid(oid), der_tlv(0x0c, value.as_bytes())])])
}

fn der_extension(oid: &[u8], critical: bool, value_der: &[u8]) -> Vec<u8> {
    let mut items = vec![der_oid(oid)];
    if critical {
        items.push(der_tlv(0x01, &[0xff]));
    }
    items.push(der_octet_string(value_der));
    der_seq(&items)
}

fn der_utctime(epoch_secs: u64) -> Vec<u8> {
    let days = (epoch_secs / 86_400) as i64;
    let sod = epoch_secs % 86_400;
    let h = sod / 3600;
    let m = (sod % 3600) / 60;
    let s = sod % 60;
    let (year, month, day) = civil_from_days(days);
    let yy = year.rem_euclid(100);
    let formatted = format!("{yy:02}{month:02}{day:02}{h:02}{m:02}{s:02}Z");
    der_tlv(0x17, formatted.as_bytes())
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m as u32, d as u32)
}

fn encode_pem(label: &str, der: &[u8]) -> String {
    let b64 = B64.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

fn parse_pem(pem: &str, label: &str) -> Option<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let start = pem.find(&begin)? + begin.len();
    let stop = pem[start..].find(&end)? + start;
    let body: String = pem[start..stop]
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    B64.decode(body.as_bytes()).ok()
}

fn parse_private_key_pem(pem: &str) -> Option<Vec<u8>> {
    parse_pem(pem, "PRIVATE KEY")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::{ClientConfig, ClientConnection, RootCertStore, ServerConnection};
    use rustls_pki_types::ServerName;

    #[test]
    fn generates_persists_and_handshakes_tls_for_localhost_ipv4_and_ipv6() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-tls-{stamp}"));

        let mat = load_or_create_cert(&dir).expect("create cert");
        assert!(mat.cert_path.is_file());
        assert!(cert_has_ipv6_loopback_san(&mat.cert_der));

        // Re-loading returns the persisted cert without regenerating.
        let mat2 = load_or_create_cert(&dir).expect("reload cert");
        assert_eq!(mat.cert_der, mat2.cert_der);

        let server_cfg = build_server_config(&mat.cert_der, &mat.key_der).expect("server cfg");
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(mat.cert_der.clone()))
            .expect("add root");
        let client_cfg = Arc::new(
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );

        for name in ["localhost", "127.0.0.1", "::1"] {
            let server_name = ServerName::try_from(name).unwrap().to_owned();
            let mut client = ClientConnection::new(Arc::clone(&client_cfg), server_name).unwrap();
            let mut server = ServerConnection::new(Arc::clone(&server_cfg)).unwrap();

            // Drive full in-memory TLS handshake.
            let mut buf = Vec::new();
            for _ in 0..16 {
                buf.clear();
                let _ = client.write_tls(&mut buf);
                if !buf.is_empty() {
                    let mut slice = &buf[..];
                    server.read_tls(&mut slice).unwrap();
                    server.process_new_packets().unwrap();
                }
                buf.clear();
                let _ = server.write_tls(&mut buf);
                if !buf.is_empty() {
                    let mut slice = &buf[..];
                    client.read_tls(&mut slice).unwrap();
                    client.process_new_packets().unwrap();
                }
                if !client.is_handshaking() && !server.is_handshaking() {
                    break;
                }
            }
            assert!(!client.is_handshaking(), "client handshake failed for {name}");
            assert!(!server.is_handshaking(), "server handshake failed for {name}");
        }

        let _ = fs::remove_dir_all(dir);
    }
}
