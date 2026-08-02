/**
 * Device-link pairing (Telegram-style) — shared wire format with HANDCASH-MOBILE.
 * Either device can show or scan; payload is embedded in the QR (no LAN required).
 *
 * v2 — single QR with encrypted root-key package (legacy / tiny payloads)
 * v3 — flashing multi-QR frames carrying root key + BRC-39 history
 */

export const PAIRING_QR_PREFIX = 'handcash-link:'
export const PAIRING_QR_V3_PREFIX = 'handcash-link3:'

/** ~700 raw bytes/chunk → scannable QR density on phone cameras. */
const FRAME_CHUNK_BYTES = 700
/** Frames per second while flashing. */
/** Slower flash = more reliable phone scans of dense frames. */
export const LINK_FLASH_FPS = 3

/** v2 — encrypted package embedded in QR (preferred when it fits one code). */
export type PairingOfferV2 = {
  v: 2
  keyHex: string
  ivHex: string
  ciphertextHex: string
  expiresAt: number
  handle?: string
}

/** v1 — LAN host (legacy Desktop). Still accepted when scanning. */
export type PairingOfferV1 = {
  v: 1
  baseUrl: string
  sessionId: string
  keyHex: string
  expiresAt: number
  handle?: string
}

export type PairingOffer = PairingOfferV2 | PairingOfferV1

export type PairingPackage = {
  /** 1 = keys only; 2 = keys + BRC-39 history blob */
  v: 1 | 2
  rootKeyHex: string
  handle: string
  identityKey: string
  address: string
  chain: 'main' | 'test'
  historyBackupBaseUrl: string
  createdAt: number
  /** Raw BRC-39 bytes (base64). Present when v >= 2. */
  brc39Base64?: string
  /** Password that decrypts brc39 (source device). Same trust window as root key. */
  brc39Password?: string
}

export type LinkFlashSession = {
  sid: string
  frames: string[]
  expiresAt: number
  handle?: string
  frameCount: number
  hasHistory: boolean
}

export type LinkAssembleProgress = {
  sid: string
  have: number
  total: number
  complete: boolean
}

function toBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function randomKeyHex(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes))
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** URL-safe base64 without padding (shorter QR payloads). */
function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  return base64ToBytes(padded + pad)
}

export async function encryptPairingPackage(
  pkg: PairingPackage,
  keyHex: string,
): Promise<{ ivHex: string; ciphertextHex: string }> {
  const keyBytes = hexToBytes(keyHex)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', toBuf(keyBytes), 'AES-GCM', false, [
    'encrypt',
  ])
  const plain = new TextEncoder().encode(JSON.stringify(pkg))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)
  return {
    ivHex: bytesToHex(iv),
    ciphertextHex: bytesToHex(new Uint8Array(cipher)),
  }
}

export async function decryptPairingPackage(
  ivHex: string,
  ciphertextHex: string,
  keyHex: string,
): Promise<PairingPackage> {
  const key = await crypto.subtle.importKey(
    'raw',
    toBuf(hexToBytes(keyHex)),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuf(hexToBytes(ivHex)) },
    key,
    toBuf(hexToBytes(ciphertextHex)),
  )
  const pkg = JSON.parse(new TextDecoder().decode(plain)) as PairingPackage
  if ((pkg.v !== 1 && pkg.v !== 2) || !pkg.rootKeyHex) throw new Error('Invalid pairing package')
  return pkg
}

export function encodePairingQr(offer: PairingOffer): string {
  return `${PAIRING_QR_PREFIX}${btoa(JSON.stringify(offer))}`
}

export function decodePairingQr(raw: string): PairingOffer {
  const text = raw.trim()
  if (!text.startsWith(PAIRING_QR_PREFIX)) throw new Error('Not a HandCash link QR')
  const offer = JSON.parse(atob(text.slice(PAIRING_QR_PREFIX.length))) as PairingOffer
  if (offer.expiresAt < Date.now()) throw new Error('Link QR expired — generate a new one')
  if (offer.v === 2) {
    if (!offer.keyHex || !offer.ivHex || !offer.ciphertextHex) {
      throw new Error('Invalid link payload')
    }
    return offer
  }
  if (offer.v === 1) {
    if (!offer.baseUrl || !offer.sessionId || !offer.keyHex) {
      throw new Error('Invalid link payload')
    }
    return offer
  }
  throw new Error('Unsupported link version')
}

/** Build a bidirectional show-QR offer (embedded ciphertext). */
export async function createEmbeddedPairingOffer(
  pkg: PairingPackage,
  ttlMs = 120_000,
): Promise<{ offer: PairingOfferV2; qrText: string }> {
  const keyHex = randomKeyHex(32)
  const enc = await encryptPairingPackage(pkg, keyHex)
  const offer: PairingOfferV2 = {
    v: 2,
    keyHex,
    ivHex: enc.ivHex,
    ciphertextHex: enc.ciphertextHex,
    expiresAt: Date.now() + ttlMs,
    handle: pkg.handle || undefined,
  }
  return { offer, qrText: encodePairingQr(offer) }
}

/**
 * Encrypt package and split into flashing v3 QR frames.
 * Frame 0 carries key + iv; remaining frames carry ciphertext chunks.
 */
export async function createLinkFlashSession(
  pkg: PairingPackage,
  ttlMs = 180_000,
): Promise<LinkFlashSession> {
  const keyHex = randomKeyHex(32)
  const enc = await encryptPairingPackage(pkg, keyHex)
  const sid = randomKeyHex(4)
  const expiresAt = Date.now() + ttlMs
  const cipherBytes = hexToBytes(enc.ciphertextHex)

  const chunks: Uint8Array[] = []
  for (let off = 0; off < cipherBytes.length; off += FRAME_CHUNK_BYTES) {
    chunks.push(cipherBytes.subarray(off, off + FRAME_CHUNK_BYTES))
  }
  if (chunks.length === 0) chunks.push(new Uint8Array(0))

  const n = 1 + chunks.length
  const header = {
    v: 3 as const,
    sid,
    i: 0,
    n,
    keyHex,
    ivHex: enc.ivHex,
    expiresAt,
    handle: pkg.handle || undefined,
    hasHistory: Boolean(pkg.brc39Base64),
  }
  const frames: string[] = [
    `${PAIRING_QR_V3_PREFIX}${toBase64Url(new TextEncoder().encode(JSON.stringify(header)))}`,
  ]
  for (let i = 0; i < chunks.length; i++) {
    const body = {
      v: 3 as const,
      sid,
      i: i + 1,
      n,
      d: toBase64Url(chunks[i]!),
    }
    frames.push(
      `${PAIRING_QR_V3_PREFIX}${toBase64Url(new TextEncoder().encode(JSON.stringify(body)))}`,
    )
  }

  return {
    sid,
    frames,
    expiresAt,
    handle: pkg.handle || undefined,
    frameCount: frames.length,
    hasHistory: Boolean(pkg.brc39Base64),
  }
}

type V3Header = {
  v: 3
  sid: string
  i: 0
  n: number
  keyHex: string
  ivHex: string
  expiresAt: number
  handle?: string
  hasHistory?: boolean
}

type V3Data = {
  v: 3
  sid: string
  i: number
  n: number
  d: string
}

type V3Frame = V3Header | V3Data

function parseV3Frame(raw: string): V3Frame | null {
  const text = raw.trim()
  if (!text.startsWith(PAIRING_QR_V3_PREFIX)) return null
  try {
    const json = new TextDecoder().decode(fromBase64Url(text.slice(PAIRING_QR_V3_PREFIX.length)))
    const frame = JSON.parse(json) as V3Frame
    if (frame.v !== 3 || !frame.sid || typeof frame.i !== 'number' || typeof frame.n !== 'number') {
      return null
    }
    return frame
  } catch {
    return null
  }
}

export function isLinkQrPayload(text: string): boolean {
  const t = text.trim()
  return t.startsWith(PAIRING_QR_PREFIX) || t.startsWith(PAIRING_QR_V3_PREFIX)
}

/** Stateful assembler for flashing v3 sessions (and still accepts v1/v2 single codes). */
export class LinkQrAssembler {
  private header: V3Header | null = null
  private chunks = new Map<number, Uint8Array>()
  private expectedTotal = 0
  private sid = ''
  private resolved: PairingPackage | null = null

  get progress(): LinkAssembleProgress | null {
    if (!this.sid && this.chunks.size === 0) return null
    const total = this.header?.n || this.expectedTotal
    const have = (this.header ? 1 : 0) + this.chunks.size
    return {
      sid: this.sid || this.header?.sid || '…',
      have: total ? Math.min(have, total) : have,
      total,
      complete: Boolean(this.resolved),
    }
  }

  reset() {
    this.header = null
    this.chunks.clear()
    this.expectedTotal = 0
    this.sid = ''
    this.resolved = null
  }

  /**
   * Ingest a scanned string. Returns the package when a full transfer is ready,
   * otherwise null (keep scanning).
   */
  async ingest(raw: string): Promise<PairingPackage | null> {
    if (this.resolved) return this.resolved

    const v3 = parseV3Frame(raw)
    if (v3) {
      if (this.sid && v3.sid !== this.sid) {
        this.reset()
      }
      this.sid = v3.sid
      this.expectedTotal = v3.n

      if (v3.i === 0) {
        const h = v3 as V3Header
        if (!h.keyHex || !h.ivHex) throw new Error('Invalid link header')
        if (h.expiresAt < Date.now()) throw new Error('Link QR expired — generate a new one')
        this.header = h
      } else {
        const d = v3 as V3Data
        if (d.d) this.chunks.set(d.i, fromBase64Url(d.d))
      }

      return this.tryAssemble()
    }

    if (raw.trim().startsWith(PAIRING_QR_PREFIX)) {
      const offer = decodePairingQr(raw)
      const pkg = await resolvePairingPackage(offer)
      this.resolved = pkg
      return pkg
    }

    return null
  }

  private async tryAssemble(): Promise<PairingPackage | null> {
    if (!this.header || this.resolved) return this.resolved
    const need = this.header.n - 1
    for (let i = 1; i <= need; i++) {
      if (!this.chunks.has(i)) return null
    }
    const parts: number[] = []
    for (let i = 1; i <= need; i++) {
      const c = this.chunks.get(i)!
      for (let j = 0; j < c.length; j++) parts.push(c[j]!)
    }
    const ciphertextHex = bytesToHex(new Uint8Array(parts))
    const pkg = await decryptPairingPackage(this.header.ivHex, ciphertextHex, this.header.keyHex)
    this.resolved = pkg
    return pkg
  }
}

/** Resolve offer → package (v2 embedded or v1 LAN fetch). */
export async function resolvePairingPackage(offer: PairingOffer): Promise<PairingPackage> {
  if (offer.v === 2) {
    return decryptPairingPackage(offer.ivHex, offer.ciphertextHex, offer.keyHex)
  }
  const url = `${offer.baseUrl.replace(/\/+$/, '')}/pair/${offer.sessionId}`
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Pairing host error (${res.status})`)
  }
  const body = (await res.json()) as { ivHex?: string; ciphertextHex?: string }
  if (!body.ivHex || !body.ciphertextHex) throw new Error('Malformed pairing response')
  return decryptPairingPackage(body.ivHex, body.ciphertextHex, offer.keyHex)
}

export function brc39BytesFromPackage(pkg: PairingPackage): Uint8Array | null {
  if (!pkg.brc39Base64) return null
  try {
    return base64ToBytes(pkg.brc39Base64)
  } catch {
    return null
  }
}

export function packageWithHistory(
  base: Omit<PairingPackage, 'v' | 'brc39Base64' | 'brc39Password'>,
  brc39: Uint8Array,
  brc39Password: string,
): PairingPackage {
  return {
    ...base,
    v: 2,
    brc39Base64: bytesToBase64(brc39),
    brc39Password,
  }
}
