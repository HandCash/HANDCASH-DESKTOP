/**
 * One draft BRC-246 session on a `webrtpay/1` link: the identity handshake of
 * `webrtpay/1` §5, unchanged, then the session messages of BRC-246 §5
 * (`msg`, `ack`, and `webrtpay/1`'s `error` and `bye`).
 *
 * `@bsv/webrtpay`'s own session type admits only payment messages, so the
 * handshake runs here on its `PeerLink`, signing its `bindingTranscript`.
 */

import {
  CHANNEL_PROTOCOL_ID,
  WebRTPayError,
  bindingTranscript,
  fromBase64,
  fromHex,
  isIdentityKey,
  randomBytes,
  toBase64,
  toHex,
  utf8Encode,
  type PeerLink,
  type WalletLike,
} from '@bsv/webrtpay'

/** Largest message accepted before the peer's `auth` verifies (`webrtpay/1` §4.4). */
export const PRE_AUTH_MAX_BYTES = 65536
/** Largest `msg`, as JSON text; a larger body goes through the messagebox. */
export const SESSION_MAX_MSG_BYTES = 256 * 1024
/** Session messages kept for a channel nobody has started reading. */
const MAX_BACKLOG = 64
const NONCE_BYTES = 32
const NONCE_CHARS = 44
const MAX_SIGNATURE_CHARS = 200
const ID_RE = /^.{1,64}$/s

export type SessionMessage =
  | { t: 'msg'; id: string; body: string }
  | { t: 'ack'; id: string }
  | { t: 'error'; code: string; message?: string }
  | { t: 'bye' }

type Hello = { t: 'hello'; v: 1; identityKey: string; nonce: string }

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function isNonce(v: unknown): v is string {
  if (typeof v !== 'string' || v.length !== NONCE_CHARS) return false
  try {
    return fromBase64(v).length === NONCE_BYTES
  } catch {
    return false
  }
}

function parseHello(r: Record<string, unknown>): Hello | null {
  return r.t === 'hello' && r.v === 1 && isIdentityKey(r.identityKey) && isNonce(r.nonce)
    ? { t: 'hello', v: 1, identityKey: r.identityKey, nonce: r.nonce }
    : null
}

function parseAuth(r: Record<string, unknown>): string | null {
  const sig = r.signature
  return r.t === 'auth' && typeof sig === 'string' && sig.length <= MAX_SIGNATURE_CHARS && /^(?:[0-9a-f]{2})+$/.test(sig)
    ? sig
    : null
}

/** A session message with only its known fields, or null for anything BRC-246 §5 does not allow. */
export function parseSessionMessage(v: unknown): SessionMessage | null {
  const r = record(v)
  if (!r) return null
  switch (r.t) {
    case 'msg':
      return typeof r.id === 'string' && ID_RE.test(r.id) && typeof r.body === 'string' ? { t: 'msg', id: r.id, body: r.body } : null
    case 'ack':
      return typeof r.id === 'string' && ID_RE.test(r.id) ? { t: 'ack', id: r.id } : null
    case 'error': {
      if (typeof r.code !== 'string' || r.code.length < 1 || r.code.length > 64) return null
      if (r.message != null && (typeof r.message !== 'string' || r.message.length > 500)) return null
      return r.message == null ? { t: 'error', code: r.code } : { t: 'error', code: r.code, message: r.message as string }
    }
    case 'bye':
      return { t: 'bye' }
    default:
      return null
  }
}

export function messageBytes(m: SessionMessage): number {
  return utf8Encode(JSON.stringify(m)).length
}

/** An authenticated session; messages wait for the first listener, up to a backlog. */
export class MessageChannel {
  private listener: ((m: SessionMessage) => void) | null = null
  private backlog: SessionMessage[] = []
  private failed = false

  constructor(
    private readonly link: PeerLink,
    readonly peerIdentityKey: string,
    pending: unknown[],
  ) {
    for (const raw of pending) this.receive(raw)
    link.onMessage((raw) => this.receive(raw))
  }

  get isOpen(): boolean {
    return this.link.isOpen && !this.failed
  }

  send(m: SessionMessage): Promise<void> {
    return this.link.send(m)
  }

  onMessage(fn: (m: SessionMessage) => void): void {
    this.listener = fn
    const kept = this.backlog.splice(0)
    queueMicrotask(() => {
      for (const m of kept) fn(m)
    })
  }

  onClose(fn: (reason?: WebRTPayError) => void): () => void {
    return this.link.onClose(fn)
  }

  /** Send `bye`, then close once it is handed to the channel. */
  bye(): void {
    if (!this.link.isOpen) {
      this.link.close()
      return
    }
    const close = () => this.link.close()
    this.link.send({ t: 'bye' }).then(close, close)
  }

  close(reason?: WebRTPayError): void {
    this.link.close(reason)
  }

  private receive(raw: unknown): void {
    if (this.failed) return
    const m = parseSessionMessage(raw)
    if (!m) {
      this.fail()
      return
    }
    if (this.listener) this.listener(m)
    else if (this.backlog.length < MAX_BACKLOG) this.backlog.push(m)
    else this.fail()
  }

  private fail(): void {
    this.failed = true
    const error = new WebRTPayError('protocol', 'Peer sent an invalid session message')
    const close = () => this.link.close(error)
    this.link.send({ t: 'error', code: 'protocol' }).then(close, close)
  }
}

/**
 * Run the `webrtpay/1` §5 handshake on `link`: hello, auth over the channel
 * binding transcript (`[2, 'webrtpay channel']`, keyID our nonce, counterparty
 * the peer), ready. Call it as soon as the link exists. Resolves with a
 * {@link MessageChannel} once our check passed and the peer's `ready` came.
 */
export function authenticateChannel(
  link: PeerLink,
  o: {
    wallet: Pick<WalletLike, 'getPublicKey' | 'createSignature' | 'verifySignature'>
    expectedPeer: string
    timeoutMs: number
    /** Start the clock only once this settles (the answer has been sent). */
    startAfter?: Promise<unknown>
  },
): Promise<MessageChannel> {
  return new Promise((resolve, reject) => {
    let expecting: 'hello' | 'auth' | 'ready' = 'hello'
    const inbox: unknown[] = []
    let busy = true
    let settled = false
    let localKey = ''
    let peer: Hello | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const localNonce = toBase64(randomBytes(NONCE_BYTES))

    link.setMaxMessageBytes(PRE_AUTH_MAX_BYTES)
    const offMessage = link.onMessage((m) => {
      if (inbox.length >= (expecting === 'ready' ? 1 + MAX_BACKLOG : 3)) {
        fail(new WebRTPayError('auth_failed', 'Peer sent too many messages during the handshake'))
        return
      }
      inbox.push(m)
      pump()
    })
    const offClose = link.onClose((reason) => fail(reason ?? new WebRTPayError('closed', 'Link closed during the handshake')))

    function fail(error: unknown): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      offMessage()
      offClose()
      const reason = error instanceof WebRTPayError ? error : new WebRTPayError('auth_failed', 'Handshake failed', { cause: error })
      link.close(reason)
      reject(reason)
    }

    function run(step: Promise<void>): void {
      step.then(() => {
        busy = false
        pump()
      }, fail)
    }

    function pump(): void {
      while (!busy && !settled && inbox.length > 0) {
        const r = record(inbox.shift())
        if (expecting === 'hello') {
          const hello = r && parseHello(r)
          if (!hello) return fail(new WebRTPayError('auth_failed', 'Peer sent no valid hello'))
          busy = true
          run(onHello(hello))
        } else if (expecting === 'auth') {
          const signature = r && parseAuth(r)
          if (!signature) return fail(new WebRTPayError('auth_failed', 'Peer sent no valid auth'))
          busy = true
          run(onAuth(signature))
        } else {
          if (r?.t !== 'ready') return fail(new WebRTPayError('auth_failed', 'Peer sent no ready'))
          finish()
        }
      }
    }

    async function start(): Promise<void> {
      localKey = (await o.wallet.getPublicKey({ identityKey: true })).publicKey
      if (o.startAfter) {
        await o.startAfter
        if (settled) return
        arm()
      }
      await link.waitOpen(o.timeoutMs)
      if (settled) return
      await link.send({ t: 'hello', v: 1, identityKey: localKey, nonce: localNonce })
    }

    async function onHello(hello: Hello): Promise<void> {
      if (hello.identityKey !== o.expectedPeer) throw new WebRTPayError('auth_failed', 'Peer is not the identity this session expects')
      if (hello.nonce === localNonce) throw new WebRTPayError('auth_failed', 'Peer repeated our nonce')
      peer = hello
      expecting = 'auth'
      const signerFingerprints = link.localFingerprints()
      const verifierFingerprints = link.remoteFingerprints()
      if (!signerFingerprints.length || !verifierFingerprints.length) {
        throw new WebRTPayError('auth_failed', 'No DTLS fingerprint to bind the session to')
      }
      const data = bindingTranscript({
        signerFingerprints,
        verifierFingerprints,
        signerNonce: localNonce,
        verifierNonce: hello.nonce,
        signerKey: localKey,
        verifierKey: hello.identityKey,
      })
      const { signature } = await o.wallet.createSignature({
        data,
        protocolID: CHANNEL_PROTOCOL_ID,
        keyID: localNonce,
        counterparty: hello.identityKey,
      })
      if (settled) return
      await link.send({ t: 'auth', signature: toHex(Uint8Array.from(signature)) })
    }

    async function onAuth(signature: string): Promise<void> {
      const data = bindingTranscript({
        signerFingerprints: link.remoteFingerprints(),
        verifierFingerprints: link.localFingerprints(),
        signerNonce: peer!.nonce,
        verifierNonce: localNonce,
        signerKey: peer!.identityKey,
        verifierKey: localKey,
      })
      let valid = false
      try {
        valid = (
          await o.wallet.verifySignature({
            data,
            signature: Array.from(fromHex(signature)),
            protocolID: CHANNEL_PROTOCOL_ID,
            keyID: peer!.nonce,
            counterparty: peer!.identityKey,
          })
        ).valid
      } catch {
        valid = false
      }
      if (!valid) throw new WebRTPayError('auth_failed', 'Peer signature does not verify')
      if (settled) return
      link.setMaxMessageBytes(SESSION_MAX_MSG_BYTES)
      expecting = 'ready'
      await link.send({ t: 'ready' })
    }

    function finish(): void {
      settled = true
      clearTimeout(timer)
      const channel = new MessageChannel(link, peer!.identityKey, inbox.splice(0))
      offMessage()
      offClose()
      resolve(channel)
    }

    function arm(): void {
      timer = setTimeout(() => fail(new WebRTPayError('timeout', `Handshake not finished within ${o.timeoutMs} ms`)), o.timeoutMs)
    }

    if (!o.startAfter) arm()
    run(start())
  })
}
