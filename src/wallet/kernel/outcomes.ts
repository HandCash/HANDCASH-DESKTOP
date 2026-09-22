import type { WalletRuntime } from '../walletRuntime'

/** Facts emitted by the kernel after state has changed. */
export type WalletOutcome =
  | {
      type: 'AccountChanged'
      accountIndex: number
      identityKey: string
      runtime: WalletRuntime
    }
  | {
      type: 'SpendCompleted'
      spendId: string
      txid: string
    }
  | {
      type: 'ItemInternalized'
      txid: string
      outpoint: string
    }
  | {
      type: 'ChainIngestCompleted'
      reason: string
    }

export function assertNeverOutcome(value: never): never {
  throw new Error(`Unhandled wallet outcome: ${JSON.stringify(value)}`)
}
