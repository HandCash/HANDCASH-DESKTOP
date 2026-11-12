---
name: release-by-tag
when: shipping Desktop or Mobile changes
---
While devving, commit to main, then build Mobile locally (`HANDCASH-MOBILE/scripts/build-apk.sh`, pin via `npm run mobile:release`) and install Desktop and the APK locally; no tag, no CI release.
Tag `vX.Y.Z` (installers on CI) only for a public release the user names; Mobile CI moves to Codemagic later.
