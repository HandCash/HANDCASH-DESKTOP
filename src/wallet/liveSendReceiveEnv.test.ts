import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatFundBanner,
  loadOrCreateLiveWallets,
  minDepositSats,
  parseLiveTxEnv,
  publicFromRoot,
} from './liveSendReceiveEnv'

describe('parseLiveTxEnv', () => {
  it('stays off unless HANDCASH_LIVE_TX is set', () => {
    expect(parseLiveTxEnv({}).enabled).toBe(false)
  })

  it('accepts print mode without treating it as a broadcast run', () => {
    const env = parseLiveTxEnv({ HANDCASH_LIVE_TX: 'print' })
    expect(env.enabled).toBe(true)
    expect(env.printOnly).toBe(true)
  })

  it('sizes the deposit from sats × rounds plus a fee buffer', () => {
    const env = parseLiveTxEnv({
      HANDCASH_LIVE_TX: '1',
      HANDCASH_LIVE_SATS: '2000',
      HANDCASH_LIVE_ROUNDS: '3',
      HANDCASH_LIVE_FEE_BUFFER: '5000',
    })
    expect(env.enabled).toBe(true)
    expect(env.printOnly).toBe(false)
    expect(env.pingpong).toBe(false)
    expect(minDepositSats(env)).toBe(11_000)
  })

  it('enables pingpong from HANDCASH_LIVE_PINGPONG', () => {
    const env = parseLiveTxEnv({
      HANDCASH_LIVE_TX: '1',
      HANDCASH_LIVE_PINGPONG: '1',
      HANDCASH_LIVE_ROUNDS: '10',
    })
    expect(env.pingpong).toBe(true)
    expect(env.rounds).toBe(10)
  })
})

describe('live wallets file', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('creates then reloads the same Alice deposit address', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-live-'))
    dirs.push(dir)
    const path = join(dir, 'wallets.json')
    const created = loadOrCreateLiveWallets(path)
    const again = loadOrCreateLiveWallets(path)
    expect(again.alice.rootKeyHex).toBe(created.alice.rootKeyHex)
    const a = publicFromRoot(created.alice.rootKeyHex, created.alice.handle, created.chain)
    const b = publicFromRoot(again.alice.rootKeyHex, again.alice.handle, again.chain)
    expect(a.address).toBe(b.address)
    expect(a.identityKey).toBe(PrivateKey.fromHex(created.alice.rootKeyHex).toPublicKey().toString())
    expect(formatFundBanner(a, 7000)).toContain(a.address)
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { alice: { rootKeyHex: string } }
    expect(raw.alice.rootKeyHex).toHaveLength(64)
  })

  it('rejects a truncated file and mints a fresh pair', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-live-'))
    dirs.push(dir)
    const path = join(dir, 'wallets.json')
    writeFileSync(path, '{"v":1}\n')
    const created = loadOrCreateLiveWallets(path)
    expect(created.alice.rootKeyHex).toHaveLength(64)
    expect(created.bob.rootKeyHex).not.toBe(created.alice.rootKeyHex)
  })
})
