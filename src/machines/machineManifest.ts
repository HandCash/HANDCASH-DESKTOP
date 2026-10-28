import { publicIdentitiesMachine } from './publicIdentitiesMachine'
import { actionLifecycleMachine } from './actionLifecycleMachine'
import { asyncActionMachine } from './asyncActionMachine'
import { appMachine } from './appMachine'
import { sendMachine } from './sendMachine'
import { unlockMachine } from './unlockMachine'
import { offerMachine } from './offerMachine'
import { bntMachine } from './bntMachine'
import { bntHoldingsMachine } from './bntHoldingsMachine'
import { coinMachine } from './coinMachine'
import { swapMachine } from './swapMachine'
import { swapOffersMachine } from './swapOffersMachine'
import { swapSettleMachine } from './swapSettleMachine'
import { marketPurchaseMachine } from './marketPurchaseMachine'
import { marketSellerSettlementMachine } from './marketSellerSettlementMachine'
import { appBrowserMachine } from './appBrowserMachine'
import { appBrowserPageMachine } from './appBrowserPageMachine'
import { assetBurnUiMachine } from './assetBurnUiMachine'
import { deviceBackupMachine } from './deviceBackupMachine'
import { historyRecoveryMachine } from './historyRecoveryMachine'
import { modelViewerMachine } from './modelViewerMachine'
import { permissionDecisionMachine } from './permissionDecisionMachine'
import { qrRevealMachine } from './qrRevealMachine'
import { qrScannerMachine } from './qrScannerMachine'
import { updateMachine } from './updateMachine'
import { walletAccountMenuMachine } from './walletAccountMenuMachine'
import { devKeysPanelMachine } from './devKeysPanelMachine'
import { tickerMachine } from './tickerMachine'
import { wipeMachine } from './wipeMachine'
import { assetSendMachine } from './assetSendMachine'
import { legacyImportMachine } from './legacyImportMachine'
import { importItemBrowserMachine } from './importItemBrowserMachine'
import { importQueueMachine } from './importQueueMachine'
import { walletJobMachine } from './walletJobMachine'
import { chartAppsMachine } from './chartAppsMachine'
import { walletStatusMachine } from './walletStatusMachine'
import { collectableSendMachine } from '../wallet/collectableSendMachine'
import { collectableSendRunMachine } from '../wallet/collectableSendRunMachine'
import { authenticityMachine } from '../wallet/authenticityMachine'
import { itemSendMachine } from '../wallet/itemSendMachine'
import { brc29SendMachine } from '../wallet/brc29SendMachine'
import { bsvSendMachine } from '../wallet/bsvSendMachine'
import { burnMachine } from '../wallet/burnMachine'
import { serverWalletRecoverMachine } from '../wallet/serverWalletRecoverMachine'
import { txLifecycleMachine } from '../wallet/txLifecycleMachine'
import { walletCoordinatorMachine } from '../wallet/walletCoordinatorMachine'
import { accountMoveMachine } from '../wallet/accountMoveMachine'
import { emailRecoveryMachine } from './emailRecoveryMachine'
import { relaySigninMachine } from './relaySigninMachine'
import { onboardEmailMachine } from './onboardEmailMachine'
import { callMachine } from './callMachine'
import { callViewMachine } from './callViewMachine'

/**
 * Executable statechart catalog. Settings and architecture tests consume this
 * instead of maintaining a second list of which machines define wallet flows.
 */
export const machineManifest = Object.freeze({
  actionLifecycle: actionLifecycleMachine,
  asyncAction: asyncActionMachine,
  publicIdentities: publicIdentitiesMachine,
  app: appMachine,
  send: sendMachine,
  unlock: unlockMachine,
  offer: offerMachine,
  bnt: bntMachine,
  coin: coinMachine,
  swap: swapMachine,
  swapOffers: swapOffersMachine,
  swapSettle: swapSettleMachine,
  marketPurchase: marketPurchaseMachine,
  marketSellerSettlement: marketSellerSettlementMachine,
  appBrowser: appBrowserMachine,
  appBrowserPage: appBrowserPageMachine,
  assetBurnUi: assetBurnUiMachine,
  deviceBackup: deviceBackupMachine,
  bntHoldings: bntHoldingsMachine,
  historyRecovery: historyRecoveryMachine,
  modelViewer: modelViewerMachine,
  permissionDecision: permissionDecisionMachine,
  qrReveal: qrRevealMachine,
  qrScanner: qrScannerMachine,
  update: updateMachine,
  walletAccountMenu: walletAccountMenuMachine,
  devKeysPanel: devKeysPanelMachine,
  ticker: tickerMachine,
  wipe: wipeMachine,
  assetSend: assetSendMachine,
  legacyImport: legacyImportMachine,
  importItemBrowser: importItemBrowserMachine,
  importQueue: importQueueMachine,
  walletJob: walletJobMachine,
  chartApps: chartAppsMachine,
  walletStatus: walletStatusMachine,
  collectableSend: collectableSendMachine,
  collectableSendRun: collectableSendRunMachine,
  authenticity: authenticityMachine,
  itemSend: itemSendMachine,
  brc29Send: brc29SendMachine,
  bsvSend: bsvSendMachine,
  burn: burnMachine,
  serverWalletRecover: serverWalletRecoverMachine,
  txLifecycle: txLifecycleMachine,
  walletCoordinator: walletCoordinatorMachine,
  accountMove: accountMoveMachine,
  emailRecovery: emailRecoveryMachine,
  relaySignin: relaySigninMachine,
  onboardEmail: onboardEmailMachine,
  call: callMachine,
  callView: callViewMachine,
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
