/** Shared IPC contract only. Release selection, HTTP and scheduling live in the Rust host. */
import type { UpdateMode, UpdateStatus } from '../machines/updateMachine'

export type ReleaseUpdater = {
  getUpdateStatus: () => Promise<UpdateStatus>
  checkForUpdates: () => Promise<UpdateStatus>
  downloadUpdate: () => Promise<UpdateStatus>
  setUpdateMode: (mode: UpdateMode) => Promise<UpdateStatus>
  installUpdate: () => Promise<void>
  onUpdateStatus: (handler: (status: UpdateStatus) => void) => () => void
}
