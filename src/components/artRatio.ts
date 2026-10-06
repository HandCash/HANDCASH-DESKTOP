/**
 * Publish a decoded bitmap's aspect ratio as `--art-ratio` on the img. CSS
 * cannot round the painted part of an `object-fit: contain` image, so art
 * frames size the img itself from this ratio: whole, uncropped, and with the
 * rounded corners on the art rather than on empty letterbox.
 */
export function noteArtRatio(img: HTMLImageElement | null): void {
  if (!img || img.naturalWidth <= 0 || img.naturalHeight <= 0) return
  img.style.setProperty('--art-ratio', String(img.naturalWidth / img.naturalHeight))
}
