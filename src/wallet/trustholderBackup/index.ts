export type {
  TrustholderEnrollment,
  TrustholderInfo,
  TrustholderOperator,
} from './types'
export {
  TrustholderHttpError,
  fetchTrustholderInfo,
  startEmailOtpAuth,
  startDevTokenAuth,
  completeAuth,
  depositShare,
  retrieveShare,
  deleteShare,
} from './client'
export {
  getTrustholderEnrollments,
  getEnrollmentForOperator,
  setTrustholderEnrollments,
  upsertTrustholderEnrollment,
  getTrustholderSharePlan,
  setTrustholderSharePlan,
  clearTrustholderSharePlan,
  type TrustholderSharePlan,
} from './prefs'
export {
  listTrustholderProviders,
  getProvider,
  ensureTrustholderSharePlan,
  getLocalOfflineShare,
  depositShareToTrustholder,
  depositSharesToTrustholders,
  LOCAL_SHARE_INDEX,
  type DepositOtpRequest,
  type DepositProgress,
  type DepositOneResult,
  type TrustholderProvider,
} from './enrollment'
