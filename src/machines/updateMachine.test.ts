import { describe, expect, it } from 'vitest'
import {
  updateView,
  type UpdateContext,
} from './updateMachine'

const base = (over: Partial<UpdateContext> = {}): UpdateContext => ({
  phase: 'idle',
  mode: 'default',
  currentVersion: '1.0.0',
  availableVersion: null,
  percent: null,
  error: null,
  canInstall: false,
  promptDismissedVersion: null,
  ...over,
})

describe('updateView', () => {
  it('hides idle and not-available',
    () => {
      expect(updateView('idle', base())).toBeNull()
      expect(updateView('not-available', base())).toBeNull()
    },
  )

  it('maps available to a downloadable pill with Later escape', () => {
    const view = updateView(
      'available',
      base({ availableVersion: '1.2.0', canInstall: true, phase: 'available' }),
    )
    expect(view?.label).toBe('Update available')
    expect(view?.action).toBe('DOWNLOAD')
    expect(view?.escapes?.[0]?.event).toBe('DISMISS')
  })

  it('hides available after Later for that version', () => {
    expect(
      updateView(
        'available',
        base({
          availableVersion: '1.2.0',
          canInstall: true,
          phase: 'available',
          promptDismissedVersion: '1.2.0',
        }),
      ),
    ).toBeNull()
  })

  it('fills download progress from percent', () => {
    const view = updateView(
      'downloading',
      base({ availableVersion: '1.2.0', percent: 42, phase: 'downloading' }),
    )
    expect(view?.label).toBe('Downloading 42%')
    expect(view?.progress).toBeCloseTo(0.42)
    expect(view?.action).toBeNull()
  })

  it('uses sideload copy while opening the Mac installer', () => {
    const view = updateView(
      'downloading',
      base({ availableVersion: '1.2.0', phase: 'downloading' }),
      { sideloadManual: true },
    )
    expect(view?.label).toBe('Opening installer…')
  })

  it('maps ready to Restart to update', () => {
    const view = updateView(
      'ready',
      base({ availableVersion: '1.2.0', canInstall: true, phase: 'ready' }),
    )
    expect(view?.label).toBe('Restart to update')
    expect(view?.action).toBe('INSTALL')
  })

  it('maps error to a short failed label with retry', () => {
    const view = updateView(
      'error',
      base({ phase: 'error', error: 'GitHub release check failed (403)' }),
    )
    expect(view?.label).toBe('Update failed')
    expect(view?.title).toContain('403')
    expect(view?.action).toBe('CHECK')
  })
})
