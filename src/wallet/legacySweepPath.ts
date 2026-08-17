/**
 * Explicit legacy UTXO → sweep vocabulary.
 *
 * Classification owns *what* an address UTXO is. This module owns the only
 * question the sweep path may ask: may this output enter `importLegacyUtxos`?
 *
 * Same pattern as `TipKind` / `SendPath` / `ItemSettlePath` — a tagged union so
 * a future change cannot silently treat asset companions or sub-fee dust as
 * funding. Assets (1-sat tips, BSV-21) never reach this chooser with a sweep
 * path; they are routed by `classifyLegacyUtxos` into baskets instead.
 *
 * HARD RULES:
 * - satoshis === 1 → hold (possible ordinal / unrecognized tip)
 * - 1 < satoshis < MIN_SWEEPABLE_SATS → hold (cannot pay its own fee)
 * - satoshis >= MIN_SWEEPABLE_SATS → sweep
 * - anything else → hold (refuse closed)
 */
import { DUST_LIMIT_SATS } from './protocolValidate'

/**
 * Bytes one legacy P2PKH input adds to a sweep: 32 txid + 4 vout + 1 script
 * length + 108 unlocking script (the `unlockingScriptLength` declared in
 * `importP2pkhFunding`) + 4 sequence.
 */
const SWEEP_INPUT_BYTES = 149
/** Version + input/output counts + locktime, plus one P2PKH change output. */
const SWEEP_OVERHEAD_BYTES = 44
/** ARC's published `miningFee` (`GET /v1/policy`): 100 satoshis per 1000 bytes. */
const SWEEP_FEE_SATS_PER_KB = 100

/**
 * Smallest legacy output worth sweeping.
 *
 * The sweep spends one output per transaction (~193 bytes) and ARC charges 100
 * satoshis per 1000 bytes, so an output owes ~20 satoshis of fee before a single
 * satoshi can reach change. Below this a sweep is arithmetically impossible —
 * every broadcaster rejects it. Broadcast rejection is deliberately transient
 * (an outage must never blacklist a live deposit), so sub-fee outputs used to
 * be rebuilt and re-rejected on every scan forever.
 *
 * Held outputs stay on the address. Nothing is lost; there is simply no
 * transaction that can move them alone.
 */
export const MIN_SWEEPABLE_SATS =
  Math.ceil(
    ((SWEEP_INPUT_BYTES + SWEEP_OVERHEAD_BYTES) * SWEEP_FEE_SATS_PER_KB) / 1000,
  ) + DUST_LIMIT_SATS

export type LegacySweepHoldReason =
  | 'oneSat'
  | 'uneconomical'
  | 'nonPositive'

/**
 * Exhaustive answer to "may this scanned legacy UTXO be fund-swept?"
 *
 * `sweep` is the only path that may call `importLegacyUtxos` / P2PKH funding.
 * Every hold reason stays on the address — never blacklisted as imported.
 */
export type LegacySweepPath =
  | { path: 'sweep' }
  | { path: 'hold'; reason: LegacySweepHoldReason }

export type LegacySweepableUtxo = {
  satoshis: number
}

/**
 * Classify once. Callers must not invent a parallel `satoshis > 1` test —
 * that is how companion dust and assets used to fall into the sweep loop.
 */
export function chooseLegacySweepPath(utxo: LegacySweepableUtxo): LegacySweepPath {
  const sats = Number(utxo.satoshis)
  if (!Number.isFinite(sats) || sats <= 0) {
    return { path: 'hold', reason: 'nonPositive' }
  }
  if (sats === 1) {
    return { path: 'hold', reason: 'oneSat' }
  }
  if (sats < MIN_SWEEPABLE_SATS) {
    return { path: 'hold', reason: 'uneconomical' }
  }
  return { path: 'sweep' }
}

/** True only when {@link chooseLegacySweepPath} returns `sweep`. */
export function isSweepableFunding(utxo: LegacySweepableUtxo): boolean {
  return chooseLegacySweepPath(utxo).path === 'sweep'
}
