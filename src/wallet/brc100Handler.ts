import type { WalletInterface } from '@bsv/sdk'
import { Beef, Transaction } from '@bsv/sdk'
import { getActiveWallet, fetchBalanceSats } from './session'
import {
  filterItemOutputsForOrigin,
  gateOriginAccess,
  isActionMethod,
  normalizeOrigin,
  requestActionApproval,
  requestItemViewApproval,
} from './permissions'
import { isItemBasket, isItemSpendArgs, prepareItemBasketArgs } from './itemAccess'
import { extractSatsFromArgs, recordAppActivity, WALLET_ACTIVITY_ORIGIN } from './appActivity'
import { scheduleHistoryBackupPush } from './deviceSync'
import { extractTxid } from './txExplorer'
import { parseOrdEnvelope } from './ordinalOwnership'
import { rememberTokenIcon } from './tokenIconCache'
import { rememberBeefBinary, hydrateInputBeef } from './beefCache'
import {
  enrichCreateActionForBsv21Issuer,
  finishBsv21IdentityMintCreateAction,
  isBsv21IdentityMintArgs,
  bsv21IdentityMintHints,
} from './bsv21Issuer'
import { normalizeTokenId } from './bsv21'
import {
  claimCloudHandlePayload,
  getClaimedCloudHandlePayload,
  isHandleClaimMethod,
  isHandleClaimOrigin,
} from './handleClaim'
import {
  getLegacyAddressPayload,
  isMigrationMethod,
  isMigrationOrigin,
  listMigrationTxids,
  refreshLegacyAddressPayload,
} from './migration'
import { playWalletSound } from './soundService'
import { requestUnlockForBridge } from './walletHealth'
import { assertOnlineForPayment } from './paymentPolicy'
import { prepareBrcActionSpend, runExclusiveSpend } from './spendGuard'
import { canAutoProcessPayment } from './autoPay'
import {
  clearPaymentProgress,
  setPaymentProgress,
} from './paymentProgress'
type HttpRequestEvent = {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  request_id: number
}

function parseOrigin(headers: Record<string, string>): string | undefined {
  const rawOrigin = headers.origin
  const rawOriginator = headers.originator
  if (rawOrigin) {
    try {
      return new URL(rawOrigin).host
    } catch {
      return undefined
    }
  }
  if (rawOriginator) {
    try {
      const candidate = rawOriginator.includes('://') ? rawOriginator : `http://${rawOriginator}`
      return new URL(candidate).host
    } catch {
      return undefined
    }
  }
  return undefined
}

function methodFromPath(path: string): string {
  return path.replace(/^\//, '').split('?')[0] || ''
}

/** Cache image-inscription outputs we just authored (BSV-21 ticker icons). */
function cacheImageIconsFromCreateAction(txid: string, args: unknown): void {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return
  const outputs = (args as { outputs?: unknown }).outputs
  if (!Array.isArray(outputs)) return
  const id = txid.trim().toLowerCase()
  for (let vout = 0; vout < outputs.length; vout++) {
    const raw = outputs[vout]
    if (!raw || typeof raw !== 'object') continue
    const script = (raw as { lockingScript?: unknown }).lockingScript
    if (typeof script !== 'string' || !script) continue
    const env = parseOrdEnvelope(script)
    if (!env?.contentType) continue
    const mime = env.contentType.toLowerCase().split(';')[0]!.trim()
    if (!mime.startsWith('image/')) continue
    rememberTokenIcon(`${id}_${vout}`, env.body, mime)
  }
}

/** Keep AtomicBEEF / tx bytes from createAction so a follow-up spend can prove inputs. */
async function cacheCreateActionBeef(
  active: NonNullable<ReturnType<typeof getActiveWallet>>,
  txid: string,
  result: unknown,
): Promise<void> {
  if (!result || typeof result !== 'object') return
  const raw = (result as { tx?: unknown }).tx
  let binary: number[] | null = null
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
    binary = raw as number[]
  } else if (raw instanceof Uint8Array) {
    binary = Array.from(raw)
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const bin = atob(raw.trim())
      binary = Array.from(bin, (c) => c.charCodeAt(0))
    } catch {
      binary = null
    }
  }
  if (!binary?.length) return
  const id = txid.trim().toLowerCase()
  try {
    const asBeef = Beef.fromBinary(binary)
    asBeef.atomicTxid = undefined
    const shaped = await hydrateInputBeef(active, asBeef)
    if (shaped && Beef.fromBinary(shaped).findTxid(id)?.tx) {
      rememberBeefBinary(id, shaped)
      return
    }
  } catch {
    // not AtomicBEEF / not shapeable
  }
  try {
    const wrapped = new Beef()
    wrapped.mergeTransaction(Transaction.fromBinary(binary))
    wrapped.atomicTxid = undefined
    const shaped = await hydrateInputBeef(active, wrapped)
    if (shaped && Beef.fromBinary(shaped).findTxid(id)?.tx) {
      rememberBeefBinary(id, shaped)
    }
  } catch {
    // ignore — follow-up spend may still fetch from services
  }
}

/**
 * Identity mint / remint: activity as received tokens (not a BSV payment spend).
 * Mint tips use tip outpoint as the activity key; genesis-only deploy+auth is an event.
 */
function recordIdentityMintActivity(
  txid: string,
  args: unknown,
  originator: string | undefined,
): void {
  const hints = bsv21IdentityMintHints(args)
  const sym = hints.sym?.trim() || 'Token'
  const outputs =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { outputs?: unknown[] }).outputs
      : undefined
  if (!Array.isArray(outputs) || outputs.length === 0) {
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'event',
      sats: 0,
      method: 'mint-token',
      note: `Minted ${sym}`,
      txid,
    })
    return
  }

  const id = txid.trim().toLowerCase()
  let recordedMint = false
  for (let vout = 0; vout < outputs.length; vout++) {
    const raw = outputs[vout]
    if (!raw || typeof raw !== 'object') continue
    const out = raw as {
      basket?: string
      tags?: string[]
      customInstructions?: string
    }
    if ((out.basket ?? '').trim().toLowerCase() !== 'bsv21') continue
    let op = ''
    let tokenId: string | null = null
    let amt: string | null = hints.amt
    let tipSym = sym
    for (const tag of out.tags ?? []) {
      const t = tag.trim()
      const lower = t.toLowerCase()
      if (lower.startsWith('op:')) op = t.slice(3).trim().toLowerCase()
      if (lower.startsWith('bsv21:')) {
        tokenId = normalizeTokenId(t.slice('bsv21:'.length))
      }
      if (lower.startsWith('amt:')) amt = t.slice(4).trim() || amt
      if (lower.startsWith('sym:')) tipSym = t.slice(4).trim() || tipSym
    }
    if (out.customInstructions) {
      try {
        const ci = JSON.parse(out.customInstructions) as {
          op?: unknown
          id?: unknown
          amt?: unknown
          sym?: unknown
        }
        if (!op && typeof ci.op === 'string') op = ci.op.trim().toLowerCase()
        if (!tokenId && typeof ci.id === 'string') {
          tokenId = normalizeTokenId(ci.id)
        }
        if (!amt && typeof ci.amt === 'string') amt = ci.amt.trim()
        if (typeof ci.sym === 'string' && ci.sym.trim()) tipSym = ci.sym.trim()
      } catch {
        // ignore
      }
    }
    if (op === 'deploy+mint') {
      tokenId = tokenId ?? normalizeTokenId(`${id}_${vout}`)
    }
    if (op !== 'mint' && op !== 'deploy+mint') continue
    if (!tokenId || !amt) continue
    const outpoint = `${id}.${vout}`
    recordedMint = true
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'receive-token',
      note: `Received ${tipSym}`,
      txid: id,
      item: {
        name: tipSym,
        origin: tokenId,
        outpoint,
        tokenId,
      },
    })
  }

  if (!recordedMint) {
    // deploy+auth (or mint args without parseable tip) — still surface the action.
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'event',
      sats: 0,
      method: 'mint-token',
      note: hints.amt
        ? `Minted ${sym}`
        : `Deployed ${sym}`,
      txid: id,
    })
  }
}

async function dispatchWalletMethod(
  wallet: WalletInterface,
  method: string,
  args: unknown,
  originator?: string,
): Promise<unknown> {
  const w = wallet as WalletInterface & Record<string, (a?: unknown, o?: string) => Promise<unknown>>

  switch (method) {
    case 'getLegacyAddress':
      return getLegacyAddressPayload()
    case 'refreshLegacyAddress':
      return refreshLegacyAddressPayload(
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as { txids?: string[]; items?: Array<{ outpoint: string; origin?: string; txid?: string; vout?: number }> })
          : undefined,
      )
    case 'listMigrationTxids':
      return listMigrationTxids()
    case 'claimCloudHandle':
      return claimCloudHandlePayload(
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as { handle: string; claimTicket?: string })
          : { handle: '' },
      )
    case 'getClaimedCloudHandle':
      return getClaimedCloudHandlePayload()
    case 'getVersion':
      return wallet.getVersion({})
    case 'getNetwork':
      return wallet.getNetwork({})
    case 'isAuthenticated':
      return { authenticated: true }
    case 'waitForAuthentication':
      return { authenticated: true }
    case 'getPublicKey':
      return wallet.getPublicKey((args ?? {}) as never, originator)
    case 'createAction':
      return wallet.createAction((args ?? {}) as never, originator)
    case 'signAction':
      return wallet.signAction((args ?? {}) as never, originator)
    case 'abortAction':
      return wallet.abortAction((args ?? {}) as never, originator)
    case 'listActions':
      return wallet.listActions((args ?? {}) as never, originator)
    case 'internalizeAction':
      return wallet.internalizeAction((args ?? {}) as never, originator)
    case 'listOutputs':
      return wallet.listOutputs((args ?? {}) as never, originator)
    case 'relinquishOutput':
      return wallet.relinquishOutput((args ?? {}) as never, originator)
    case 'getBalance': {
      const satoshis = await fetchBalanceSats(wallet)
      return { satoshis }
    }
    case 'encrypt':
      return wallet.encrypt((args ?? {}) as never, originator)
    case 'decrypt':
      return wallet.decrypt((args ?? {}) as never, originator)
    case 'createHmac':
      return wallet.createHmac((args ?? {}) as never, originator)
    case 'verifyHmac':
      return wallet.verifyHmac((args ?? {}) as never, originator)
    case 'createSignature':
      return wallet.createSignature((args ?? {}) as never, originator)
    case 'verifySignature':
      return wallet.verifySignature((args ?? {}) as never, originator)
    case 'acquireCertificate':
      return wallet.acquireCertificate((args ?? {}) as never, originator)
    case 'listCertificates':
      return wallet.listCertificates((args ?? {}) as never, originator)
    case 'proveCertificate':
      return wallet.proveCertificate((args ?? {}) as never, originator)
    case 'relinquishCertificate':
      return wallet.relinquishCertificate((args ?? {}) as never, originator)
    case 'discoverByIdentityKey':
      return wallet.discoverByIdentityKey((args ?? {}) as never, originator)
    case 'discoverByAttributes':
      return wallet.discoverByAttributes((args ?? {}) as never, originator)
    case 'revealCounterpartyKeyLinkage':
      return wallet.revealCounterpartyKeyLinkage((args ?? {}) as never, originator)
    case 'revealSpecificKeyLinkage':
      return wallet.revealSpecificKeyLinkage((args ?? {}) as never, originator)
    case 'getHeight':
      return wallet.getHeight({})
    case 'getHeaderForHeight':
      return wallet.getHeaderForHeight((args ?? {}) as never)
    default: {
      if (typeof w[method] === 'function') {
        return w[method](args, originator)
      }
      throw new Error(`Unsupported BRC-100 method: ${method}`)
    }
  }
}

export async function handleBrc100Request(event: HttpRequestEvent): Promise<{ status: number; body: string }> {
  if (event.method === 'OPTIONS') {
    return { status: 200, body: '' }
  }

  const method = methodFromPath(event.path)
  if (!method || method === 'manifest.json' || method === 'favicon.ico') {
    return { status: 404, body: JSON.stringify({ status: 'error', description: 'Not found' }) }
  }

  const active = getActiveWallet()
  if (!active) {
    requestUnlockForBridge()
    return {
      status: 503,
      body: JSON.stringify({
        status: 'error',
        code: 'WALLET_LOCKED',
        description: 'Unlock HandCash to use the BRC-100 interface.',
      }),
    }
  }

  let args: unknown = undefined
  if (event.body) {
    try {
      args = JSON.parse(event.body)
    } catch {
      args = event.body
    }
  }

  // BRC-99: rewrite `p 1sat <scope>` → storage basket `1sat`; reject unknown schemes.
  {
    const prepared = prepareItemBasketArgs(args)
    if (prepared.error) {
      return {
        status: 400,
        body: JSON.stringify({
          status: 'error',
          code: prepared.error.code,
          description: prepared.error.description,
        }),
      }
    }
    args = prepared.args
  }

  const originator = parseOrigin(event.headers)

  const access = await gateOriginAccess(originator, method)
  if (access === 'unauthenticated') {
    if (method === 'isAuthenticated' || method === 'waitForAuthentication') {
      return { status: 200, body: JSON.stringify({ authenticated: false }) }
    }
    return {
      status: 401,
      body: JSON.stringify({
        status: 'error',
        code: 'NOT_AUTHENTICATED',
        description: 'This app is not allowed to use the wallet. Call waitForAuthentication first.',
      }),
    }
  }
  if (access === 'deny') {
    return {
      status: 403,
      body: JSON.stringify({
        status: 'error',
        code: 'PERMISSION_DENIED',
        description: 'You denied this app access to HandCash.',
      }),
    }
  }

  if (
    (isMigrationMethod(method) || isHandleClaimMethod(method)) &&
    !(isMigrationOrigin(originator) || isHandleClaimOrigin(originator))
  ) {
    return {
      status: 403,
      body: JSON.stringify({
        status: 'error',
        code: 'MIGRATION_ORIGIN_DENIED',
        description: 'Migration and handle-claim methods are only available to HandCash web hosts.',
      }),
    }
  }

  if (isActionMethod(method)) {
    if (method === 'createAction' || method === 'signAction') {
      try {
        assertOnlineForPayment()
        // Local toolbox / history backup is authoritative — no chain heal before
        // pay. Still refuse auto-pay when local balance cannot cover the ask.
        const amountSats = extractSatsFromArgs(method, args)
        const silentAutoPay =
          !isItemSpendArgs(method, args) &&
          !isBsv21IdentityMintArgs(method, args) &&
          canAutoProcessPayment(normalizeOrigin(originator), method, amountSats)
        if (silentAutoPay) {
          await prepareBrcActionSpend(method, args)
        }
      } catch (err) {
        const description = err instanceof Error ? err.message : String(err)
        const offline = /offline/i.test(description)
        return {
          status: offline ? 503 : 400,
          body: JSON.stringify({
            status: 'error',
            code: offline ? 'OFFLINE_PAYMENTS_DISABLED' : 'INSUFFICIENT_OR_STALE_FUNDS',
            description,
          }),
        }
      }
    }
    const actionDecision = await requestActionApproval(originator, method, args)
    if (actionDecision !== 'allow') {
      return {
        status: 403,
        body: JSON.stringify({
          status: 'error',
          code: 'ACTION_DENIED',
          description: 'You denied this transaction or signing request.',
        }),
      }
    }
  }

  if (method === 'listOutputs') {
    const basket =
      args && typeof args === 'object' && !Array.isArray(args)
        ? (args as { basket?: unknown }).basket
        : undefined
    if (isItemBasket(basket)) {
      const viewDecision = await requestItemViewApproval(originator, args)
      if (viewDecision !== 'allow') {
        return {
          status: 403,
          body: JSON.stringify({
            status: 'error',
            code: 'ITEM_VIEW_DENIED',
            description: 'You denied this app access to view collectables.',
          }),
        }
      }
    }
  }

  try {
    let result: unknown
    if (method === 'createAction' || method === 'signAction') {
      try {
        setPaymentProgress('preparing', 'Waiting to send…')
        result = await runExclusiveSpend(
          async () => {
            // Local balance check only — never block on address scan / chain ingest.
            await prepareBrcActionSpend(method, args)
            let actionArgs = args
            if (method === 'createAction' && args && typeof args === 'object') {
              try {
                setPaymentProgress('preparing', 'Preparing payment')
                actionArgs = await enrichCreateActionForBsv21Issuer(
                  active,
                  args as Parameters<typeof enrichCreateActionForBsv21Issuer>[1],
                )
              } catch (err) {
                console.warn('[bsv21-issuer] enrich createAction failed', err)
                // Identity mints with tip spends need inputBEEF — do not fall
                // through to createAction or the toolbox error is opaque.
                if (isBsv21IdentityMintArgs('createAction', args)) throw err
              }
            }
            setPaymentProgress(
              'broadcasting',
              'Signing and sending to the network',
            )
            const created = await dispatchWalletMethod(
              active.wallet,
              method,
              actionArgs,
              originator,
            )
            // Auth / Sigma fund tips use unlockingScriptLength → signable only.
            // Complete with root P2PKH so the app gets a txid (collectables pattern).
            if (method === 'createAction') {
              try {
                return await finishBsv21IdentityMintCreateAction(
                  active,
                  actionArgs,
                  created,
                )
              } catch (err) {
                console.warn('[bsv21-issuer] finish signable mint failed', err)
                throw err
              }
            }
            return created
          },
          () => {
            setPaymentProgress('preparing', 'Preparing payment')
          },
        )
        setPaymentProgress('finishing', 'Updating your balance')
      } catch (err) {
        clearPaymentProgress()
        const description = err instanceof Error ? err.message : String(err)
        const offline = /offline/i.test(description)
        return {
          status: offline ? 503 : 400,
          body: JSON.stringify({
            status: 'error',
            code: offline ? 'OFFLINE_PAYMENTS_DISABLED' : 'INSUFFICIENT_OR_STALE_FUNDS',
            description,
          }),
        }
      } finally {
        clearPaymentProgress()
      }
    } else if (method === 'internalizeAction') {
      // Serialize with spends — concurrent internalize mid-broadcast can thrash outs.
      result = await runExclusiveSpend(() =>
        dispatchWalletMethod(active.wallet, method, args, originator),
      )
    } else {
      result = await dispatchWalletMethod(active.wallet, method, args, originator)
    }

    if (method === 'listOutputs') {
      const basket =
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as { basket?: unknown }).basket
          : undefined
      if (isItemBasket(basket)) {
        result = filterItemOutputsForOrigin(originator, result)
      }
    }

    if (method === 'refreshLegacyAddress') {
      const payload = result as { importedCount?: number; importedItemsCount?: number } | null
      const funds = payload?.importedCount ?? 0
      const items = payload?.importedItemsCount ?? 0
      if (funds > 0 || items > 0) playWalletSound('receive')
      else playWalletSound('soft')
    } else if (method === 'createAction') {
      const txid = extractTxid(result)
      if (txid) {
        cacheImageIconsFromCreateAction(txid, args)
        void cacheCreateActionBeef(active, txid, result)
      }
      if (isBsv21IdentityMintArgs(method, args) && txid) {
        recordIdentityMintActivity(txid, args, originator)
        playWalletSound('success')
      } else {
        const sats = extractSatsFromArgs(method, args)
        if (sats > 0) {
          recordAppActivity({
            origin: originator,
            kind: 'spent',
            sats,
            method,
            note: typeof (args as { description?: string })?.description === 'string'
              ? (args as { description: string }).description
              : undefined,
            txid,
          })
          playWalletSound('success')
        } else {
          playWalletSound('soft')
        }
      }
      // P2P createAction mutates toolbox outs + remittance metadata — backup BRC-39.
      scheduleHistoryBackupPush('createAction')
    } else if (method === 'signAction') {
      playWalletSound('soft')
      scheduleHistoryBackupPush('signAction')
    } else if (method === 'internalizeAction') {
      const sats = extractSatsFromArgs(method, args)
      if (sats > 0) {
        recordAppActivity({
          origin: originator,
          kind: 'earned',
          sats,
          method,
          txid: extractTxid(result) ?? extractTxid(args),
        })
        playWalletSound('receive')
      } else {
        playWalletSound('soft')
      }
      scheduleHistoryBackupPush('internalizeAction')
    } else if (isActionMethod(method)) {
      playWalletSound('soft')
    }

    return { status: 200, body: JSON.stringify(result ?? {}) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isActionMethod(method)) playWalletSound('error')
    return {
      status: 400,
      body: JSON.stringify({ status: 'error', description: message }),
    }
  }
}
