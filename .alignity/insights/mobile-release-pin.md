---
name: mobile-release-pin
when: shipping Mobile with a Desktop release
---
Pin ui-core-source.json to the remote Desktop tag SHA, not Alignity's rewritten worktree SHA; shared version must match that tag.
Mobile's production-signed release-apk.yml can ship via its own pushed tag without Desktop's MOBILE_RELEASE_TOKEN.
