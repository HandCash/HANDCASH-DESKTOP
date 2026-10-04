import 'fake-indexeddb/auto'
import { MerklePath, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { SetupClient, type Wallet } from '@bsv/wallet-toolbox-client'
import { describe, expect, it } from 'vitest'
import { encodeBsv21Binary } from './token/decode162'
import { persistNoSendActions } from './toolboxActionBatch'

const BRC29: [2, string] = [2, '3241645161d8']
const TOKEN_ID = `${'ab'.repeat(32)}_0`

async function fundedWallet(): Promise<{ wallet: Wallet; root: PrivateKey }> {
  const root = PrivateKey.fromRandom()
  const setup = await SetupClient.createWalletIdb({
    chain: 'main',
    rootKeyHex: root.toHex(),
    databaseName: `action-batch-${Math.random().toString(16).slice(2)}`,
  } as Parameters<typeof SetupClient.createWalletIdb>[0])
  const services = setup.services as unknown as Record<string, unknown>
  services.getChainTracker = async () => ({
    isValidRootForHeight: async () => true,
    currentHeight: async () => 900_000,
  })
  services.getHeight = async () => 900_000
  services.getHeaderForHeight = async () => new Array(80).fill(0)

  const sender = PrivateKey.fromRandom().toPublicKey().toString()
  const derivationPrefix = Utils.toBase64(Utils.toArray('prefix', 'utf8'))
  const derivationSuffix = Utils.toBase64(Utils.toArray('suffix', 'utf8'))
  const payee = setup.keyDeriver
    .derivePrivateKey(BRC29, `${derivationPrefix} ${derivationSuffix}`, sender)
    .toPublicKey()
  const fund = new Transaction()
  fund.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromHex(''),
  })
  fund.addOutput({ satoshis: 100_000, lockingScript: new P2PKH().lock(payee.toAddress()) })
  fund.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: fund.id('hex'), txid: true }]])
  await setup.wallet.internalizeAction({
    tx: fund.toAtomicBEEF(),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: sender },
      },
    ],
    description: 'fund the wallet',
  })
  return { wallet: setup.wallet, root }
}

/** The shape of `sendBsv21Tokens`: a signed `noSend` action with token change in `bsv21`. */
async function signedTokenSend(
  wallet: Wallet,
  root: PrivateKey,
): Promise<{ txid: string; tx: number[]; noSendChange: string[] }> {
  const created = await wallet.createAction({
    description: 'token transfer',
    labels: ['bsv21'],
    outputs: [
      {
        satoshis: 1,
        basket: 'bsv21',
        outputDescription: 'token change',
        tags: ['bsv21', `bsv21:${TOKEN_ID}`],
        lockingScript: encodeBsv21Binary({
          tokenId: TOKEN_ID,
          amount: 3_000n,
          rest: new P2PKH().lock(root.toAddress()).toHex(),
        }).toHex(),
      },
    ],
    options: { noSend: true, randomizeOutputs: false, signAndProcess: true },
  })
  // What every signed send did before broadcasting through signedSendLifecycle.
  await wallet.actionBatch.abort()
  return { txid: created.txid!, tx: Array.from(created.tx!), noSendChange: created.noSendChange ?? [] }
}

async function tokenChange(wallet: Wallet) {
  const listed = await wallet.listOutputs({
    basket: 'bsv21',
    include: 'locking scripts',
    limit: 100,
  })
  return listed.outputs
}

/** Change of a `nosend` action funds only through `noSendChange` until the Arcade pin promotes it. */
async function spendTokenChange(
  wallet: Wallet,
  sent: { txid: string; tx: number[]; noSendChange: string[] },
) {
  return wallet.createAction({
    description: 'spend token change',
    inputBEEF: sent.tx,
    inputs: [{ outpoint: `${sent.txid}.0`, unlockingScriptLength: 108, inputDescription: 'token tip' }],
    outputs: [
      { satoshis: 1, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(), outputDescription: 'payee' },
    ],
    options: { noSend: true, noSendChange: sent.noSendChange, randomizeOutputs: false, signAndProcess: false },
  })
}

describe('toolbox action batch', () => {
  it('keeps the token change of a signed send spendable after the batch is released', async () => {
    const { wallet, root } = await fundedWallet()
    persistNoSendActions(wallet)

    const sent = await signedTokenSend(wallet, root)
    const { txid } = sent

    const actions = await wallet.listActions({ labels: ['bsv21'], limit: 10 })
    expect(actions.actions.map((a) => [a.txid, a.status])).toEqual([[txid, 'nosend']])
    const change = await tokenChange(wallet)
    expect(change.map((o) => o.outpoint)).toEqual([`${txid}.0`])
    expect(change[0]!.spendable).toBe(true)
    expect(change[0]!.lockingScript?.startsWith('054253563231')).toBe(true)

    expect(sent.noSendChange.length).toBeGreaterThan(0)
    const next = await spendTokenChange(wallet, sent)
    expect(next.signableTransaction?.reference).toBeTruthy()
  })

  it('auto mode drops the signed send, so the change cannot be spent (Toolbox 2.13 control)', async () => {
    const { wallet, root } = await fundedWallet()

    const sent = await signedTokenSend(wallet, root)

    expect(await tokenChange(wallet)).toEqual([])
    expect((await wallet.listActions({ labels: ['bsv21'], limit: 10 })).actions).toEqual([])
    await expect(spendTokenChange(wallet, sent)).rejects.toThrow(/must be spendable wallet-managed output/)
  })

  it('is idempotent and refuses to switch under an open batch', async () => {
    const { wallet, root } = await fundedWallet()
    persistNoSendActions(wallet)
    const legacy = wallet.actionBatch
    persistNoSendActions(wallet)
    expect(wallet.actionBatch).toBe(legacy)
    expect(legacy.mode).toBe('legacy')

    const auto = await fundedWallet()
    await auto.wallet.createAction({
      description: 'staged token transfer',
      outputs: [
        {
          satoshis: 1,
          basket: 'bsv21',
          outputDescription: 'token change',
          lockingScript: new P2PKH().lock(root.toAddress()).toHex(),
        },
      ],
      options: { noSend: true, signAndProcess: true },
    })
    expect(() => persistNoSendActions(auto.wallet)).toThrow(/already open/)
  })
})
