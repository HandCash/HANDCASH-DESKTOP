import { HTTPWalletJSON, WalletClient } from '@bsv/sdk'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  conformanceChecks,
  conformanceContext,
  formatConformanceReport,
  runConformanceCheck,
  type ConformanceContext,
  type ConformanceProfile,
  type ConformanceResult,
} from './brc100Conformance'

/**
 * Runs the BRC-100 conformance suite against a live wallet over the HTTP
 * substrate. Any implementation: HandCash, Metanet, or another wallet bound
 * to the BRC-100 port. Levels 1 and 2 and linkage revelations prompt on
 * wallets with permissions; approve them, or narrow with BRC100_LEVELS=0.
 *
 *   npm run test:brc100:live
 *   BRC100_WALLET_URL=http://127.0.0.1:3321 BRC100_ORIGINATOR=conformance.localhost \
 *   BRC100_LEVELS=0,1,2 BRC100_P_SCHEMES= npm run test:brc100:live
 */
const url = process.env.BRC100_WALLET_URL ?? 'http://127.0.0.1:3321'
// The SDK sends a bare-hostname originator as http://<host>, and HandCash lets
// plaintext claim only loopback or private hosts: a local run names itself so.
const originator = process.env.BRC100_ORIGINATOR ?? 'conformance.localhost'
const levels = (process.env.BRC100_LEVELS ?? '0,1,2')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n): n is 0 | 1 | 2 => n === 0 || n === 1 || n === 2)
const supportedPermissionSchemes = (process.env.BRC100_P_SCHEMES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const profiles: ConformanceProfile[] = ['wallet', 'app-boundary']

describe(`BRC-100 conformance: ${url} as ${originator}`, () => {
  let ctx: ConformanceContext
  const results: ConformanceResult[] = []

  beforeAll(async () => {
    // The live config installs a headless DOM, so the SDK believes it runs in a
    // browser and leaves the caller unnamed; declare it as a native client does.
    const declared: typeof fetch = (input, init) =>
      fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), Originator: originator } })
    const wallet = new WalletClient(new HTTPWalletJSON(originator, url, declared), originator)
    ctx = await conformanceContext(wallet, { originator, securityLevels: levels, supportedPermissionSchemes })
  })

  for (const check of conformanceChecks(profiles)) {
    it(`${check.id} — ${check.brc}`, async () => {
      const result = await runConformanceCheck(check, ctx)
      results.push(result)
      expect(result.ok, result.reason).toBe(true)
    })
  }

  it('report', () => {
    console.info(`\n${formatConformanceReport(results)}`)
  })
})
