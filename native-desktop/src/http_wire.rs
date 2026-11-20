//! Minimal HTTP/1.1 request parser and response writer over any `Read + Write`
//! stream (plain `TcpStream` or `rustls::StreamOwned`).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_HEADER_COUNT: usize = 128;

#[derive(Debug)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub enum ParseError {
    Eof,
    BadRequest(String),
    BodyTooLarge,
}

/// Read a single HTTP/1.1 request from `stream`, enforcing `max_body_bytes`.
pub fn read_http_request<R: Read>(
    stream: R,
    max_body_bytes: usize,
) -> Result<HttpRequest, ParseError> {
    let mut reader = BufReader::new(stream);
    let mut req_line = String::new();
    let n = reader
        .read_line(&mut req_line)
        .map_err(|e| ParseError::BadRequest(e.to_string()))?;
    if n == 0 {
        return Err(ParseError::Eof);
    }
    let req_line = req_line.trim_end_matches(['\r', '\n']);
    let mut parts = req_line.split_whitespace();
    let method = parts
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ParseError::BadRequest("missing method".into()))?
        .to_ascii_uppercase();
    let raw_target = parts
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ParseError::BadRequest("missing target".into()))?
        .to_string();
    let path = raw_target
        .split('?')
        .next()
        .unwrap_or(&raw_target)
        .to_string();

    let mut headers = HashMap::new();
    let mut header_bytes = req_line.len();
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|e| ParseError::BadRequest(e.to_string()))?;
        if read == 0 {
            break;
        }
        header_bytes += read;
        if header_bytes > MAX_HEADER_BYTES || headers.len() >= MAX_HEADER_COUNT {
            return Err(ParseError::BadRequest("headers too large".into()));
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim().to_string();
            headers.entry(key).or_insert(val);
        }
    }

    let is_chunked = headers
        .get("transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));

    let body = if is_chunked {
        read_chunked_body(&mut reader, max_body_bytes)?
    } else if let Some(cl_raw) = headers.get("content-length") {
        let len: usize = cl_raw
            .trim()
            .parse()
            .map_err(|_| ParseError::BadRequest("invalid content-length".into()))?;
        if len > max_body_bytes {
            return Err(ParseError::BodyTooLarge);
        }
        let mut buf = vec![0u8; len];
        reader
            .read_exact(&mut buf)
            .map_err(|e| ParseError::BadRequest(format!("incomplete body: {e}")))?;
        buf
    } else {
        Vec::new()
    };

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn read_chunked_body<R: BufRead>(
    reader: &mut R,
    max_body_bytes: usize,
) -> Result<Vec<u8>, ParseError> {
    let mut out = Vec::new();
    loop {
        let mut size_line = String::new();
        let n = reader
            .read_line(&mut size_line)
            .map_err(|e| ParseError::BadRequest(e.to_string()))?;
        if n == 0 {
            return Err(ParseError::BadRequest("unexpected EOF in chunked body".into()));
        }
        let hex_part = size_line
            .trim()
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        let chunk_len = usize::from_str_radix(hex_part, 16)
            .map_err(|_| ParseError::BadRequest("invalid chunk size".into()))?;
        if chunk_len == 0 {
            // Consume trailing headers/CRLF.
            let mut trailer = String::new();
            let _ = reader.read_line(&mut trailer);
            break;
        }
        if out.len().saturating_add(chunk_len) > max_body_bytes {
            return Err(ParseError::BodyTooLarge);
        }
        let start = out.len();
        out.resize(start + chunk_len, 0);
        reader
            .read_exact(&mut out[start..])
            .map_err(|e| ParseError::BadRequest(format!("incomplete chunk: {e}")))?;
        // Consume CRLF after chunk data.
        let mut crlf = [0u8; 2];
        let _ = reader.read_exact(&mut crlf);
    }
    Ok(out)
}

pub fn write_http_response<W: Write>(
    stream: &mut W,
    status: u16,
    content_type: &str,
    extra_headers: &[(&str, &str)],
    body: &[u8],
) -> std::io::Result<()> {
    let reason = reason_phrase(status);
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in extra_headers {
        head.push_str(k);
        head.push_str(": ");
        head.push_str(v);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    if !body.is_empty() {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_content_length_and_chunked_requests() {
        let raw = b"POST /createAction?x=1 HTTP/1.1\r\nHost: 127.0.0.1:3321\r\nOrigin: https://app.test\r\nContent-Length: 7\r\n\r\n{\"a\":1}";
        let req = read_http_request(Cursor::new(&raw[..]), 1024).unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/createAction");
        assert_eq!(req.headers.get("origin").map(String::as_str), Some("https://app.test"));
        assert_eq!(req.body, br#"{"a":1}"#);

        let chunked = b"POST /ping HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n";
        let req2 = read_http_request(Cursor::new(&chunked[..]), 1024).unwrap();
        assert_eq!(req2.body, b"hello");

        // Body too large rejected.
        let big = b"POST /big HTTP/1.1\r\nContent-Length: 500\r\n\r\n";
        assert!(matches!(
            read_http_request(Cursor::new(&big[..]), 100),
            Err(ParseError::BodyTooLarge)
        ));
    }
}
