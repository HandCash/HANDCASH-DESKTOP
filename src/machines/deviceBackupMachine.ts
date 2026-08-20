import { assign, setup, type SnapshotFrom } from 'xstate'

/**
 * Device backup UI chart.
 *
 * One screen at a time: the device list, a camera, one device's recovery
 * direction, or an opened recovery copy. Direction is chosen inside `device`,
 * so the chart cannot represent "both directions in progress".
 */
export type DeviceBackupEvent =
  | { type: 'SCAN' }
  | { type: 'SCAN_CANCEL' }
  | { type: 'SCANNED'; peerDeviceId?: string }
  | { type: 'TOGGLE_MY_CODE' }
  | { type: 'OPEN_DEVICE'; peerDeviceId: string }
  | { type: 'PROTECT_LOCAL' }
  | { type: 'PROTECT_PEER' }
  | { type: 'SEAL' }
  | { type: 'SEAL_OK' }
  | { type: 'IMPORT' }
  | { type: 'IMPORT_OK' }
  | { type: 'OPEN_RECOVERY'; peerDeviceId: string }
  | { type: 'UNSEAL' }
  | { type: 'UNSEAL_OK' }
  | { type: 'FAIL'; error: string }
  | { type: 'BACK' }

export type DeviceBackupContext = {
  /** Device whose recovery relationship is on screen. */
  peerDeviceId: string | null
  /** This device's own code QR is revealed only on request. */
  showMyCode: boolean
  error: string | null
}

export const deviceBackupMachine = setup({
  types: {
    context: {} as DeviceBackupContext,
    events: {} as DeviceBackupEvent,
  },
  actions: {
    clearPeer: assign({ peerDeviceId: null, error: null }),
    clearError: assign({ error: null }),
    toggleMyCode: assign(({ context }) => ({ showMyCode: !context.showMyCode })),
    selectPeer: assign(({ event }) =>
      event.type === 'OPEN_DEVICE' || event.type === 'OPEN_RECOVERY'
        ? { peerDeviceId: event.peerDeviceId, error: null }
        : {},
    ),
    selectScanned: assign(({ event }) =>
      event.type === 'SCANNED' && event.peerDeviceId
        ? { peerDeviceId: event.peerDeviceId, error: null }
        : {},
    ),
    fail: assign(({ event }) => (event.type === 'FAIL' ? { error: event.error } : {})),
  },
  guards: {
    scannedPeer: ({ event }) => event.type === 'SCANNED' && Boolean(event.peerDeviceId),
  },
}).createMachine({
  id: 'deviceBackup',
  initial: 'devices',
  context: { peerDeviceId: null, showMyCode: false, error: null },
  states: {
    devices: {
      entry: 'clearPeer',
      on: {
        SCAN: { target: 'scanning' },
        TOGGLE_MY_CODE: { actions: 'toggleMyCode' },
        OPEN_DEVICE: { target: 'device', actions: 'selectPeer' },
        OPEN_RECOVERY: { target: 'recovery', actions: 'selectPeer' },
        FAIL: { actions: 'fail' },
      },
    },
    scanning: {
      on: {
        SCANNED: [
          { target: 'device', guard: 'scannedPeer', actions: 'selectScanned' },
          { target: 'devices' },
        ],
        SCAN_CANCEL: { target: 'devices' },
        FAIL: { target: 'devices', actions: 'fail' },
      },
    },
    /** One device: read its direction, or establish exactly one. */
    device: {
      initial: 'choosing',
      on: { BACK: { target: 'devices' } },
      states: {
        choosing: {
          on: {
            PROTECT_LOCAL: { target: 'sealPrompt' },
            PROTECT_PEER: { target: 'importPrompt' },
          },
        },
        sealPrompt: {
          on: {
            SEAL: { target: 'sealing' },
            BACK: { target: 'choosing', actions: 'clearError' },
          },
        },
        sealing: {
          on: {
            SEAL_OK: { target: 'sealed' },
            FAIL: { target: 'sealPrompt', actions: 'fail' },
          },
        },
        /** Sealed copy is on screen for the peer to scan. */
        sealed: {},
        importPrompt: {
          on: {
            IMPORT: { target: 'importing' },
            SCAN: { target: '#deviceBackup.scanning' },
            BACK: { target: 'choosing', actions: 'clearError' },
          },
        },
        importing: {
          on: {
            IMPORT_OK: { target: 'choosing', actions: 'clearError' },
            FAIL: { target: 'importPrompt', actions: 'fail' },
          },
        },
      },
    },
    /** Open a stored copy of a peer wallet to restore it elsewhere. */
    recovery: {
      initial: 'locked',
      on: { BACK: { target: 'devices' } },
      states: {
        locked: {
          on: { UNSEAL: { target: 'unsealing' } },
        },
        unsealing: {
          on: {
            UNSEAL_OK: { target: 'opened' },
            FAIL: { target: 'locked', actions: 'fail' },
          },
        },
        opened: {},
      },
    },
  },
})

export type DeviceBackupSnapshot = SnapshotFrom<typeof deviceBackupMachine>
