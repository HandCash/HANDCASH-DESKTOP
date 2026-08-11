export type { TrustholderEnrollment, TrustholderInfo, TrustholderOperator } from './types'
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
} from './prefs'
export {
  listTrustholderProviders,
  depositSharesToTrustholders,
  type DepositOtpRequest,
  type DepositProgress,
  type DepositRegisterRequest,
  type DepositResult,
  type TrustholderProvider,
} from './enrollment'
