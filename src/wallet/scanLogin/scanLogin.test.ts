import { PrivateKey } from '@bsv/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VaultTransfer } from '../deviceTransfer'
import {
  approveScanLogin,
  listScanLoginRows,
  setScanLoginDeps,
  startScanLoginApproval,
} from './approvals'
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
    expect(tryParseScanLoginPayload(JSON.stringify({ ...payload, urls: ['https://evil.example'] }))).toBeNull()
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

describe('scan-to-login fallback', () => {
  it('devices on different networks are told to use email sign-in', async () => {
    const { payload, off } = pair()
    const away = { ...payload, urls: ['http://10.9.9.9:3340'] }
    await expect(helloScanLogin(away, { label: 'Mac', fetchImpl: lanFetch() })).rejects.toBeInstanceOf(ScanLoginUnreachable)

    setScanLoginDeps({ fetchImpl: lanFetch(), label: () => 'Mac', vault: () => transfer, confirm: async () => undefined })
    await startScanLoginApproval(away)
    off()
    const [row] = listScanLoginRows()
    expect(row).toMatchObject({ face: 'unreachable', live: false, title: "Couldn't reach Windows PC" })
    expect(row?.detail).toMatch(/Sign in with email/)
    await expect(approveScanLogin(away.loginKey)).rejects.toThrow(/Compare the codes/)
  })
})
