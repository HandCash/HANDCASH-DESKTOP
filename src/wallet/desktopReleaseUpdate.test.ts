import fs from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

describe('Rust release updater IPC contract', () => {
  it('routes checks and modes to native, projects pushes, and unsubscribes', async () => {
    const posted: Array<{ id: string; method: string; params: unknown }> = []
    const window: Record<string, any> = {
      ipc: { postMessage: (raw: string) => posted.push(JSON.parse(raw)) },
    }
    vm.runInNewContext(fs.readFileSync('native-desktop/handcash-page.js', 'utf8'), {
      window, document: { addEventListener() {} }, console, Map, Set, Promise, Error,
    })
    const api = window.handcash
    const checking = api.checkForUpdates()
    expect(posted[0]!.method).toBe('checkForUpdates')
    const status = { phase: 'available', availableVersion: '1.3.719', canInstall: true }
    window.__handcashNativeReply({ id: posted[0]!.id, ok: true, value: status })
    await expect(checking).resolves.toEqual(status)
    const mode = api.setUpdateMode('none')
    expect(posted[1]).toMatchObject({ method: 'setUpdateMode', params: { mode: 'none' } })
    window.__handcashNativeReply({ id: posted[1]!.id, ok: true, value: { mode: 'none' } })
    await mode
    const seen: unknown[] = []
    const unsubscribe = api.onUpdateStatus((value: unknown) => seen.push(value))
    expect(posted[2]!.method).toBe('startUpdateChecks')
    window.__handcashNativeReply({ id: posted[2]!.id, ok: true, value: null })
    window.__handcashNativePush({ channel: 'update-status', payload: status })
    unsubscribe()
    window.__handcashNativePush({ channel: 'update-status', payload: { phase: 'idle' } })
    expect(seen).toEqual([status])
  })
})
