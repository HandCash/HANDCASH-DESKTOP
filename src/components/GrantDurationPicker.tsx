import { SegmentGroup } from '@aeon-ui/react'
import {
  GRANT_DURATIONS,
  setPendingGrantDuration,
  type GrantDuration,
  type PendingPermission,
} from '../wallet/permissions'

/** How long a Connect lasts (BRC-73 grant lapse). The pending prompt holds the choice; this only projects it. */
export function GrantDurationPicker({ pending }: { pending: PendingPermission }) {
  return (
    <div className="grant-duration" data-aeon-scope="grant-duration" data-aeon-state={pending.grantDuration}>
      <span className="grant-duration-label" id={`grant-duration-${pending.id}`}>
        Connected for
      </span>
      <SegmentGroup.Root
        aria-labelledby={`grant-duration-${pending.id}`}
        value={pending.grantDuration}
        onValueChange={(next) => setPendingGrantDuration(pending.id, next as GrantDuration)}
      >
        {GRANT_DURATIONS.map((d) => (
          <SegmentGroup.Item key={d.id} value={d.id}>
            {d.label}
          </SegmentGroup.Item>
        ))}
      </SegmentGroup.Root>
    </div>
  )
}
