import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bapAddress, bapIdFor, bapKey } from './bapRecords'
import type { PresentedIdentityMaterial } from './publicIdentities'
import type { WalletRuntime } from './walletRuntime'

const mockMaterial = vi.hoisted(() => ({ value: null as PresentedIdentityMaterial | null }))
vi.mock('./publicIdentities', () => ({ presentedIdentityMaterial: () => mockMaterial.value }))

import { DevSigningKeyRefused, describeDevSigningKey, exportDevSigningKey } from './devSigningKey'

const master = PrivateKey.fromRandom()
const runtime = (chain: 'main' | 'test' = 'main') => ({ instance: { chain } }) as unknown as WalletRuntime

function presented(seq: number): PresentedIdentityMaterial {
  return {
    kind: 'presented',
    issuedAt: '2026-10-03T00:00:00.000Z',
    pkg: { v: 1, bapId: bapIdFor(master), beefB64: '' },
    identity: {
      bapId: bapIdFor(master),
      name: 'Dev',
      rootAddress: bapAddress(master, 0),
      keys: Array.from({ length: seq }, (_, i) => ({ seq: i + 1, address: bapAddress(master, i + 1) })),
      alias: { txid: '00'.repeat(32), signer: bapAddress(master, seq) },
    } as unknown as Extract<PresentedIdentityMaterial, { kind: 'presented' }>['identity'],
    signingKey: bapKey(master, seq),
  }
}

describe('developer key', () => {
  beforeEach(() => {
    mockMaterial.value = null
  })

  it('exports the current BAP signing key, never the identity master or root', () => {
    mockMaterial.value = presented(2)
    const key = exportDevSigningKey(runtime())
    const exported = PrivateKey.fromWif(key.wif)
    expect(key.seq).toBe(2)
    expect(exported.toAddress()).toBe(bapAddress(master, 2))
    expect(key.address).toBe(bapAddress(master, 2))
    expect(exported.toHex()).not.toBe(master.toHex())
    expect(exported.toHex()).not.toBe(bapKey(master, 0).toHex())
  })

  it('describes the key without the secret', () => {
    mockMaterial.value = presented(1)
    const described = describeDevSigningKey(runtime())
    expect(described).toMatchObject({ kind: 'ready', key: { seq: 1, address: bapAddress(master, 1) } })
    expect(JSON.stringify(described)).not.toContain(bapKey(master, 1).toWif())
  })

  it('uses the testnet WIF prefix on test chain', () => {
    mockMaterial.value = presented(1)
    expect(exportDevSigningKey(runtime('test')).wif).toBe(bapKey(master, 1).toWif([0xef]))
  })

  it('refuses before an identity is published, after it is withdrawn, and for the root', () => {
    expect(() => exportDevSigningKey(runtime())).toThrow(DevSigningKeyRefused)
    expect(describeDevSigningKey(runtime())).toMatchObject({ kind: 'refused', reason: 'not-published' })

    mockMaterial.value = { kind: 'withdrawn', issuedAt: '2026-10-03T00:00:00.000Z' }
    expect(describeDevSigningKey(runtime())).toMatchObject({ kind: 'refused', reason: 'revoked' })

    const root = presented(1)
    if (root.kind === 'presented') root.identity.keys = [{ seq: 0, address: bapAddress(master, 0) }] as never
    mockMaterial.value = root
    expect(describeDevSigningKey(runtime())).toMatchObject({ kind: 'refused', reason: 'root-key' })
  })
})
