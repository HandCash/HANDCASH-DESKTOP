// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Platform-neutral pure-Rust Bitcoin transaction, block header PoW, BUMP SPV,
//! BEEF/AtomicBEEF, 1Sat `ord` inscription, and BRC-150 provenance engine.

pub mod beef;
pub mod brc150;
pub mod bump;
pub mod header;
pub mod ord;
pub mod recover;
pub mod signer;
pub mod tx;

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BitcoinError {
    UnexpectedEof,
    InvalidVarint,
    InvalidMagic(String),
    InvalidHex(String),
    InvalidHeader(String),
    InvalidBump(String),
    SpvFailed(String),
    TrailingBytes(usize),
}

impl fmt::Display for BitcoinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnexpectedEof => write!(f, "unexpected end of binary input"),
            Self::InvalidVarint => write!(f, "invalid compact-size varint"),
            Self::InvalidMagic(m) => write!(f, "unsupported binary magic: {m}"),
            Self::InvalidHex(m) => write!(f, "invalid hex: {m}"),
            Self::InvalidHeader(m) => write!(f, "invalid block header: {m}"),
            Self::InvalidBump(m) => write!(f, "invalid BUMP merkle path: {m}"),
            Self::SpvFailed(m) => write!(f, "SPV verification failed: {m}"),
            Self::TrailingBytes(n) => write!(f, "{n} unexpected trailing byte(s)"),
        }
    }
}

impl std::error::Error for BitcoinError {}

/// Safe bounds-checked binary reader for Bitcoin wire formats.
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub fn position(&self) -> usize {
        self.pos
    }

    pub fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    pub fn read_u8(&mut self) -> Result<u8, BitcoinError> {
        if self.pos >= self.buf.len() {
            return Err(BitcoinError::UnexpectedEof);
        }
        let b = self.buf[self.pos];
        self.pos += 1;
        Ok(b)
    }

    pub fn read_exact<const N: usize>(&mut self) -> Result<[u8; N], BitcoinError> {
        if self.remaining() < N {
            return Err(BitcoinError::UnexpectedEof);
        }
        let mut out = [0u8; N];
        out.copy_from_slice(&self.buf[self.pos..self.pos + N]);
        self.pos += N;
        Ok(out)
    }

    pub fn read_slice(&mut self, len: usize) -> Result<&'a [u8], BitcoinError> {
        if self.remaining() < len {
            return Err(BitcoinError::UnexpectedEof);
        }
        let slice = &self.buf[self.pos..self.pos + len];
        self.pos += len;
        Ok(slice)
    }

    pub fn read_u32_le(&mut self) -> Result<u32, BitcoinError> {
        Ok(u32::from_le_bytes(self.read_exact::<4>()?))
    }

    pub fn read_u64_le(&mut self) -> Result<u64, BitcoinError> {
        Ok(u64::from_le_bytes(self.read_exact::<8>()?))
    }

    pub fn read_varint(&mut self) -> Result<u64, BitcoinError> {
        let first = self.read_u8()?;
        match first {
            0x00..=0xfc => Ok(first as u64),
            0xfd => {
                let b = self.read_exact::<2>()?;
                Ok(u16::from_le_bytes(b) as u64)
            }
            0xfe => Ok(self.read_u32_le()? as u64),
            0xff => self.read_u64_le(),
        }
    }

    pub fn read_varbytes(&mut self) -> Result<&'a [u8], BitcoinError> {
        let len_u64 = self.read_varint()?;
        let len = usize::try_from(len_u64).map_err(|_| BitcoinError::InvalidVarint)?;
        self.read_slice(len)
    }
}

pub fn write_varint(out: &mut Vec<u8>, value: u64) {
    if value < 0xfd {
        out.push(value as u8);
    } else if value <= 0xffff {
        out.push(0xfd);
        out.extend_from_slice(&(value as u16).to_le_bytes());
    } else if value <= 0xffff_ffff {
        out.push(0xfe);
        out.extend_from_slice(&(value as u32).to_le_bytes());
    } else {
        out.push(0xff);
        out.extend_from_slice(&value.to_le_bytes());
    }
}

pub fn reverse_32(mut bytes: [u8; 32]) -> [u8; 32] {
    bytes.reverse();
    bytes
}
