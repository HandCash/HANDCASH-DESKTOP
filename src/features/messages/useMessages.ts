import { useExternalGeneration } from '../../stores/useExternalGeneration'
import {
  getMessageWriteGeneration,
  listAllMessages,
  listMessagePeers,
  subscribeMessages,
  type ChatMessage,
} from '../../wallet/messageStore'

function subscribe(listener: () => void): () => void {
  return subscribeMessages(listener)
}

export function useMessages(): readonly ChatMessage[] {
  return useExternalGeneration(subscribe, getMessageWriteGeneration, listAllMessages)
}

export function useMessagePeers(): ReturnType<typeof listMessagePeers> {
  return useExternalGeneration(
    subscribe,
    getMessageWriteGeneration,
    listMessagePeers,
  )
}
