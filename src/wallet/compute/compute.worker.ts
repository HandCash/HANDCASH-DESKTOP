/// <reference lib="webworker" />
import type { ComputeRequest } from '../../ports/computePort'
import { handleComputeRequest } from './computeOps'

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (event: MessageEvent<ComputeRequest>) => {
  const { reply, transfer } = handleComputeRequest(event.data)
  scope.postMessage(reply, transfer)
}
