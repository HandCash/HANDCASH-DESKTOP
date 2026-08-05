import { useEffect, useState } from 'react'

type MobileDeviceInfo = {
  grapheneOs: boolean
  playServicesInstalled: boolean
  sideloadUpdates: boolean
}

/**
 * Shown in Settings on HandCash Mobile when running on GrapheneOS.
 * Play Services are not required; updates are sideload APKs.
 */
export function MobileGrapheneNote() {
  const [info, setInfo] = useState<MobileDeviceInfo | null>(null)

  useEffect(() => {
    if (window.handcash?.platform !== 'android') return
    void window.handcash
      .getDeviceInfo?.()
      .then((device) => {
        if (device?.grapheneOs) setInfo(device)
      })
      .catch(() => undefined)
  }, [])

  if (!info?.grapheneOs) return null

  return (
    <li className="settings-row settings-row-static">
      <div className="settings-graphene-note">
        <strong className="settings-row-label">GrapheneOS</strong>
        <p className="settings-row-desc">
          HandCash Mobile runs without Google Play Services. Keys stay in the app sandbox;
          Android backup is disabled for this wallet.
        </p>
        <ul className="settings-graphene-list">
          <li>
            <strong>Updates</strong> — sideload a new APK from{' '}
            <button
              type="button"
              className="settings-inline-link"
              onClick={() =>
                void window.handcash?.openExternal?.('https://handcash.io/wallet')
              }
            >
              handcash.io/wallet
            </button>
            ; compare the published SHA-256 before installing.
          </li>
          <li>
            <strong>Scan to link</strong> — allow Camera when prompted (Settings → Apps →
            HandCash → Permissions). Paste fallback works if camera stays denied.
          </li>
          <li>
            <strong>Biometrics</strong> — optional; your vault password always unlocks the
            wallet.
          </li>
          {!info.playServicesInstalled ? (
            <li>
              <strong>No Play Services</strong> — expected on GrapheneOS; push notifications
              and Google sign-in are not used by this app.
            </li>
          ) : null}
        </ul>
      </div>
    </li>
  )
}
