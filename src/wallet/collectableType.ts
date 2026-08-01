const STORAGE_KEY = 'handcash.brc100.collectableType'

/** Protocol family shown in the Collectables top-bar selector. */
export type CollectableType = '1sat' | 'twonk'

type Listener = (type: CollectableType) => void

const listeners = new Set<Listener>()
let current: CollectableType | null = null

function read(): CollectableType {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === '1sat' || raw === 'twonk') return raw
  } catch {
    // ignore
  }
  return '1sat'
}

function ensure(): CollectableType {
  if (!current) current = read()
  return current
}

function write(type: CollectableType) {
  current = type
  try {
    localStorage.setItem(STORAGE_KEY, type)
  } catch {
    // ignore
  }
  for (const cb of listeners) cb(type)
}

export function getCollectableType(): CollectableType {
  return ensure()
}

export function setCollectableType(type: CollectableType) {
  if (type === ensure()) return
  write(type)
}

export function subscribeCollectableType(cb: Listener): () => void {
  listeners.add(cb)
  cb(ensure())
  return () => {
    listeners.delete(cb)
  }
}

export function collectableTypeLabel(type: CollectableType): string {
  return type === 'twonk' ? 'Twonk' : '1Sat'
}
