/**
 * Scan-to-login across networks, peer to peer over the BRC-33 messagebox.
 *
 * The messagebox is a store-and-forward mailbox keyed by public key. Here both
 * ends use one-time keys (the new device's `loginKey`, the approver's fresh
 * key), so the mailbox learns nothing about any account, and the vault inside
 * is sealed to the QR's key. The request/response bodies are the same ones the
 * local-network path carries, so the HMAC proofs and the 6-digit code apply
 * unchanged.
 */
import { errorText } from '../errorText'
import type { PrivateKey } from '@bsv/sdk'
import { signedIdentityHeaders } from '../identityRequestAuth'
import { randomHex } from '../deviceTransfer'
import { freshMessageboxAuthHeaders, type MessageboxMethod } from '../messageboxAuth'
import { DEFAULT_BRC_CLOUD_BASE_URL } from '../walletConfig'
import { getScanLoginSession, handleScanLoginRequestAsync } from './receiver'

export const SCAN_LOGIN_BOX = 'scan-login'
export const RELAY_POLL_MS = 1_500

type Fetch = typeof fetch
type RelayOptions = { base?: string; fetchImpl?: Fetch }

type Mail = { messageId: string; sender: string; body: string }

const baseOf = (opts: RelayOptions) => (opts.base ?? DEFAULT_BRC_CLOUD_BASE_URL).replace(/\/+$/, '')

async function call(
  key: PrivateKey,
  method: MessageboxMethod,
  route: string,
  payload: Record<string, unknown>,
  opts: RelayOptions,
): Promise<Record<string, unknown>> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${baseOf(opts)}/v1/messagebox/${route}`
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...freshMessageboxAuthHeaders({ rootKeyHex: key.toHex(), method, messageBox: SCAN_LOGIN_BOX, includeAuthrite: true }),
    },
    body: JSON.stringify({ messageBox: SCAN_LOGIN_BOX, ...payload }),
  }
  const res = await fetchImpl(url, { ...init, headers: await signedIdentityHeaders(key.toHex(), 'messagebox', url, init) })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(`relay-${route}-${res.status}${json.error ? `-${String(json.error)}` : ''}`)
  return json
}

export async function relaySend(key: PrivateKey, to: string, body: unknown, opts: RelayOptions = {}): Promise<void> {
  await call(key, 'sendMessage', 'sendMessage', { message: { recipient: to, messageBox: SCAN_LOGIN_BOX, body: JSON.stringify(body) } }, opts)
}

export async function relayInbox(key: PrivateKey, opts: RelayOptions = {}): Promise<Mail[]> {
  const json = await call(key, 'listMessages', 'listMessages', {}, opts)
  return Array.isArray(json.messages) ? (json.messages as Mail[]) : []
}

export async function relayAck(key: PrivateKey, ids: string[], opts: RelayOptions = {}): Promise<void> {
  if (ids.length) await call(key, 'acknowledgeMessage', 'acknowledgeMessage', { messageIds: ids }, opts)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Approver side: one request to the new device's mailbox, then wait for its
 * answer in ours. Resolves with the same `{status, body}` a local request gives.
 */
export async function relayRequest(
  approverKey: PrivateKey,
  loginKey: string,
  step: 'hello' | 'confirm' | 'vault' | 'refuse',
  fields: Record<string, unknown>,
  args: RelayOptions & { timeoutMs: number; pollMs?: number },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const id = randomHex(16)
  await relaySend(approverKey, loginKey, { t: 'req', id, step, ...fields }, args)
  const deadline = Date.now() + args.timeoutMs
  while (Date.now() < deadline) {
    const mail = await relayInbox(approverKey, args)
    const seen: string[] = []
    let answer: { status: number; body: Record<string, unknown> } | null = null
    for (const m of mail) {
      if (m.sender !== loginKey) continue
      seen.push(m.messageId)
      try {
        const parsed = JSON.parse(m.body) as { t?: string; id?: string; status?: number; body?: Record<string, unknown> }
        if (parsed.t === 'res' && parsed.id === id) answer = { status: Number(parsed.status) || 0, body: parsed.body ?? {} }
      } catch {
        /* not ours */
      }
    }
    await relayAck(approverKey, seen, args).catch(() => undefined)
    if (answer) return answer
    await sleep(args.pollMs ?? RELAY_POLL_MS)
  }
  throw new Error('relay-timeout')
}

/**
 * New-device side: poll the mailbox for the live session's key and answer each
 * request through the same handler the local server uses. Stops when the
 * session finishes, expires or is replaced, or when `stop()` is called.
 */
export function runScanLoginRelay(args: RelayOptions & { pollMs?: number } = {}): () => void {
  const session = getScanLoginSession()
  if (!session) return () => undefined
  let stopped = false
  void (async () => {
    while (!stopped) {
      const live = getScanLoginSession()
      if (!live || live.key !== session.key || live.done || live.payload.expiresAt <= Date.now()) return
      try {
        const mail = await relayInbox(session.key, args)
        const handled: string[] = []
        for (const m of mail) {
          handled.push(m.messageId)
          let req: { t?: string; id?: string; step?: string; [k: string]: unknown }
          try {
            req = JSON.parse(m.body)
          } catch {
            continue
          }
          if (req.t !== 'req' || typeof req.id !== 'string' || typeof req.step !== 'string') continue
          const { t: _t, id, step, ...fields } = req
          const out = await handleScanLoginRequestAsync({
            method: 'POST',
            path: `/handcash-device/v1/scan-login/${step}`,
            body: JSON.stringify({ ...fields, approverKey: m.sender }),
          })
          console.info('[scan-login] relay', step, out.status)
          await relaySend(session.key, m.sender, { t: 'res', id, status: out.status, body: JSON.parse(out.body) }, args).catch(
            (error) => console.warn('[scan-login] relay reply failed', String(error)),
          )
        }
        await relayAck(session.key, handled, args).catch(() => undefined)
      } catch (error) {
        console.warn('[scan-login] relay poll failed', errorText(error))
      }
      await sleep(args.pollMs ?? RELAY_POLL_MS)
    }
  })()
  return () => {
    stopped = true
  }
}
