import { PrivateKey } from '@bsv/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openVaultTransfer, type VaultTransfer } from '../deviceTransfer'
import {
  approveScanLogin,
  listScanLoginRows,
  setScanLoginDeps,
  startScanLoginApproval,
} from './approvals'
import { runScanLoginRelay } from './relay'
import { helloScanLogin, refuseScanLogin, ScanLoginUnreachable, sendScanLoginVault } from './approver'
import { scanLoginQrText, tryParseScanLoginPayload, type ScanLoginPayload } from './payload'
import {
  endScanLoginSession,
  handleScanLoginRequest,
  startScanLoginSession,
  subscribeScanLoginSession,
  type ScanLoginEvent,
} from './receiver'

const LAN = 'http://192.168.1.20:3340'

const transfer: VaultTransfer = {
  v: 1,
  kind: 'handcash-brc250-vault',
  master: { derivation: 'brc-42', keyHex: PrivateKey.fromRandom().toHex() },
  enrollment: null,
  accounts: { version: 1 },
  sentAt: 1,
}

/** The new device's peer server, reached in-process; other addresses are off this network. */
function lanFetch(seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = String(init?.body ?? '')
    seen.push(body)
    if (!url.startsWith(LAN)) throw new TypeError('Failed to fetch')
    const res = handleScanLoginRequest({ method: init?.method ?? 'GET', path: new URL(url).pathname, body })
    return new Response(res.body, { status: res.status })
  }) as typeof fetch
}

function pair(): { payload: ScanLoginPayload; events: ScanLoginEvent[]; off: () => void } {
  const payload = startScanLoginSession({ urls: [LAN], label: 'Windows PC' })
  const events: ScanLoginEvent[] = []
  const off = subscribeScanLoginSession((event) => events.push(event))
  return { payload, events, off }
}

afterEach(() => endScanLoginSession())

describe('scan-to-login QR', () => {
  it('carries a one-time secret and the new device key, and nothing else secret', () => {
    const { payload, off } = pair()
    off()
    const parsed = tryParseScanLoginPayload(scanLoginQrText(payload))
    expect(parsed).toEqual(payload)
    expect(parsed?.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed?.loginKey).toMatch(/^(02|03)[0-9a-f]{64}$/)
    expect(startScanLoginSession({ urls: [LAN], label: 'x' }).secret).not.toBe(payload.secret)
  })

  it('refuses expired, incomplete and unrelated codes', () => {
    const { payload, off } = pair()
    off()
    expect(tryParseScanLoginPayload(scanLoginQrText(payload), payload.expiresAt + 1)).toBeNull()
    expect(tryParseScanLoginPayload(JSON.stringify({ ...payload, secret: '' }))).toBeNull()
    expect(tryParseScanLoginPayload(JSON.stringify({ ...payload, urls: ['https://evil.example'] }))?.urls).toEqual([])
    expect(tryParseScanLoginPayload('{"v":3,"identityKey":"02"}')).toBeNull()
  })
})

describe('scan-to-login pairing and approval', () => {
  it('both screens show the same 6-digit code and the approver name', async () => {
    const { payload, events, off } = pair()
    const conn = await helloScanLogin(payload, { label: 'Mac', fetchImpl: lanFetch() })
    off()
    expect(conn.code).toMatch(/^\d{6}$/)
    expect(events).toEqual([{ type: 'connected', approverLabel: 'Mac', code: conn.code }])
  })

  it('a device without the secret cannot pair', async () => {
    const { payload, events, off } = pair()
    const forged = { ...payload, secret: 'ab'.repeat(32) }
    await expect(helloScanLogin(forged, { label: 'Mac', fetchImpl: lanFetch() })).rejects.toThrow(/refused/)
    off()
    expect(events).toEqual([])
  })

  it('only the first device to answer pairs', async () => {
    const { payload, off } = pair()
    await helloScanLogin(payload, { label: 'Mac', fetchImpl: lanFetch() })
    await expect(helloScanLogin(payload, { label: 'iPhone', fetchImpl: lanFetch() })).rejects.toThrow(/already answered/)
    off()
  })

  it('the vault crosses the network only as ciphertext and opens on the new device', async () => {
    const { payload, events, off } = pair()
    const seen: string[] = []
    const conn = await helloScanLogin(payload, { label: 'Mac', fetchImpl: lanFetch(seen) })
    await sendScanLoginVault(conn, transfer, lanFetch(seen))
    off()
    const vault = events.find((event) => event.type === 'vault')
    expect(vault?.type === 'vault' && vault.transfer.master.keyHex).toBe(transfer.master.keyHex)
    for (const body of seen) {
      expect(body).not.toContain(transfer.master.keyHex)
      expect(body).not.toContain(payload.secret)
    }
  })

  it('refusing tells the new device', async () => {
    const { payload, events, off } = pair()
    const conn = await helloScanLogin(payload, { label: 'Mac', fetchImpl: lanFetch() })
    await refuseScanLogin(conn, lanFetch())
    off()
    expect(events.at(-1)).toEqual({ type: 'refused' })
  })

  it('approval waits on presence and on the compared code', async () => {
    const confirm = vi.fn(async () => undefined)
    setScanLoginDeps({ fetchImpl: lanFetch(), label: () => 'Mac', vault: () => transfer, confirm })
    const { payload, events, off } = pair()
    await startScanLoginApproval(payload)
    const [row] = listScanLoginRows()
    expect(row).toMatchObject({ face: 'comparing', via: 'local', label: 'Windows PC', live: true })
    expect(row?.code).toMatch(/^\d{6}$/)
    await approveScanLogin(payload.loginKey)
    off()
    expect(confirm).toHaveBeenCalledWith('approve sign-in on Windows PC')
    expect(listScanLoginRows()[0]).toMatchObject({ face: 'approved', title: 'Signed in on Windows PC' })
    expect(events.some((event) => event.type === 'vault')).toBe(true)
  })
})

describe('scan-to-login session limits', () => {
  it('a code past its expiry ends on the approving device without asking to approve', async () => {
    const confirm = vi.fn(async () => undefined)
    const sent: string[] = []
    setScanLoginDeps({ fetchImpl: lanFetch(sent), label: () => 'Mac', vault: () => transfer, confirm })
    const { payload, off } = pair()
    await startScanLoginApproval(payload)
    off()
    vi.useFakeTimers({ now: payload.expiresAt + 1 })
    try {
      expect(listScanLoginRows()[0]).toMatchObject({ face: 'expired', live: false, title: 'Sign-in expired' })
      sent.length = 0
      await expect(approveScanLogin(payload.loginKey)).rejects.toThrow(/expired/)
    } finally {
      vi.useRealTimers()
    }
    expect(confirm).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('approving twice sends the wallet once', async () => {
    const sent: string[] = []
    setScanLoginDeps({ fetchImpl: lanFetch(sent), label: () => 'Mac', vault: () => transfer, confirm: async () => undefined })
    const { payload, off } = pair()
    await startScanLoginApproval(payload)
    sent.length = 0
    const results = await Promise.allSettled([approveScanLogin(payload.loginKey), approveScanLogin(payload.loginKey)])
    off()
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(sent.filter((body) => body.includes('sealedVault'))).toHaveLength(1)
    expect(listScanLoginRows()[0]).toMatchObject({ face: 'approved' })
  })

  it('a captured QR cannot open the wallet: it is sealed to a key the QR does not carry', async () => {
    const { payload, off } = pair()
    const seen: string[] = []
    const conn = await helloScanLogin(payload, { label: 'Mac', fetchImpl: lanFetch(seen) })
    await sendScanLoginVault(conn, transfer, lanFetch(seen))
    off()
    const sealed = JSON.parse(seen.find((body) => body.includes('sealedVault'))!).sealedVault as string
    const captured = tryParseScanLoginPayload(scanLoginQrText(payload))!
    expect(JSON.stringify(captured)).not.toMatch(/keyHex|privateKey/)
    expect(() => openVaultTransfer(sealed, PrivateKey.fromRandom())).toThrow()
    expect(handleScanLoginRequest({ method: 'POST', path: '/handcash-device/v1/scan-login/hello', body: '{}' }).status).toBe(404)
  })
})

describe('scan-to-login fallback', () => {
  it('devices that answer on neither network are told to show a fresh code', async () => {
    const { payload, off } = pair()
    const away = { ...payload, urls: ['http://10.9.9.9:3340'] }
    await expect(helloScanLogin(away, { label: 'Mac', fetchImpl: lanFetch() })).rejects.toBeInstanceOf(ScanLoginUnreachable)

    setScanLoginDeps({ fetchImpl: lanFetch(), label: () => 'Mac', vault: () => transfer, confirm: async () => undefined })
    await startScanLoginApproval(away)
    off()
    const [row] = listScanLoginRows()
    expect(row).toMatchObject({ face: 'unreachable', live: false, title: "Couldn't reach Windows PC" })
    expect(row?.detail).toMatch(/fresh code/)
    await expect(approveScanLogin(away.loginKey)).rejects.toThrow(/Compare the codes/)
  })
})

describe('scan-to-login relay (different networks)', () => {
  /** An in-memory BRC-33 messagebox: recipient comes from the signing identity header. */
  function mailbox(): typeof fetch {
    const boxes = new Map<string, { messageId: string; sender: string; body: string }[]>()
    let n = 0
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const route = String(input).split('/').pop()
      const identity = new Headers(init?.headers).get('X-BRC33-Identity')!
      const body = JSON.parse(String(init?.body))
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
      if (route === 'sendMessage') {
        const list = boxes.get(body.message.recipient) ?? []
        list.push({ messageId: String(++n), sender: identity, body: body.message.body })
        boxes.set(body.message.recipient, list)
        return json({ status: 'success' })
      }
      if (route === 'listMessages') return json({ status: 'success', messages: boxes.get(identity) ?? [] })
      boxes.set(identity, (boxes.get(identity) ?? []).filter((m) => !body.messageIds.includes(m.messageId)))
      return json({ status: 'success' })
    }) as typeof fetch
  }

  it('pairs and delivers the vault with no shared network', async () => {
    const fetchImpl = mailbox()
    const payload = startScanLoginSession({ urls: [], label: 'Windows PC' })
    const events: ScanLoginEvent[] = []
    subscribeScanLoginSession((e) => events.push(e))
    const stop = runScanLoginRelay({ fetchImpl, pollMs: 5 })
    const conn = await helloScanLogin(payload, { label: 'Phone', fetchImpl, relayMs: 3000 })
    expect(conn.url).toBe('relay')
    expect(events[0]).toEqual({ type: 'connected', approverLabel: 'Phone', code: conn.code })
    await sendScanLoginVault(conn, transfer, fetchImpl)
    stop()
    expect(events[1]).toMatchObject({ type: 'vault', transfer: { master: transfer.master } })
  })

  it('a forged proof over the relay is refused', async () => {
    const fetchImpl = mailbox()
    const payload = startScanLoginSession({ urls: [], label: 'Windows PC' })
    const stop = runScanLoginRelay({ fetchImpl, pollMs: 5 })
    await expect(helloScanLogin({ ...payload, secret: '11'.repeat(32) }, { label: 'x', fetchImpl, relayMs: 3000 })).rejects.toThrow()
    stop()
  })
})
