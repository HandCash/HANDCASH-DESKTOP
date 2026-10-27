import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeyDeriver, PrivateKey, ProtoWallet, PublicKey, WalletWireProcessor, WalletWireTransceiver, type WalletInterface } from '@bsv/sdk'
import { sdk } from '@handcash/wallet-engine'
import { dispatchEcpm, clearEcpmPermissions } from './ecpm'
import { dispatchWalletMethod, handleBrc100Request } from './brc100Handler'
import { allowOrigin, cancelPendingPermissions, clearPermissionSession, resolvePermission, subscribePermissionRequests, type PendingPrompt } from './permissions'
import { disposeWalletRuntime, getWalletRuntime, installWalletRuntime, resetWalletRuntimeForTests } from './walletRuntime'
import type { ActiveWallet } from './session'

let off: () => void
let prompt: PendingPrompt | null
let wallet: ProtoWallet
const point = new PrivateKey(31).toPublicKey().toString()
const args = (operation = 'apply', p = point, extra = {}) => ({ protocolID: [2, `p ecpm ${operation} ${p} mental poker deal`] as [2, string], keyID: 'deck', counterparty: 'self', ...extra })
function activate(next = new ProtoWallet(new KeyDeriver(new PrivateKey(17)))) {
  wallet = next
  return installWalletRuntime({ wallet, identityKey: new PrivateKey(17).toPublicKey().toString(), accountIndex: 0, chain: 'main' } as unknown as ActiveWallet)
}
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
async function approve<T>(pending: Promise<T>): Promise<T> {
  await tick()
  expect(prompt?.kind).toBe('action')
  if (prompt?.kind !== 'action') throw new Error('Missing ECPM consent')
  expect(prompt.title).toBe('Point masking')
  expect(prompt.summary).toContain('all key IDs')
  expect(prompt.details.join(' ')).toContain('security level: 2')
  resolvePermission(prompt.id, 'allow')
  return pending
}
beforeEach(() => {
  clearEcpmPermissions(); resetWalletRuntimeForTests(); cancelPendingPermissions()
  vi.stubGlobal('window', {})
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) })
  prompt = null
  off = subscribePermissionRequests(value => { prompt = value })
  activate()
})
afterEach(() => { vi.restoreAllMocks(); disposeWalletRuntime('test'); clearEcpmPermissions(); cancelPendingPermissions(); off(); vi.unstubAllGlobals() })

describe('HandCash shared Desktop/Mobile ECPM path', () => {
  it('dispatches semantically, matches an independent scalar oracle, removes masks and preserves ordinary keys', async () => {
    const ordinary = vi.spyOn(wallet, 'getPublicKey')
    const masked = await approve(dispatchWalletMethod(wallet, 'getPublicKey', args(), 'game.example')) as { publicKey: string }
    const d = new KeyDeriver(new PrivateKey(17)).derivePrivateKey([2, 'p ecpm mental poker deal'], 'deck', 'self')
    expect(masked).toEqual({ publicKey: PublicKey.fromString(point).mul(d).encode(true, 'hex') })
    expect(ordinary).not.toHaveBeenCalled()
    expect(await dispatchWalletMethod(wallet, 'getPublicKey', args('remove', masked.publicKey), 'game.example')).toEqual({ publicKey: point })
    expect(await dispatchWalletMethod(wallet, 'getPublicKey', { protocolID: [0, 'ordinary keys'], keyID: 'one', counterparty: 'self' }, 'game.example')).toHaveProperty('publicKey')
    expect(ordinary).toHaveBeenCalledTimes(1)
  })

  it('works through binary BRC-100 and the JSON socket/in-app handler', async () => {
    const adapter = new Proxy(wallet, { get: (target, key) => key === 'getPublicKey' ? (a: unknown, o: string) => dispatchWalletMethod(wallet, 'getPublicKey', a, o) : Reflect.get(target, key) })
    const binary = new WalletWireTransceiver(new WalletWireProcessor(adapter as WalletInterface))
    const masked = await approve(binary.getPublicKey(args(), 'game.example'))
    expect((await binary.getPublicKey(args('remove', masked.publicKey), 'game.example')).publicKey).toBe(point)
    allowOrigin('game.example')
    const response = await handleBrc100Request({ method: 'POST', path: '/getPublicKey', headers: { originator: 'game.example', origin: 'https://game.example' }, body: JSON.stringify(args('remove', masked.publicKey)), request_id: 1 }, getWalletRuntime())
    expect(response.status, response.body).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ publicKey: point })
  })

  it('requires ECPM consent despite an existing connection; denies invalid calls and unrelated schemes', async () => {
    allowOrigin('game.example')
    const denied = dispatchWalletMethod(wallet, 'getPublicKey', args(), 'game.example')
    const rejection = expect(denied).rejects.toThrow(/denied/)
    await tick(); expect(prompt).not.toBeNull(); resolvePermission(prompt!.id, 'deny'); await rejection
    for (const extra of [{ seekPermission: false }, { identityKey: true }, { forSelf: true }, { protocolID: [2, `p ecpm apply ${'02' + 'f'.repeat(64)} mental poker deal`] }]) {
      await expect(dispatchWalletMethod(wallet, 'getPublicKey', args('apply', point, extra), 'game.example')).rejects.toThrow()
    }
    await expect(dispatchWalletMethod(wallet, 'encrypt', { ...args(), plaintext: [1] }, 'game.example')).rejects.toThrow(/permission scheme/)
    await expect(dispatchWalletMethod(wallet, 'getPublicKey', { ...args(), protocolID: [2, 'p unknown operation'] }, 'game.example')).rejects.toThrow(/permission scheme/)
  })

  it('drops cached/pending grants on account replacement, lock and app permission revocation', async () => {
    await approve(dispatchEcpm(wallet, args(), 'game.example'))
    clearPermissionSession('game.example')
    await expect(dispatchEcpm(wallet, args('apply', point, { seekPermission: false }), 'game.example')).rejects.toThrow(/permission/)
    const pending = dispatchEcpm(wallet, args(), 'game.example'); const rejected = expect(pending).rejects.toThrow()
    await tick(); const old = prompt!.id; activate(); await rejected
    expect(resolvePermission(old, 'allow')).toBe(false)
    expect(prompt).toBeNull()
    disposeWalletRuntime('locked')
    await expect(dispatchEcpm(wallet, args(), 'game.example')).rejects.toThrow(/unlocked/)
  })

  it('honors privileged key policy and rejects an unlock completed after account replacement', async () => {
    const manager = new sdk.PrivilegedKeyManager(async () => new PrivateKey(23), 1)
    Object.assign(wallet, { privilegedKeyManager: manager })
    const privilegedArgs = args('apply', point, { privileged: true, privilegedReason: 'Protected shuffle' })
    const masked = await approve(dispatchEcpm(wallet, privilegedArgs, 'game.example')) as { publicKey: string }
    const d = new KeyDeriver(new PrivateKey(23)).derivePrivateKey([2, 'p ecpm mental poker deal'], 'deck', 'self')
    expect(masked.publicKey).toBe(PublicKey.fromString(point).mul(d).encode(true, 'hex'))
    manager.destroyKey()
    clearEcpmPermissions()
    let release: (key: PrivateKey) => void = () => {}
    Object.assign(wallet, { privilegedKeyManager: { getPrivilegedKey: () => new Promise<PrivateKey>(resolve => { release = resolve }) } })
    const late = dispatchEcpm(wallet, privilegedArgs, 'game.example'); const rejected = expect(late).rejects.toThrow(/session changed/)
    await tick(); resolvePermission(prompt!.id, 'allow'); await tick(); activate(); release(new PrivateKey(23)); await rejected
  })

  it('times out abandoned consent and coalesces a same-scope burst into one prompt', async () => {
    vi.useFakeTimers()
    try {
      const first = dispatchEcpm(wallet, args(), 'game.example')
      const second = dispatchEcpm(wallet, args('apply', point, { keyID: 'other deck' }), 'game.example')
      const refused = Promise.all([expect(first).rejects.toThrow(/denied/), expect(second).rejects.toThrow(/denied/)])
      await tick(); const id = prompt!.id
      await vi.advanceTimersByTimeAsync(120_000)
      await refused
      expect(prompt).toBeNull()
      expect(resolvePermission(id, 'allow')).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('supports full-length protocols; expires grants and refuses without a prompt host', async () => {
    const name = 'mental poker deal'.padEnd(273, 'x')
    const longArgs = { ...args(), protocolID: [2, `p ecpm apply ${point} ${name}`] }
    await approve(dispatchEcpm(wallet, longArgs, 'game.example'))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001)
    await expect(dispatchEcpm(wallet, { ...longArgs, seekPermission: false }, 'game.example')).rejects.toThrow(/permission/)
    vi.restoreAllMocks(); off(); off = () => {}
    await expect(dispatchEcpm(wallet, args(), 'other.example')).rejects.toThrow(/denied/)
  })
})
