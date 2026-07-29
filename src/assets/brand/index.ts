/**
 * HandCash brand assets for official HandCash Desktop (sourced from handcash.io + Connect SDK).
 * Prefer PNG marks for pixel fidelity; SVGs are vector recreations for theming.
 */
import markGreenPng from './handcash-mark-green.png'
import markDarkPng from './handcash-mark-dark.png'
import markRoundPng from './handcash-mark-round.png'
import markLightPng from './handcash-mark-light.png'
import ogPng from './handcash-og.png'
import markGreenSvg from './handcash-mark-green.svg?url'
import markRoundSvg from './handcash-mark-round.svg?url'
import wordmarkSvg from './handcash-wordmark.svg?url'
import logoSvg from './handcash-logo.svg?url'

export const handcashBrand = {
  markGreenPng,
  markDarkPng,
  markRoundPng,
  markLightPng,
  ogPng,
  markGreenSvg,
  markRoundSvg,
  wordmarkSvg,
  logoSvg,
} as const

export type HandCashMarkVariant = 'green' | 'round' | 'dark' | 'light'
