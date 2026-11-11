import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * IndexedDB clones every row a cursor touches, rawTx and remittance included.
 * Paging by offset alone re-reads every skipped row on each page, and a status
 * list over an empty partial walks the whole transactions store. Multi-page
 * scans pass the resume id (the offset stays for providers that ignore it), and
 * status scans query one status at a time.
 */
const KEYSET_ELSEWHERE = new Set([
  // IndexedDB reads through `readPendingChangePage`; findOutputs is the fallback.
  'balanceView.ts',
])

function calls(source: string, method: string): string[] {
  const found: string[] = []
  const re = new RegExp(`${method}!?\\??\\.?\\(\\{`, 'g')
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 0
    let end = m.index + m[0].length - 1
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++
      else if (source[end] === '}' && --depth === 0) break
    }
    found.push(source.slice(m.index, end + 1))
  }
  return found
}

const PAGES_BY_OFFSET = /offset:\s*(?!0\b)[^,}\s]+|offset,/

function offenders(check: (file: string, source: string) => boolean): string[] {
  const dir = join(__dirname)
  return readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !KEYSET_ELSEWHERE.has(file))
    .filter((file) => check(file, readFileSync(join(dir, file), 'utf8')))
}

describe('storage scans read each row once', () => {
  it('pairs every offset page of outputs with afterOutputId', () => {
    expect(
      offenders((_, source) =>
        calls(source, 'findOutputs').some((c) => PAGES_BY_OFFSET.test(c) && !c.includes('afterOutputId')),
      ),
    ).toEqual([])
  })

  it('pairs every offset page of transactions with afterTransactionId', () => {
    expect(
      offenders((_, source) =>
        calls(source, 'findTransactions').some((c) => PAGES_BY_OFFSET.test(c) && !c.includes('afterTransactionId')),
      ),
    ).toEqual([])
  })

  it('never walks every transaction to filter by a status list', () => {
    expect(
      offenders((_, source) =>
        calls(source, 'findTransactions').some((c) => /partial:\s*\{\s*\}/.test(c) && /\bstatus:/.test(c)),
      ),
    ).toEqual([])
  })
})
