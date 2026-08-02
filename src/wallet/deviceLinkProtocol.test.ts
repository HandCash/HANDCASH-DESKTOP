import { describe, expect, it } from 'vitest'
import {
  LinkQrAssembler,
  createLinkFlashSession,
  packageWithHistory,
  type PairingPackage,
} from './deviceLinkProtocol'

describe('link flash v3', () => {
  it('round-trips keys + history across shuffled frames', async () => {
    const brc39 = new Uint8Array(1800).map((_, i) => i % 256)
    const pkg = packageWithHistory(
      {
        rootKeyHex: 'ab'.repeat(32),
        handle: 'tester',
        identityKey: 'cd'.repeat(33),
        address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
        chain: 'main',
        historyBackupBaseUrl: '',
        createdAt: Date.now(),
      },
      brc39,
      'SourcePass1!',
    )

    const session = await createLinkFlashSession(pkg, 60_000)
    expect(session.frameCount).toBeGreaterThan(2)
    expect(session.hasHistory).toBe(true)

    const assembler = new LinkQrAssembler()
    const order = session.frames.map((_, i) => i).reverse()
    let resolved: PairingPackage | null = null
    for (const i of order) {
      resolved = await assembler.ingest(session.frames[i]!)
    }
    expect(resolved).not.toBeNull()
    expect(resolved!.rootKeyHex).toBe(pkg.rootKeyHex)
    expect(resolved!.brc39Base64).toBe(pkg.brc39Base64)
    expect(resolved!.brc39Password).toBe('SourcePass1!')
    expect(assembler.progress?.complete).toBe(true)
  })
})
