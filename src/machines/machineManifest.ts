import { appMachine } from './appMachine'
import { sendMachine } from './sendMachine'
import { unlockMachine } from './unlockMachine'
import { marketListingMachine } from './marketListingMachine'
import { marketPurchaseMachine } from './marketPurchaseMachine'
import { marketSellerSettlementMachine } from './marketSellerSettlementMachine'
import { collectableSendMachine } from '../wallet/collectableSendMachine'
import { itemSendMachine } from '../wallet/itemSendMachine'
import { brc29SendMachine } from '../wallet/brc29SendMachine'
import { bsvSendMachine } from '../wallet/bsvSendMachine'
import { burnMachine } from '../wallet/burnMachine'
import { walletCoordinatorMachine } from '../wallet/walletCoordinatorMachine'

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
  collectableSend: collectableSendMachine,
  itemSend: itemSendMachine,
  brc29Send: brc29SendMachine,
  bsvSend: bsvSendMachine,
  burn: burnMachine,
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
