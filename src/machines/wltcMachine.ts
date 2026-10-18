import { assign, setup } from 'xstate'

type Context = {
  operation: 'credit' | 'prove' | 'withdraw' | null
  ltcTxid: string | null
  bsvTxid: string | null
  error: string | null
}

type Event =
  | { type: 'CREDIT' }
  | { type: 'PROVE' }
  | { type: 'WITHDRAW' }
  | { type: 'RESUME_BROADCAST'; ltcTxid: string }
  | { type: 'SEEN' }
  | { type: 'AWAITING' }
  | { type: 'PENDING' }
  | { type: 'PROVEN' }
  | { type: 'VOIDED' }
  | { type: 'REFUSED'; error: string }
  | { type: 'MINTED'; bsvTxid: string }
  | { type: 'LTC_SIGNED'; ltcTxid: string }
  | { type: 'BURNED'; bsvTxid: string }
  | { type: 'BROADCASTED' }
  | { type: 'BROADCAST_QUEUED'; error: string }
  | { type: 'FAIL'; error: string }

/**
 * The wLTC bridge (1-of-1 federation: this wallet holds the LTC reserve key).
 *
 * Credit: a deposit seen paying the reserve is minted at once against the
 * backed wLTC (BRC-255 `bk`), naming the deposit; one mint per LTC outpoint,
 * labelled with it so a restored wallet never mints it twice. While the first
 * deposit is unproven its deploy is the authority, so later deposits AWAIT.
 *
 * Prove: an unproven deposit stays PENDING while this wallet's own Litecoin
 * header chain counts fewer than 6 confirmations over its block; then its
 * burial proof (deposit, merkle path, block header) is recorded and its wLTC
 * can move. A deposit the explorers stop knowing is VOIDED (abandoned): its
 * wLTC never moves.
 *
 * Withdraw: the LTC transaction is signed first and kept unsent; wLTC is
 * burned next; only a burned withdrawal is broadcast. A failed burn leaves the
 * reserve untouched. A failed broadcast after the burn is QUEUED and retried
 * until it lands; it is never abandoned or re-burned.
 */
export const wltcMachine = setup({
  types: { context: {} as Context, events: {} as Event },
  actions: {
    credit: assign({ operation: 'credit', ltcTxid: null, bsvTxid: null, error: null }),
    prove: assign({ operation: 'prove', ltcTxid: null, bsvTxid: null, error: null }),
    withdraw: assign({ operation: 'withdraw', ltcTxid: null, bsvTxid: null, error: null }),
    resume: assign(({ event }) => (event.type === 'RESUME_BROADCAST' ? { operation: 'withdraw' as const, ltcTxid: event.ltcTxid, error: null } : {})),
    ltcTxid: assign(({ event }) => (event.type === 'LTC_SIGNED' ? { ltcTxid: event.ltcTxid } : {})),
    bsvTxid: assign(({ event }) => (event.type === 'MINTED' || event.type === 'BURNED' ? { bsvTxid: event.bsvTxid } : {})),
    error: assign(({ event }) =>
      event.type === 'FAIL' || event.type === 'REFUSED' || event.type === 'BROADCAST_QUEUED' ? { error: event.error } : {},
    ),
  },
}).createMachine({
  id: 'wltc',
  initial: 'idle',
  context: { operation: null, ltcTxid: null, bsvTxid: null, error: null },
  states: {
    idle: {
      on: {
        CREDIT: { target: 'reading', actions: 'credit' },
        PROVE: { target: 'proving', actions: 'prove' },
        WITHDRAW: { target: 'building', actions: 'withdraw' },
        RESUME_BROADCAST: { target: 'broadcasting', actions: 'resume' },
      },
    },
    reading: {
      on: {
        SEEN: 'minting',
        REFUSED: { target: 'refused', actions: 'error' },
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    minting: {
      on: {
        MINTED: { target: 'credited', actions: 'bsvTxid' },
        AWAITING: 'awaiting',
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    proving: {
      on: {
        PROVEN: 'proven',
        PENDING: 'pending',
        VOIDED: 'voided',
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    building: {
      on: {
        LTC_SIGNED: { target: 'burning', actions: 'ltcTxid' },
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    burning: {
      on: {
        BURNED: { target: 'broadcasting', actions: 'bsvTxid' },
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    // Burned is final against the redeemer: the LTC transaction must land.
    broadcasting: {
      on: {
        BROADCASTED: 'withdrawn',
        BROADCAST_QUEUED: { target: 'queued', actions: 'error' },
      },
    },
    credited: { type: 'final' },
    awaiting: { type: 'final' },
    pending: { type: 'final' },
    proven: { type: 'final' },
    voided: { type: 'final' },
    refused: { type: 'final' },
    withdrawn: { type: 'final' },
    queued: { type: 'final' },
    failed: { type: 'final' },
  },
})
