import { useEffect, useState } from 'react'
import {
  collectableTypeLabel,
  getCollectableType,
  setCollectableType,
  subscribeCollectableType,
  type CollectableType,
} from '../wallet/collectableType'
import { playWalletSound } from '../wallet/soundService'

const OPTIONS: CollectableType[] = ['1sat', 'twonk']

/**
 * Top-bar protocol selector for Collectables (1Sat | Twonk).
 * Chart: type ∈ {1sat, twonk}; UI = f(type).
 */
export function CollectableTypeToggle() {
  const [type, setType] = useState<CollectableType>(() => getCollectableType())

  useEffect(() => subscribeCollectableType(setType), [])

  return (
    <div
      className="collectable-type-toggle"
      role="group"
      aria-label="Collectable type"
      data-aeon-scope="collectable-type"
      data-aeon-state={type}
    >
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className="collectable-type-btn"
          aria-pressed={type === option}
          data-active={type === option ? true : undefined}
          title={collectableTypeLabel(option)}
          onClick={() => {
            if (option === type) return
            playWalletSound('soft')
            setCollectableType(option)
          }}
        >
          {collectableTypeLabel(option)}
        </button>
      ))}
    </div>
  )
}
