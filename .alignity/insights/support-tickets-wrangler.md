---
name: support-tickets-wrangler
when: reading device logs or support tickets from this machine
---
Pressing Upload opens a BRC-CLOUD D1 `support_tickets` row naming the R2 log; read them with `npm run triage recent` and `npm run triage T-XXXXXXXX`, which use `wrangler login` (no `.env` token exists here).
Never POST probes to a real device bucket: it keeps 30 uploads, so each probe evicts the oldest log. Use a throwaway bucket and delete it after.
