import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import type { Chain } from './vault'

export const LIVE_WALLETS_PATH = resolve(process.cwd(), '.live-wallets.json')

export type LiveActorKeys = {
  handle: string
  rootKeyHex: string
}

export type LiveWalletsFile = {
  v: 1
  chain: Chain
  alice: LiveActorKeys
  bob: LiveActorKeys
}

export type LiveTxEnv = {
  enabled: boolean
  printOnly: boolean
  sats: number
  rounds: number
  /** When true, each round is Alice→Bob then Bob→Alice. */
  pingpong: boolean
  waitMs: number
  feeBufferSats: number
}

export type LiveActorPublic = {
  handle: string
  identityKey: string
  address: string
}

export function parseLiveTxEnv(
  env: NodeJS.ProcessEnv = process.env,
): LiveTxEnv {
  const flag = (env.HANDCASH_LIVE_TX ?? '').trim().toLowerCase()
  const printOnly = flag === 'print'
  const enabled = printOnly || flag === '1' || flag === 'true'
  const sats = Math.max(546, Math.trunc(Number(env.HANDCASH_LIVE_SATS) || 2_000))
  const rounds = Math.max(1, Math.trunc(Number(env.HANDCASH_LIVE_ROUNDS) || 1))
  const pingpongFlag = (env.HANDCASH_LIVE_PINGPONG ?? '').trim().toLowerCase()
  const pingpong = pingpongFlag === '1' || pingpongFlag === 'true'
  const waitMs = Math.max(
    5_000,
    Math.trunc(Number(env.HANDCASH_LIVE_WAIT_MS) || 20 * 60_000),
  )
  const feeBufferSats = Math.max(
    1_000,
    Math.trunc(Number(env.HANDCASH_LIVE_FEE_BUFFER) || 5_000),
  )
  return { enabled, printOnly, sats, rounds, pingpong, waitMs, feeBufferSats }
}

export function minDepositSats(env: LiveTxEnv): number {
  // Alice funds every outbound A→B hop; Bob is funded by the first hop in pingpong.
  return env.sats * env.rounds + env.feeBufferSats
}

export function publicFromRoot(
  rootKeyHex: string,
  handle: string,
  chain: Chain,
): LiveActorPublic {
  const root = PrivateKey.fromHex(rootKeyHex)
  // Same as `bootWallet`: toolbox identity is the root key, address is root P2PKH.
  void chain
  return {
    handle,
    identityKey: root.toPublicKey().toString(),
    address: root.toAddress(),
  }
}

function randomActor(handle: string): LiveActorKeys {
  return { handle, rootKeyHex: PrivateKey.fromRandom().toHex() }
}

export function loadOrCreateLiveWallets(path = LIVE_WALLETS_PATH): LiveWalletsFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LiveWalletsFile>
    if (
      parsed.v === 1 &&
      parsed.alice?.rootKeyHex &&
      parsed.bob?.rootKeyHex &&
      parsed.alice.handle &&
      parsed.bob.handle
    ) {
      return {
        v: 1,
        chain: parsed.chain === 'test' ? 'test' : 'main',
        alice: parsed.alice,
        bob: parsed.bob,
      }
    }
  } catch {
    // create below
  }

  const created: LiveWalletsFile = {
    v: 1,
    chain: 'main',
    alice: randomActor('live-alice'),
    bob: randomActor('live-bob'),
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600 })
  return created
}

export function formatFundBanner(
  alice: LiveActorPublic,
  needSats: number,
): string {
  return [
    '',
    '—— live send/receive — fund Alice (mainnet) ——',
    `P2PKH address:  ${alice.address}`,
    `Identity key:   ${alice.identityKey}`,
    `Need at least:  ${needSats} sats (then re-run without HANDCASH_LIVE_TX=print)`,
    'Send from Desktop to the address. Do not paste the key file into chat.',
    '————————————————————————————————————————————',
    '',
  ].join('\n')
}
