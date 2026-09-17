import { appMachine } from './appMachine'
import { sendMachine } from './sendMachine'
import { unlockMachine } from './unlockMachine'
import { marketListingMachine } from './marketListingMachine'
import { marketPurchaseMachine } from './marketPurchaseMachine'
import { marketSellerSettlementMachine } from './marketSellerSettlementMachine'
import { appBrowserMachine } from './appBrowserMachine'
import { assetBurnUiMachine } from './assetBurnUiMachine'
import { deviceBackupMachine } from './deviceBackupMachine'
import { fungibleDetailsMachine } from './fungibleDetailsMachine'
import { modelViewerMachine } from './modelViewerMachine'
import { permissionDecisionMachine } from './permissionDecisionMachine'
import { qrRevealMachine } from './qrRevealMachine'
import { qrScannerMachine } from './qrScannerMachine'
import { updateMachine } from './updateMachine'
import { walletAccountMenuMachine } from './walletAccountMenuMachine'
import { wipeMachine } from './wipeMachine'
import { collectableSendMachine } from '../wallet/collectableSendMachine'
import { collectableSendRunMachine } from '../wallet/collectableSendRunMachine'
import { authenticityMachine } from '../wallet/authenticityMachine'
import { itemSendMachine } from '../wallet/itemSendMachine'
import { brc29SendMachine } from '../wallet/brc29SendMachine'
import { bsvSendMachine } from '../wallet/bsvSendMachine'
import { burnMachine } from '../wallet/burnMachine'
import { txLifecycleMachine } from '../wallet/txLifecycleMachine'
import { walletCoordinatorMachine } from '../wallet/walletCoordinatorMachine'
import { bsv21SendMachine } from '../wallet/token/sendMachine'

/**
 * Executable statechart catalog. Settings and architecture tests consume this
 * instead of maintaining a second list of which machines define wallet flows.
 */
export const machineManifest = Object.freeze({
  app: appMachine,
  send: sendMachine,
  unlock: unlockMachine,
  marketListing: marketListingMachine,
  marketPurchase: marketPurchaseMachine,
  marketSellerSettlement: marketSellerSettlementMachine,
  appBrowser: appBrowserMachine,
  assetBurnUi: assetBurnUiMachine,
  deviceBackup: deviceBackupMachine,
  fungibleDetails: fungibleDetailsMachine,
  modelViewer: modelViewerMachine,
  permissionDecision: permissionDecisionMachine,
  qrReveal: qrRevealMachine,
  qrScanner: qrScannerMachine,
  update: updateMachine,
  walletAccountMenu: walletAccountMenuMachine,
  wipe: wipeMachine,
  collectableSend: collectableSendMachine,
  collectableSendRun: collectableSendRunMachine,
  authenticity: authenticityMachine,
  itemSend: itemSendMachine,
  brc29Send: brc29SendMachine,
  bsvSend: bsvSendMachine,
  bsv21Send: bsv21SendMachine,
  burn: burnMachine,
  txLifecycle: txLifecycleMachine,
  walletCoordinator: walletCoordinatorMachine,
})

export type MachineManifestId = keyof typeof machineManifest

export function machineStateManifest(): Readonly<
  Record<MachineManifestId, readonly string[]>
> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(machineManifest).map(([id, machine]) => [
        id,
        Object.freeze(
          Object.keys(machine.config.states ?? {}).length > 0
            ? Object.keys(machine.config.states ?? {})
            : Object.keys(machine.root.states).length > 0
              ? Object.keys(machine.root.states)
              : [`@event:${machine.id}`],
        ),
      ]),
    ),
  ) as Record<MachineManifestId, readonly string[]>
}
