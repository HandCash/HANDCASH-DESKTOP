import { useSyncExternalStore } from 'react'
import {
  getFiatCurrency,
  subscribeFiatCurrency,
  type FiatCode,
} from '../wallet/fiatCurrency'

export function useFiatCurrency(): FiatCode {
  return useSyncExternalStore(subscribeFiatCurrency, getFiatCurrency, getFiatCurrency)
}
