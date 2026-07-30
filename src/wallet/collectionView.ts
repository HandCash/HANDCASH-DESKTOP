const STORAGE_PREFIX = 'handcash.brc100.collectionView'

export type CollectionView = 'list' | 'grid'
export type CollectionViewScope = 'apps' | 'friends' | 'collectables'

type Listener = (view: CollectionView) => void

const listeners = new Map<CollectionViewScope, Set<Listener>>()
const current = new Map<CollectionViewScope, CollectionView>()

function storageKey(scope: CollectionViewScope): string {
  return `${STORAGE_PREFIX}.${scope}`
}

function read(scope: CollectionViewScope): CollectionView {
  try {
    const raw = localStorage.getItem(storageKey(scope))
    if (raw === 'list' || raw === 'grid') return raw
    // Migrate legacy single-key preference for apps.
    if (scope === 'apps') {
      const legacy = localStorage.getItem(STORAGE_PREFIX)
      if (legacy === 'list' || legacy === 'grid') return legacy
    }
  } catch {
    // ignore
  }
  return 'list'
}

function ensure(scope: CollectionViewScope): CollectionView {
  let view = current.get(scope)
  if (!view) {
    view = read(scope)
    current.set(scope, view)
  }
  return view
}

function write(scope: CollectionViewScope, view: CollectionView) {
  current.set(scope, view)
  try {
    localStorage.setItem(storageKey(scope), view)
  } catch {
    // ignore
  }
  const set = listeners.get(scope)
  if (set) for (const cb of set) cb(view)
}

export function getCollectionView(scope: CollectionViewScope = 'apps'): CollectionView {
  return ensure(scope)
}

export function setCollectionView(
  view: CollectionView,
  scope: CollectionViewScope = 'apps',
) {
  if (view === ensure(scope)) return
  write(scope, view)
}

export function subscribeCollectionView(
  cb: Listener,
  scope: CollectionViewScope = 'apps',
): () => void {
  let set = listeners.get(scope)
  if (!set) {
    set = new Set()
    listeners.set(scope, set)
  }
  set.add(cb)
  cb(ensure(scope))
  return () => {
    set!.delete(cb)
  }
}
