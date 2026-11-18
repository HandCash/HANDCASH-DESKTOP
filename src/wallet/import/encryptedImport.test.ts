import { beforeEach, describe, expect, it, vi } from 'vitest'

let active: { identityKey: string; chain: string } | null = { identityKey: 'id-a', chain: 'main' }
const writes: unknown[] = []
let beforeAuthorize: (() => void) | null = null

const perms = vi.hoisted(() => ({
  isOriginAllowed: vi.fn((_origin: string) => true),
  requestActionApproval: vi.fn(async (_origin: string, _method: string, _args: unknown): Promise<'allow' | 'deny'> => 'allow'),
  withdrawActionPrompts: vi.fn(),
}))

vi.mock('../permissions', () => perms)
vi.mock('../session', () => ({ getActiveWallet: () => active }))
vi.mock('../appIdentity', () => ({
  normalizeAppHost: (origin: string) => (origin.includes('://') ? new URL(origin).host : origin),
}))
vi.mock('./store', () => ({
  addImportedSource: vi.fn(async (secret: unknown, _label: unknown, _id: string, _chain: string, authorize?: () => void) => {
    beforeAuthorize?.()
    authorize?.()
    writes.push(secret)
    return { source: { id: 'source-1' }, existing: false }
  }),
}))
vi.mock('./importSource', () => ({
  parseImportSecret: (_kind: string, f: { primary: string; secondary: string }) =>
    ({ ok: true, secret: { kind: 'handcash', first: f.primary, second: f.secondary } }),
}))
vi.mock('./recoveryHints', () => ({ parseRecoveryHints: () => null, rememberRecoveryHints: vi.fn() }))
vi.mock('./importIntent', () => ({ requestImportedSource: vi.fn() }))
vi.mock('../navStore', () => ({ openSetting: vi.fn() }))

import {
  beginHandCashImport,
  clearEncryptedImports,
  completeHandCashImport,
  handCashImportContext,
  pendingImportReviews,
  revokeEncryptedImports,
  type HandCashImportRequest,
} from './encryptedImport'

const ORIGIN = 'https://market.handcash.io'
const HOST = 'market.handcash.io'
const enc = new TextEncoder()
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** The sending app's side: seal shares to the receiver descriptor. */
async function seal(request: HandCashImportRequest, body: unknown = { cloud: 'share-one', trustholder: 'share-two' }) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const peer = await crypto.subtle.importKey('raw', unb64(request.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, 256)
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const context = enc.encode(handCashImportContext(request))
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(request.id), info: context },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context }, key, enc.encode(JSON.stringify(body)))
  return { id: request.id, publicKey: b64(await crypto.subtle.exportKey('raw', pair.publicKey)), iv: b64(iv), ciphertext: b64(ct) }
}

/** An approval the test releases by hand, to act while the review waits. */
function holdApproval() {
  let release!: (d: 'allow' | 'deny') => void
  perms.requestActionApproval.mockImplementationOnce(() => new Promise((r) => { release = r }))
  return (d: 'allow' | 'deny') => release(d)
}

const waitForPrompt = () => vi.waitFor(() => expect(perms.requestActionApproval).toHaveBeenCalled())

describe('encrypted HandCash import (Packet F write gate)', () => {
  beforeEach(() => {
    clearEncryptedImports()
    vi.restoreAllMocks()
    perms.isOriginAllowed.mockReset().mockReturnValue(true)
    perms.requestActionApproval.mockReset().mockResolvedValue('allow')
    perms.withdrawActionPrompts.mockReset()
    active = { identityKey: 'id-a', chain: 'main' }
    writes.length = 0
    beforeAuthorize = null
  })

  it('saves once after the user approves, and an identical retry neither prompts nor writes again', async () => {
    const request = await beginHandCashImport(ORIGIN)
    const delivery = await seal(request)
    const receipt = await completeHandCashImport(ORIGIN, delivery)
    expect(receipt).toEqual({ sourceId: 'source-1', saved: true, existing: false })
    expect(await completeHandCashImport(ORIGIN, delivery)).toEqual(receipt)
    expect(perms.requestActionApproval).toHaveBeenCalledTimes(1)
    expect(perms.requestActionApproval).toHaveBeenCalledWith(HOST, 'completeHandCashImport', { identityKey: 'id-a', chain: 'main' })
    expect(writes).toHaveLength(1)
  })

  it('a different ciphertext for a used receiver is refused', async () => {
    const request = await beginHandCashImport(ORIGIN)
    await completeHandCashImport(ORIGIN, await seal(request))
    await expect(completeHandCashImport(ORIGIN, await seal(request))).rejects.toThrow('already used')
    expect(writes).toHaveLength(1)
  })

  it('a denied review writes nothing', async () => {
    perms.requestActionApproval.mockResolvedValue('deny')
    const request = await beginHandCashImport(ORIGIN)
    await expect(completeHandCashImport(ORIGIN, await seal(request))).rejects.toMatchObject({ code: 'IMPORT_REVIEW_DENIED' })
    expect(writes).toHaveLength(0)
  })

  it('a host without a grant is refused before any prompt', async () => {
    const request = await beginHandCashImport(ORIGIN)
    perms.isOriginAllowed.mockReturnValue(false)
    await expect(completeHandCashImport(ORIGIN, await seal(request))).rejects.toMatchObject({ code: 'IMPORT_REVIEW_REVOKED' })
    expect(perms.requestActionApproval).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  it('a forged origin cannot deliver to another host’s receiver', async () => {
    const request = await beginHandCashImport(ORIGIN)
    await expect(completeHandCashImport('https://evil.example', await seal(request))).rejects.toThrow('Connect again')
    expect(perms.requestActionApproval).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  it('an expired receiver is refused', async () => {
    const request = await beginHandCashImport(ORIGIN)
    const delivery = await seal(request)
    vi.spyOn(Date, 'now').mockReturnValue(request.expiresAt + 1)
    await expect(completeHandCashImport(ORIGIN, delivery)).rejects.toThrow('Connect again')
    expect(writes).toHaveLength(0)
  })

  it('a review still open at the deadline expires and its prompt is withdrawn', async () => {
    const request = await beginHandCashImport(ORIGIN)
    const delivery = await seal(request)
    holdApproval()
    vi.spyOn(Date, 'now').mockReturnValue(request.expiresAt - 20)
    await expect(completeHandCashImport(ORIGIN, delivery)).rejects.toMatchObject({ code: 'IMPORT_REVIEW_EXPIRED' })
    expect(perms.withdrawActionPrompts).toHaveBeenCalledWith(HOST, 'completeHandCashImport')
    expect(writes).toHaveLength(0)
  })

  it('a delivery into another account or network is refused', async () => {
    const request = await beginHandCashImport(ORIGIN)
    const delivery = await seal(request)
    active = { identityKey: 'id-b', chain: 'main' }
    await expect(completeHandCashImport(ORIGIN, delivery)).rejects.toThrow('Connect again')
    active = { identityKey: 'id-a', chain: 'test' }
    await expect(completeHandCashImport(ORIGIN, delivery)).rejects.toThrow('Connect again')
    expect(writes).toHaveLength(0)
  })

  it('switching account while the review waits refuses the approval', async () => {
    const request = await beginHandCashImport(ORIGIN)
    const release = holdApproval()
    const result = completeHandCashImport(ORIGIN, await seal(request))
    await waitForPrompt()
    active = { identityKey: 'id-b', chain: 'main' }
    release('allow')
    await expect(result).rejects.toMatchObject({ code: 'IMPORT_REVIEW_REVOKED' })
    expect(writes).toHaveLength(0)
  })

  it('disconnecting the host while the review waits refuses it and withdraws the prompt', async () => {
    const request = await beginHandCashImport(ORIGIN)
    const release = holdApproval()
    const result = completeHandCashImport(ORIGIN, await seal(request))
    await waitForPrompt()
    expect(pendingImportReviews()).toEqual([{ host: HOST, expiresAt: request.expiresAt }])
    revokeEncryptedImports(HOST)
    release('allow')
    await expect(result).rejects.toMatchObject({ code: 'IMPORT_REVIEW_REVOKED' })
    expect(perms.withdrawActionPrompts).toHaveBeenCalledWith(HOST, 'completeHandCashImport')
    expect(pendingImportReviews()).toEqual([])
    expect(writes).toHaveLength(0)
  })

  it('locking during decryption refuses the delivery before any prompt', async () => {
    const request = await beginHandCashImport(ORIGIN)
    const result = completeHandCashImport(ORIGIN, await seal(request))
    clearEncryptedImports()
    await expect(result).rejects.toMatchObject({ code: 'IMPORT_REVIEW_REVOKED' })
    expect(perms.requestActionApproval).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  it('a revoke that lands during the write is refused by the store’s last check', async () => {
    const request = await beginHandCashImport(ORIGIN)
    beforeAuthorize = () => revokeEncryptedImports(HOST)
    await expect(completeHandCashImport(ORIGIN, await seal(request))).rejects.toMatchObject({ code: 'IMPORT_SAVE_FAILED' })
    expect(writes).toHaveLength(0)
  })

  it('tampered ciphertext never reaches the review', async () => {
    const request = await beginHandCashImport(ORIGIN)
    const delivery = await seal(request)
    const ct = unb64(delivery.ciphertext)
    ct[0] = ct[0]! ^ 1
    await expect(completeHandCashImport(ORIGIN, { ...delivery, ciphertext: b64(ct) })).rejects.toMatchObject({ code: 'IMPORT_SAVE_FAILED' })
    expect(perms.requestActionApproval).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })
})
