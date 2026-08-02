import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express from 'express'
import { createStore } from './store.js'

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const DATA_DIR = process.env.DATA_DIR || './data'
const NAME = process.env.NAME || 'Local Backup Service'
const DEV_OTP = process.env.DEV_OTP || '000000'

const store = createStore(DATA_DIR)
const app = express()
app.use(cors())
app.use(express.json({ limit: '32kb' }))

/** @type {Map<string, { email: string, code: string, expiresAt: number }>} */
const pendingAuth = new Map()
/** @type {Map<string, { email: string, expiresAt: number }>} */
const sessions = new Map()

function isBrc140Share(line) {
  const parts = String(line || '').trim().split('.')
  if (parts.length !== 4) return false
  const [x, y, t, integrity] = parts
  if (!x || !y || !integrity) return false
  if (!/^[0-9a-f]{8}$/i.test(integrity)) return false
  const threshold = Number.parseInt(t, 10)
  return Number.isInteger(threshold) && threshold >= 2
}

function bearerToken(req) {
  const h = req.headers.authorization
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null
  return h.slice('Bearer '.length).trim() || null
}

function requireSession(req, res) {
  const token = bearerToken(req)
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' })
    return null
  }
  const session = sessions.get(token)
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token)
    res.status(401).json({ error: 'Session expired' })
    return null
  }
  return session
}

function lifecycleAllowsEnroll(lifecycle) {
  if (lifecycle.status === 'retired') return false
  if (lifecycle.status === 'sunset') return false
  if (lifecycle.retireAt && Date.parse(lifecycle.retireAt) <= Date.now()) return false
  return true
}

function lifecycleAllowsRetrieve(lifecycle) {
  if (lifecycle.status === 'retired') return false
  if (lifecycle.retireAt && Date.parse(lifecycle.retireAt) <= Date.now()) return false
  return true
}

app.get('/info', (_req, res) => {
  res.json({
    name: NAME,
    version: '0.1.0',
    role: 'backup-service',
    authMethods: ['DevEmail'],
    requiresPasswordWithOtp: false,
    lifecycle: store.getLifecycle(),
  })
})

app.post('/auth/start', (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase()
  if (!email || !email.includes('@')) {
    res.status(400).json({ error: 'Valid email required' })
    return
  }
  const requestId = crypto.randomBytes(16).toString('hex')
  const code = DEV_OTP
  pendingAuth.set(requestId, {
    email,
    code,
    expiresAt: Date.now() + 10 * 60 * 1000,
  })
  console.log(`[auth] OTP for ${email}: ${code} (requestId=${requestId})`)
  res.json({
    requestId,
    expiresInSec: 600,
    // Local/dev only — production operators must not return this.
    devCode: code,
  })
})

app.post('/auth/verify', (req, res) => {
  const requestId = String(req.body?.requestId || '').trim()
  const code = String(req.body?.code || '').trim()
  const pending = pendingAuth.get(requestId)
  if (!pending || pending.expiresAt < Date.now()) {
    pendingAuth.delete(requestId)
    res.status(400).json({ error: 'Invalid or expired request' })
    return
  }
  if (code !== pending.code) {
    res.status(400).json({ error: 'Invalid code' })
    return
  }
  pendingAuth.delete(requestId)
  const token = crypto.randomBytes(24).toString('hex')
  sessions.set(token, {
    email: pending.email,
    expiresAt: Date.now() + 30 * 60 * 1000,
  })
  res.json({ token, email: pending.email, expiresInSec: 1800 })
})

app.post('/share/enroll', (req, res) => {
  if (!requireSession(req, res)) return
  const lifecycle = store.getLifecycle()
  if (!lifecycleAllowsEnroll(lifecycle)) {
    res.status(403).json({ error: 'Service is not accepting new enrollments', lifecycle })
    return
  }
  const userIdHash = String(req.body?.userIdHash || '')
    .trim()
    .toLowerCase()
  const share = String(req.body?.share || '').trim()
  if (!/^[0-9a-f]{64}$/.test(userIdHash)) {
    res.status(400).json({ error: 'userIdHash must be 64 hex chars (sha256)' })
    return
  }
  if (!isBrc140Share(share)) {
    res.status(400).json({ error: 'share must be BRC-140 format x.y.threshold.integrity' })
    return
  }
  store.putShare(userIdHash, share)
  res.json({ ok: true, userIdHash, enrolledAt: store.getShare(userIdHash)?.enrolledAt })
})

app.post('/share/retrieve', (req, res) => {
  if (!requireSession(req, res)) return
  const lifecycle = store.getLifecycle()
  if (!lifecycleAllowsRetrieve(lifecycle)) {
    res.status(403).json({ error: 'Service has retired; retrieve unavailable', lifecycle })
    return
  }
  const userIdHash = String(req.body?.userIdHash || '')
    .trim()
    .toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(userIdHash)) {
    res.status(400).json({ error: 'userIdHash must be 64 hex chars (sha256)' })
    return
  }
  const row = store.getShare(userIdHash)
  if (!row) {
    res.status(404).json({ error: 'No share enrolled for this userIdHash' })
    return
  }
  res.json({ share: row.share, enrolledAt: row.enrolledAt })
})

app.post('/share/delete', (req, res) => {
  if (!requireSession(req, res)) return
  const userIdHash = String(req.body?.userIdHash || '')
    .trim()
    .toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(userIdHash)) {
    res.status(400).json({ error: 'userIdHash must be 64 hex chars (sha256)' })
    return
  }
  store.deleteShare(userIdHash)
  res.json({ ok: true })
})

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

const thisFile = fileURLToPath(import.meta.url)
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked === thisFile) {
  app.listen(PORT, HOST, () => {
    console.log(`[backup-service] ${NAME} listening on http://${HOST}:${PORT}`)
    console.log(`[backup-service] data: ${path.resolve(DATA_DIR)}`)
  })
}
