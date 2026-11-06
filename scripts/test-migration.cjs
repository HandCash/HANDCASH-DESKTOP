// Standalone protocol regression checks. Uses WebCrypto and the real sender /
// receiver modules, with account/storage ports substituted for synthetic data.
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')
let ts
try { ts = require('typescript') } catch { ts = require('../../items-market/node_modules/typescript') }
const root = path.join(__dirname, '..')

function load(file, ports = {}) {
  const module = { exports: {} }
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file, reportDiagnostics: true,
  })
  assert.equal((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  vm.runInNewContext(result.outputText, {
    module, exports: module.exports,
    require: name => { if (!(name in ports)) throw new Error(`Unexpected port: ${name}`); return ports[name] },
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Date, atob, btoa,
  }, { filename: file })
  return module.exports
}

let active, saved, routes, receives, saveGate
const source = { cloud: 'synthetic cloud share', trustholder: 'synthetic trustholder share' }
const receiver = load(path.join(root, 'src/wallet/import/encryptedImport.ts'), {
  '../session': { getActiveWallet: () => active },
  '../appIdentity': { normalizeAppHost: s => new URL(s.includes('://') ? s : `https://${s}`).host },
  './store': { addImportedSource: async (secret, label, expected, expectedChain) => {
    if (saveGate) await saveGate
    assert.equal(active?.identityKey, expected)
    assert.equal(active?.chain, expectedChain)
    saved.push(secret)
    return { source: { id: 'source-1' }, existing: false }
  } },
  './importSource': { parseImportSecret: (kind, fields) => ({ ok: true, secret: { kind, ...fields } }) },
  './recoveryHints': { parseRecoveryHints: () => null, rememberRecoveryHints: () => {} },
  './importIntent': { requestImportedSource: id => receives.push(id) },
  '../navStore': { openSetting: id => routes.push(id) },
})
const sender = load(path.join(root, '../items-market/src/lib/brc100/encryptedImport.ts'))
beforeEach(() => {
  active = { identityKey: `02${'a'.repeat(64)}`, chain: 'main' }
  saved = []; routes = []; receives = []; saveGate = null
  receiver.clearEncryptedImports()
})

test('website seals to the connected receiver; only the saved-source route runs', async () => {
  const request = await receiver.beginHandCashImport('https://handcash.io')
  const sealed = await sender.sealHandCashImport(request, source)
  assert.ok(!JSON.stringify(sealed).includes(source.cloud))
  assert.ok(!JSON.stringify(request).includes('privateKey'))
  const receipt = await receiver.completeHandCashImport('handcash.io', sealed)
  assert.equal(receipt.saved, true)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].primary, source.cloud)
  assert.deepEqual(routes, ['import'])
  assert.deepEqual(receives, ['source-1'])
})

test('concurrent delivery and a lost-response retry save once and return the same receipt', async () => {
  const request = await receiver.beginHandCashImport('handcash.io')
  const sealed = await sender.sealHandCashImport(request, source)
  const receipts = await Promise.all([
    receiver.completeHandCashImport('handcash.io', sealed),
    receiver.completeHandCashImport('handcash.io', sealed),
  ])
  assert.equal(receipts[0], receipts[1])
  assert.equal(await receiver.completeHandCashImport('handcash.io', sealed), receipts[0])
  assert.equal(saved.length, 1)
  assert.equal(receives.length, 1)
})

test('cross-origin delivery and a different receiving account cannot save shares', async () => {
  const request = await receiver.beginHandCashImport('handcash.io')
  const sealed = await sender.sealHandCashImport(request, source)
  await assert.rejects(receiver.completeHandCashImport('market.handcash.io', sealed), /expired|changed/)
  active = { ...active, identityKey: `03${'b'.repeat(64)}` }
  await assert.rejects(receiver.completeHandCashImport('handcash.io', sealed), /expired|changed/)
  assert.equal(saved.length, 0)
})

test('tampering with ciphertext fails closed without exposing shares in errors', async () => {
  const request = await receiver.beginHandCashImport('handcash.io')
  const sealed = await sender.sealHandCashImport(request, source)
  const ciphertext = Buffer.from(sealed.ciphertext, 'base64')
  ciphertext[0] ^= 1
  await assert.rejects(receiver.completeHandCashImport('handcash.io', {
    ...sealed, ciphertext: ciphertext.toString('base64'),
  }), error => !error.message.includes(source.cloud) && /Could not save/.test(error.message))
  assert.equal(saved.length, 0)
  const fresh = await receiver.beginHandCashImport('handcash.io')
  assert.notEqual(fresh.id, request.id)
})

test('the receiver descriptor is authenticated by encryption', async () => {
  const request = await receiver.beginHandCashImport('handcash.io')
  const sealed = await sender.sealHandCashImport({ ...request, identityKey: 'another-wallet' }, source)
  await assert.rejects(receiver.completeHandCashImport('handcash.io', sealed), /Could not save/)
  assert.equal(saved.length, 0)
})

test('expired requests and locked/cleared sessions cannot receive an export', async () => {
  const request = await receiver.beginHandCashImport('handcash.io')
  const sealed = await sender.sealHandCashImport(request, source)
  request.expiresAt = Date.now() - 1
  await assert.rejects(receiver.completeHandCashImport('handcash.io', sealed), /expired/)
  await assert.rejects(sender.sealHandCashImport(request, source), /unlocked mainnet/)
  receiver.clearEncryptedImports()
  await assert.rejects(receiver.completeHandCashImport('handcash.io', sealed), /expired/)
  active = null
  await assert.rejects(receiver.beginHandCashImport('handcash.io'), /Unlock/)
  assert.equal(saved.length, 0)
})

test('the sender refuses a testnet receiver before exporting anything', async () => {
  active.chain = 'test'
  const request = await receiver.beginHandCashImport('handcash.io')
  await assert.rejects(sender.sealHandCashImport(request, source), /mainnet/)
})

test('account switching during asynchronous save cannot route the imported source', async () => {
  const request = await receiver.beginHandCashImport('handcash.io')
  const sealed = await sender.sealHandCashImport(request, source)
  let resume
  saveGate = new Promise(resolve => { resume = resolve })
  const delivery = receiver.completeHandCashImport('handcash.io', sealed)
  active = { ...active, identityKey: 'different' }
  resume()
  await assert.rejects(delivery, /Could not save/)
  assert.equal(saved.length, 0)
  assert.equal(receives.length, 0)
})

test('onboarding migration intent survives module reload and is consumed once', () => {
  const storage = new Map()
  const opened = []
  const ports = {
    './import': { requestImportKind: kind => opened.push(kind) },
    './navStore': { openSetting: setting => opened.push(setting) },
    './walletConfig': { MIGRATE_LOGIN_URL: 'https://example.invalid/migrate?from=wallet-login' },
    '../storage/registry': { storageRegistry: { cloudMigrationIntent: { key: 'intent' } } },
    './durableStorage': {
      durableGetItem: key => storage.get(key),
      durableSetItem: (key, value) => storage.set(key, value),
      durableRemoveItem: key => storage.delete(key),
    },
  }
  const file = path.join(root, 'src/wallet/cloudMigrationIntent.ts')
  load(file, ports).armCloudMigrationIntent()
  const reloaded = load(file, ports)
  assert.equal(reloaded.peekCloudMigrationIntent(), true)
  assert.equal(reloaded.consumeCloudMigrationIntent(), true)
  assert.equal(reloaded.consumeCloudMigrationIntent(), false)
  assert.deepEqual(opened, ['handcash', 'import'])
  reloaded.armCloudMigrationIntent()
  reloaded.cancelCloudMigrationIntent()
  assert.equal(reloaded.peekCloudMigrationIntent(), false)
})

test('real source store seals at rest, de-duplicates and refuses a failed durable save', async () => {
  active = { ...active, rootKeyHex: '11'.repeat(32), accountIndex: 0 }
  const disk = new Map()
  let writable = true
  let notifications = 0
  const store = load(path.join(root, 'src/wallet/import/store.ts'), {
    '@bsv/sdk': { Utils: { toArray: (s, encoding) => [...Buffer.from(s, encoding)] } },
    '../../storage/registry': { storageRegistry: { importedSources: { key: 'synthetic-source-store' } } },
    '../accountLocalKeys': { accountLocalKeyFor: (key, owner) => `${owner.identityKey}:${key}` },
    '../base64Binary': {
      base64ToBytes: s => [...Buffer.from(s, 'base64')],
      bytesToBase64: b => Buffer.from(b).toString('base64'),
    },
    '../durableStorage': {
      durableGetItem: key => disk.get(key), durableRemoveItem: key => disk.delete(key),
      durableSetItem: (key, value) => { if (!writable) return false; disk.set(key, value); return true },
    },
    '../walletRuntime': { getWalletRuntime: () => ({ instance: active }) },
    './itemStore': { forgetImportItemStore: async () => {} },
    './importSource': { sourceFingerprint: () => 'synthetic-fingerprint' },
  })
  store.subscribeImportedSources(() => { notifications++ })
  const secret = { kind: 'handcash', first: 'synthetic-first-private-share', second: 'synthetic-second-private-share' }
  const first = await store.addImportedSource(secret, undefined, active.identityKey)
  assert.equal(first.existing, false)
  assert.ok(![...disk.values()].join('').includes(secret.first))
  assert.equal((await store.loadImportedSources())[0].secret.first, secret.first)
  assert.equal((await store.addImportedSource(secret)).existing, true)
  assert.equal((await store.loadImportedSources()).length, 1)
  assert.equal(notifications, 1)
  await assert.rejects(store.addImportedSource(secret, undefined, 'wrong-receiver'), /wallet changed/)
  await assert.rejects(store.addImportedSource(secret, undefined, active.identityKey, 'test'), /network changed/)
  writable = false
  await assert.rejects(store.updateImportedSource(first.source.id, { label: 'unsaved' }), /Could not save/)
  assert.equal(notifications, 1)
  assert.notEqual((await store.loadImportedSources())[0].label, 'unsaved')
})

test('real sweep distinguishes completion, failed items and fee pauses, invalidating old totals', async () => {
  const jobEvents = []
  const patches = []
  let result = { results: [{ outpoint: 'synthetic_0', result: { kind: 'moved', txid: 'synthetic-tx' } }], stopped: null }
  const holdings = [{ address: 'synthetic-address', path: 'm/9/0', label: 'HandCash', cashCount: 0, cashSats: 0, itemCount: 1 }]
  const sweep = load(path.join(root, 'src/wallet/import/sweep.ts'), {
    '../walletRuntime': { getWalletRuntime: () => ({ instance: active }) },
    '../appLog': { appendAppLog: () => {} },
    '../walletJobs': { beginWalletJob: () => ({ id: 'synthetic-job', progress: () => {},
      finish: () => jobEvents.push('finish'), stop: () => jobEvents.push('stop'), fail: () => jobEvents.push('fail') }) },
    '../../machines/importQueueMachine': { IMPORT_CHUNK: 100 },
    '../itemMigrateBundle': { MAX_ITEMS_PER_MIGRATE_TX: 25 },
    '../phraseSweep': { peekPhraseItemMigrateCursor: () => null, refreshAfterPhraseItemMigrate: async () => {} },
    './holdings': { totalHoldings: () => ({ cashCount: 0, cashSats: 0, itemCount: 1, held: {}, partial: 0 }), addHeld: () => ({}) },
    './importSource': { keyDeriverFor: () => ({ privateKeyAt: () => { throw new Error('Unexpected signing') } }) },
    './itemStore': { listedImportOutpoints: async () => new Set(['synthetic_0']) },
    './items': { syncImportItems: async () => ({ complete: true }), importItems: async () => result, clearImportItems: async () => {} },
    './store': { loadImportedSources: async () => [{ id: 'source', secret: {}, scan: { complete: true, holdings } }],
      updateImportedSource: async (id, patch) => { patches.push(patch) } },
  })
  assert.equal((await sweep.sweepImportedSource({ sourceId: 'source' })).status, 'completed')
  assert.equal(jobEvents.pop(), 'finish')
  assert.equal(patches.at(-1).scan, null)
  result = { results: [{ outpoint: 'synthetic_0', result: { kind: 'unreadable' } }], stopped: null }
  const failed = await sweep.sweepImportedSource({ sourceId: 'source' })
  assert.equal(failed.status, 'partial')
  assert.equal(failed.failed, 1)
  assert.equal(jobEvents.pop(), 'stop')
  result = { results: [], stopped: 'funds' }
  assert.equal((await sweep.sweepImportedSource({ sourceId: 'source' })).status, 'paused')
  assert.equal(jobEvents.pop(), 'stop')
})

test('real UTXO scan refuses partially rejected sets and marks failed address reads incomplete', async () => {
  let rejected = 1
  const scan = load(path.join(root, 'src/wallet/import/scan.ts'), {
    '../walletRuntime': { getWalletRuntime: () => ({ instance: active }) },
    '../paymentPolicy': { assertOnlineForPayment: () => {} },
    '../appLog': { appendAppLog: () => {} },
    './discovery': {},
    './holdings': { inspectHoldings: async () => [{ address: 'synthetic', error: 'network unavailable' }] },
    './handcashUtxoSet': {
      fetchHandCashUtxoSet: async () => ({ kind: 'fetched', utxos: [{}] }),
      verifyUtxoSet: async () => ({ rejected, addresses: [{ address: 'synthetic' }], cashOutputs: new Map(), itemOutpoints: new Map(), readAddresses: ['synthetic'] }),
      readUnspentOnChain: async () => ({ stopped: false, unknown: new Set(), unspent: new Set() }),
    },
    './importSource': {},
    './items': { checkUtxoSetItems: async () => ({ stopped: false, failed: 0, unspent: new Set() }) },
    './recoveryHints': {},
    './store': {},
  })
  assert.equal(await scan.utxoSetScan({}, 'main', { sourceId: 'source' }), null)
  rejected = 0
  assert.equal((await scan.utxoSetScan({}, 'main', { sourceId: 'source' })).complete, false)
})
