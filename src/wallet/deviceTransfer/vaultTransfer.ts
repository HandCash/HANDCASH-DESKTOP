/**
 * The vault an approving device sends to a new one, encrypted (BRC-78) to the
 * new device's one-time key. Whoever relays it holds only ciphertext.
 */
import { EncryptedMessage, PrivateKey, PublicKey, Utils } from '@bsv/sdk'
import type { LegacyGoogleEnrollment } from '../legacyGoogleRecovery'
import { identityKeyForAccount, readVaultAccounts } from '../vaultAccounts'
import type { VaultMaster } from '../vaultMaster'

export type VaultTransfer = {
  v: 1
  kind: 'handcash-brc250-vault'
  master: VaultMaster
  enrollment: LegacyGoogleEnrollment | null
  accounts: unknown
  sentAt: number
}

export function vaultTransferOf(
  master: VaultMaster,
  enrollment: LegacyGoogleEnrollment | null,
): VaultTransfer {
  return {
    v: 1,
    kind: 'handcash-brc250-vault',
    master,
    enrollment,
    accounts: readVaultAccounts(identityKeyForAccount(master, 0)),
    sentAt: Date.now(),
  }
}

/** Base64 ciphertext only the holder of `loginKey`'s private key opens. */
export function sealVaultTransfer(
  payload: VaultTransfer,
  sender: PrivateKey,
  loginKey: string,
): string {
  return Utils.toBase64(
    EncryptedMessage.encrypt(
      Utils.toArray(JSON.stringify(payload), 'utf8'),
      sender,
      PublicKey.fromString(loginKey),
    ),
  )
}

export function openVaultTransfer(sealed: string, loginKey: PrivateKey): VaultTransfer {
  const plain = EncryptedMessage.decrypt(Utils.toArray(sealed, 'base64'), loginKey)
  const payload = JSON.parse(Utils.toUTF8(plain)) as VaultTransfer
  if (payload.v !== 1 || payload.kind !== 'handcash-brc250-vault' || !payload.master?.keyHex) {
    throw new Error('The approving device sent an invalid vault')
  }
  return payload
}
