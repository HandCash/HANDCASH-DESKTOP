import { yieldToUi } from './yieldToUi'
import { foregroundSpendWaiting } from './walletCoordinator'

export type WalletSummary = { sats: number; outputCount: number; rowCount: number }
type Page = WalletSummary & { next: number | null; revision: number }
type SummaryProvider = {
  readCashSummaryPage?: (identity: string, after: number, revision?: number) => Promise<Page>
  validateCashSummaryRevision: (revision: number) => void
}
type SummaryWallet = {
  storage?: {
    runAsStorageProvider: <T>(read: (provider: SummaryProvider) => Promise<T>) => Promise<T>
  }
}

/** Display only: release the provider after every 100 physical rows, before yielding. */
export async function readWalletSummary(
  wallet: SummaryWallet,
  identity: string,
  current: () => boolean,
): Promise<(WalletSummary & { validate: () => Promise<void> }) | null> {
  if (!wallet.storage) return null
  let provider: SummaryProvider | undefined
  let revision: number | undefined
  let after = 0
  const summary: WalletSummary = { sats: 0, outputCount: 0, rowCount: 0 }
  for (;;) {
    if (!current()) throw new Error('Wallet summary session changed')
    // Do not queue another background page ahead of a foreground send.
    if (foregroundSpendWaiting()) throw new Error('Wallet summary deferred to send')
    const page = await wallet.storage.runAsStorageProvider(async (sp) => {
      if (!sp.readCashSummaryPage) return null
      if (provider && provider !== sp) throw new Error('Wallet summary provider changed')
      provider = sp
      return sp.readCashSummaryPage(identity, after, revision)
    })
    if (!page) return null
    if (!current()) throw new Error('Wallet summary session changed')
    revision = page.revision
    summary.sats += page.sats
    summary.outputCount += page.outputCount
    summary.rowCount += page.rowCount
    if (!Object.values(summary).every(n => Number.isSafeInteger(n) && n >= 0)) {
      throw new Error('Invalid wallet summary')
    }
    if (page.next == null) {
      const validate = async () => {
        await wallet.storage!.runAsStorageProvider(async (sp) => {
          if (!current() || sp !== provider) throw new Error('Wallet summary session changed')
          sp.validateCashSummaryRevision(revision!)
        })
      }
      await validate()
      return { ...summary, validate }
    }
    if (page.next <= after) throw new Error('Wallet summary cursor did not advance')
    after = page.next
    await yieldToUi()
  }
}
