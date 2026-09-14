/**
 * Create or revoke a Sigma identity from the unlocked wallet.
 *
 * Publish is two transactions on purpose. The first isolates a 1-sat fund in
 * the persona basket. The second spends that fund as VIN 0 and inscribes the
 * persona, so the Sigma signature binds a known outpoint. The control output
 * stays in the same basket. Revocation spends the control output and does not
 * touch the root key or the BRC-169 handle.
 */

import { Beef, type PrivateKey } from '@bsv/sdk'
import { getBeefForTxidCached, rememberBeefBinary } from '../beefCache'
import { assertOnlineForPayment } from '../paymentPolicy'
import { clearPaymentProgress, setPaymentProgress } from '../paymentProgress'
import { getActiveWallet, type ActiveWallet } from '../session'
import { runExclusiveSpend } from '../spendGuard'
import {
  buildSigmaControlOutput,
  buildSigmaDocumentOutput,
  buildSigmaFundOutput,
  personaLockingScript,
} from './actions'
import {
  listSigmaIdentities,
  patchSigmaIdentity,
  rememberSigmaIdentity,
  type SigmaPersonaRecord,
} from './catalog'
import { P2PKH_UNLOCK_LENGTH } from './constants'
import { normalizeAbout, normalizePersonaName } from './payload'
import {
  deriveSigmaIdentityPrivateKey,
  personaIdFromName,
  sigmaIdentityBasket,
  sigmaSigningAddress,
} from './paths'
import { completeSignableWithKey } from './signable'

type Listed = {
  outpoint?: string
  lockingScript?: string
  tags?: string[]
}

function txidOf(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const txid = (result as { txid?: unknown }).txid
  return typeof txid === 'string' ? txid.trim().toLowerCase() : ''
}

function txBytesOf(result: unknown): number[] | null {
  if (!result || typeof result !== 'object') return null
  const tx = (result as { tx?: unknown }).tx
  if (Array.isArray(tx) && tx.every((n) => typeof n === 'number')) return tx as number[]
  return null
}

async function beefFor(
  active: ActiveWallet,
  txid: string,
  raw?: number[] | null,
): Promise<number[]> {
  if (raw?.length) {
    try {
      const beef = new Beef()
      beef.mergeRawTx(raw)
      if (beef.findTxid(txid)?.tx) {
        const binary = Array.from(beef.toBinary())
        rememberBeefBinary(txid, binary)
        return binary
      }
    } catch {
      rememberBeefBinary(txid, raw)
    }
  }
  const beef = await getBeefForTxidCached(active, txid, { allowUnprovenRawTx: true })
  return Array.from(beef.toBinary())
}

async function findBasketOutput(
  active: ActiveWallet,
  basket: string,
  match: (row: Listed) => boolean,
): Promise<Listed | null> {
  const listed = await active.wallet.listOutputs({
    basket,
    include: 'locking scripts',
    limit: 25,
  })
  const rows = (listed.outputs ?? []) as Listed[]
  return rows.find(match) ?? null
}

function outpointParts(outpoint: string): { txid: string; vout: number } {
  const [txid = '', voutRaw = ''] = outpoint.trim().toLowerCase().replace('_', '.').split('.')
  const vout = Number(voutRaw)
  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0) {
    throw new Error('Sigma identity fund outpoint is not valid.')
  }
  return { txid, vout }
}

async function spendAsVin0(args: {
  active: ActiveWallet
  description: string
  outpoint: string
  beef: number[]
  outputs: Array<ReturnType<typeof buildSigmaDocumentOutput>>
  signer: PrivateKey
}): Promise<string> {
  const created = await args.active.wallet.createAction({
    description: args.description.slice(0, 50),
    labels: ['sigma-identity'],
    inputBEEF: args.beef,
    inputs: [
      {
        outpoint: args.outpoint,
        unlockingScriptLength: P2PKH_UNLOCK_LENGTH,
        inputDescription: 'Sigma identity',
      },
    ],
    outputs: args.outputs,
    options: {
      trustSelf: 'known',
      randomizeOutputs: false,
      signAndProcess: false,
      knownTxids: [outpointParts(args.outpoint).txid],
    },
  })
  const signable = (
    created as { signableTransaction?: { tx?: number[]; reference?: string } }
  ).signableTransaction
  if (signable?.reference && Array.isArray(signable.tx)) {
    const signed = await completeSignableWithKey(
      args.active,
      { tx: signable.tx, reference: signable.reference },
      args.outpoint,
      args.signer,
    )
    return signed.txid
  }
  const txid = txidOf(created)
  if (txid) return txid
  throw new Error('Wallet did not return a signable Sigma identity transaction.')
}

async function ensureFund(args: {
  active: ActiveWallet
  personaId: string
  generation: number
  address: string
  existing?: string
}): Promise<string> {
  const basket = sigmaIdentityBasket(args.personaId)
  const wantLock = personaLockingScript(args.address)
  if (args.existing) {
    const held = await findBasketOutput(
      args.active,
      basket,
      (row) => (row.outpoint ?? '').replace('_', '.') === args.existing,
    )
    if (held?.outpoint) return held.outpoint.replace('_', '.')
  }
  const already = await findBasketOutput(args.active, basket, (row) => {
    const tags = row.tags ?? []
    const lock = (row.lockingScript ?? '').toLowerCase()
    return tags.includes('role:fund') || lock === wantLock
  })
  if (already?.outpoint && (already.tags ?? []).includes('role:fund')) {
    return already.outpoint.replace('_', '.')
  }

  setPaymentProgress('preparing', 'Isolating Sigma identity funds')
  const funded = await args.active.wallet.createAction({
    description: `Fund Sigma identity ${args.personaId}`.slice(0, 50),
    labels: ['sigma-identity'],
    outputs: [
      buildSigmaFundOutput({
        personaId: args.personaId,
        generation: args.generation,
        address: args.address,
      }),
    ],
    options: {
      acceptDelayedBroadcast: true,
      signAndProcess: true,
      randomizeOutputs: false,
    },
  })
  const txid = txidOf(funded)
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error('Could not fund the Sigma identity.')
  }
  const raw = txBytesOf(funded)
  if (raw) rememberBeefBinary(txid, raw)

  const placed = await findBasketOutput(args.active, basket, (row) => {
    const lock = (row.lockingScript ?? '').toLowerCase()
    return lock === wantLock || (row.tags ?? []).includes('role:fund')
  })
  if (placed?.outpoint) return placed.outpoint.replace('_', '.')
  return `${txid}.0`
}

export async function publishSigmaIdentity(args: {
  name: string
  about?: string
}): Promise<SigmaPersonaRecord> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet to create a Sigma identity.')
  const name = normalizePersonaName(args.name)
  if (!name) throw new Error('Name must be 1–40 characters.')
  const about = normalizeAbout(args.about)
  if (args.about?.trim() && !about) {
    throw new Error('Context must be 80 characters or fewer.')
  }
  const personaId = personaIdFromName(name)
  if (!personaId) throw new Error('Name needs a letter or number so it can be a persona id.')
  const existing = listSigmaIdentities(active.identityKey).find((row) => row.id === personaId)
  if (existing?.status === 'active') {
    throw new Error(`Sigma identity “${existing.name}” already exists. Revoke it before creating another with this id.`)
  }

  assertOnlineForPayment()
  return runExclusiveSpend(async () => {
    const signer = deriveSigmaIdentityPrivateKey({
      rootKeyHex: active.rootKeyHex,
      personaId,
      generation: 0,
    })
    const publicKey = signer.toPublicKey().toString().toLowerCase()
    const address = sigmaSigningAddress(signer)
    const basket = sigmaIdentityBasket(personaId)
    rememberSigmaIdentity({
      id: personaId,
      name,
      ...(about ? { about } : {}),
      generation: 0,
      publicKey,
      address,
      identityKey: active.identityKey,
      basket,
      status: existing?.status === 'funding' ? 'funding' : 'funding',
      createdAt: existing?.createdAt ?? Date.now(),
      ...(existing?.fundOutpoint ? { fundOutpoint: existing.fundOutpoint } : {}),
    })

    try {
      const fundOutpoint = await ensureFund({
        active,
        personaId,
        generation: 0,
        address,
        existing: existing?.fundOutpoint,
      })
      patchSigmaIdentity(active.identityKey, personaId, { fundOutpoint, status: 'funding' })
      const { txid: fundTxid, vout: fundVout } = outpointParts(fundOutpoint)
      setPaymentProgress('signing', 'Inscribing Sigma identity')
      const beef = await beefFor(active, fundTxid)
      const publishedTxid = await spendAsVin0({
        active,
        description: `Publish Sigma identity ${name}`,
        outpoint: fundOutpoint,
        beef,
        signer,
        outputs: [
          buildSigmaDocumentOutput({
            personaId,
            name,
            about,
            generation: 0,
            address,
            signer,
            fundTxid,
            fundVout,
            op: 'publish',
          }),
          buildSigmaControlOutput({
            personaId,
            generation: 0,
            address,
          }),
        ],
      })
      const origin = `${publishedTxid}_0`
      const controlOutpoint = `${publishedTxid}.1`
      const record: SigmaPersonaRecord = {
        id: personaId,
        name,
        ...(about ? { about } : {}),
        generation: 0,
        publicKey,
        address,
        identityKey: active.identityKey,
        basket,
        status: 'active',
        createdAt: existing?.createdAt ?? Date.now(),
        origin,
        controlOutpoint,
      }
      rememberSigmaIdentity(record)
      setPaymentProgress('finishing', 'Sigma identity created')
      return record
    } catch (err) {
      clearPaymentProgress()
      throw err
    } finally {
      setTimeout(() => clearPaymentProgress(), 1200)
    }
  })
}

export async function revokeSigmaIdentity(personaId: string): Promise<void> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet to revoke a Sigma identity.')
  const row = listSigmaIdentities(active.identityKey).find((item) => item.id === personaId)
  if (!row || row.status !== 'active' || !row.controlOutpoint) {
    throw new Error('That Sigma identity has no active control output to spend.')
  }
  assertOnlineForPayment()
  await runExclusiveSpend(async () => {
    const signer = deriveSigmaIdentityPrivateKey({
      rootKeyHex: active.rootKeyHex,
      personaId: row.id,
      generation: row.generation,
    })
    const { txid, vout } = outpointParts(row.controlOutpoint!)
    setPaymentProgress('signing', 'Revoking Sigma identity')
    try {
      const beef = await beefFor(active, txid)
      await spendAsVin0({
        active,
        description: `Revoke Sigma identity ${row.name}`,
        outpoint: row.controlOutpoint!,
        beef,
        signer,
        outputs: [
          buildSigmaDocumentOutput({
            personaId: row.id,
            name: row.name,
            about: row.about,
            generation: row.generation,
            address: row.address,
            signer,
            fundTxid: txid,
            fundVout: vout,
            op: 'revoke',
            origin: row.origin,
          }),
        ],
      })
      patchSigmaIdentity(active.identityKey, row.id, {
        status: 'revoked',
        controlOutpoint: undefined,
        fundOutpoint: undefined,
      })
      setPaymentProgress('finishing', 'Sigma identity revoked')
    } finally {
      setTimeout(() => clearPaymentProgress(), 1200)
    }
  })
}
