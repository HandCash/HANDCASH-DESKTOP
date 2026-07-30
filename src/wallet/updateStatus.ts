import { useEffect, useState } from 'react'

export type UpdateMode = 'default' | 'manual' | 'none'

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'ready'
  | 'error'

export type UpdateStatus = {
  phase: UpdatePhase
  mode: UpdateMode
  currentVersion: string
  availableVersion: string | null
  percent: number | null
  error: string | null
  canInstall: boolean
}

const IDLE: UpdateStatus = {
  phase: 'idle',
  mode: 'default',
  currentVersion: '0.0.0',
  availableVersion: null,
  percent: null,
  error: null,
  canInstall: false,
}

let cached: UpdateStatus = IDLE
const listeners = new Set<(status: UpdateStatus) => void>()

function emit(status: UpdateStatus) {
  cached = status
  for (const listener of listeners) listener(status)
}

export function subscribeUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
  listeners.add(listener)
  listener(cached)
  return () => listeners.delete(listener)
}

export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState(cached)
  useEffect(() => subscribeUpdateStatus(setStatus), [])
  return status
}

export function initUpdateStatusBridge(): () => void {
  const api = window.handcash
  if (!api?.getUpdateStatus || !api.onUpdateStatus) {
    return () => undefined
  }

  let cancelled = false
  void api.getUpdateStatus().then((status) => {
    if (!cancelled) emit(status)
  })

  const off = api.onUpdateStatus((status) => emit(status))
  return () => {
    cancelled = true
    off()
  }
}

export async function checkForUpdatesNow(): Promise<UpdateStatus> {
  const api = window.handcash
  if (!api?.checkForUpdates) return cached
  const status = await api.checkForUpdates()
  emit(status)
  return status
}

export async function setUpdateModeNow(mode: UpdateMode): Promise<UpdateStatus> {
  const api = window.handcash
  if (!api?.setUpdateMode) return cached
  const status = await api.setUpdateMode(mode)
  emit(status)
  return status
}

export async function downloadUpdateNow(): Promise<UpdateStatus> {
  const api = window.handcash
  if (!api?.downloadUpdate) return cached
  const status = await api.downloadUpdate()
  emit(status)
  return status
}

export async function installUpdateNow(): Promise<void> {
  await window.handcash?.installUpdate?.()
}
