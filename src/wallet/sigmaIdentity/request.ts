/**
 * How a createAction output asks to be signed by a Sigma identity.
 * Tags and customInstructions are requests, not the proof — the proof is the
 * VIN-bound Sigma tail.
 */

import { normalizePersonaId } from './paths'

export type SigmaIdentityRequest = {
  personaId: string | null
  generation: number
  /** Display mirror. Authoritative name is the persona inscription. */
  name?: string
}

type OutputLike = {
  tags?: string[]
  customInstructions?: string
  basket?: string
}

function readCi(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export function sigmaIdentityRequestFromOutput(out: OutputLike): SigmaIdentityRequest | null {
  let personaId: string | null = null
  let generation = 0
  let name: string | undefined
  let requested = false

  for (const tag of out.tags ?? []) {
    const t = tag.trim().toLowerCase()
    if (t === 'sigma-identity') requested = true
    if (t.startsWith('sigma-identity:')) {
      requested = true
      personaId = normalizePersonaId(t.slice('sigma-identity:'.length)) ?? personaId
    }
  }

  const ci = readCi(out.customInstructions)
  if (ci) {
    const raw = ci.sigmaIdentity ?? ci.issuerPersona
    if (raw === true) requested = true
    if (typeof raw === 'string' && raw.trim()) {
      requested = true
      personaId = normalizePersonaId(raw) ?? personaId
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      requested = true
      const o = raw as { id?: unknown; generation?: unknown; name?: unknown }
      if (typeof o.id === 'string') personaId = normalizePersonaId(o.id) ?? personaId
      if (typeof o.name === 'string' && o.name.trim()) name = o.name.trim()
      if (typeof o.generation === 'number' && Number.isInteger(o.generation)) {
        generation = o.generation
      }
    }
    if (typeof ci.issuerPersona === 'string') {
      personaId = normalizePersonaId(ci.issuerPersona) ?? personaId
    }
    if (typeof ci.sigmaIdentityGeneration === 'number') {
      generation = ci.sigmaIdentityGeneration
    }
    if (typeof ci.issuerName === 'string' && ci.issuerName.trim()) {
      name = ci.issuerName.trim()
    }
  }

  if (!requested) return null
  return { personaId, generation, ...(name ? { name } : {}) }
}

export function outputRequestsSigmaIdentity(out: OutputLike): boolean {
  return sigmaIdentityRequestFromOutput(out) != null
}
