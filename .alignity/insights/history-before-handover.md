---
name: history-before-handover
when: changing wallet import or account handover readiness
---
Chain health `ok` is not history-import evidence (it can mean timeout or stillImporting); require an identity-scoped successful history restore before declaring a restored wallet ready to move.
Never bypass holding guards or boot a non-holder signing Toolbox just to stage the restore.
