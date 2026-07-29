import { useEffect, useState } from 'react'
import {
  getDisplayCurrency,
  subscribeDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'

export function useDisplayCurrency(): DisplayCurrency {
  const [unit, setUnit] = useState<DisplayCurrency>(() => getDisplayCurrency())
  useEffect(() => subscribeDisplayCurrency(setUnit), [])
  return unit
}
