import { createActor, fromPromise, waitFor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clipboardMachine } from '../machines/clipboard.js'

const withWrite = (write: (value: string) => Promise<void>) =>
  clipboardMachine.provide({ actors: { write: fromPromise<void, { value: string }>(({ input }) => write(input.value)) } })

describe('clipboardMachine', () => {
  afterEach(() => vi.useRealTimers())

  it('writes the value, shows copied, then returns to idle', async () => {
    vi.useFakeTimers()
    const written: string[] = []
    const actor = createActor(withWrite(async (value) => void written.push(value)), { input: { timeout: 500 } }).start()

    actor.send({ type: 'COPY', value: 'npm i aeon-ui-engine' })
    await waitFor(actor, (s) => s.matches('copied'))
    expect(written).toEqual(['npm i aeon-ui-engine'])

    vi.advanceTimersByTime(500)
    expect(actor.getSnapshot().value).toBe('idle')
  })

  it('shows failed when the clipboard refuses', async () => {
    const actor = createActor(withWrite(async () => Promise.reject(new Error('denied'))), { input: {} }).start()

    actor.send({ type: 'COPY', value: 'x' })
    await waitFor(actor, (s) => s.matches('failed'))
  })

  it('copies again while still showing copied', async () => {
    const written: string[] = []
    const actor = createActor(withWrite(async (value) => void written.push(value)), { input: {} }).start()

    actor.send({ type: 'COPY', value: 'a' })
    await waitFor(actor, (s) => s.matches('copied'))
    actor.send({ type: 'COPY', value: 'b' })
    await waitFor(actor, () => written.length === 2)

    expect(written).toEqual(['a', 'b'])
  })

  it('plays copy on success and error on failure', async () => {
    const sounds: string[] = []
    const machine = (write: () => Promise<void>) =>
      clipboardMachine.provide({
        actors: { write: fromPromise<void, { value: string }>(write) },
        actions: { soundCopied: () => void sounds.push('copy'), soundFailed: () => void sounds.push('error') },
      })

    const ok = createActor(machine(async () => {}), { input: {} }).start()
    ok.send({ type: 'COPY', value: 'a' })
    await waitFor(ok, (s) => s.matches('copied'))

    const bad = createActor(machine(async () => Promise.reject(new Error('denied'))), { input: {} }).start()
    bad.send({ type: 'COPY', value: 'b' })
    await waitFor(bad, (s) => s.matches('failed'))

    expect(sounds).toEqual(['copy', 'error'])
  })
})
