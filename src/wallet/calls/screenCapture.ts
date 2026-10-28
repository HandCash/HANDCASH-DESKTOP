/**
 * Sharing a screen or window in a call. The desktop app lists sources for
 * its own picker; picking one tells the main process which source the next
 * `getDisplayMedia` call may have, so the system never opens a picker of
 * its own and nothing is captured that the user did not just choose.
 */

export type ScreenSource = { id: string; name: string; kind: 'screen' | 'window'; thumbnail: string }

function bridge() {
  return typeof window !== 'undefined' ? window.handcash : undefined
}

export function screenShareAvailable(): boolean {
  const b = bridge()
  return !!b?.listScreenSources && !!b.chooseScreenSource && !!globalThis.navigator?.mediaDevices?.getDisplayMedia
}

export async function listScreenSources(): Promise<ScreenSource[]> {
  return (await bridge()?.listScreenSources?.()) ?? []
}

export async function captureScreen(sourceId: string): Promise<MediaStream> {
  const b = bridge()
  if (!b?.chooseScreenSource || !(await b.chooseScreenSource(sourceId))) {
    throw Object.assign(new Error('screen source refused'), { name: 'NotAllowedError' })
  }
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false })
}

export function screenFailureText(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'HandCash isn’t allowed to record the screen (on a Mac: System Settings, Privacy & Security, Screen Recording)'
  }
  if (name === 'NotFoundError') return 'That window has closed'
  return 'Screen sharing didn’t start'
}
