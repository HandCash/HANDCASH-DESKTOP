import type { WalletInterface } from '@bsv/sdk'
import { getActiveWallet, fetchBalanceSats } from './session'
import {
  gateOriginAccess,
  isActionMethod,
  requestActionApproval,
} from './permissions'
import { extractSatsFromArgs, recordAppActivity } from './appActivity'
import { extractTxid } from './txExplorer'
import {
  getLegacyAddressPayload,
  isMigrationMethod,
  isMigrationOrigin,
  listMigrationTxids,
  refreshLegacyAddressPayload,
} from './migration'
import { playWalletSound } from './soundService'

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

  if (isMigrationMethod(method) && !isMigrationOrigin(originator)) {
    return {
      status: 403,
      body: JSON.stringify({
        status: 'error',
        code: 'MIGRATION_ORIGIN_DENIED',
        description: 'Migration methods are only available to HandCash migrate hosts.',
      }),
    }
  }

  if (isActionMethod(method)) {
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

  try {
    const result = await dispatchWalletMethod(active.wallet, method, args, originator)

    if (method === 'refreshLegacyAddress') {
      playWalletSound('receive')
    } else if (method === 'createAction') {
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
          txid: extractTxid(result),
        })
        playWalletSound('success')
      }
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
      }
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
