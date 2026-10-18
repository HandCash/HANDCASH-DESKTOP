import {
  CachedKeyDeriver,
  KeyDeriver,
  PrivateKey,
  ProtoWallet,
  registerAsyncCryptoBackend,
  unregisterAsyncCryptoBackend,
  type WalletInterface,
} from '@bsv/sdk'
import { BdkVerifier } from '@bsv/verifast'
import { Wallet } from '@handcash/wallet-engine'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dispatchWalletMethod } from '../wallet/brc100Handler'
import {
  BRC42_PRIVATE_VECTORS,
  BRC42_PUBLIC_VECTORS,
  brc43Invoice,
  childPrivateKey,
  childPublicKey,
  invoiceOrThrow,
  publicKeyOf,
} from './bkdsReference'
import {
  PEER_PRIVATE_KEY,
  PEER_PUBLIC_KEY,
  conformanceChecks,
  conformanceContext,
  runConformanceCheck,
  type ConformanceContext,
  type ConformanceOptions,
} from './brc100Conformance'

const ROOT = PrivateKey.fromHex('5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed')

describe('BRC-42 reference (judges every wallet below)', () => {
  it.each(BRC42_PRIVATE_VECTORS)('private vector $invoiceNumber', (v) => {
    expect(childPrivateKey(v)).toBe(v.privateKey)
  })

  it.each(BRC42_PUBLIC_VECTORS)('public vector $invoiceNumber', (v) => {
    expect(childPublicKey(v)).toBe(v.publicKey)
  })

  it('sender and recipient meet on one key', () => {
    const invoiceNumber = invoiceOrThrow([2, 'brc conformance'], '1')
    const sender = '11'.repeat(32)
    const recipient = '22'.repeat(32)
    const pub = childPublicKey({ senderPrivateKey: sender, recipientPublicKey: publicKeyOf(recipient), invoiceNumber })
    const priv = childPrivateKey({ recipientPrivateKey: recipient, senderPublicKey: publicKeyOf(sender), invoiceNumber })
    expect(publicKeyOf(priv)).toBe(pub)
  })

  it('formats BRC-43 invoices and names the rule a bad one breaks', () => {
    expect(brc43Invoice([0, '  Hello World '], '1')).toEqual({ ok: true, invoiceNumber: '0-hello world-1', protocolName: 'hello world' })
    expect(brc43Invoice([1, 'Document Signing'], '1')).toMatchObject({ invoiceNumber: '1-document signing-1' })
    expect(brc43Invoice([2, 'Private Document Signing'], '1337')).toMatchObject({ invoiceNumber: '2-private document signing-1337' })
    expect(brc43Invoice([0, 'hello protocol'], '1')).toEqual({ ok: false, refusal: 'protocol-suffix' })
  })

  it('agrees with the SDK KeyDeriver the wallets are built on', () => {
    const deriver = new KeyDeriver(ROOT)
    const invoiceNumber = invoiceOrThrow([2, 'brc conformance'], 'k')
    expect(deriver.derivePublicKey([2, 'brc conformance'], 'k', PEER_PUBLIC_KEY).toString()).toBe(
      publicKeyOf(childPrivateKey({ recipientPrivateKey: PEER_PRIVATE_KEY, senderPublicKey: ROOT.toPublicKey().toString(), invoiceNumber })),
    )
  })
})

function defineSuite(name: string, makeWallet: () => Promise<WalletInterface>, opts: ConformanceOptions, expectFail: string[] = []) {
  describe(name, () => {
    let ctx: ConformanceContext
    beforeAll(async () => {
      ctx = await conformanceContext(await makeWallet(), opts)
    })
    for (const check of conformanceChecks(opts.profiles)) {
      const known = expectFail.includes(check.id)
      it(`${known ? '[known gap] ' : ''}${check.id} — ${check.brc}`, async () => {
        const result = await runConformanceCheck(check, ctx)
        if (known) expect(result.ok, 'known gap now passes: drop it from expectFail').toBe(false)
        else expect(result.ok, result.reason).toBe(true)
      })
    }
  })
}

function engineWallet(root: PrivateKey): Wallet {
  const keyDeriver = new CachedKeyDeriver(root)
  const storage = { _authId: { identityKey: keyDeriver.identityKey }, setServices() {}, destroy: async () => {} }
  return new Wallet({ chain: 'main', keyDeriver, storage } as never)
}

/** HandCash's bridge: the engine wallet behind `dispatchWalletMethod`, as an app reaches it. */
function bridgeWallet(inner: WalletInterface, originator: string): WalletInterface {
  return new Proxy({} as WalletInterface, {
    get: (_t, method) =>
      typeof method === 'string' && method !== 'then'
        ? (args: unknown) => dispatchWalletMethod(inner, method, args, originator)
        : undefined,
  })
}

defineSuite('SDK ProtoWallet (reference implementation)', async () => new ProtoWallet(ROOT), {}, [
  // ProtoWallet has no privileged keyring and answers privileged requests with the everyday root.
  'privileged-never-everyday',
])

defineSuite('HandCash wallet engine', async () => engineWallet(ROOT), {})

describe('HandCash wallet engine on the WASM crypto backend', () => {
  const verifier = new BdkVerifier({ network: 'main' })
  beforeAll(async () => {
    await verifier.preload()
    registerAsyncCryptoBackend(verifier)
  })
  afterAll(() => unregisterAsyncCryptoBackend(verifier))

  it('serves ECDH from WASM', () => {
    expect(verifier.isReady() && verifier.supportsCrypto('multiplyPublicKey')).toBe(true)
  })

  defineSuite('checks', async () => engineWallet(ROOT), {})
})

defineSuite(
  'HandCash BRC-100 bridge (as an application)',
  async () => bridgeWallet(engineWallet(ROOT), 'conformance.example'),
  { originator: 'conformance.example', profiles: ['wallet', 'app-boundary'] },
)
