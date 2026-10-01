import { Beef, MerklePath, P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { bapAliasScript, bapIdFor, bapIdScript, bapKey, bFileScript } from './bapRecords'
import {
  buildIssuerIdentityPackage,
  issuerProfile,
  type IssuerIdentityImage,
  type IssuerIdentityPackage,
} from './issuerIdentity'

/** Test-only: BAP identity transactions as `publishIssuerIdentity` writes them. */
export const PNG_1PX: IssuerIdentityImage = {
  contentType: 'image/png',
  bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
}

function provenAt(tx: Transaction, height: number): MerklePath {
  return new MerklePath(height, [
    [
      { offset: 0, hash: tx.id('hex'), txid: true },
      { offset: 1, duplicate: true },
    ],
  ])
}

let nonce = 0

/** One transaction carrying `scripts` as 0-sat outputs; proven when `minedHeight` is set. Heights must be distinct. */
export function recordTx(scripts: string[], minedHeight?: number): Transaction {
  const fund = new Transaction()
  fund.addInput({
    sourceTXID: (++nonce).toString(16).padStart(64, '0'),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromHex(''),
  })
  fund.addOutput({ satoshis: 100, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
  fund.merklePath = provenAt(fund, 800_000 + nonce)
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScript: Script.fromHex('') })
  for (const script of scripts) tx.addOutput({ satoshis: 0, lockingScript: Script.fromHex(script) })
  if (minedHeight !== undefined) tx.merklePath = provenAt(tx, minedHeight)
  return tx
}

export function beefOf(...txs: Transaction[]): number[] {
  const beef = new Beef()
  for (const tx of txs) beef.mergeTransaction(tx)
  return beef.toBinary()
}

export type IdentityFixture = {
  master: PrivateKey
  bapId: string
  /** `identity-1`: the signing key right after the first publish. */
  signer: PrivateKey
  imageTx: Transaction
  aliasTx: Transaction
  pkg: IssuerIdentityPackage
  beefs: number[][]
}

/** First publish: image file, then root-signed ID declaring `identity-1` beside its ALIAS. */
export function bapIdentityFixture(opts: {
  master?: PrivateKey
  name?: string
  description?: string
  image?: IssuerIdentityImage
  imageHeight?: number
  aliasHeight?: number
}): IdentityFixture {
  const master = opts.master ?? PrivateKey.fromRandom()
  const bapId = bapIdFor(master)
  const signer = bapKey(master, 1)
  const imageTx = recordTx([bFileScript(opts.image ?? PNG_1PX)], opts.imageHeight)
  const profile = issuerProfile({ name: opts.name ?? 'Studio', description: opts.description ?? '' }, imageTx.id('hex'))
  const aliasTx = recordTx(
    [
      bapIdScript({ bapId, address: signer.toAddress(), signer: bapKey(master, 0) }),
      bapAliasScript({ bapId, profile, signer }),
    ],
    opts.aliasHeight,
  )
  const beefs = [beefOf(imageTx), beefOf(aliasTx)]
  const pkg = buildIssuerIdentityPackage(bapId, beefs, { preferAlias: aliasTx.id('hex') })
  if (!pkg) throw new Error('fixture identity package did not verify')
  return { master, bapId, signer, imageTx, aliasTx, pkg, beefs }
}

/** Rotation from `identity-<fromSeq>` to the next key, re-signing the profile in the same transaction. */
export function rotationTx(
  fixture: Pick<IdentityFixture, 'master' | 'bapId' | 'imageTx'>,
  fromSeq: number,
  opts?: { name?: string; minedHeight?: number },
): { tx: Transaction; next: PrivateKey } {
  const next = bapKey(fixture.master, fromSeq + 1)
  const profile = issuerProfile({ name: opts?.name ?? 'Studio', description: '' }, fixture.imageTx.id('hex'))
  const tx = recordTx(
    [
      bapIdScript({ bapId: fixture.bapId, address: next.toAddress(), signer: bapKey(fixture.master, fromSeq) }),
      bapAliasScript({ bapId: fixture.bapId, profile, signer: next }),
    ],
    opts?.minedHeight,
  )
  return { tx, next }
}
