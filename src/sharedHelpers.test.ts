import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * One helper per job. A second copy of a shared helper is how a codebase grows
 * two meanings for one word; these rules fail the build when one appears.
 */
const srcRoot = path.resolve(process.cwd(), 'src')

function sourceFiles(): { file: string; text: string }[] {
  return fs
    .readdirSync(srcRoot, { recursive: true })
    .filter((name): name is string => typeof name === 'string' && /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({
      file: path.join('src', name).replaceAll(path.sep, '/'),
      text: fs.readFileSync(path.join(srcRoot, name), 'utf8'),
    }))
}

const RULES: { name: string; use: string; home: string; pattern: RegExp }[] = [
  {
    name: 'inline error-to-text',
    use: 'errorText(err) from src/wallet/errorText.ts',
    home: 'src/wallet/errorText.ts',
    pattern: /instanceof Error \? [\w$.]+\.message : String\(/,
  },
  {
    name: 'local sleep / timeout helper',
    use: 'sleep, withTimeout, timeoutSignal from src/wallet/timing.ts',
    home: 'src/wallet/timing.ts',
    pattern:
      /^\s*(?:export )?(?:async )?function (?:sleep|delay|withTimeout|raceTimeout|timeoutSignal)\b|\bconst (?:sleep|delay|withTimeout|raceTimeout|timeoutSignal) = (?:async )?(?:<[^>]*>)?\(/m,
  },
  {
    name: 'inline sleep',
    use: 'sleep(ms) from src/wallet/timing.ts',
    home: 'src/wallet/timing.ts',
    pattern: /new Promise(?:<void>)?\(\(?(resolve|r|res)\)? => (?:window\.)?setTimeout\(\1, /,
  },
  {
    name: 'inline AbortSignal.timeout guard',
    use: 'timeoutSignal(ms) from src/wallet/timing.ts',
    home: 'src/wallet/timing.ts',
    pattern: /'timeout' in AbortSignal/,
  },
  {
    name: 'local hex helper',
    use: 'hexToBytes, bytesToHex from src/wallet/hexBinary.ts (strict 0x input: ethHexToBytes)',
    home: 'src/wallet/hexBinary.ts',
    pattern: /function (?:hexToBytes|bytesToHex)\b/,
  },
]

/**
 * Files that still abort a fetch from a hand-written timer
 * (`setTimeout(() => controller.abort(), ms)` + `clearTimeout`). Only shrinks.
 */
const MANUAL_ABORT_TIMERS = new Set<string>([
  'src/wallet/blockHeaders.ts',
  'src/wallet/chainProbeClient.ts',
  'src/wallet/chainTrackerFallback.ts',
  'src/wallet/createActionInputFate.ts',
  'src/wallet/dependencyHealth.ts',
  'src/wallet/legacyScan.ts',
  'src/wallet/ltc/chain.ts',
  'src/wallet/marketSettlement.ts',
  'src/wallet/rawTxFallback.ts',
  'src/wallet/scanLogin/approver.ts',
  'src/wallet/spendingAuthorization.ts',
  'src/wallet/swap/exolix.ts',
  'src/wallet/swap/exolixSwap.ts',
  'src/wallet/tipHeaderFailover.ts',
])
const MANUAL_ABORT = /setTimeout\(\(\) => *\w+\.abort\(/

describe('shared helpers have one home', () => {
  const files = sourceFiles()

  for (const rule of RULES) {
    it(`no ${rule.name} outside ${rule.home} (use ${rule.use})`, () => {
      const offenders = files.filter((f) => f.file !== rule.home && rule.pattern.test(f.text)).map((f) => f.file)
      expect(offenders).toEqual([])
    })
  }

  it('no new hand-written abort timers (use timeoutSignal(ms)); the allowlist only shrinks', () => {
    const found = new Set(files.filter((f) => MANUAL_ABORT.test(f.text)).map((f) => f.file))
    expect([...found].filter((file) => !MANUAL_ABORT_TIMERS.has(file))).toEqual([])
    expect([...MANUAL_ABORT_TIMERS].filter((file) => !found.has(file))).toEqual([])
  })
})
