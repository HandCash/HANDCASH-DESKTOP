import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Ratchet for Aeon adherence.
 *
 * A screen step (busy / phase / mode / confirming / step) belongs on a chart.
 * Files below already violate that. Do not add to the list. When one is
 * moved onto a machine, delete its line.
 *
 * New components that introduce a screen step without `useMachine` fail here
 * so an agent cannot ship a hand-rolled panel and call it Aeon.
 */
const GRANDFATHERED = new Set([
  'components/AddFriendPanel.tsx',
  'components/CollectableVerifyMark.tsx',
  'components/ConfirmPasswordGate.tsx',
  'components/CreateKeysBackupPanel.tsx',
  'components/FriendDetailsPanel.tsx',
  'components/HistoryBackupPanel.tsx',
  'components/HistoryRecoveryPanel.tsx',
  'components/ImportPhrasePanel.tsx',
  'components/LogViewerPanel.tsx',
  'components/MessagesPanel.tsx',
  'components/OnboardProtectPanel.tsx',
  'components/ReceivePanel.tsx',
  'components/UnlockSettingsPanel.tsx',
  'components/WalletBackupPanel.tsx',
  'components/WalletSetupConfigPanel.tsx',
])

const STEP_STATE =
  /const \[(?:busy|phase|mode|confirming|confirmingRemove|confirmRevoke|step),/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('Aeon screen steps', () => {
  const root = path.resolve(import.meta.dirname, '../components')
  const violations = walk(root).flatMap((file) => {
    const source = readFileSync(file, 'utf8')
    if (!STEP_STATE.test(source)) return []
    if (source.includes('useMachine(')) return []
    const rel = path.relative(path.resolve(import.meta.dirname, '..'), file)
    return [rel]
  })

  it('does not add a screen step outside a chart', () => {
    const fresh = violations.filter((rel) => !GRANDFATHERED.has(rel))
    expect(
      fresh,
      [
        'Screen steps belong on an XState chart, then the panel projects data-aeon-state.',
        'Write src/machines/<name>Machine.ts first (see identityMachine / sendMachine).',
        'Do not add useState busy/phase/mode/confirming. See .cursor/rules/aeon-ui.mdc.',
      ].join('\n'),
    ).toEqual([])
  })

  it('keeps the grandfather list equal to the remaining debt', () => {
    expect([...GRANDFATHERED].sort()).toEqual([...violations].sort())
  })
})
