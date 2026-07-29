const STORAGE_KEY = 'handcash.brc100.displayCurrency'

export type DisplayCurrency = 'usd' | 'bsv'

type Listener = (currency: DisplayCurrency) => void

const listeners = new Set<Listener>()

function read(): DisplayCurrency {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'bsv' || raw === 'usd') return raw
  } catch {
    // ignore
  }
  return 'usd'
}

let current: DisplayCurrency = read()

function write(currency: DisplayCurrency) {
  current = currency
  try {
    localStorage.setItem(STORAGE_KEY, currency)
  } catch {
    // ignore
  }
  for (const cb of listeners) cb(currency)
}

export function getDisplayCurrency(): DisplayCurrency {
  return current
}

export function setDisplayCurrency(currency: DisplayCurrency) {
  if (currency === current) return
  write(currency)
}

export function toggleDisplayCurrency(): DisplayCurrency {
  const next = current === 'usd' ? 'bsv' : 'usd'
  write(next)
  return next
}

export function subscribeDisplayCurrency(cb: Listener): () => void {
  listeners.add(cb)
  cb(current)
  return () => {
    listeners.delete(cb)
  }
}
