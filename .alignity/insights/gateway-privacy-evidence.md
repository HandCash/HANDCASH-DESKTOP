---
name: gateway-privacy-evidence
when: assessing gateway privacy or service opt-outs
---
Verify client payloads/triggers, server persistence and deployed configuration separately; local synthetic uploads do not prove production receipt, and raw deletion does not prove derived-data deletion.
Backup opt-out is not global network opt-out; verify every disabled service with request-denial tests and authorized synthetic deployment captures; labelled-field redaction does not guarantee secret exclusion.
