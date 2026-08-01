export type ToastTone = 'neutral' | 'success' | 'error'

export type ToastItem = {
  id: string
  title: string
  body?: string
  tone: ToastTone
  durationMs: number
  createdAt: number
}

type Listener = (items: ToastItem[]) => void

const listeners = new Set<Listener>()
let items: ToastItem[] = []
let seq = 0

function emit() {
  for (const listener of listeners) listener(items)
}

export function getToasts(): ToastItem[] {
  return items
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener)
  listener(items)
  return () => {
    listeners.delete(listener)
  }
}

export function dismissToast(id: string): void {
  const next = items.filter((t) => t.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

export function showToast(input: {
  title: string
  body?: string
  tone?: ToastTone
  durationMs?: number
}): string {
  const id = `toast-${Date.now()}-${++seq}`
  const tone = input.tone ?? 'neutral'
  const durationMs =
    input.durationMs ?? (tone === 'error' ? 5600 : tone === 'success' ? 2200 : 4200)
  const item: ToastItem = {
    id,
    title: input.title,
    body: input.body,
    tone,
    durationMs,
    createdAt: Date.now(),
  }
  items = [...items, item].slice(-4)
  emit()
  if (durationMs > 0) {
    window.setTimeout(() => dismissToast(id), durationMs)
  }
  return id
}

export function toastError(title: string, body?: string): string {
  return showToast({ title, body, tone: 'error' })
}

export function toastSuccess(title: string, body?: string): string {
  return showToast({ title, body, tone: 'success' })
}

export function toastCopied(what?: string): string {
  return showToast({
    title: what ? `Copied ${what}` : 'Copied',
    tone: 'success',
    durationMs: 1800,
  })
}
