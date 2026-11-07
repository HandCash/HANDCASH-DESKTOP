import { describe, expect, it, vi } from 'vitest'
import { createActor, waitFor } from 'xstate'
import { settingsPreferencesMachine } from './settingsPreferencesMachine'
import type { SettingsPreferences, SettingsPreferencesPort } from '../wallet/settingsPreferences'

describe('Settings preferences', () => {
  function fixture() {
    let preferences: SettingsPreferences = { appearance: 'system', sound: true }
    let changed: (() => void) | undefined
    const stop = vi.fn()
    const port: SettingsPreferencesPort = {
      read: () => preferences,
      choose: vi.fn((path) => {
        preferences = path.kind === 'appearance'
          ? { ...preferences, appearance: path.value }
          : { ...preferences, sound: path.value }
      }),
      subscribe: (listener) => { changed = listener; return stop },
    }
    const actor = createActor(settingsPreferencesMachine, { input: { port } }).start()
    return { actor, port, stop, external: (next: SettingsPreferences) => {
      preferences = next
      changed?.()
    } }
  }

  it('persists tagged choices and projects both preferences without resetting siblings', () => {
    const { actor, port } = fixture()
    actor.send({ type: 'CHOOSE', path: { kind: 'appearance', value: 'dark' } })
    expect(port.choose).toHaveBeenCalledWith({ kind: 'appearance', value: 'dark' })
    actor.send({ type: 'CHOOSE', path: { kind: 'sound', value: false } })
    expect(actor.getSnapshot().context).toMatchObject({ appearance: 'dark', sound: false })
    expect(actor.getSnapshot().matches('ready')).toBe(true)
    actor.stop()
  })

  it('reconciles external changes without writing them back and unsubscribes on stop', async () => {
    const { actor, port, stop, external } = fixture()
    external({ appearance: 'light', sound: false })
    await waitFor(actor, (snapshot) => snapshot.context.appearance === 'light')
    expect(actor.getSnapshot().context.sound).toBe(false)
    expect(port.choose).not.toHaveBeenCalled()
    actor.stop()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
