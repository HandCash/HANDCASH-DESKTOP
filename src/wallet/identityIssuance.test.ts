import type { WalletRuntime } from './walletRuntime'
import { Beef, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveWallet } from './session'
const state = vi.hoisted(() => ({
  active: null as ActiveWallet | null,
  values: new Map<string, string>(),
}))
vi.mock('./walletRuntime', () => ({
  runtimeIsCurrent: (runtime: WalletRuntime) =>
    runtime.instance === state.active,
}))
function runtime(): WalletRuntime {
  return { instance: state.active } as WalletRuntime
}
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => state.values.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    state.values.set(key, value)
    return true
  },
}))
vi.mock('./beefCache', () => ({
  rememberBeefBinary: vi.fn(),
  hydrateInputBeef: async (_active: unknown, beef: Beef) => beef.toBinary(),
  buildMergedInputBeef: vi.fn(),
}))
import {
  enrichIdentityIssuance,
  finishIdentityIssuance,
  releaseIdentityIssuance,
} from './identityIssuance'
import { issuerMetadataFromScript } from './issuerMetadata'
import { sigmaSignDeployLockingScript, verifySigmaIssuer } from './token/issuer'
import {
  importIssuerPrivateKey,
  removePublicIdentity,
  saveWalletPublicIdentity,
  selectPublicIdentity,
} from './publicIdentities'
import { encodeBsv21Binary } from './token/decode162'

const root = PrivateKey.fromHex('01'.padStart(64, '0'))
const issuer = PrivateKey.fromHex('02'.padStart(64, '0'))
const fields = {
  displayName: 'Studio',
  icon: 'https://example.test/studio.png',
  description: 'Collectibles and awards',
}
const lock = new P2PKH().lock(root.toAddress()).toHex()
function sourceBeef(): { tx: number[]; txid: string } {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: 'ab'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromHex(''),
  })
  tx.addOutput({ satoshis: 2, lockingScript: Script.fromHex(lock) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { tx: beef.toBinary(), txid: tx.id('hex') }
}
function nftArgs() {
  const script = new Script()
  script.writeOpCode(0x00)
  script.writeOpCode(0x63)
  script.writeBin(Utils.toArray('ord'))
  script.writeOpCode(0x51)
  script.writeBin(Utils.toArray('text/plain'))
  script.writeOpCode(0x00)
  script.writeBin(Utils.toArray('Award #1'))
  script.writeOpCode(0x68)
  const lockingScript = script.toHex() + lock
  return {
    description: 'Issue award',
    outputs: [
      {
        lockingScript,
        satoshis: 1,
        basket: '1sat',
        tags: ['ordinal', 'issuer:' + root.toPublicKey().toString()],
        customInstructions: JSON.stringify({ name: 'Award #1', app: 'Studio' }),
      },
    ],
  }
}
beforeEach(() => {
  state.values.clear()
  state.active = {
    identityKey: root.toPublicKey().toString(),
    rootKeyHex: root.toHex().padStart(64, '0'),
    chain: 'main',
    accountIndex: 0,
    wallet: {
      createAction: vi.fn(async () => sourceBeef()),
      listOutputs: vi.fn(async () => ({ outputs: [] })),
      signAction: vi.fn(),
      abortAction: vi.fn(async () => ({ aborted: true })),
    },
  } as unknown as ActiveWallet
  saveWalletPublicIdentity(runtime(), fields)
})
function boundTransaction(
  args: Awaited<ReturnType<typeof enrichIdentityIssuance>>,
): Transaction {
  const tx = new Transaction()
  const [txid, vout] = args.inputs![0]!.outpoint.split('.')
  tx.addInput({
    sourceTXID: txid!,
    sourceOutputIndex: Number(vout),
    unlockingScript: Script.fromHex(''),
  })
  for (const out of args.outputs!)
    tx.addOutput({
      satoshis: out.satoshis!,
      lockingScript: Script.fromHex(out.lockingScript!),
    })
  return tx
}
describe('standard issuer-backed minting', () => {
  it('requires a human profile before preparing an anchor', async () => {
    removePublicIdentity(runtime(), root.toPublicKey().toString())
    await expect(enrichIdentityIssuance(runtime(), nftArgs())).rejects.toThrow(
      /display name and icon/,
    )
    expect(state.active!.wallet.createAction).not.toHaveBeenCalled()
  })
  it('signs mixed NFT and FT genesis outputs under one issuer and one anchor', async () => {
    const id = root.toPublicKey().toString()
    const args = await enrichIdentityIssuance(
      runtime(),
      {
        outputs: [
          ...nftArgs().outputs,
          {
            satoshis: 1,
            basket: 'bsv21',
            tags: ['op:deploy+mint'],
            customInstructions: JSON.stringify({
              op: 'deploy+mint',
              amt: '10',
            }),
            lockingScript: encodeBsv21Binary({
              amount: 10n,
              payload: { sym: 'MIX' },
              rest: lock,
            }).toHex(),
          },
        ],
      },
      id,
    )
    const tx = boundTransaction(args)
    for (let i = 0; i < 2; i++) {
      expect(verifySigmaIssuer(tx, i, id)).toBe(true)
      expect(
        issuerMetadataFromScript(args.outputs![i]!.lockingScript).issuerProfile
          ?.identityKey,
      ).toBe(id)
    }
    expect(state.active!.wallet.createAction).toHaveBeenCalledTimes(1)
  })
  it('uses the SDK anchor flow and the selected imported key for an NFT, while funding stays with the wallet', async () => {
    const id = importIssuerPrivateKey(
      runtime(),
      issuer.toHex().padStart(64, '0'),
      fields,
    )
    selectPublicIdentity(runtime(), id)
    const args = await enrichIdentityIssuance(runtime(), nftArgs(), id)
    expect(state.active!.wallet.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ noSend: true }),
        outputs: [
          expect.objectContaining({
            basket: 'sigma',
            satoshis: 2,
            lockingScript: lock,
          }),
        ],
      }),
    )
    expect(args.options?.sendWith).toEqual([
      args.inputs![0]!.outpoint.split('.')[0],
    ])
    const out = args.outputs![0]!
    expect(out.tags?.filter((tag) => tag.startsWith('issuer:'))).toEqual([
      `issuer:${id}`,
    ])
    expect(JSON.parse(out.customInstructions!).issuer).toBe(id)
    const metadata = issuerMetadataFromScript(out.lockingScript)
    expect(metadata.issuer).toBe(id)
    expect(metadata.issuerProfile?.displayName).toBe('Studio')
    expect(verifySigmaIssuer(boundTransaction(args), 0, id)).toBe(true)
    expect(
      verifySigmaIssuer(
        boundTransaction(args),
        0,
        root.toPublicKey().toString(),
      ),
    ).toBe(false)
  })
  it('signs a BRC-162 fungible genesis with the same profile and Sigma wire', async () => {
    saveWalletPublicIdentity(runtime(), fields)
    const id = root.toPublicKey().toString()
    const args = await enrichIdentityIssuance(
      runtime(),
      {
        outputs: [
          {
            satoshis: 1,
            basket: 'bsv21',
            tags: ['op:deploy+mint', 'sym:TEST'],
            customInstructions: JSON.stringify({
              op: 'deploy+mint',
              amt: '1000',
              sym: 'TEST',
            }),
            lockingScript: encodeBsv21Binary({
              amount: 1000n,
              payload: { sym: 'TEST' },
              rest: lock,
            }).toHex(),
          },
        ],
      },
      id,
    )
    expect(
      issuerMetadataFromScript(args.outputs![0]!.lockingScript).issuerProfile
        ?.identityKey,
    ).toBe(id)
    expect(verifySigmaIssuer(boundTransaction(args), 0, id)).toBe(true)
  })
  it('rejects changed selection after consent or during anchor creation, and never returns an unsigned mint', async () => {
    const id = importIssuerPrivateKey(
      runtime(),
      issuer.toHex().padStart(64, '0'),
      fields,
    )
    await expect(
      enrichIdentityIssuance(runtime(), nftArgs(), id),
    ).rejects.toThrow(/changed after approval/)
    expect(state.active!.wallet.createAction).not.toHaveBeenCalled()
    vi.mocked(state.active!.wallet.createAction).mockImplementation(
      async () => {
        selectPublicIdentity(runtime(), id)
        return sourceBeef()
      },
    )
    await expect(
      enrichIdentityIssuance(
        runtime(),
        nftArgs(),
        root.toPublicKey().toString(),
      ),
    ).rejects.toThrow(/changed after approval/)
    expect(state.active!.wallet.abortAction).toHaveBeenCalledWith({
      reference: sourceBeef().txid,
    })
  })
  it('releases the signable mint and its anchor when the mint fails before broadcast', async () => {
    const args = await enrichIdentityIssuance(runtime(), nftArgs())
    const created = { signableTransaction: { tx: [], reference: 'mint-ref' } }
    await releaseIdentityIssuance(runtime(), args, created)
    expect(vi.mocked(state.active!.wallet.abortAction).mock.calls).toEqual([
      [{ reference: 'mint-ref' }],
      [{ reference: sourceBeef().txid }],
    ])
    vi.mocked(state.active!.wallet.abortAction).mockClear()
    await releaseIdentityIssuance(runtime(), args, created)
    await releaseIdentityIssuance(runtime(), nftArgs())
    expect(state.active!.wallet.abortAction).not.toHaveBeenCalled()
  })
  it('does not re-sign transfers, and refuses malformed fresh items before funding', async () => {
    const transfer = {
      ...nftArgs(),
      inputs: [{ outpoint: `${'ab'.repeat(32)}.0` }],
    }
    expect(await enrichIdentityIssuance(runtime(), transfer)).toBe(transfer)
    await expect(
      enrichIdentityIssuance(runtime(), {
        outputs: [{ satoshis: 1, basket: '1sat', lockingScript: lock }],
      }),
    ).rejects.toThrow(/ord inscription/)
    expect(state.active!.wallet.createAction).not.toHaveBeenCalled()
  })
  it('verifies the real input binding and rejects script tampering', () => {
    const tx = new Transaction()
    tx.addInput({
      sourceTXID: 'ab'.repeat(32),
      sourceOutputIndex: 1,
      unlockingScript: Script.fromHex(''),
    })
    tx.addOutput({
      satoshis: 1,
      lockingScript: Script.fromHex(
        sigmaSignDeployLockingScript({
          lockingScriptHex: lock,
          fundTxid: 'ab'.repeat(32),
          fundVout: 1,
          identityKeyHex: root.toHex(),
        }),
      ),
    })
    expect(verifySigmaIssuer(tx, 0, root.toPublicKey().toString())).toBe(true)
    tx.inputs[0]!.sourceOutputIndex = 2
    expect(verifySigmaIssuer(tx, 0, root.toPublicKey().toString())).toBe(false)
    tx.inputs[0]!.sourceOutputIndex = 1
    tx.outputs[0]!.lockingScript = Script.fromHex(
      tx.outputs[0]!.lockingScript.toHex().replace(
        lock,
        new P2PKH().lock(issuer.toAddress()).toHex(),
      ),
    )
    expect(verifySigmaIssuer(tx, 0, root.toPublicKey().toString())).toBe(false)
  })
  it('completes the root-funded anchor without exposing the issuer private key to the app', async () => {
    const args = await enrichIdentityIssuance(runtime(), nftArgs())
    const tx = boundTransaction(args)
    const beef = Beef.fromBinary(args.inputBEEF!)
    beef.mergeTransaction(tx)
    vi.mocked(state.active!.wallet.signAction).mockResolvedValue({
      txid: tx.id('hex'),
    })
    const result = await finishIdentityIssuance(runtime(), args, {
      signableTransaction: { tx: beef.toBinary(), reference: 'mint-reference' },
    })
    expect(result).toHaveProperty('txid')
    expect(result).not.toHaveProperty('signableTransaction')
    expect(state.active!.wallet.signAction).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: 'mint-reference',
        spends: { 0: { unlockingScript: expect.any(String) } },
      }),
    )
  })
})
