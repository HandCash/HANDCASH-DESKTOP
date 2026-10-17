import type { WalletRuntime } from './walletRuntime'
import { Beef, Hash, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
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
  durableRemoveItem: (key: string) => {
    state.values.delete(key)
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
  prepareUnsignedIssuance,
  releaseIdentityIssuance,
} from './identityIssuance'
import { brc162StampFromScript, issuerMetadataFromScript } from './issuerMetadata'
import { issuerFromRemittance, sigmaSignDeployLockingScript, verifySigmaIssuer } from './token/issuer'
import {
  importIssuerPrivateKey,
  recordPublishedIdentity,
  selectPublicIdentity,
} from './publicIdentities'
import { encodeBsv21Binary } from './token/decode162'
import { bapIdentityFixture } from './issuerIdentity.fixture'
import { resetIssuerIdentitiesForTests } from './issuerIdentities'

const root = PrivateKey.fromHex('01'.padStart(64, '0'))
const issuer = PrivateKey.fromHex('02'.padStart(64, '0'))
const rootIdentity = bapIdentityFixture({ master: root, name: 'Studio' })
const issuerIdentity = bapIdentityFixture({ master: issuer, name: 'Imported studio' })
const rootSigner = rootIdentity.signer.toPublicKey().toString()
const issuerSigner = issuerIdentity.signer.toPublicKey().toString()
function importIssuer(): string {
  const id = importIssuerPrivateKey(runtime(), issuer.toHex().padStart(64, '0'))
  recordPublishedIdentity(runtime(), id, issuerIdentity.pkg)
  return id
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
  resetIssuerIdentitiesForTests()
  recordPublishedIdentity(runtime(), root.toPublicKey().toString(), rootIdentity.pkg)
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
  it('signs with the identity key when no profile is published', async () => {
    state.values.clear()
    resetIssuerIdentitiesForTests()
    const id = root.toPublicKey().toString()
    const args = await enrichIdentityIssuance(runtime(), nftArgs(), id)
    expect(verifySigmaIssuer(boundTransaction(args), 0, id)).toBe(true)
    expect(issuerMetadataFromScript(args.outputs![0]!.lockingScript)).toEqual({ issuer: id })
  })
  it('signs mixed NFT and FT genesis outputs with the identity key under one anchor, never a BAP key', async () => {
    const id = root.toPublicKey().toString()
    const args = await enrichIdentityIssuance(
      runtime(),
      {
        outputs: [
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
          ...nftArgs().outputs,
        ],
      },
      id,
    )
    const tx = boundTransaction(args)
    // The item carries its stamp; the BRC-162 deploy's stamp is the trailing output.
    expect(args.outputs).toHaveLength(3)
    expect(verifySigmaIssuer(tx, 0, id)).toBe(false)
    for (const i of [1, 2]) {
      expect(verifySigmaIssuer(tx, i, id)).toBe(true)
      expect(verifySigmaIssuer(tx, i, rootSigner)).toBe(false)
      expect(issuerMetadataFromScript(args.outputs![i]!.lockingScript)).toEqual({ issuer: id })
    }
    expect(state.active!.wallet.createAction).toHaveBeenCalledTimes(1)
  })
  it('refuses a binary token genesis that is not output 0', async () => {
    const id = root.toPublicKey().toString()
    await expect(
      enrichIdentityIssuance(
        runtime(),
        {
          outputs: [
            ...nftArgs().outputs,
            {
              satoshis: 1,
              basket: 'bsv21',
              tags: ['op:deploy+mint'],
              customInstructions: JSON.stringify({ op: 'deploy+mint', amt: '10' }),
              lockingScript: encodeBsv21Binary({ amount: 10n, payload: { sym: 'MIX' }, rest: lock }).toHex(),
            },
          ],
        },
        id,
      ),
    ).rejects.toThrow(/must be output 0/)
  })
  it('uses the SDK anchor flow and the selected imported key for an NFT, while funding stays with the wallet', async () => {
    const id = importIssuer()
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
    expect(args.options).toMatchObject({ noSend: true, knownTxids: [sourceBeef().txid] })
    expect(args.options?.sendWith).toBeUndefined()
    expect(args.inputs![0]!.outpoint).toBe(`${sourceBeef().txid}.0`)
    const out = args.outputs![0]!
    expect(out.tags?.filter((tag) => tag.startsWith('issuer:'))).toEqual([`issuer:${id}`])
    const instructions = JSON.parse(out.customInstructions!)
    expect(instructions).toMatchObject({ issuer: id })
    expect(instructions).not.toHaveProperty('bapId')
    expect(issuerMetadataFromScript(out.lockingScript)).toEqual({ issuer: id })
    expect(verifySigmaIssuer(boundTransaction(args), 0, id)).toBe(true)
    expect(verifySigmaIssuer(boundTransaction(args), 0, issuerSigner)).toBe(false)
    expect(
      verifySigmaIssuer(
        boundTransaction(args),
        0,
        root.toPublicKey().toString(),
      ),
    ).toBe(false)
  })
  it('signs a BRC-162 fungible genesis with the same identity key and Sigma wire', async () => {
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
    // The deploy stays a plain BRC-162 lock; the stamp is a sibling output.
    const deploy = args.outputs![0]!.lockingScript!
    expect(deploy).not.toContain('5349474d41')
    expect(issuerMetadataFromScript(deploy)).toEqual({})
    expect(args.outputs).toHaveLength(2)
    const stamp = args.outputs![1]!
    expect(stamp.satoshis).toBe(0)
    expect(brc162StampFromScript(stamp.lockingScript)).toEqual({
      issuer: id,
      deploy: Utils.toHex(Hash.sha256(Utils.toArray(deploy, 'hex'))),
    })
    expect(verifySigmaIssuer(boundTransaction(args), 1, id)).toBe(true)
  })
  it('rejects changed selection after consent or during anchor creation, and never returns an unsigned mint', async () => {
    const id = importIssuer()
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
    expect(state.active!.wallet.createAction).toHaveBeenLastCalledWith({
      description: 'Send issuer anchor',
      options: { sendWith: [sourceBeef().txid, tx.id('hex')], acceptDelayedBroadcast: true },
    })
  })
  it('releases both when the signed mint cannot be queued with its anchor', async () => {
    const args = await enrichIdentityIssuance(runtime(), nftArgs())
    const tx = boundTransaction(args)
    const beef = Beef.fromBinary(args.inputBEEF!)
    beef.mergeTransaction(tx)
    vi.mocked(state.active!.wallet.signAction).mockResolvedValue({ txid: tx.id('hex') })
    vi.mocked(state.active!.wallet.createAction).mockResolvedValueOnce({
      sendWithResults: [{ txid: tx.id('hex'), status: 'failed' }],
    } as never)
    const created = { signableTransaction: { tx: beef.toBinary(), reference: 'mint-reference' } }
    await expect(finishIdentityIssuance(runtime(), args, created)).rejects.toThrow()
    await releaseIdentityIssuance(runtime(), args, created)
    expect(vi.mocked(state.active!.wallet.abortAction).mock.calls).toEqual([
      [{ reference: 'mint-reference' }],
      [{ reference: sourceBeef().txid }],
    ])
  })
})

describe('unsigned issuance', () => {
  beforeEach(() => {
    state.values.clear()
    resetIssuerIdentitiesForTests()
  })
  it('issues an item with no identity: no anchor, no issuer tape, no issuer tag', async () => {
    const args = await prepareUnsignedIssuance(runtime(), nftArgs())
    const out = args.outputs![0]!
    expect(out.lockingScript).toBe(nftArgs().outputs[0]!.lockingScript)
    expect(issuerMetadataFromScript(out.lockingScript)).toEqual({})
    expect(out.tags).toEqual(['ordinal'])
    expect(args.inputs).toBeUndefined()
    expect(state.active!.wallet.createAction).not.toHaveBeenCalled()
  })
  it('deploys a BSV-21 token with no stamp and no issuer claim', async () => {
    const args = await prepareUnsignedIssuance(runtime(), {
      outputs: [
        {
          satoshis: 1,
          basket: 'bsv21',
          tags: ['op:deploy+mint', 'issuer:' + rootSigner],
          customInstructions: JSON.stringify({ op: 'deploy+mint', amt: '10', issuer: rootSigner, bapId: rootIdentity.bapId }),
          lockingScript: encodeBsv21Binary({ amount: 10n, payload: { sym: 'RAW' }, rest: lock }).toHex(),
        },
      ],
    })
    const out = args.outputs![0]!
    expect(issuerMetadataFromScript(out.lockingScript)).toEqual({})
    expect(out.tags!.some(tag => tag.startsWith('issuer:'))).toBe(false)
    expect(issuerFromRemittance(out)).toBeNull()
    expect(JSON.parse(out.customInstructions!)).not.toHaveProperty('bapId')
    expect(state.active!.wallet.createAction).not.toHaveBeenCalled()
  })
  it('still refuses an item without a valid ord inscription', async () => {
    const args = nftArgs()
    args.outputs[0]!.lockingScript = lock
    await expect(prepareUnsignedIssuance(runtime(), args)).rejects.toThrow(/valid ord inscription/)
  })
})
