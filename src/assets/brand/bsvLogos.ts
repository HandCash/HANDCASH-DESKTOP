import bsvLogoDefault from './bsv-logo.png'
import bsvLogoClassic from './bsv-logo-classic.png'

export { bsvLogoDefault, bsvLogoClassic }

export function bsvLogoForClassic(classic: boolean): string {
  return classic ? bsvLogoClassic : bsvLogoDefault
}

if (typeof window !== 'undefined') {
  for (const src of [bsvLogoDefault, bsvLogoClassic]) {
    const img = new Image()
    img.src = src
  }
}
