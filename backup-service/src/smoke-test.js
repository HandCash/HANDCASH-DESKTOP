#!/usr/bin/env node
/**
 * Local smoke tests for the backup-service share vault.
 *   npm test            — single instance enroll/retrieve
 *   npm run test:cluster — 2-of-3 across three ports
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrivateKey } from '@bsv/sdk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const cluster = process.argv.includes('--cluster')

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

async function waitHealth(base, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) return
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Service not healthy: ${base}`)
}

async function auth(base, email) {
  const start = await fetch(`${base}/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const startBody = await start.json()
  if (!start.ok) throw new Error(`auth/start failed: ${JSON.stringify(startBody)}`)
  const verify = await fetch(`${base}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: startBody.requestId, code: startBody.devCode }),
  })
  const verifyBody = await verify.json()
  if (!verify.ok) throw new Error(`auth/verify failed: ${JSON.stringify(verifyBody)}`)
  return verifyBody.token
}

/**
 * @param {string} base
 * @param {string} token
 * @param {string} userIdHash
 * @param {string} share
 */
async function enroll(base, token, userIdHash, share) {
  const res = await fetch(`${base}/share/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ userIdHash, share }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`enroll failed: ${JSON.stringify(body)}`)
}

/**
 * @param {string} base
 * @param {string} token
 * @param {string} userIdHash
 */
async function retrieve(base, token, userIdHash) {
  const res = await fetch(`${base}/share/retrieve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ userIdHash }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`retrieve failed: ${JSON.stringify(body)}`)
  return body.share
}

function startServer({ port, dataDir, name }) {
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.mkdirSync(dataDir, { recursive: true })
  const child = spawn(process.execPath, [path.join(root, 'src/server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      NAME: name,
      DEV_OTP: '000000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return child
}

async function testSingle() {
  const port = 18787
  const dataDir = path.join(root, '.smoke-data', 'single')
  const child = startServer({ port, dataDir, name: 'Smoke Single' })
  const base = `http://127.0.0.1:${port}`
  try {
    await waitHealth(base)
    const info = await (await fetch(`${base}/info`)).json()
    if (info.role !== 'backup-service') throw new Error('bad /info role')
    if (info.lifecycle?.status !== 'active') throw new Error('expected active lifecycle')

    const key = PrivateKey.fromRandom()
    const rootHex = key.toHex()
    const shares = key.toBackupShares(2, 3)
    const email = 'smoke@example.com'
    const userIdHash = sha256Hex(email)
    const token = await auth(base, email)
    await enroll(base, token, userIdHash, shares[0])
    const got = await retrieve(base, token, userIdHash)
    if (got !== shares[0]) throw new Error('retrieved share mismatch')

    // Sunset blocks enroll
    const { createStore } = await import('./store.js')
    createStore(dataDir).setLifecycle({
      status: 'sunset',
      sunsetAt: new Date().toISOString(),
      retireAt: new Date(Date.now() + 86400000).toISOString(),
      message: 'rotating',
      successorUrl: null,
    })
    const info2 = await (await fetch(`${base}/info`)).json()
    if (info2.lifecycle.status !== 'sunset') throw new Error('lifecycle not updated')
    const token2 = await auth(base, email)
    let enrollBlocked = false
    try {
      await enroll(base, token2, userIdHash, shares[1])
    } catch {
      enrollBlocked = true
    }
    if (!enrollBlocked) throw new Error('enroll should fail during sunset')
    // retrieve still ok during sunset
    await retrieve(base, token2, userIdHash)

    console.log('ok — single-instance enroll/retrieve + sunset gate')
    console.log(`   root ${rootHex.slice(0, 12)}… share stored for ${userIdHash.slice(0, 12)}…`)
  } finally {
    child.kill('SIGTERM')
  }
}

async function testCluster() {
  const ports = [18787, 18788, 18789]
  const children = ports.map((port, i) =>
    startServer({
      port,
      dataDir: path.join(root, '.smoke-data', `n${i}`),
      name: `Smoke ${i + 1}`,
    }),
  )
  const bases = ports.map((p) => `http://127.0.0.1:${p}`)
  try {
    await Promise.all(bases.map((b) => waitHealth(b)))
    const key = PrivateKey.fromRandom()
    const rootHex = key.toHex()
    const shares = key.toBackupShares(2, 3)
    const email = 'cluster@example.com'
    const userIdHash = sha256Hex(email)

    for (let i = 0; i < 3; i++) {
      const token = await auth(bases[i], email)
      await enroll(bases[i], token, userIdHash, shares[i])
    }

    const t0 = await auth(bases[0], email)
    const t1 = await auth(bases[1], email)
    const s0 = await retrieve(bases[0], t0, userIdHash)
    const s1 = await retrieve(bases[1], t1, userIdHash)
    const recovered = PrivateKey.fromBackupShares([s0, s1])
    if (recovered.toHex() !== rootHex) {
      throw new Error('2-of-3 recovery mismatch')
    }
    console.log('ok — 2-of-3 cluster recover from any two backup services')
    console.log(`   root ${rootHex.slice(0, 12)}… via ports ${ports[0]}+${ports[1]}`)
  } finally {
    for (const child of children) child.kill('SIGTERM')
  }
}

try {
  if (cluster) await testCluster()
  else await testSingle()
} catch (err) {
  console.error('FAIL', err)
  process.exit(1)
}
