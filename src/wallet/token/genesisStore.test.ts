import { Beef, LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { durableForgetCached, durableRemoveItem } from '../durableStorage'
import { storageRegistry } from '../../storage/registry'
import {
  holdTokenGenesis,
  resetTokenGenesisForTests,
  retainTokenGenesis,
  retainedTokenGenesis,
} from './genesisStore'

/** A deploy-sized transaction: one output carrying `bytes` of script. */
function deploy(seed: number, bytes: number): { beef: Beef; txid: string } {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: seed.toString(16).padStart(64, '0'),
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  })
  const len = bytes.toString(16).padStart(4, '0')
  tx.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(
      `6a4d${len.slice(2)}${len.slice(0, 2)}${(seed & 0xff).toString(16).padStart(2, '0').repeat(bytes)}`,
    ),
  })
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  return { beef, txid: tx.id('hex') }
}

describe('token genesis store', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetTokenGenesisForTests()
    durableRemoveItem(storageRegistry.tokenGenesis.key)
    durableForgetCached()
  })

  it('evicts deploys no list holds before the deploys of held tokens', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const heldDeploy = deploy(1, 60 * 1024)
    holdTokenGenesis([heldDeploy.txid])
    expect(await retainTokenGenesis(heldDeploy.beef, heldDeploy.txid, null)).toBe(true)

    // Sixteen unheld deploys (~80KB of base64 each) push the store over 1MB.
    const others = Array.from({ length: 16 }, (_, i) => deploy(10 + i, 60 * 1024))
    for (const other of others) {
      expect(await retainTokenGenesis(other.beef, other.txid, null)).toBe(true)
    }

    expect(retainedTokenGenesis(heldDeploy.txid)).not.toBeNull()
    expect(retainedTokenGenesis(others[0]!.txid)).toBeNull()
    expect(retainedTokenGenesis(others.at(-1)!.txid)).not.toBeNull()
  })
})
