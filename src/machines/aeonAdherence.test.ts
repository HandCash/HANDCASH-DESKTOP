import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const componentsRoot = path.resolve(process.cwd(), 'src/components')

function componentFiles(): string[] {
  return fs
    .readdirSync(componentsRoot, { recursive: true })
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.tsx'))
    .map((name) => path.join(componentsRoot, name))
}

function relative(file: string): string {
  return path.relative(process.cwd(), file).replaceAll(path.sep, '/')
}

/**
 * Existing deliberate bitmap renderers. New feature UI must use DeferredImage
 * or AppAvatar; adding to this list is an architectural decision.
 */
const RAW_IMAGE_RENDERERS = new Set([
  'src/components/AnimatedQr.tsx',
  'src/components/AppAvatar.tsx',
  'src/components/DeferredImage.tsx',
  'src/components/FungibleTokenFace.tsx',
  'src/components/IdentityPanel.tsx',
  'src/components/PaymentDetailsPanel.tsx',
  'src/components/RecentActivity.tsx',
  'src/components/WhatIsBsvPanel.tsx',
])

/** Known pre-machine compose flows; this allowlist may only shrink. */
const AD_HOC_FLOW_STATE = new Set<string>([])

describe('Aeon architecture ratchet', () => {
  it('does not add a bare image renderer', () => {
    const offenders = componentFiles()
      .filter((file) => /<img\b/.test(fs.readFileSync(file, 'utf8')))
      .map(relative)
      .filter((file) => !RAW_IMAGE_RENDERERS.has(file))
    expect(offenders).toEqual([])
  })

  it('does not add component-local compose stages', () => {
    const stagePattern =
      /useState(?:<[^>]+>)?\([^\n]*(?:['"`](?:edit|confirm|loading|open)['"`]|stage)/i
    const offenders = componentFiles()
      .filter((file) => stagePattern.test(fs.readFileSync(file, 'utf8')))
      .map(relative)
      .filter((file) => !AD_HOC_FLOW_STATE.has(file))
    expect(offenders).toEqual([])
  })

  it('keeps wallet domain code independent of React components', () => {
    const walletRoot = path.resolve(process.cwd(), 'src/wallet')
    const offenders = fs
      .readdirSync(walletRoot, { recursive: true })
      .filter((name): name is string => typeof name === 'string' && name.endsWith('.ts'))
      .map((name) => path.join(walletRoot, name))
      .filter((file) => /from\s+['"][^'"]*components\//.test(fs.readFileSync(file, 'utf8')))
      .map(relative)
    expect(offenders).toEqual([])
  })
})
