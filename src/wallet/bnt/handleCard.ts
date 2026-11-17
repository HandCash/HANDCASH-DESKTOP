/**
 * The identity key card as a handle's IPT token (BRC-255 §2): one countersigned
 * item naming the handle (`hdl`), its card picture as the icon and its 3D model
 * as the content. Builds deploy fields only; issuing goes through issueBntAsset.
 */
import { assertBntFields, type BntDeployFields } from './payload'

export const HANDLE_CARD_MODEL_TYPE = 'model/gltf-binary'

export type HandleCardIptArgs = {
  /** The handle, with or without its leading `$`. */
  handle: string
  /** Issuer identity keys and their majority. */
  iss: string[]
  m: number
  /** The beacon's first outpoint, `txid_vout`. */
  bcn: string
  sil: number
  /** Exactly one release: `rel`, or `relk` with `k`. */
  rel?: string
  relk?: string[]
  k?: number
  /** The card picture (PNG/JPEG/WebP), at most 96 KiB. */
  image: { mediaType: string; bytes: Uint8Array }
  /** The GLB model, at most 1 MiB. */
  glb: Uint8Array
}

const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46] // "glTF"

export function handleCardIptFields(args: HandleCardIptArgs): BntDeployFields {
  const handle = args.handle.trim().replace(/^\$/, '')
  if (!handle) throw new Error('A handle card names its handle')
  if (!/^image\//i.test(args.image.mediaType)) throw new Error('The card picture is an image')
  if (!GLB_MAGIC.every((b, i) => args.glb[i] === b)) throw new Error('The card model is a GLB (glTF binary)')
  const fields: BntDeployFields = {
    mode: 'countersign',
    kind: 'item',
    iss: args.iss.map((k) => k.toLowerCase()),
    m: args.m,
    bcn: args.bcn,
    sil: args.sil,
    ...(args.rel != null ? { rel: args.rel } : {}),
    ...(args.relk != null ? { relk: args.relk.map((k) => k.toLowerCase()), k: args.k } : {}),
    name: `$${handle} identity key`,
    hdl: handle,
    icon: { mediaType: args.image.mediaType, bytes: args.image.bytes },
    ctype: HANDLE_CARD_MODEL_TYPE,
    c: args.glb,
  }
  assertBntFields(fields)
  return fields
}
