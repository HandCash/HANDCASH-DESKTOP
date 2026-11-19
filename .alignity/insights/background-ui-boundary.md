---
name: background-ui-boundary
when: moving wallet background work off the UI thread
---
Heavy background reads and decoding belong in workers; worker failure must retain the last UI result, never silently fall back to heavy renderer work.
A timed-out worker must be terminated, not merely have its promise rejected while it keeps consuming CPU.
