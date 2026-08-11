import type { WalletInterface } from '@bsv/sdk'
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
import { extractSatsFromArgs, recordAppActivity } from './appActivity'
import { scheduleHistoryBackupPush } from './deviceSync'
import { extractTxid } from './txExplorer'
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
import { prepareBrcActionSpend, runExclusiveSpend, invalidateFundingHealCache } from './spendGuard'
import { enrichCreateActionForBsv21Issuer } from './bsv21Issuer'
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
        // Interactive approvals: show the sheet immediately. A full chain heal
        // before the prompt made sequential mint/pays feel stalled (idle column
        // for tens of seconds). Auto-pay still heals first so silent allows are
        // based on live outs; post-approve heal under lock remains for everyone.
        const amountSats = extractSatsFromArgs(method, args)
        const silentAutoPay =
          !isItemSpendArgs(method, args) &&
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
        setPaymentProgress('preparing', 'Checking spendable funds')
        result = await runExclusiveSpend(async () => {
          // Second heal under lock immediately before broadcast (cloud-style).
          setPaymentProgress('preparing', 'Checking spendable funds')
          await prepareBrcActionSpend(method, args)
          let actionArgs = args
          if (method === 'createAction' && args && typeof args === 'object') {
            try {
              actionArgs = await enrichCreateActionForBsv21Issuer(
                active,
                args as Parameters<typeof enrichCreateActionForBsv21Issuer>[1],
              )
            } catch (err) {
              console.warn('[bsv21-issuer] enrich createAction failed', err)
            }
          }
          setPaymentProgress(
            'broadcasting',
            'Signing and sending to the network',
          )
          return dispatchWalletMethod(active.wallet, method, actionArgs, originator)
        })
        setPaymentProgress('finishing', 'Updating your balance')
        invalidateFundingHealCache()
      } catch (err) {
        clearPaymentProgress()
        invalidateFundingHealCache()
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
