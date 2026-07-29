const STORAGE_KEY = 'handcash.brc100.collectionView'

export type CollectionView = 'list' | 'grid'

type Listener = (view: CollectionView) => void

const listeners = new Set<Listener>()

function read(): CollectionView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'list' || raw === 'grid') return raw
  } catch {
    // ignore
  }
  return 'list'
}

let current: CollectionView = read()

function write(view: CollectionView) {
  current = view
  try {
    localStorage.setItem(STORAGE_KEY, view)
  } catch {
    // ignore
  }
  for (const cb of listeners) cb(view)
}

export function getCollectionView(): CollectionView {
  return current
}

export function setCollectionView(view: CollectionView) {
  if (view === current) return
  write(view)
}

export function subscribeCollectionView(cb: Listener): () => void {
  listeners.add(cb)
  cb(current)
  return () => {
    listeners.delete(cb)
  }
}
