/**
 * GitHub-style mirrored 5×5 identicon from an arbitrary seed.
 * Useful as Avatar fallback when no photo/icon URL is available.
 */

/** FNV-1a 32-bit → expand to 16 bytes for grid + color. */
export function identiconSeedBytes(seed: string): Uint8Array {
  const s = seed.trim().toLowerCase() || 'aeon'
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const out = new Uint8Array(16)
  let x = h >>> 0
  for (let i = 0; i < 16; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = (x >>> 0) & 0xff
  }
  let h2 = 0x811c9dc5 ^ s.length
  for (let i = 0; i < s.length; i++) {
    h2 ^= s.charCodeAt(s.length - 1 - i)
    h2 = Math.imul(h2, 0x01000193)
  }
  for (let i = 0; i < 8; i++) {
    out[i] ^= (h2 >>> ((i % 4) * 8)) & 0xff
  }
  return out
}

/** 5×5 mirrored boolean grid. */
export function identiconGrid(seed: string): boolean[][] {
  const b = identiconSeedBytes(seed)
  const grid: boolean[][] = []
  let bit = 0
  for (let row = 0; row < 5; row++) {
    const cells: boolean[] = []
    for (let col = 0; col < 3; col++) {
      const byte = b[bit >> 3]!
      const on = ((byte >> (bit & 7)) & 1) === 1
      cells.push(on)
      bit++
    }
    grid.push([cells[0]!, cells[1]!, cells[2]!, cells[1]!, cells[0]!])
  }
  return grid
}

export function identiconColor(seed: string): { h: number; s: number; l: number } {
  const b = identiconSeedBytes(seed)
  const h = Math.round(((b[13]! << 8) | b[14]!) % 360)
  const s = 55 + (b[15]! % 30)
  const l = 42 + (b[12]! % 16)
  return { h, s, l }
}

/** SVG data URL for `<img src>` / CSS background. */
export function identiconDataUrl(seed: string, size = 128): string {
  const grid = identiconGrid(seed)
  const { h, s, l } = identiconColor(seed)
  const cell = size / 5
  const fg = `hsl(${h} ${s}% ${l}%)`
  const bg = `hsl(${h} ${Math.max(12, s - 35)}% ${Math.min(92, l + 38)}%)`
  let rects = ''
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (!grid[r]![c]) continue
      rects += `<rect x="${c * cell}" y="${r * cell}" width="${cell}" height="${cell}" fill="${fg}"/>`
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${bg}"/>` +
    rects +
    `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
