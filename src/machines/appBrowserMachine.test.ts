import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { appBrowserMachine, type AppBrowserOpener } from './appBrowserMachine'

function start(open: AppBrowserOpener) {
  const actor = createActor(appBrowserMachine, { input: { open } })
  actor.start()
  return actor
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('appBrowserMachine', () => {
  it('hands the normalised url to the shell and reports the host', async () => {
    const open = vi.fn<AppBrowserOpener>().mockResolvedValue({ ok: true })
    const actor = start(open)

    actor.send({ type: 'TYPE', value: 'lilpoker.com/poker' })
    actor.send({ type: 'OPEN' })
    await settled()

    expect(open).toHaveBeenCalledWith('https://lilpoker.com/poker')
    expect(actor.getSnapshot().value).toBe('handedOff')
    expect(actor.getSnapshot().context.host).toBe('lilpoker.com')
  })

  it('never asks the shell to open an address the wallet refuses', async () => {
    const open = vi.fn<AppBrowserOpener>().mockResolvedValue({ ok: true })
    const actor = start(open)

    actor.send({ type: 'TYPE', value: 'javascript:alert(1)' })
    actor.send({ type: 'OPEN' })
    await settled()

    expect(open).not.toHaveBeenCalled()
    expect(actor.getSnapshot().value).toBe('refused')
    expect(actor.getSnapshot().context.error).toMatch(/only opens https/)
  })

  it('surfaces a shell failure as a refusal', async () => {
    const actor = start(async () => ({ ok: false, error: 'No in-app browser on this device' }))

    actor.send({ type: 'TYPE', value: 'https://lilpoker.com' })
    actor.send({ type: 'OPEN' })
    await settled()

    expect(actor.getSnapshot().value).toBe('refused')
    expect(actor.getSnapshot().context.error).toBe('No in-app browser on this device')
  })

  it('treats a thrown shell error as a refusal, not a hand-off', async () => {
    const actor = start(async () => {
      throw new Error('plugin missing')
    })

    actor.send({ type: 'TYPE', value: 'https://lilpoker.com' })
    actor.send({ type: 'OPEN' })
    await settled()

    expect(actor.getSnapshot().value).toBe('refused')
    expect(actor.getSnapshot().context.error).toBe('plugin missing')
  })

  it('clears the refusal as soon as the address is edited', async () => {
    const actor = start(async () => ({ ok: true }))

    actor.send({ type: 'TYPE', value: 'file:///etc/hosts' })
    actor.send({ type: 'OPEN' })
    await settled()
    actor.send({ type: 'TYPE', value: 'https://lilpoker.com' })

    expect(actor.getSnapshot().value).toBe('editing')
    expect(actor.getSnapshot().context.error).toBe(null)
  })
})
