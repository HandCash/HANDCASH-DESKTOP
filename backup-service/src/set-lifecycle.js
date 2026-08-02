#!/usr/bin/env node
import { createStore } from './store.js'

const dataDir = process.env.DATA_DIR || './data'
const status = process.argv[2]
if (!status || !['active', 'sunset', 'retired'].includes(status)) {
  console.error('Usage: node src/set-lifecycle.js <active|sunset|retired> [--retire-at ISO] [--message text]')
  process.exit(1)
}

let retireAt = null
let message = null
let successorUrl = null
for (let i = 3; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--retire-at') retireAt = process.argv[++i] ?? null
  else if (arg === '--message') message = process.argv[++i] ?? null
  else if (arg === '--successor') successorUrl = process.argv[++i] ?? null
}

const store = createStore(dataDir)
const lifecycle = store.setLifecycle({
  status,
  sunsetAt: status === 'sunset' ? new Date().toISOString() : status === 'active' ? null : store.getLifecycle().sunsetAt,
  retireAt,
  message:
    message ??
    (status === 'sunset'
      ? 'This provider is shutting down. Rotate your backup slice before retireAt.'
      : status === 'retired'
        ? 'This provider has retired.'
        : null),
  successorUrl,
})
console.log(JSON.stringify(lifecycle, null, 2))
