# Multicurrency permission request — UNSENT

Superseded as the primary path: the user authorized incremental replacement of restricted components. Keep this unsent draft only as a fallback; no contact or publication is authorized.

## Verified routing and authority (6 November 2026)

- **Primary:** [BSV Association official contact form](https://bsvassociation.org/contact/). Ask for the legal/IP licensing team and an authorized signatory. No dedicated public SDK/Toolbox licensing-request inbox or published multichain commercial-license offer was verified. This is a verified official routing channel, not a promise they offer an exception.
- **Parallel introduction / provenance:** [Project Babbage contact](https://projectbabbage.com/contact), published email **support@projectbabbage.com**. Ask them to identify their rights in historical Toolbox/SDK contributions and the person authorized to license them; do not assume Babbage owns the whole stack.
- **Technical scope:** [TS Stack maintainers](https://github.com/bsv-blockchain/ts-stack) can help identify source snapshots, contributors and assignment evidence. A maintainer reply alone is not proof of licensing authority.

BSV Association, Swiss identifier CHE-427.008.338, is the named v6 licensor in the installed SDK/Verifast/Webrtpay texts. Historical Toolbox/SDK v4 notices identify BSV Blockchain Association (Bitcoin Association). This establishes the named licensor, NOT complete chain of title. Ask the Association to confirm authority over the listed historical and embedded contributions and identify any exceptions.

Verifast embeds BDK 1.2.2 (6d1e8092e8a9917d2544cddc9e20c6dc38242d93), whose local license names Bitcoin Association (2019–2020), and bitcoin-sv node 879fc8b42168dd0e608dafd51b39c6dabad37d4d, whose [v5 license](https://github.com/bitcoin-sv/bitcoin-sv/blob/879fc8b42168dd0e608dafd51b39c6dabad37d4d/LICENSE) names BSV Association. Historical MIT portions name Satoshi Nakamoto, Bitcoin/Core/ABC developers and others. SDK permissive portions include Yours/BitPay, Fedor Indutny, Google Closure, noble, SJCL and mnemonic contributors. Existing permissive grants normally supply the needed copyright permission if their terms are retained; do not request blanket relicensing of their code. Any restricted contribution not assigned or sublicensable by the Association requires its actual owner's separate consent or replacement. Babbage's authority over any contribution remains unverified.

## Babbage comparison — no established permission shortcut

[Archived Metanet Desktop license](https://github.com/bsv-blockchain/metanet-desktop/blob/master/LICENSE.txt) and [historical Toolbox license](https://github.com/bsv-blockchain/wallet-toolbox/blob/master/license.md) are Open BSV **v4**, not unrestricted MIT. Current [Toolbox client license](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/client/LICENSE.txt) is **v6**. Both restrict the covered software/derivatives to BSV. [User Wallet 0.9.9 manifest](https://github.com/p2ppsr/user-wallet/blob/master/package.json) pins SDK 3.1.0 and Toolbox client 2.14.6, using Tauri/React/MUI; its inspected root listing has no license file establishing a permissive grant. HandCash instead uses Aeon/shared Mobile UI, native shells and a local Toolbox-derived engine, with the same restricted primitive family. Different packaging or currency conversion displays do not establish native other-chain permission. No public multichain exception or applicable commercial grant was found in the inspected sources; private agreements may exist, but confer no rights on HandCash.

## Ready-to-send draft

**To:** BSV Association legal/IP licensing team, via official contact form  
**Separate copy / introduction:** Project Babbage, support@projectbabbage.com  
**Subject:** Written multicurrency permission for HandCash Desktop/Mobile — SDK, Toolbox and embedded components

Hello,

We are developing HandCash Desktop and its shared Mobile wallet. We want to retain BSV as a first-class network while adding native support for other currencies, including Bitcoin, Litecoin and EVM/USDC. Our aim is to bring users and liquidity from the existing crypto landscape into BSV by making it easy to hold and use those assets alongside BSV in one self-custodial wallet. This is our intended benefit, not a claim of guaranteed liquidity or an existing endorsement.

We respect your rights and want explicit written permission rather than relying on assumptions about Open BSV licensing or another vendor's products. Please route this to the person authorized to grant the relevant copyright and patent permissions.

Our current identified scope is:

- @bsv/sdk **2.8.11** (Desktop lock) and **2.8.1** (sibling Mobile lock).
- @bsv/verifast **0.3.6**, including its JavaScript/WASM and incorporated BDK/node material.
- @bsv/webrtpay **0.2.1**, distributed through our vendored tarball.
- @bsv/wallet-toolbox-client **2.13.2**, the recorded source-map baseline of our modified local @handcash/wallet-engine **0.1.0**, introduced in HandCash commit **3aa5421a**.
- Applicable historical v4 material identified by upstream notices at TS Stack snapshot **d215223af67b2b08ef628e8e07f5cff8b60ec9b3**, subsequent v6 material, and embedded BDK **1.2.2 / 6d1e8092e8a9917d2544cddc9e20c6dc38242d93** and bitcoin-sv node **879fc8b42168dd0e608dafd51b39c6dabad37d4d** under their applicable legacy/v5 terms.

These are verified checkout versions, not a representation that every released binary has exactly this dependency graph. We can provide lockfile integrity values, retained notices, exact source snapshots and an agreed hash-pinned schedule before execution. Please identify any missing covered components. Future updates should be included only if expressly agreed, not presumed covered.

Would you grant a perpetual, worldwide, non-exclusive, royalty-free permission, irrevocable except for clearly defined breach terms, for the scheduled code and our derivatives to:

1. Use, reproduce, modify and combine it in native multicurrency wallets, including on non-BSV chains, and in software containing both BSV and other-chain functionality, expressly overriding the applicable BSV-only field-of-use conditions for this scope.
2. Distribute and publish source, modified source, JavaScript bundles, WASM, native binaries, installers and app-store packages on Desktop (Linux, macOS, Windows) and Mobile (Android, iOS).
3. Operate commercially, provide paid services and support, and permit commercial and noncommercial use by users and downstream recipients.
4. Redistribute under an agreed permissive open-source grant (preferably MIT or Apache-2.0) with downstream recipients and forks receiving equivalent rights to use, modify, redistribute and sublicense, without separate applications, chain restrictions or per-recipient fees. A HandCash-only exception would not meet our open-source goal.
5. Exercise any necessary patent rights you can grant, with their scope expressly stated.

We will retain required copyright, license and third-party notices. We are not seeking permission to erase provenance, claim ownership of your contributions or imply endorsement or trademark rights.

Please confirm the legal entity granting permission, its authority over each scheduled component and historical contribution, any exclusions, and the identity/contact route of any other rights holders whose separate consent is needed. In particular, please clarify whether embedded BDK/node restricted portions and historical Babbage contributions are covered by your authority. We will continue to comply separately with permissive third-party licenses.

If an unrestricted downstream grant is not available, please state the exact alternative terms, costs and decision timeline, and whether a narrower combination permission is available while BSV components remain BSV-only. We would obtain legal review of that alternative; we do not assume architectural separation alone resolves the issue. Please also identify whether any separate permission is needed for implementation from the relevant published BRC specifications, as distinct from copying implementation code.

We are also seeking advice on any notice or licensing remediation appropriate for existing distributions; this request should not be read as a legal conclusion about them. Please provide a signed amendment or grant and a component schedule rather than informal assurance.

Thank you,
HandCash development team

## Decision

Fastest plausible path: request the written grant first, with a short agreed response deadline; do not wait for a complete rewrite before asking. No applicable existing multichain grant has been established. If they cannot grant downstream freedom, retain the independent permissive-replacement plan from `licensing-audit.md`; a paid HandCash-only license could speed a product launch but would not make the restricted code freely reusable. Do not remove dependencies, notices or change terms pending approval and counsel's review. This draft has not been sent or published.
