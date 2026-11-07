import { PrivateKey } from '@bsv/sdk'
import { createActor, waitFor } from 'xstate'
import { pairingCodeMachine } from '../../machines/pairingCodeMachine'
import { signIdentityText } from '../messageboxAuth'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openVaultTransfer, type VaultTransfer } from '../deviceTransfer'
import {
  approveScanLogin,
  confirmScanLoginCode,
  listScanLoginRows,
  refuseScanLoginFor,
  setScanLoginDeps,
  startScanLoginApproval,
} from './approvals'
import { runScanLoginRelay } from './relay'
import {
  confirmPairingCode,
  helloScanLogin,
  PairingCodeRejected,
  refuseScanLogin,
  ScanLoginUnreachable,
  sendScanLoginVault,
} from './approver'
import { pairingReceiptText, scanLoginQrText, sha256Hex, tryParseScanLoginPayload, type ScanLoginPayload } from './payload'
import {
  endScanLoginSession,
  getScanLoginSession,
  handleScanLoginRequest,
  handleScanLoginRequestAsync,
  startScanLoginSession,
  subscribeScanLoginSession as subscribeSession,
  type ScanLoginEvent,
} from './receiver'

const subscriptions: Array<() => void> = []
function subscribeScanLoginSession(listener: (event: ScanLoginEvent) => void) {
  const off = subscribeSession(listener)
  subscriptions.push(off)
  return off
}

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
    const res = await handleScanLoginRequestAsync({ method: init?.method ?? 'GET', path: new URL(url).pathname, body })
    return new Response(res.body, { status: res.status })
  }) as typeof fetch
}

function pair(autoAcknowledge = true): { payload: ScanLoginPayload; events: ScanLoginEvent[]; off: () => void } {
  const payload = startScanLoginSession({ urls: [LAN], label: 'Windows PC' })
  const events: ScanLoginEvent[] = []
  const off = subscribeScanLoginSession((event) => {
    events.push(event)
    if (autoAcknowledge && event.type === 'vault') void event.acknowledge()
  })
  return { payload, events, off }
}

afterEach(() => {
  for (const off of subscriptions.splice(0)) off()
  endScanLoginSession()
})

/** The code exists only on the new device's screen: read it from what that screen is told. */
function shownCode(events: ScanLoginEvent[]): string {
  const hello = events.find((event) => event.type === 'connected')
  if (hello?.type !== 'connected') throw new Error('no approver yet')
  return hello.code
}
const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000')

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
  it('the new device shows a 6-digit code and the approver name; the approver is never given the code', async () => {
    const { payload, events, off } = pair()
    const seen: string[] = []
    const conn = await helloScanLogin(payload, { label: 'Mac', fetchImpl: lanFetch(seen) })
    off()
    const code = shownCode(events)
    expect(code).toMatch(/^\d{6}$/)
    expect(events[0]).toMatchObject({ type: 'connected', approverLabel: 'Mac' })
    expect(JSON.stringify(conn)).not.toContain(code)
    expect(JSON.stringify(payload)).not.toContain(code)
    expect(scanLoginQrText(payload)).not.toContain(code)
    const hello = handleScanLoginRequest({ method: 'POST', path: '/handcash-device/v1/scan-login/hello', body: '{}' })
    expect(hello.body).not.toContain(code)
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
    await confirmPairingCode(conn, shownCode(events), lanFetch(seen))
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

  it('approval waits on presence and on the typed code', async () => {
    const confirm = vi.fn(async () => undefined)
    setScanLoginDeps({ fetchImpl: lanFetch(), label: () => 'Mac', vault: () => transfer, confirm })
    const { payload, events, off } = pair()
    await startScanLoginApproval(payload)
    const [row] = listScanLoginRows()
    expect(row).toMatchObject({ face: 'comparing', via: 'local', label: 'Windows PC', live: true })
    expect(row?.code).toBeNull()
    expect(row?.pairing).toEqual({ length: 6, attemptsLeft: 3, confirmed: false })
    await expect(approveScanLogin(payload.loginKey)).rejects.toThrow(/Type the code/)
    expect(events.some((event) => event.type === 'vault')).toBe(false)
    expect(await confirmScanLoginCode(payload.loginKey, shownCode(events))).toEqual({ ok: true })
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
    const events: ScanLoginEvent[] = []
    subscribeScanLoginSession((event) => events.push(event))
    await startScanLoginApproval(payload)
    await confirmScanLoginCode(payload.loginKey, shownCode(events))
    sent.length = 0
    const results = await Promise.allSettled([approveScanLogin(payload.loginKey), approveScanLogin(payload.loginKey)])
    off()
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(sent.filter((body) => body.includes('sealedVault'))).toHaveLength(1)
    expect(listScanLoginRows()[0]).toMatchObject({ face: 'approved' })
  })

  it('a captured QR cannot open the wallet: it is sealed to a key the QR does not carry', async () => {
    const { payload, events, off } = pair()
    const seen: string[] = []
    const conn = await helloScanLogin(payload, { label: 'Mac', fetchImpl: lanFetch(seen) })
    await confirmPairingCode(conn, shownCode(events), lanFetch(seen))
    await sendScanLoginVault(conn, transfer, lanFetch(seen))
    off()
    const sealed = JSON.parse(seen.find((body) => body.includes('sealedVault'))!).sealedVault as string
    const captured = tryParseScanLoginPayload(scanLoginQrText(payload))!
    expect(JSON.stringify(captured)).not.toMatch(/keyHex|privateKey/)
    expect(() => openVaultTransfer(sealed, PrivateKey.fromRandom())).toThrow()
    expect(handleScanLoginRequest({ method: 'POST', path: '/handcash-device/v1/scan-login/hello', body: '{}' }).status).toBe(404)
  })
})

describe('verified pairing completion', () => {
  it.each([false, true])('the real chart waits for the real receiver and handles setup failure=%s', async (fail) => {
    const { payload, events } = pair(false)
    const conn = await helloScanLogin(payload, { label: 'Phone', fetchImpl: lanFetch() })
    const actor = createActor(pairingCodeMachine, { input: {
      length: 6,
      attemptsLeft: 3,
      confirm: async (digits: string) => {
        await confirmPairingCode(conn, digits, lanFetch())
        return { ok: true as const }
      },
      approve: () => sendScanLoginVault(conn, transfer, lanFetch()),
    } }).start()
    try {
      const code = shownCode(events)
      for (let i = 1; i <= code.length; i++) actor.send({ type: 'TYPE', value: code.slice(0, i) })
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe('vault'))
      expect(actor.getSnapshot().value).toBe('sending')
      expect(actor.getSnapshot().status).toBe('active')
      const event = events.at(-1)!
      if (event.type !== 'vault') throw new Error('no transfer')
      if (fail) event.fail()
      else await event.acknowledge()
      await waitFor(actor, (s) => s.status === 'done')
      expect(actor.getSnapshot().value).toBe(fail ? 'ended' : 'approved')
    } finally {
      actor.stop()
    }
  })

  it.each(['session', 'approver', 'ciphertext', 'signer'])('rejects a receipt bound to another %s', async (field) => {
    const { payload, events } = pair()
    const conn = await helloScanLogin(payload, { label: 'Phone', fetchImpl: lanFetch() })
    await confirmPairingCode(conn, shownCode(events), lanFetch())
    // Even a valid signature by the receiver must bind this exact transfer and both peers.
    const receiverKey = getScanLoginSession()!.key
    const fake = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const sealed = JSON.parse(String(init?.body)).sealedVault as string
      const key = field === 'signer' ? PrivateKey.fromRandom() : receiverKey
      const text = pairingReceiptText(
        field === 'session' ? PrivateKey.fromRandom().toPublicKey().toString() : payload.loginKey,
        field === 'approver' ? PrivateKey.fromRandom().toPublicKey().toString() : conn.approverKey.toPublicKey().toString(),
        field === 'ciphertext' ? sha256Hex('another transfer') : sha256Hex(sealed),
      )
      return new Response(JSON.stringify({ ok: true, signature: signIdentityText(key.toHex(), text).signature }))
    }) as typeof fetch
    await expect(sendScanLoginVault(conn, transfer, fake)).rejects.toThrow(/prove/)
  })

  it('does not approve or record the device until installation and runtime startup acknowledge', async () => {
    const { payload, events } = pair(false)
    const recorded = vi.fn()
    setScanLoginDeps({ fetchImpl: lanFetch(), vault: () => transfer, confirm: async () => undefined, onApproved: recorded })
    await startScanLoginApproval(payload)
    await confirmScanLoginCode(payload.loginKey, shownCode(events))
    let resolved = false
    const sending = approveScanLogin(payload.loginKey).then(() => { resolved = true })
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('vault'))
    expect(resolved).toBe(false)
    expect(recorded).not.toHaveBeenCalled()
    expect(listScanLoginRows()[0]?.face).not.toBe('approved')
    const event = events.at(-1)!
    if (event.type !== 'vault') throw new Error('no transfer')
    await event.acknowledge()
    await sending
    expect(recorded).toHaveBeenCalledTimes(1)
    expect(listScanLoginRows()[0]?.face).toBe('approved')
  })

  it('failed setup never produces success even after decryption', async () => {
    const { payload, events } = pair(false)
    const conn = await helloScanLogin(payload, { label: 'Phone', fetchImpl: lanFetch() })
    await confirmPairingCode(conn, shownCode(events), lanFetch())
    const sending = sendScanLoginVault(conn, transfer, lanFetch())
    const rejected = expect(sending).rejects.toThrow(/not verified/)
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('vault'))
    const event = events.at(-1)!
    if (event.type !== 'vault') throw new Error('no transfer')
    event.fail()
    await rejected
    await event.acknowledge() // a late callback cannot turn failure into success
  })

  it('an unsigned success response cannot impersonate a ready receiver', async () => {
    const { payload, events } = pair()
    const real = lanFetch()
    const conn = await helloScanLogin(payload, { label: 'Phone', fetchImpl: real })
    await confirmPairingCode(conn, shownCode(events), real)
    const fake = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch
    await expect(sendScanLoginVault(conn, transfer, fake)).rejects.toThrow(/did not prove/)
  })

  it('a peer without typed-code and completion-receipt support fails closed', async () => {
    const { payload } = pair()
    const old = vi.fn(async () => new Response(JSON.stringify({ loginKey: payload.loginKey }), { status: 200 })) as typeof fetch
    await expect(helloScanLogin(payload, { label: 'Phone', fetchImpl: old, relay: false })).rejects.toThrow(/Update HandCash/)
  })

  it('an unacknowledged install times out and cannot later claim success', async () => {
    const { payload, events } = pair(false)
    const conn = await helloScanLogin(payload, { label: 'Phone', fetchImpl: lanFetch() })
    await confirmPairingCode(conn, shownCode(events), lanFetch())
    vi.useFakeTimers()
    try {
      const sending = sendScanLoginVault(conn, transfer, lanFetch())
      const rejected = expect(sending).rejects.toThrow(/not verified/)
      const event = events.at(-1)!
      if (event.type !== 'vault') throw new Error('no transfer')
      await vi.advanceTimersByTimeAsync(90_000)
      await rejected
      await event.acknowledge()
      expect(events.filter((e) => e.type === 'vault')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refusing during the presence prompt prevents release of the vault', async () => {
    const { payload, events } = pair()
    let release!: () => void
    const prompt = new Promise<void>((resolve) => { release = resolve })
    const sent: string[] = []
    setScanLoginDeps({ fetchImpl: lanFetch(sent), vault: () => transfer, confirm: () => prompt })
    await startScanLoginApproval(payload)
    await confirmScanLoginCode(payload.loginKey, shownCode(events))
    const sending = approveScanLogin(payload.loginKey)
    const rejected = expect(sending).rejects.toThrow(/ended/)
    await refuseScanLoginFor(payload.loginKey)
    release()
    await rejected
    expect(sent.some((body) => body.includes('sealedVault'))).toBe(false)
  })

  it('a new nonce cannot re-confirm a consumed code', async () => {
    const { payload, events } = pair()
    const conn = await helloScanLogin(payload, { label: 'Phone', fetchImpl: lanFetch() })
    await confirmPairingCode(conn, shownCode(events), lanFetch())
    await expect(confirmPairingCode(conn, '000000', lanFetch())).rejects.toMatchObject({ reason: 'replayed' })
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
    await expect(approveScanLogin(away.loginKey)).rejects.toThrow()
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
    subscribeScanLoginSession((e) => {
      events.push(e)
      if (e.type === 'vault') void e.acknowledge()
    })
    const stop = runScanLoginRelay({ fetchImpl, pollMs: 5 })
    const conn = await helloScanLogin(payload, { label: 'Phone', fetchImpl, relayMs: 3000 })
    expect(conn.url).toBe('relay')
    expect(events[0]).toMatchObject({ type: 'connected', approverLabel: 'Phone' })
    await confirmPairingCode(conn, shownCode(events), fetchImpl)
    await sendScanLoginVault(conn, transfer, fetchImpl)
    stop()
    expect(events.find((e) => e.type === 'vault')).toMatchObject({ type: 'vault', transfer: { master: transfer.master } })
  }, 15_000)

  it('a forged proof over the relay is refused', async () => {
    const fetchImpl = mailbox()
    const payload = startScanLoginSession({ urls: [], label: 'Windows PC' })
    const stop = runScanLoginRelay({ fetchImpl, pollMs: 5 })
    await expect(helloScanLogin({ ...payload, secret: '11'.repeat(32) }, { label: 'x', fetchImpl, relayMs: 3000 })).rejects.toThrow()
    stop()
  })
})


describe('typed pairing code (BRC-249): the code is typed, checked on the new device, and never travels', () => {
  const VAULT = '/handcash-device/v1/scan-login/vault'

  async function paired(fetchImpl = lanFetch()) {
    const { payload, events, off } = pair()
    const conn = await helloScanLogin(payload, { label: 'Mac', fetchImpl })
    return { payload, events, off, conn, fetchImpl }
  }

  it('a wrong code is refused and counted, and the vault stays closed', async () => {
    const { events, conn, fetchImpl, off } = await paired()
    const bad = wrongFor(shownCode(events))
    await expect(confirmPairingCode(conn, bad, fetchImpl)).rejects.toMatchObject({ reason: 'wrong', attemptsLeft: 2 })
    await expect(sendScanLoginVault(conn, transfer, fetchImpl)).rejects.toThrow()
    off()
    expect(events.some((event) => event.type === 'vault' || event.type === 'confirmed')).toBe(false)
  })

  it('three wrong codes lock the session for good, even for the right code', async () => {
    const { events, conn, fetchImpl, off } = await paired()
    const code = shownCode(events)
    const bad = wrongFor(code)
    await expect(confirmPairingCode(conn, bad, fetchImpl)).rejects.toMatchObject({ attemptsLeft: 2 })
    await expect(confirmPairingCode(conn, bad, fetchImpl)).rejects.toMatchObject({ attemptsLeft: 1 })
    await expect(confirmPairingCode(conn, bad, fetchImpl)).rejects.toMatchObject({ reason: 'locked' })
    await expect(confirmPairingCode(conn, code, fetchImpl)).rejects.toBeInstanceOf(PairingCodeRejected)
    await expect(sendScanLoginVault(conn, transfer, fetchImpl)).rejects.toThrow()
    off()
    expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'locked' })
    expect(events.some((event) => event.type === 'vault')).toBe(false)
  })

  it('a code older than two minutes is refused and ends the session', async () => {
    const { events, conn, fetchImpl, off } = await paired()
    const code = shownCode(events)
    vi.useFakeTimers({ now: Date.now() + 2 * 60_000 + 1 })
    try {
      await expect(confirmPairingCode(conn, code, fetchImpl)).rejects.toMatchObject({ reason: 'expired' })
    } finally {
      vi.useRealTimers()
    }
    await expect(sendScanLoginVault(conn, transfer, fetchImpl)).rejects.toThrow()
    off()
    expect(events.at(-1)).toMatchObject({ type: 'failed', reason: 'expired' })
  })

  it('a captured confirm request cannot be replayed', async () => {
    const seen: string[] = []
    const { events, conn, fetchImpl, off } = await paired(lanFetch(seen))
    await confirmPairingCode(conn, shownCode(events), fetchImpl)
    const captured = seen.at(-1)!
    expect(JSON.parse(captured).nonce).toBeTruthy()
    expect(captured).not.toContain(shownCode(events))
    const replay = handleScanLoginRequest({
      method: 'POST',
      path: '/handcash-device/v1/scan-login/confirm',
      body: captured,
    })
    off()
    expect(replay.status).toBe(409)
  })

  it('the vault is refused until the code is confirmed, then accepted once', async () => {
    const { payload, events, conn, fetchImpl, off } = await paired()
    const approverKey = conn.approverKey.toPublicKey().toString().toLowerCase()
    const early = handleScanLoginRequest({ method: 'POST', path: VAULT, body: JSON.stringify({ approverKey, sealedVault: 'x', proof: 'y' }) })
    expect(early.status).toBe(403)
    await confirmPairingCode(conn, shownCode(events), fetchImpl)
    await sendScanLoginVault(conn, transfer, fetchImpl)
    off()
    expect(events.map((event) => event.type)).toEqual(['connected', 'confirmed', 'vault'])
    expect(payload.secret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a second hello does not reset the code or the attempts', async () => {
    const { payload, events, conn, fetchImpl, off } = await paired()
    await expect(confirmPairingCode(conn, wrongFor(shownCode(events)), fetchImpl)).rejects.toMatchObject({ attemptsLeft: 2 })
    await expect(helloScanLogin(payload, { label: 'iPhone', fetchImpl })).rejects.toThrow(/already answered/)
    await expect(confirmPairingCode(conn, wrongFor(shownCode(events)), fetchImpl)).rejects.toMatchObject({ attemptsLeft: 1 })
    off()
  })

  it('the approver checks digits before sending anything', async () => {
    const sent: string[] = []
    setScanLoginDeps({ fetchImpl: lanFetch(sent), label: () => 'Mac', vault: () => transfer, confirm: async () => undefined })
    const { payload, events, off } = pair()
    await startScanLoginApproval(payload)
    sent.length = 0
    await expect(confirmScanLoginCode(payload.loginKey, '12 34')).rejects.toThrow(/6 numbers/)
    expect(sent).toEqual([])
    const wrong = await confirmScanLoginCode(payload.loginKey, wrongFor(shownCode(events)))
    expect(wrong).toMatchObject({ ok: false, ended: false, attemptsLeft: 2 })
    expect(listScanLoginRows()[0]?.pairing).toMatchObject({ attemptsLeft: 2, confirmed: false })
    off()
  })

  it('through the relay a wrong code is refused the same way', async () => {
    const boxes = new Map<string, { messageId: string; sender: string; body: string }[]>()
    let n = 0
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
    const payload = startScanLoginSession({ urls: [], label: 'Windows PC' })
    const events: ScanLoginEvent[] = []
    subscribeScanLoginSession((e) => events.push(e))
    const stop = runScanLoginRelay({ fetchImpl, pollMs: 5 })
    const conn = await helloScanLogin(payload, { label: 'Phone', fetchImpl, relayMs: 3000 })
    await expect(confirmPairingCode(conn, wrongFor(shownCode(events)), fetchImpl)).rejects.toMatchObject({ reason: 'wrong' })
    stop()
  })
})
