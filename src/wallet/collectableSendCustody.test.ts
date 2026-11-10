import { readFileSync } from 'node:fs'
import { P2PKH, PrivateKey } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { ActiveWallet } from './session'
import { brc29PrivateKey } from './brc29Keys'
import { lockHolder, tipKeyFromInstructions, tipSigningKey } from './tipKeys'

const source = readFileSync(new URL('./collectables.ts', import.meta.url), 'utf8')

describe('collectable send custody metadata', () => {
  it('reads the exact held row even for cached single and bulk selections', () => {
    const single = source.slice(source.indexOf('export async function sendCollectable('), source.indexOf('await assertOrdinalIsDeviceLocked(tipLockingScript'))
    expect(single).toContain('const heldRow = await readHeldItemRow(')
    expect(single).toContain('const match: HeldOutput | undefined = heldRow')
    expect(single).toContain('customInstructions: heldRow.customInstructions')
    const bulk = source.slice(source.indexOf('const cached = cachedNow.get(outpoint)'))
    expect(bulk).toContain('const heldRow = await readHeldItemRow(')
    expect(bulk).toContain('cached && heldRow')
    expect(bulk).toContain('customInstructions: heldRow.customInstructions')
  })
  it('recovers a child key from exact-row instructions without a basket scan', async () => {
    const root = PrivateKey.fromHex('33'.repeat(32))
    const remittance = {
      derivationPrefix: 'imported-send-custody',
      derivationSuffix: 'selected-tip',
      senderIdentityKey: PrivateKey.fromHex('44'.repeat(32)).toPublicKey().toString(),
    }
    const key = brc29PrivateKey(root, remittance)
    const listOutputs = vi.fn(async () => { throw new Error('no basket scan') })
    const wallet = {
      identityKey: root.toPublicKey().toString(), rootKeyHex: root.toHex(),
      address: root.toAddress(), wallet: { listOutputs },
    } as unknown as ActiveWallet
    const script = new P2PKH().lock(key.toAddress()).toHex()
    expect(lockHolder(wallet, script)).toBe('other')
    tipKeyFromInstructions(wallet, JSON.stringify(remittance))
    expect(lockHolder(wallet, script)).toBe('derived')
    expect((await tipSigningKey(wallet, script)).toHex()).toBe(key.toHex())
    expect(listOutputs).not.toHaveBeenCalled()
    expect(lockHolder(wallet, new P2PKH().lock(PrivateKey.fromHex('55'.repeat(32)).toAddress()).toHex())).toBe('other')
  })
})
