---
name: holding-is-cooperative
when: changing account holding, moves, the spend guard, or wording in BRC-249 and docs about them
if: docs/bsva/brcs/wallet/0249.md
---
Account holding is a cooperative signal between the user's own installs, not a lock or security boundary: every install keeps the keys. Keep the spend check (refuse or move quietly), add no user step or UI, and describe it only as preventing accidental double spends by well-behaved installs.
