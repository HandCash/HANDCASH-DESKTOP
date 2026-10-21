/**
 * A BNT asset's picture: its icon, or an image item's content, from the deploy.
 * A deploy never changes, so the picture is encoded once per asset and kept in
 * the item art store, where Activity finds it after a relaunch or once the
 * asset has been sent away.
 */
import { getItemArtDataUrl, rememberItemArt } from '../localItemArt'
import type { BntDeployFields } from './payload'

const IMAGE_ITEM_MAX_BYTES = 512 * 1024

/** Per asset id: its data URL, or null for a deploy without a picture. */
const encoded = new Map<string, string | null>()

const artKey = (assetId: string) => `bnt:${assetId}`

function deployPicture(fields: BntDeployFields): { mime: string; bytes: Uint8Array } | null {
  if (fields.icon && /^image\//i.test(fields.icon.mediaType)) return { mime: fields.icon.mediaType, bytes: fields.icon.bytes }
  if (fields.kind === 'item' && fields.c && fields.ctype && /^image\//i.test(fields.ctype) && fields.c.length <= IMAGE_ITEM_MAX_BYTES) {
    return { mime: fields.ctype, bytes: fields.c }
  }
  return null
}

function dataUrl(mediaType: string, bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${mediaType};base64,${btoa(binary)}`
}

/** The deploy's picture, encoded on the first read of this asset and kept for later renders. */
export function bntDeployArt(assetId: string, fields: BntDeployFields): string | undefined {
  const key = assetId.trim().toLowerCase()
  if (encoded.has(key)) return encoded.get(key) ?? undefined
  const picture = deployPicture(fields)
  const url = picture ? dataUrl(picture.mime, picture.bytes) : null
  encoded.set(key, url)
  if (picture && !getItemArtDataUrl(artKey(key))) rememberItemArt(artKey(key), picture.bytes, picture.mime)
  return url ?? undefined
}

/** The picture of an asset this device has read, held or not; nothing for one it never read. */
export function bntArtUrl(assetId: string | undefined | null): string | undefined {
  const key = assetId?.trim().toLowerCase()
  if (!key) return undefined
  return encoded.get(key) ?? getItemArtDataUrl(artKey(key))
}

export function resetBntArtForTests(): void {
  encoded.clear()
}
