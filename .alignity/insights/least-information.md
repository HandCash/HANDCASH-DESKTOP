---
name: least-information
when: caching, persisting or passing proofs, BEEF or wallet state outside its owner
---
Keep only what the reader needs: UI and caches keep the outcome of a proof (verdict, proven path), never the proof. Proofs stay with their owner or are rebuilt from the outcome on demand (send replays the verdict path).
Rows for value paid to someone else carry no proof; the peer gets it in the inbox envelope.
