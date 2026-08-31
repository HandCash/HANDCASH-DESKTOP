import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { WalletProfile } from '../machines/appMachine'
import { isMobileWalletPlatform } from '../wallet/isMobilePlatform'
import {
  resolvePermission,
  subscribePermissionRequests,
  type PendingAction,
  type PendingPrompt,
} from '../wallet/permissions'
import { getSideScanOpen, subscribeSideScan } from '../wallet/navStore'
import { releaseWarmedQrCamera } from '../wallet/qrCameraWarm'
import { playWalletSound } from '../wallet/soundService'
import { toastSuccess } from '../wallet/toast'
import { appDisplayName } from '../wallet/appIdentity'
import { setAutoPaySettings } from '../wallet/autoPay'
import { WhatIsBsvPanel } from './WhatIsBsvPanel'
import { ScanPanel } from './ScanPanel'
import { RecentActivityPanel } from './RecentActivity'
import { PermissionRequestPanel } from './PermissionRequestPanel'
import { PermissionItemPreview } from './PermissionItemPreview'
import {
  clearPaymentProgress,
  getPaymentProgress,
  marketBusyCopy,
  setPaymentProgress,
  subscribePaymentProgress,
  type PaymentProgress,
} from '../wallet/paymentProgress'

type Props = {
  profile: WalletProfile
}

/**
 * Desktop right column — permission prompts, payment progress, activity feed.
 * Isolated so payment-progress ticks do not re-render WalletNav / collectables.
 */
export const DashboardSideColumn = memo(function DashboardSideColumn({ profile }: Props) {
  const sideRef = useRef<HTMLElement>(null)
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null)
  const [paymentProgress, setPaymentProgressState] = useState<PaymentProgress>(() =>
    getPaymentProgress(),
  )
  const [lastApproved, setLastApproved] = useState<PendingAction | null>(null)
  const [sideScanOpen, setSideScanOpen] = useState(
    () => !isMobileWalletPlatform() && getSideScanOpen(),
  )

  const sideBusy =
    !isMobileWalletPlatform() &&
    (pendingPrompt != null || paymentProgress.phase !== 'idle')
  const sideApproval = !isMobileWalletPlatform() && pendingPrompt != null

  useEffect(() => {
    if (isMobileWalletPlatform()) return
    return subscribePermissionRequests(setPendingPrompt)
  }, [])
  useEffect(() => {
    if (isMobileWalletPlatform()) return
    return subscribePaymentProgress(setPaymentProgressState)
  }, [])
  useEffect(() => {
    if (pendingPrompt) setLastApproved(null)
  }, [pendingPrompt?.id])
  useEffect(() => {
    if (!sideBusy || !sideRef.current) return
    sideRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [sideBusy, pendingPrompt?.id, paymentProgress.phase])
  useEffect(() => {
    if (isMobileWalletPlatform()) return
    return subscribeSideScan((open) => {
      setSideScanOpen(open)
      if (!open) releaseWarmedQrCamera()
    })
  }, [])

  const onPermissionAllow = useCallback(
    (autoPay?: { enabled: boolean; maxUsd: number; windowHours: number }) => {
      if (!pendingPrompt) return false
      if (!resolvePermission(pendingPrompt.id, 'allow')) return false
      if (autoPay) setAutoPaySettings(pendingPrompt.origin, autoPay)
      const name = appDisplayName(pendingPrompt.origin)
      if (
        pendingPrompt.kind === 'action' &&
        (pendingPrompt.method === 'createAction' ||
          pendingPrompt.method === 'signAction' ||
          pendingPrompt.method === 'createMarketListingAdvert' ||
          pendingPrompt.method === 'createCancelMarketListingAdvert' ||
          pendingPrompt.method === 'purchaseMarketListing')
      ) {
        setLastApproved(pendingPrompt)
        const market = marketBusyCopy(pendingPrompt.method)
        setPaymentProgress(
          'preparing',
          market?.detail ?? 'Starting…',
          pendingPrompt.itemOutpoint,
          market?.label,
        )
      } else if (
        pendingPrompt.kind === 'action' &&
        getPaymentProgress().detail === 'Starting…'
      ) {
        clearPaymentProgress()
        setLastApproved(null)
      }
      playWalletSound('connect')
      if (pendingPrompt.kind === 'connect') {
        toastSuccess('Connected', `${name} can use your wallet`)
      } else {
        toastSuccess('Approved', pendingPrompt.title || name)
      }
      return true
    },
    [pendingPrompt],
  )

  const onPermissionDeny = useCallback(() => {
    if (!pendingPrompt) return false
    if (!resolvePermission(pendingPrompt.id, 'deny')) return false
    playWalletSound('deny')
    return true
  }, [pendingPrompt])

  if (isMobileWalletPlatform()) return null

  return (
    <aside
      ref={sideRef}
      className="dashboard-side"
      data-aeon-scope="dashboard-side"
      data-aeon-state={sideBusy ? 'permission' : 'idle'}
    >
      {sideApproval && pendingPrompt ? (
        <section className="panel permission-side-panel" aria-label="Permission request">
          <PermissionRequestPanel
            pending={pendingPrompt}
            onAllow={onPermissionAllow}
            onDeny={onPermissionDeny}
            actions="inline"
          />
        </section>
      ) : sideBusy ? (
        <section
          className="panel permission-side-panel permission-side-panel--processing"
          aria-label={paymentProgress.label || 'Working'}
          aria-busy="true"
        >
          <div className="send-spinner" aria-hidden />
          <p className="send-status-title">{paymentProgress.label || 'Working…'}</p>
          <p className="send-status-sub">
            {paymentProgress.detail ||
              (lastApproved
                ? `${lastApproved.title} — ${appDisplayName(lastApproved.origin)}`
                : 'Finishing the approved request.')}
          </p>
          {lastApproved?.itemOutpoint || lastApproved?.tokenId || lastApproved?.itemName ? (
            <PermissionItemPreview
              outpoint={lastApproved.itemOutpoint}
              tokenId={lastApproved.tokenId}
              itemName={lastApproved.itemName}
              itemImageUrl={lastApproved.itemImageUrl}
              previewKind={lastApproved.previewKind}
            />
          ) : null}
        </section>
      ) : (
        <>
          {sideScanOpen ? <ScanPanel placement="side" /> : <WhatIsBsvPanel />}
          <RecentActivityPanel chain={profile.chain} />
        </>
      )}
    </aside>
  )
})
