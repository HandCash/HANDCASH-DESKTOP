import { describe, expect, it } from 'vitest'
import {
  HISTORY_DOCUMENT_BUDGET_BYTES,
  HistoryDocumentTooLargeError,
  assertHistoryDocumentEncryptable,
  summarizeBrc38TableSizes,
} from './historyDocumentBudget'

/** Canonical-shaped document with a padded table, sized to order. */
function documentWithFatTable(table: string, bytes: number): string {
  const row = `{"note":"${'x'.repeat(Math.max(1, bytes))}"}`
  return `{"brc":38,"tables":{"certificates":[],"outputs":[],"provenTxReqs":[],"${table}":[${row}]}}`
}

describe('history document budget', () => {
  it('passes a document the encrypt path can survive', () => {
    expect(() => assertHistoryDocumentEncryptable(documentWithFatTable('transactions', 1024))).not.toThrow()
  })

  it('refuses a document that would OOM the renderer', () => {
    const json = documentWithFatTable('provenTxs', HISTORY_DOCUMENT_BUDGET_BYTES + 1024)
    expect(() => assertHistoryDocumentEncryptable(json)).toThrow(HistoryDocumentTooLargeError)
  })

  it('names the largest table so the cause is visible', () => {
    const json = `{"brc":38,"tables":{"outputs":[${'"o",'.repeat(10)}"o"],"provenTxReqs":[${'"r",'.repeat(500)}"r"],"transactions":[]}}`
    const sizes = summarizeBrc38TableSizes(json)
    expect(sizes[0]?.table).toBe('provenTxReqs')
    expect(sizes.find((size) => size.table === 'outputs')?.bytes).toBeGreaterThan(0)
  })

  it('reports every table it finds without double counting the document', () => {
    const json = documentWithFatTable('outputs', 4096)
    const total = summarizeBrc38TableSizes(json).reduce((sum, size) => sum + size.bytes, 0)
    expect(total).toBeLessThanOrEqual(json.length)
    expect(total).toBeGreaterThan(4096)
  })
})
