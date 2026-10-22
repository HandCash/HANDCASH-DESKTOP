import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { openSealedShare, sealedShareKey, type SealedShare } from './sealedShare'

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function seal(share: string, to: PrivateKey): Promise<SealedShare> {
  const ephemeral = PrivateKey.fromRandom()
  const aes = await sealedShareKey(ephemeral, to.toPublicKey(), 'encrypt')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(share)),
  )
  return {
    v: 1,
    ephemeralKey: ephemeral.toPublicKey().toString(),
    iv: base64url(iv),
    ciphertext: base64url(ciphertext),
  }
}

describe('sealed recovery shares', () => {
  it('opens a share sealed to this release key', async () => {
    const release = PrivateKey.fromRandom()
    const sealed = await seal('share-text-1', release)
    await expect(openSealedShare(release, sealed)).resolves.toBe('share-text-1')
  })

  it('refuses a share sealed to another key or an unknown envelope', async () => {
    const sealed = await seal('share-text-1', PrivateKey.fromRandom())
    await expect(openSealedShare(PrivateKey.fromRandom(), sealed)).rejects.toThrow()
    await expect(
      openSealedShare(PrivateKey.fromRandom(), { ...sealed, v: 2 } as unknown as SealedShare),
    ).rejects.toThrow('Unsupported recovery-share envelope')
  })
})
