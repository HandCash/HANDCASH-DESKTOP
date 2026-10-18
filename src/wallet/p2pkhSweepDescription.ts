/**
 * Description of a P2PKH sweep transaction.
 *
 * A sweep pays nobody: it moves coins already received at an address into the
 * wallet's own change. The arrival is recorded on the deposit (or the sale it
 * settled), so the ledger must not draw the sweep as a coin row of its own.
 */
export function p2pkhSweepDescription(coins: number, firstTxid: string): string {
  return coins === 1 ? `Import P2PKH UTXO ${firstTxid.slice(0, 16)}...` : `Import ${coins} P2PKH UTXOs`
}

const SWEEP_DESCRIPTION = /^Import (?:P2PKH UTXO [0-9a-f]{16}\.\.\.|\d+ P2PKH UTXOs)$/i

export function isP2pkhSweepDescription(description: string | null | undefined): boolean {
  return typeof description === 'string' && SWEEP_DESCRIPTION.test(description.trim())
}
