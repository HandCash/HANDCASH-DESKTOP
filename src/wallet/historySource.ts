/**
 * Where history comes from: a paired install first, the history backup
 * provider second. Both feed the same BRC-39 merge (`restoreBrc39BackupBytes`),
 * so the source never changes what is trusted: the bytes are sealed to the
 * root key and a peer of another identity is never asked.
 */
import { errorText } from './errorText'
import { appendAppLog } from './appLog'
import { fetchDevicePeerHistory } from './devicePeer'
import { listDeviceWallets, type DeviceWallet } from './deviceWallets'
import { downloadAndRestoreBrc39Backup, restoreBrc39BackupBytes, type HistoryImportResult } from './historyBackup'
import { getActiveWallet } from './session'

export function historyPeers(identityKey: string): DeviceWallet[] {
  return listDeviceWallets().filter(
    (w) =>
      !w.isLocal &&
      w.linkMode === 'linked' &&
      w.peerBaseUrl != null &&
      w.identityKey.toLowerCase() === identityKey.toLowerCase(),
  )
}

export type HistorySource = 'peer' | 'backup'

export async function pullHistoryPeerFirst(
  password?: string | null,
): Promise<HistoryImportResult & { source: HistorySource }> {
  const active = getActiveWallet()
  if (active) {
    // Online peers first, then the most recently seen.
    const peers = historyPeers(active.identityKey).sort(
      (a, b) => Number(b.online) - Number(a.online) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0),
    )
    for (const peer of peers) {
      try {
        const { bytes } = await fetchDevicePeerHistory(peer.peerBaseUrl as string, active.identityKey, active.rootKeyHex)
        const result = await restoreBrc39BackupBytes(bytes, password, 'merge')
        appendAppLog('info', `[history] pulled from paired device ${peer.label}`)
        return { ...result, source: 'peer' }
      } catch (err) {
        appendAppLog(
          'info',
          `[history] paired device ${peer.label} unavailable (${errorText(err)}) — next source`,
        )
      }
    }
  }
  return { ...(await downloadAndRestoreBrc39Backup(password)), source: 'backup' }
}
