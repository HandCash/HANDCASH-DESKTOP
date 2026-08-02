import fs from 'node:fs'
import path from 'node:path'

/**
 * @typedef {{
 *   shares: Record<string, { share: string, enrolledAt: string }>,
 *   lifecycle: {
 *     status: 'active' | 'sunset' | 'retired',
 *     sunsetAt: string | null,
 *     retireAt: string | null,
 *     message: string | null,
 *     successorUrl: string | null,
 *   }
 * }} StoreData
 */

/** @param {string} dataDir */
export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'store.json')

  /** @returns {StoreData} */
  function read() {
    try {
      if (!fs.existsSync(file)) return empty()
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return {
        shares: parsed.shares && typeof parsed.shares === 'object' ? parsed.shares : {},
        lifecycle: {
          ...empty().lifecycle,
          ...(parsed.lifecycle && typeof parsed.lifecycle === 'object' ? parsed.lifecycle : {}),
        },
      }
    } catch {
      return empty()
    }
  }

  /** @param {StoreData} data */
  function write(data) {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
  }

  return {
    getLifecycle: () => read().lifecycle,
    /** @param {Partial<StoreData['lifecycle']>} patch */
    setLifecycle(patch) {
      const data = read()
      data.lifecycle = { ...data.lifecycle, ...patch }
      write(data)
      return data.lifecycle
    },
    /** @param {string} userIdHash */
    getShare(userIdHash) {
      return read().shares[userIdHash] ?? null
    },
    /**
     * @param {string} userIdHash
     * @param {string} share
     */
    putShare(userIdHash, share) {
      const data = read()
      data.shares[userIdHash] = { share, enrolledAt: new Date().toISOString() }
      write(data)
    },
    /** @param {string} userIdHash */
    deleteShare(userIdHash) {
      const data = read()
      delete data.shares[userIdHash]
      write(data)
    },
  }
}

function empty() {
  return {
    shares: {},
    lifecycle: {
      status: /** @type {'active'} */ ('active'),
      sunsetAt: null,
      retireAt: null,
      message: null,
      successorUrl: null,
    },
  }
}
