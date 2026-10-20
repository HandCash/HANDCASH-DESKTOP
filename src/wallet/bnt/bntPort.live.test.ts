import { Transaction } from '@bsv/sdk'
import { deflateSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'
import { readBntDeploy, walkBnt } from './validity'

/**
 * BNT end to end against the running wallet's BRC-100 port, on mainnet.
 * Never used by `npm test`.
 *
 *   npm run test:bnt:live:read   connect, list, refusals (no approvals)
 *   npm run test:bnt:live        also issue, mint, split and merge a fresh
 *                                test token with an icon, issue and send an
 *                                image item (six approvals in HandCash), then
 *                                walk both to their deploys from WhatsOnChain
 */
const mode = process.env.HANDCASH_LIVE_BNT ?? ''
const url = process.env.BRC100_WALLET_URL ?? 'http://127.0.0.1:3321'
const origin = process.env.BRC100_ORIGIN ?? 'http://localhost'
const WOC = 'https://api.whatsonchain.com/v1/bsv/main'
const APPROVAL_MS = 10 * 60_000

type Refusal = { status: number; code?: string; description?: string }
type Asset = { assetId: string; kind: string; balance: string; outputs: number; authority: boolean; deploy: string; imageUrl?: string; supply: { policy: string } }
type Media = { mediaType: string; base64: string }

async function call<T>(method: string, args: object = {}): Promise<T> {
  const res = await fetch(`${url}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(args),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(`${method}: ${res.status} ${JSON.stringify(body)}`), { ...body, status: res.status })
  return body as T
}

async function refusal(method: string, args: object): Promise<Refusal> {
  try {
    await call(method, args)
  } catch (err) {
    return err as Refusal
  }
  throw new Error(`${method} was accepted; expected a refusal`)
}

async function approve<T>(what: string, method: string, args: object): Promise<T> {
  console.info(`\n>>> Approve in HandCash: ${what}`)
  return call<T>(method, args)
}

async function assets(): Promise<Asset[]> {
  return (await call<{ assets: Asset[] }>('listBntAssets')).assets
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const fetched = new Map<string, Promise<string | null>>()

function wocHex(txid: string): Promise<string | null> {
  let hex = fetched.get(txid)
  if (!hex) {
    hex = (async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const res = await fetch(`${WOC}/tx/${txid}/hex`)
        if (res.ok) return (await res.text()).trim()
        await sleep(res.status === 429 ? 1500 : 4000)
      }
      fetched.delete(txid)
      return null
    })()
    fetched.set(txid, hex)
  }
  return hex
}

/** A transaction from WhatsOnChain with every input's source linked, as walkBnt expects. */
async function linked(txid: string): Promise<Transaction | null> {
  const hex = await wocHex(txid)
  if (!hex) return null
  const tx = Transaction.fromHex(hex)
  for (const input of tx.inputs) {
    const parent = await wocHex(input.sourceTXID!)
    if (!parent) return null
    input.sourceTransaction = Transaction.fromHex(parent)
  }
  return tx
}

/** The E2E test token: deploy f357dd82, split 42128ed2, merge 0f9c13ad (block 971921). */
const E2E = {
  assetId: '2d57a85607ed4233597dafe8ed18cd55762142ad',
  txids: [
    'f357dd8299ad2c2fc94aa48f231b6d8b6d0d16da961de6d7f5e6ba111f4a895b',
    '42128ed2c4dabef2b8b0d1b76ba7b9e6b06d232f947dc6f26821020e5a738fc5',
    '0f9c13ade73d3708b850a316a69352bc83a7638eb8b8558295336cd2f9a5ed21',
  ],
}

/**
 * Walk `subject` to the deploy using only WhatsOnChain transactions; `validated` names every hop but the deploy.
 * The walk runs twice: once to download, once more on the cached transactions to time the check alone.
 */
async function walkFromChain(deployTxid: string, subject: string) {
  const deployTx = await linked(deployTxid)
  if (!deployTx) throw new Error(`deploy ${deployTxid} is not on WhatsOnChain`)
  const read = readBntDeploy(deployTx, 0)
  if (!read.ok) throw new Error(`deploy ${deployTxid} does not read: ${read.detail}`)
  const walk = await walkBnt(subject, read.deploy, linked, () => false)
  const startedAt = performance.now()
  await walkBnt(subject, read.deploy, linked, () => false)
  const checkMs = performance.now() - startedAt
  console.info(`[bnt live] walk of ${subject.slice(0, 8)}: check ${checkMs.toFixed(1)} ms, ${fetched.size} transactions downloaded`)
  return { deploy: read.deploy, walk, checkMs }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/** A size-pixel PNG of a filled circle, so test assets show a real picture in HandCash. */
function circlePng(size: number, rgb: [number, number, number]): Media {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6 // RGBA
  const stride = 1 + size * 4
  const rows = Buffer.alloc(size * stride)
  const r = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x + 0.5 - r) ** 2 + (y + 0.5 - r) ** 2 <= r * r) rows.set([...rgb, 255], y * stride + 1 + x * 4)
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  return { mediaType: 'image/png', base64: png.toString('base64') }
}

const ICON = circlePng(64, [9, 105, 218])
const PICTURE = circlePng(256, [26, 127, 55])
const dataUrlOf = (m: Media) => `data:${m.mediaType};base64,${m.base64}`
const zeros = (bytes: number): Media => ({ mediaType: 'image/png', base64: Buffer.alloc(bytes).toString('base64') })

const randomAssetId = () => Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')

describe.skipIf(mode !== 'read' && mode !== '1')(`BNT live: ${url} as ${origin}`, () => {
  let identityKey = ''
  let held: Asset[] = []

  beforeAll(async () => {
    await call('waitForAuthentication')
    identityKey = (await call<{ publicKey: string }>('getPublicKey', { identityKey: true })).publicKey
    held = await assets()
  }, APPROVAL_MS)

  it('connects and names this identity', () => {
    expect(identityKey).toMatch(/^0[23][0-9a-f]{64}$/)
  })

  it('lists held assets with whole balances', () => {
    for (const a of held) {
      expect(a.assetId).toMatch(/^[0-9a-f]{40}$/)
      expect(a.balance).toMatch(/^\d+$/)
      expect(a.deploy).toMatch(/^[0-9a-f]{64}_\d+$/)
    }
  })

  it('shows held asset pictures as image data URLs', () => {
    for (const a of held) if (a.imageUrl) expect(a.imageUrl).toMatch(/^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/]+=*$/)
  })

  it('the held E2E token walks from its merge to its deploy on public transactions', async (ctx) => {
    if (!held.some((a) => a.assetId === E2E.assetId)) return ctx.skip()
    const [deploy, , merge] = E2E.txids
    const { deploy: read, walk } = await walkFromChain(deploy!, merge!)
    expect(read.assetId).toBe(E2E.assetId)
    expect(walk).toMatchObject({ ok: true })
    if (walk.ok) expect([...walk.validated].sort()).toEqual(E2E.txids.slice(1).sort())
  }, 120_000)

  describe('refusals arrive before any approval', () => {
    const token = () => held.find((a) => a.kind === 'token' && BigInt(a.balance) > 0n)

    it('a malformed asset id', async () => {
      const r = await refusal('transferBntAsset', { assetId: 'nope', recipient: identityKey, amount: '1' })
      expect([r.status, r.code]).toEqual([400, 'BNT_BAD_ASSET_ARGS'])
    })

    it('an asset this wallet does not know', async () => {
      const r = await refusal('transferBntAsset', { assetId: randomAssetId(), recipient: identityKey, amount: '1' })
      expect([r.status, r.code]).toEqual([400, 'BNT_NOT_HELD'])
    })

    it('a recipient that is not an identity key', async (ctx) => {
      const t = token()
      if (!t) return ctx.skip()
      const r = await refusal('transferBntAsset', { assetId: t.assetId, recipient: 'alice', amount: '1' })
      expect([r.status, r.code]).toEqual([400, 'BNT_BAD_ASSET_ARGS'])
    })

    it('a zero amount', async (ctx) => {
      const t = token()
      if (!t) return ctx.skip()
      const r = await refusal('transferBntAsset', { assetId: t.assetId, recipient: identityKey, amount: '0' })
      expect([r.status, r.code]).toEqual([400, 'BNT_BAD_ASSET_ARGS'])
    })

    it('one unit more than the balance', async (ctx) => {
      const t = token()
      if (!t) return ctx.skip()
      const r = await refusal('transferBntAsset', { assetId: t.assetId, recipient: identityKey, amount: String(BigInt(t.balance) + 1n) })
      expect([r.status, r.code]).toEqual([400, 'BNT_INSUFFICIENT'])
    })

    it('minting a fixed-supply token', async (ctx) => {
      const t = held.find((a) => a.kind === 'token' && a.supply.policy === 'fixed')
      if (!t) return ctx.skip()
      const r = await refusal('mintBntAsset', { assetId: t.assetId, amount: '1' })
      expect([r.status, r.code]).toEqual([400, 'BNT_FIXED_SUPPLY'])
    })

    it('issuing a token with no symbol', async () => {
      const r = await refusal('issueBntAsset', { kind: 'token', supply: '10' })
      expect([r.status, r.code]).toEqual([400, 'BNT_BAD_ASSET_ARGS'])
    })

    it('issuing a countersigned asset', async () => {
      const r = await refusal('issueBntAsset', { kind: 'token', supply: '10', sym: 'X', mode: 'countersign' })
      expect([r.status, r.code]).toEqual([400, 'BNT_UNSUPPORTED_MODE'])
    })

    it.each<[string, object]>([
      ['an icon one byte over 96 KiB', { kind: 'token', supply: '10', sym: 'X', icon: zeros(96 * 1024 + 1) }],
      ['an icon with no media type', { kind: 'token', supply: '10', sym: 'X', icon: { base64: ICON.base64 } }],
      ['an empty icon', { kind: 'token', supply: '10', sym: 'X', icon: zeros(0) }],
      ['a token carrying content', { kind: 'token', supply: '10', sym: 'X', icon: ICON, content: PICTURE }],
      ['item content one byte over 1 MiB', { kind: 'item', name: 'Too big', content: zeros(1024 * 1024 + 1) }],
    ])('issuing with %s', async (_, args) => {
      const r = await refusal('issueBntAsset', args)
      expect([r.status, r.code]).toEqual([400, 'BNT_BAD_ASSET_ARGS'])
    })
  })

  describe.skipIf(mode !== '1')('fresh assets with pictures: issue, move, walk', () => {
    it(
      'moves on mainnet and walks back to its deploy from public transactions',
      async () => {
        const issued = await approve<{ assetId: string; txid: string; supply: string }>(
          'issue 1000 E2E2 (test token with a blue circle icon and a mint authority)',
          'issueBntAsset',
          { kind: 'token', supply: '1000', sym: 'E2E2', name: 'Live test token', auth: true, icon: ICON },
        )
        expect(issued.txid).toMatch(/^[0-9a-f]{64}$/)
        expect(issued.supply).toBe('1000')
        const assetId = issued.assetId

        const minted = await approve<{ txid: string; amount: string }>('mint 24 E2E2', 'mintBntAsset', { assetId, amount: '24' })
        expect(minted.amount).toBe('24')

        const split = await approve<{ txid: string; delivered: boolean }>('send 256 E2E2 to yourself (split)', 'transferBntAsset', {
          assetId,
          recipient: identityKey,
          amount: '256',
        })
        expect(split.delivered).toBe(true)

        const over = await refusal('transferBntAsset', { assetId, recipient: identityKey, amount: '1025' })
        expect(over.code).toBe('BNT_INSUFFICIENT')

        const merge = await approve<{ txid: string; delivered: boolean }>('send all 1024 E2E2 to yourself (merge)', 'transferBntAsset', {
          assetId,
          recipient: identityKey,
          amount: '1024',
        })
        expect(merge.delivered).toBe(true)

        const after = (await assets()).find((a) => a.assetId === assetId)
        expect(after?.balance).toBe('1024')
        expect(after?.authority).toBe(true)
        expect(after?.imageUrl).toBe(dataUrlOf(ICON))

        const txids = [issued.txid, minted.txid, split.txid, merge.txid]
        console.info('[bnt live] txids\n' + txids.map((t) => `  https://whatsonchain.com/tx/${t}`).join('\n'))

        const { deploy, walk } = await walkFromChain(issued.txid, merge.txid)
        expect(deploy.assetId).toBe(assetId)
        expect(deploy.fields.icon?.mediaType).toBe(ICON.mediaType)
        expect(Buffer.from(deploy.fields.icon!.bytes).toString('base64')).toBe(ICON.base64)
        expect(walk).toMatchObject({ ok: true })
        if (walk.ok) expect([...walk.validated].sort()).toEqual(txids.slice(1).sort())
      },
      4 * APPROVAL_MS,
    )

    it(
      'an image item moves on mainnet and walks back to its deploy with its picture',
      async () => {
        const issued = await approve<{ assetId: string; txid: string; kind: string }>(
          'issue the item "Live test picture" (a green circle)',
          'issueBntAsset',
          { kind: 'item', name: 'Live test picture', content: PICTURE },
        )
        expect(issued.kind).toBe('item')
        const assetId = issued.assetId

        const two = await refusal('transferBntAsset', { assetId, recipient: identityKey, amount: '2' })
        expect([two.status, two.code]).toEqual([400, 'BNT_BAD_ASSET_ARGS'])

        const sent = await approve<{ txid: string; delivered: boolean }>('send "Live test picture" to yourself', 'transferBntAsset', {
          assetId,
          recipient: identityKey,
        })
        expect(sent.delivered).toBe(true)

        const after = (await assets()).find((a) => a.assetId === assetId)
        expect(after).toMatchObject({ kind: 'item', balance: '1', imageUrl: dataUrlOf(PICTURE) })

        console.info('[bnt live] item txids\n' + [issued.txid, sent.txid].map((t) => `  https://whatsonchain.com/tx/${t}`).join('\n'))

        const { deploy, walk } = await walkFromChain(issued.txid, sent.txid)
        expect(deploy.assetId).toBe(assetId)
        expect(deploy.fields.ctype).toBe(PICTURE.mediaType)
        expect(Buffer.from(deploy.fields.c!).toString('base64')).toBe(PICTURE.base64)
        expect(walk).toMatchObject({ ok: true })
        if (walk.ok) expect([...walk.validated]).toEqual([sent.txid])
      },
      2 * APPROVAL_MS,
    )
  })
})
