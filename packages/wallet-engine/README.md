# @handcash/wallet-engine

HandCash's local BRC-100 wallet engine. It is consumed from this repository by
Desktop and Mobile and is not published to npm.

`@bsv/sdk` remains the source of audited key, script, transaction and BEEF
primitives. This package owns IndexedDB state, action planning, history
portability, network service composition and monitor recovery.

The initial source baseline was recovered from the source map shipped with
`@bsv/wallet-toolbox-client@2.13.2`, then brought under HandCash ownership so
the runtime fixes previously applied to generated bundles live in reviewed
TypeScript. The upstream license and third-party notices are retained beside
this file.
