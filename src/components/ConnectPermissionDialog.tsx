import { useEffect, useState } from 'react'
import { stateToAttr } from '@aeon-ui/core'
import type { PendingPermission } from '../wallet/permissions'
import { CONNECT_SCOPES, appDisplayName, appHomepage } from '../wallet/appIdentity'
import { AppAvatar } from './AppAvatar'
import { ModalPortal } from './ModalPortal'
import { ScopeIcon } from './ScopeIcon'

type Props = {
  pending: PendingPermission | null
  onAllow: () => void
  onDeny: () => void
}

function ConnectPermissionBody({
  pending,
  onAllow,
  onDeny,
}: {
  pending: PendingPermission
  onAllow: () => void
  onDeny: () => void
}) {
  const [iconReady, setIconReady] = useState(false)
  const name = appDisplayName(pending.origin)
  const home = appHomepage(pending.origin)

  useEffect(() => {
    setIconReady(false)
  }, [pending.origin, pending.id])

  return (
    <div
      className="panel modal permission-modal connect-permission-modal"
      data-aeon-part="content"
      data-aeon-state={iconReady ? undefined : 'loading'}
      role="dialog"
      aria-modal="true"
      aria-labelledby="connect-permission-title"
    >
      <div className="connect-app-hero">
        <AppAvatar
          origin={pending.origin}
          name={name}
          size="lg"
          onReady={() => setIconReady(true)}
        />
        <div>
          <p className="permission-eyebrow">HandCash Connect</p>
          <h2 id="connect-permission-title">Connect {name}?</h2>
          <p className="connect-app-host mono">{pending.origin}</p>
        </div>
      </div>

      <p className="lede">
        <strong>{name}</strong> wants to connect to your HandCash wallet.
        {home ? (
          <>
            {' '}
            <a href={home} target="_blank" rel="noreferrer">
              Visit site
            </a>
          </>
        ) : null}
      </p>

      <div className="scope-list" aria-label="Permissions requested">
        <p className="scope-list-label">This app will be able to</p>
        {CONNECT_SCOPES.map((scope) => (
          <div key={scope.id} className="scope-row">
            <span className="scope-icon" aria-hidden>
              <ScopeIcon scopeId={scope.id} size={15} />
            </span>
            <div>
              <strong>{scope.label}</strong>
              <p>{scope.description}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="permission-note">
        Payments still need your approval every time. You can disconnect this app later from
        Connected apps.
      </p>

      <div className="actions connect-actions">
        <button className="btn btn-ghost" type="button" onClick={onDeny}>
          Deny
        </button>
        <button className="btn btn-primary" type="button" autoFocus onClick={onAllow}>
          Authorize
        </button>
      </div>
    </div>
  )
}

export function ConnectPermissionDialog({ pending, onAllow, onDeny }: Props) {
  if (!pending) return null

  return (
    <ModalPortal>
      <div
        className="modal-backdrop permission-backdrop"
        data-aeon-scope="dialog"
        data-aeon-state={stateToAttr('pending')}
        role="presentation"
      >
        <ConnectPermissionBody pending={pending} onAllow={onAllow} onDeny={onDeny} />
      </div>
    </ModalPortal>
  )
}
