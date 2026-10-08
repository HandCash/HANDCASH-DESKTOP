# Changelog

## [1.3.502] - 2026-10-08

### Changed

- Patch release (every push must ship a new version).

## [1.3.501] - 2026-10-08

### Changed
- **Wallet code restored to the 1.3.471 checkpoint (yesterday 07:59).** Item sending broke during yesterday's run of changes. Everything under `src/` is exactly as released in 1.3.471; the 1.3.472–1.3.500 changes are listed below and come back one at a time, each on its own. Support tooling outside the app (`scripts/triage`, Cursor rules) is kept. No stored data is touched: the toolbox transactions table, the Activity store, the import saved list, the job index and job records keep their keys and formats; the 1.3.498 ledger-snapshot store is simply not read.

## [1.3.500] - 2026-10-07

### Fixed
- **A new import sweep no longer stays at zero over items an earlier import already moved.** Three held import transactions (1.3.498) had moved 24 items without the saved import list ever hearing back, so every later sweep tried them again. The pre-sign check refused the bundle naming those inputs as spent, and the run treated that like any rejected bundle: halve, build, abort, halve again, down to each item, then record a failure — which keeps the item on the list. The phone did this 22 times per sweep and moved nothing. When the refusal names the bundle's own tips, those tips now leave the run at once as "already moved — spent on chain", the saved list drops them, and the rest of the bundle is sent again whole at the same size. Items the wallet already holds are never retried.

## [1.3.499] - 2026-10-07

### Fixed
- **Import rows that already landed stay in Activity across a restart.** Early imports were written into Activity, so they never left. Later ones were only remembered in memory until a history read that takes minutes, and a restart threw that memory away — including a save that was still waiting when the app closed. Each import is written down as it lands, and closing the app finishes that write. A history read that does not yet list them keeps the rows already written. Held import transactions are included in that read from their own description, so ones the retry queue already dropped still come back.

## [1.3.498] - 2026-10-07

### Fixed
- **A mined import transaction is no longer stuck as "not sent yet".** Since 1.3.492, import and item-send transactions are stored as held (`nosend`) and leave that state only when Arcade accepts them. When Arcade errored on a large package and another broadcaster took it, nothing released it, even after it was mined. The retry queue kept re-posting it with incomplete ancestry, and the unlock rescue never looked at held rows. Three of the phone's import transactions (5c872303, 10952771, fca756eb) were in block 970086 and still held. A held transaction's change cannot fund the next payment, it gets no proof request, and Activity hid it while Collect showed its items.
  - A retry now asks whether the chain already has the transaction. If it does, the retry ends and the transaction is released to unconfirmed. Its change becomes spendable and the proof task fetches its merkle proof.
  - The unlock pass releases every held transaction the chain already has. It decides on chain evidence only. A held transaction the network does not have is never broadcast by this pass.
- **Activity shows held imports the wallet has broadcast.** The ledger read only completed, unconfirmed and sending transactions. It now also shows held ones that Arcade took, that a node reported, or that the retry queue is still broadcasting. An app's held transaction that was never broadcast stays out. Each row's status comes from the storage index on every read, so a transaction released after it was cached is not judged by its old status.

### Changed
- **Activity paints past imports at launch.** The wallet's own transaction list is Activity's base layer, and on the phone its first read took 146–220 s behind the storage lock. Until it finished, every import was missing from Activity. The last read is now saved in its own IndexedDB store (newest 10,000 rows, cleared by a wallet wipe) and shown at launch, then the live read replaces it.

## [1.3.497] - 2026-10-07

### Changed
- **Import transactions broadcast through the same flow as every payment.** The broadcast itself was already shared (seal, archive, miner outbox, Arcade, landing watch). Around it, the import did three things of its own:
  - It held the wallet's exclusive spend lock through the whole post and the wait for Arcade, up to 158 s on the phone, so payments and syncs queued behind it. A payment releases the lock once the transaction is signed and registered. Imports now do the same (`signForeignInputAction`), then wait for the result outside the lock (`settleForeignInputAction`).
  - It judged Arcade's answer to the first post alone. When a fallback broadcaster took the transaction, the import stopped as "propagating" and paused 8 s twice, then dropped the remaining items, although the miner outbox (which retries every 60 s) was still taking it to Arcade. The import now waits on that same outcome: once Arcade holds the transaction, the common flow frees its change and the next transaction is funded from it.
  - It had its own wait for the change to free up, and the bulk collectable send had a third copy. Both now use one helper, `awaitChainedLegFunding`.
- **Bulk collectable sends wait for Arcade before funding the next transaction from the last one's change.** They used to free that change as soon as the transaction was signed, before any miner had seen it. They also skip the wait after the last transaction. A transaction the network has not taken yet stops the run, and only the untouched items are reported as not sent. The signed transaction used to be counted among them.

## [1.3.496] - 2026-10-07

### Fixed
- **Import transactions no longer spend up to a minute sealing inputs that were never the wallet's.** After signing, a send seals its inputs so no second send can pick them. For an import, every item input comes from the imported phrase's address, not from the wallet. The seal still asked storage twice per input (outputs by txid, then the transaction), on the lock the next createAction waits for. That took 33 s for a 25-item transaction and 58 s for a 44-item one on the phone, and every lookup found nothing. Those inputs are now marked in memory only. createAction already handles any input the wallet does hold.
- **The unlock landing replay also waits for a saved-wallet sweep.** 1.3.494 held the replay only while the import progress bar ran. A sweep reports through its own Activity row, so about 100 landing checks ran on the storage lock during a sweep.
- **Each import transaction stays small enough for Arcade.** Arcade accepted a package of 704 KB, but at 1.00–1.04 MB it returned an error or never answered. Another broadcaster then took the transaction, and the import paused for about three minutes until Arcade caught up. The per-transaction budget is now 750 KB. Light items still fit 100 to a transaction. Items carrying large inscriptions split into more transactions.

### Changed
- **Imported items show in Activity as each transaction lands.** The import's row keeps its bar, and each transaction it lands appears beneath it right away instead of after the run. The wallet's own transaction list was not re-read during an import, so Activity stood still while the count climbed. Once the run ends they fold into one record, as before.
- Logs: `[foreign-input] … pack= register= post= pin=` splits what was `pack`/`post`, and `[signed-send] register <txid> done <N>ms prepare= seal= archive=` appears when registration takes over 250 ms.

## [1.3.495] - 2026-10-07

### Fixed
- **Imported items stop vanishing on restart.** While the wallet is busy (an import, a send or a sync), a basket read keeps the cards already painted and adds the newly listed ones. It used to add them at the end. Startup paints from a saved copy of the first 1,000 cards, so on a wallet past 1,000 items the newest imports were the ones cut. They came back only after a 2–3.5 minute basket read listed them again. Arrivals now go in front, matching the basket's newest-first order, and so do items minted to yourself.

## [1.3.494] - 2026-10-07

### Fixed
- **Imported items get their merkle proofs again, so each import transaction stops re-reading every earlier one.** Since 1.3.492, import transactions are created with `noSend`. When Arcade accepts one, the pin set the transaction to unproven but left its proof request at `nosend`. The Toolbox's per-block proof task never reads `nosend`; only the hourly-to-weekly no-send check does. So those transactions stayed unproven for days. On every createAction the Toolbox walks back through unproven ancestors and merges each one's stored input BEEF (0.3–3 MB per migrate). On the phone, planning a 5-tip transaction took 13–48 s, and once 381 s. Planning a 100-tip transaction took 19–21 s when those ancestors were proven. A send the network has taken now moves its proof request to `unmined`, as the Toolbox's own `retireNoSendWithoutProof` does. Unlock also moves requests left over from older builds, 10 at a time and only those Arcade accepted or saw land. Log: `[stale-output] proof request <txid> nosend → unmined`.
- **The unlock landing replay waits while an import runs.** The replay was added in 1.3.486: Arcade fate checks for every pinned send plus a rescue pass over unproven outgoing transactions. It ran for five minutes (71 pins and 18 rescues) on the same Toolbox storage lock as the import's createAction.

### Changed
- **Recovered items move 100 per transaction again, and 1.3.493's move to 25 is reverted.** Most of each transaction's cost is fixed. On the phone, 100 tips (1.3.469) and 34 tips (1.3.483) per transaction cost about 0.5 s a tip. Bundles of 5–15 tips cost 3.5–5.6 s a tip. One first transaction of 25 replaces the 5/15 ramp, so the first items still land early without two extra transactions.

## [1.3.493] - 2026-10-07

### Changed
- **Recovered items move 25 per transaction again (it was 100).** On the phone the Toolbox's storage pass took 12–166 s per transaction whatever the bundle size, while signing took 1–2 s per tip. A 100-tip transaction held the wallet for minutes, and 10 would repeat the storage pass ten times as often. With 25, each transaction holds the wallet for about a minute. One queue call is still one transaction: 5, then 15, then 25 at a time.

## [1.3.492] - 2026-10-07

### Fixed
- **Recovery item and token moves follow the same broadcast rules as every other send.** Each import transaction is now created with `noSend` and handed to `signedSendLifecycle`. That step seals its inputs, archives the body, posts it to the miners and keeps retrying it. Before, the toolbox's own Monitor broadcast these transactions as well, and a submit that no miner tracked (`untracked`) was taken as a success. A run now continues only after Arcade has accepted the previous transaction and its change can pay the next fee. If the transaction is still propagating, the import pauses briefly and then resumes. A signed transaction is never aborted. Only a signing failure releases the unsigned action. Logs: `[foreign-input] <txid> accepted|propagating submit=<kind> done <N>ms create= sign= pack= post=`.
- **One runner moves recovered items.** A sweep used to run its own chunk loop next to the import queue, so the two could pick the same tips. A sweep now puts its listed items in the import queue and waits for them. Their progress shows on the sweep's Activity row, and every pause and stop is handled in one place.

### Changed
- **Item migrate runs are a statechart (`itemMigrateRunMachine`, in Settings → Statecharts).** Each bundle failure is classified once into one of seven kinds: busy, abandoned, funds, spent fee coin, locked, network or rejected. Only a rejected bundle is halved. Every other kind waits, rebuilds once or stops, and the untried items are answered "add BSV" or "paused", never "failed". Stop reasons and their messages come from one table shared by the run, the queue and the sweep.
- The import queue pauses and retries on a spent fee coin or a still-propagating transaction. Every other stop drops that wallet's waiting items.
- Scans try their read passes in a fixed order: HandCash UTXO set, then hinted history, then the full walk. Each scan logs `[import] scan path=<pass> of=<order> … done <N>ms`.
- Removed the per-address resume position from older builds, which nothing still wrote, along with its "Paused collectable import" banner and its Activity row.

## [1.3.491] - 2026-10-07

### Fixed
- **Recovery is fast again right after unlock.** The legacy import itself did not slow down. In the earlier fast run it happened to start before unlock. Now it starts right after unlock, while the unlock recompose is still running, and every spend waits for that recompose to finish. On a phone with a large history the recompose took 2–4 minutes, for two reasons:
  - The history step's "is local state empty?" check asked the toolbox for one output and one action. To do that the toolbox counted every row, deserializing each stored transaction with its raw tx and input BEEF, which took ~160 s while every spend was blocked. It now reads a single row by index (one spendable change output, then one listed action) and stops there. It logs `[layers] empty-check done <N>ms` when it takes 250 ms or more.
  - The unlock rescue looked for unproven outgoing sends with a status list, which walked the whole transactions store. It now runs one indexed query per status for this user.

### Security
- **Mobile: grants made in an in-app tab cannot be used from the loopback socket.** Another Android app can open a connection to `127.0.0.1:3321` and claim any `Origin`. Pages opened in the wallet's in-app tab now talk to the wallet over a WebView channel whose origin Android reports and the page cannot forge. A site first connected there is bound to that channel: a socket request using its grant gets `403 ORIGIN_BOUND_IN_APP` and logs `[brc100] refused <method> from <host> on the loopback socket: connected in an app tab`. Sites connected from an external browser keep working over the socket as before.

## [1.3.490] - 2026-10-07

### Security
- **Connect no longer lets one site borrow another site's name or grants.** Every grant (Connect, item and token views, receive, auto-pay, identity proofs, and the migrate, market and handle-claim host lists) is keyed by the caller's host.
  - The bridge refuses a plaintext `http://` page that claims a public host, because whoever controls the network can serve it. This mattered most for `market-v2.handcash.io`: it is on the market list and sends no HSTS. Loopback and private-network addresses still work over http for local development.
  - Sandboxed iframes and file pages send `Origin: null`. They used to share a single "Unknown app" identity, so connecting one connected all of them, on any site. They are now refused, as are callers that send neither an `Origin` nor an `Originator`, and origins with schemes that are neither web nor browser-extension.
  - Refusals return `403 ORIGIN_REFUSED` with the reason and log `[brc100] refused <method>: <reason>`.
- **Prompts no longer title a look-alike site "HandCash".** A host HandCash does not own whose name reads as HandCash (for example `handcash.vercel.app`, `hand-cash.co` or `h4ndca5h.app`), or any internationalized (IDN) host, is now titled with its bare host instead of a friendly name. Connected apps saved under an old name are renamed on load.

## [1.3.489] - 2026-10-07

- Tagged without its changes; they ship in 1.3.490. Same code as 1.3.488.

## [1.3.488] - 2026-10-07

### Diagnostics
- **Triage separates real errors from noise.** Code deduplicates every warning/error family in an upload, keeps one raw line for each, and marks the ones the previous upload did not have. Jev then judges each family "real problem or noise" and picks the root one. The report, the log dashboard card and `npm run triage verdicts` show the root and the families that matter, raw, and fold the rest into one count, for example: `2 of 19 families matter · noise: 17 families, 27 lines`. A root pick that Jev's own per-family answer called noise is not shown. The dashboard no longer lists the per-family answers as judgments, and replaces its repeating-problems list with this.
- The unlock rescue also logs when it found nothing to follow: `[landing] rescue checked=0 unproven=N`. Before, a missing line could mean either that or that it never ran.
- `npm run triage <device> -- --state` no longer cuts its JSON off at 64 KB when piped.

## [1.3.487] - 2026-10-07

### Diagnostics
- `npm run triage verdicts [device] [--limit N] [--json]` prints the live log dashboard's stored Jev verdicts as plain text: severity, fix first and why, driver, flags, freezes vs the previous upload, workloads, repeating problems and counters. It makes no Jev call and needs no wallet sign-in; it reads with `LOG_DASHBOARD_READ_TOKEN` from `.env`, which is read-only and reaches that one route. The dashboard itself is now a single compact feed with a slim top bar. No app changes.

## [1.3.486] - 2026-10-07

### Fixed
- **Imports and sends that never reached the chain while the balance dropped.** This is a regression since 0.1.626 (100-item bundles and 1–3 MB packages). The broadcaster times out a slow miner. Arcade got at most 8 s (6 s on desktop) for a megabyte package, and once it had failed a round it was moved to the back of the list for the whole session. GorillaPool, Bitails, WhatsOnChain or Taal then reported "success", so the tx was never pinned, the landing watch never started, and the miner outbox dropped the row as finished. Nothing ever followed or re-sent it. On the lab phone, Arcade's acceptance rate across all migrates went from 100% (0.1.618–0.1.622) to 0 of 25 (0.1.634).
  - Every round now ends with Arcade's own answer. Arcade goes back to the front of the list before each post. If a round settles without Arcade's verdict (not asked, timed out or errored), Arcade is asked directly, with a time limit that grows with the package size (20 s plus 40 ms per KB, at most 3 min).
  - A success from another broadcaster without Arcade's acceptance keeps the tx in the outbox, so it is retried until Arcade accepts and the landing watch follows it.
  - Slow miners now get up to 60 s per post instead of 8 s.
  - **Unlock rescue.** Outgoing transactions still unproven after 10 minutes, nobody watching them and not rejected are checked against Arcade and the chain on unlock. That covers stranded imports from affected builds, up to 60 per unlock, oldest first, within 7 days. Ones on chain are marked landed; ones Arcade has queued are watched; ones neither knows of are rebuilt from local storage and re-posted.

### Diagnostics
- Triage counts `withoutArcade`, `arcadeAskedDirectly`, `arcadeRestored`, `rescueUnbuilt` and `rescueRefused` per txid, and the unlock rescue logs `[landing] rescue checked= landed= followed= reposted= … done <N>ms`.

## [1.3.485] - 2026-10-07

### Fixed
- **Import shows progress within seconds.** A run used to read 100 sources and sign ~40-tip bundles before its first item landed, so the count sat at 0 for most of a minute. The first chunks of a run (Browse items and the sweep) now move 5, then 15, then 40 items, then 100 at a time.
- **Custody journal backup stuck on 412.** Cloudflare weakens the ETag of a compressed GET (`W/"…"`), and the host compared `If-Match` against the strong form, so once a push fell back to reading the remote copy every retry failed with `push 412` and the off-device journal stopped growing. The client now sends the strong form back (custody journal and the BRC-39 history probe); BRC-CLOUD also accepts the weak form, which unblocks installed builds.

## [1.3.484] - 2026-10-07

### Diagnostics
- The triage extractor, Jev questions and Jev call moved to `scripts/triage/core.mjs`, which has no Node built-ins; `scripts/triage-logs.mjs` keeps the CLI, the local sources and the printed report. Output is byte-identical (`--state` diffed on the latest Android uploads). The BRC-CLOUD live log dashboard (`/logs-dashboard`, sign in with a wallet identity proof) runs this same core, so every fact added here reaches it on the next cloud deploy. No app changes.

## [1.3.483] - 2026-10-07

### Fixed
- **Import no longer scans twice.** A sweep reuses the HandCash set the preview scan just read, moves from a list synced in the last 30 minutes instead of listing every collectable again, and keeps that list when it pauses so a resume (or an app update mid-import) starts moving at once. Before, every sweep re-fetched the set, re-checked ~1,400 outpoints, re-paged addresses and re-checked 3,700 items on chain — 48–74 s — and a paused sweep deleted the list.
- **Import no longer stalls behind unlock.** Unlock's recompose now holds the payment-blocking region only while it decides about cloud history; its funding pass runs as ordinary chain ingest, which sends and imports run beside. A replaced (restored) wallet stays fenced until reconciled. Background import bundles keep their queue position for up to 10 minutes instead of timing out at 45 s, and the fallback wait no longer waits for chain ingest. The import shows "Waiting for the wallet to finish syncing…" instead of looking stuck.
- **Unlock history push loop.** The push unlock defers re-ran as "unlock", deferred itself again, and never uploaded — re-reading every Toolbox basket each minute. The deferred push now runs, and skips the upload when the cloud copy already matches this wallet.
- **Lighter empty-wallet check.** The history empty/overwrite gates no longer count the `1sat` and `bsv21` baskets (thousands of large rows); the unlock probe stops at the first change output.

## [1.3.482] - 2026-10-07

### Performance
- Activity: while the screen was open, the feed rebuilt its whole projection every 5 s and on every activity, app or asset event. It threw away its write-generation cache each time and handed React a new array, so every row re-rendered even when nothing had changed. A tick now reuses the cached snapshot unless an expiry write or a pending row's age moved it, and an unchanged feed no longer re-renders. App and asset changes still rebuild it. Mount also builds the feed once instead of twice.

### Diagnostics
- The 0.1.632 upload's worst burst (12 freezes, 17.9 s blocked, right after opening Activity during the unlock recompose) had no measured owner. Activity now logs `[activity] feed refresh done <N>ms` and `feed mount done <N>ms`. Recompose's history, chain, balance and relist steps and the post-recompose derived-change pass (journal, recover, echo, full activity-ledger refresh) are named UI phases, so stall lines and triage name the step instead of just `active: recompose`.

## [1.3.481] - 2026-10-07

### Fixed
- Import hang: a sweep reopened while the first was still running started a second sweep of the same items. The second confirm now joins the run in flight and shows its progress. A sweep that stops (the wallet locking mid-run, for instance) now logs why instead of going quiet.
- Before each item bundle, the migrate stepped aside for every spend-priority hold, including other background bundles, and waited with no limit and no log line. It now waits only for payments and permission prompts, for at most two minutes (the spend queue still orders the bundle behind them). It logs what it is waiting on after 5 s and then every 30 s. When the wallet stays busy, the log names which layer holds it and whether the wait ended idle.
- Each sweep step (address reads, the HandCash UTXO set, the saved item list, the 1Sat outpoint check, every item chunk, the token sweep, the closing refresh) logs `[import] still <step> after <N>s` every 30 s while it runs, and the progress bar names the step with counts. The outpoint check stops after three failed index chunks in a row instead of waiting out 40 s per chunk; what is left unchecked is re-read on the next sweep.
- A re-sweep no longer re-reads every cash address an earlier sweep already emptied (89 addresses, about 30 s, on the lab phone).
- The saved item list reopens its database after the WebView closes the connection.

### Performance
- Launch freezes owned by `verified-issuers refresh`: a refetched list identical to the one held re-rendered every collectable and activity row. On top of that, each row built its own issuer resolver, re-parsing the stored identity index and rebuilding the look-alike name map. Unchanged lists no longer bump the generation, and a render pass shares one resolver pair (rebuilt on any identity change, and at least every 30 s for newly mined heights).

## [1.3.480] - 2026-10-07

### Changed
- Activity: the item count in a batch row's top-left corner grows into a pill to fit its digits, stopping just short of the top-right mark. From 1,000 it reads in thousands with a `k` (one decimal below 10k, always rounded down: 1,999 shows `1.9k`). Hovering shows the exact count.

## [1.3.479] - 2026-10-07

### Changed
- Item migrate bundles hand the wallet only the source transactions they spend. Each chunk's input BEEF holds the sources of up to 100 items (about 10 MB when one item carries large art), and every bundle passed all of it to createAction. The Toolbox then parsed and hashed the whole chunk again in argument validation, storage planning and signable-transaction build, and the wallet did the same once more while packing. A mined source now travels with only its own merkle proof, and an unmined source with the ancestry that proves it. A chunk that cannot be scoped is sent whole, as before.
- Triage of the last migrate run (v0.1.628, 12 bundles, 217 items): 6% of bundle time was the miner post. Most of it was Toolbox IndexedDB work (`create_action.storage_plan`, `sign_action.process`), and bundles ran about 4× slower per item while the app was not fully visible. Jev names Toolbox storage as the bottleneck.

### Diagnostics
- `[phrase-sweep] migrate package` logs `in=<N>`, the input BEEF handed to createAction. `[phrase-sweep] migrate … done` splits `pack=<N>ms` (wallet-side BEEF work after signing) out of `sign`.
- Triage computes migrate throughput (tips per minute, phase shares, per-tip time by visibility, package versus posted EF bytes) and asks Jev for the migrate bottleneck. It reads the previous upload when the latest has no bundles.

## [1.3.478] - 2026-10-07

### Changed

- Patch release (every push must ship a new version).

## [1.3.478] - 2026-10-07

### Changed
- Item imports pack more items per transaction. The per-transaction budget used to count every parent transaction an item came from, so a mint that created 100 items charged all 100 artworks to move one. Arcade never receives parent transactions: it validates Extended Format, which is the new transaction plus each input's spent amount and locking script. The budget now counts only that. Parent transactions and BRC-150 history stay on the device and travel off-chain in the inbox envelope; nothing is re-inscribed, and migrate outputs are plain 1-sat P2PKH.

### Diagnostics
- `[phrase-sweep] migrate package` logs `ef=<N>`, the Extended Format bytes posted to Arcade, beside the full package size. Triage reports it.

## [1.3.476] - 2026-10-07

### Fixed
- Imported items no longer disappear from Activity after a restart. A migrate is signed for delayed broadcast and stays `sending` in the wallet's ledger after Arcade accepts it; Activity now counts `sending` as history.
- Importing no longer blocks new payments. Migrate bundles run in a background lane: a bundle never starts while a payment is queued, a payment prompt is open, or within 5 seconds of the last payment (an app's create → sign pair stays together). A payment waits for at most the one bundle already in flight.

### Diagnostics
- `[phrase-sweep] yielded to payments done <N>ms` is counted by triage.

## [1.3.475] - 2026-10-07

### Fixed
- Imports, sends and broadcasts keep their pace while Android has HandCash in the background. Hidden-page work no longer yields through the browser scheduler, which Android bills to a ~1% background CPU budget (one migrate spent 452s signing; 30s heartbeats arrived up to 470s apart).
- The spend watchdog counts only time the app was on screen, so a migrate slowed by the background is no longer abandoned mid-signature.
- An abandoned migrate is never rebuilt over the same items. The import waits for what the original send actually did — records it if it broadcast, retries only if it truly failed, and otherwise stops with the items kept.

### Diagnostics
- Triage tags each import step with page visibility and reports heartbeat cadence while hidden.

## [1.3.474] - 2026-10-07

### Changed
- Collectable import moves items whose source transactions carry their art about four times more per transaction. The crash-safe retry copy of each migrate now keeps the signed transaction and its unmined ancestors in full, and names mined sources by txid; a retry fetches those back with their proofs. The per-transaction source budget only guards the miner post now, so it rises from 256 KB to 1 MB.
- A rebuilt retry package larger than 256 KB no longer replaces the thin queued copy in the shared signed-transaction archive, and local lookups skip a thin archived copy and read storage instead.

### Added
- `[phrase-sweep] migrate <txid> done <N>ms create= sign= post=` log line; triage reports it with the retry body size and busy-wallet waits.

## [1.3.473] - 2026-10-07

### Fixed
- Imported items keep the creator the index named when they were chosen. Each item's signer, app, collection and art now travel with the move into Collect, so HandCash-minted items such as Ageless Republic shelve under their creator immediately, instead of waiting for the indexer to learn about the unmined move.
- Items already imported without a creator are healed. Collect now asks the index about origins that no cached answer covers, 100 per request, once per session, and never replaces an answer it already holds. This is attribution only; authenticity verdicts are unchanged.

## [1.3.472] - 2026-10-06

### Fixed
- Collectable import bundles every tip that shares one large source transaction into a single transaction again, instead of sending one item per transaction.
- A selected import no longer fails or splits its bundle when the wallet is busy (for example, restoring after unlock). It waits for the wallet to go idle and retries the whole bundle. If the wallet stays busy, the import stops with the named reason `busy` and keeps every tip for the next run.
- The import progress bar moves as each transaction lands, not only when a whole chunk answers.
- Import migrates no longer write a "Receiving" row and toast per item. Rows already written are folded into the import record, which also removes the duplicate "Verifying" spinner in Activity.
- Collectables keeps a basket read that finishes after its timeout and relists once the wallet is idle, so imported items appear in inventory.

### Added
- `[collectables] basket read done <N>ms` log line; triage reports activity writes by kind and watches recompose, legacy scan, cloud backup, chain ingest and coordinator tags.

## [1.3.471] - 2026-10-06

### Fixed
- Item migrates and token sweeps check, before signing, that the wallet kept every item as input *i* ahead of its own funding inputs. Sats move first-in, first-out, so a funding input ahead of an item would push the inscription into change. Today's wallet toolbox already keeps that order; this guard refuses to sign, and releases the reserved coins, if a future version changes it.

## [1.3.470] - 2026-10-06

### Fixed
- **Activity no longer goes blank during a large import.** A running import counts as one row of the feed window, so older history still shows below its progress row and the list scrolls.
- **Imports no longer push older history out of Activity.** Imported items are no longer written as one stored row each. The wallet's own transaction record shows them, named and folded under the import. When storage is full, import rows are trimmed before any other history.
- **Collectables fill in as each import transaction lands.** The grid used to wait for a wallet read that the running import blocked. Now all 100 items of a transaction show as soon as that transaction is accepted.

### Changed
- Each import transaction sends miners only itself and the transactions it spends, not every source transaction of the chunk. Bundles are sized to keep that package small, so every package fits the durable retry outbox that resends it after a restart or a miner outage.
- While one chunk signs and broadcasts, the next chunk's source transactions are fetched in the background.
- Log triage reports the size of each migrate package, the background fetch timing, and the size of any package the retry outbox refuses.

## [1.3.469] - 2026-10-06

### Changed
- Collectables move up to 100 per transaction (one import chunk) instead of 25: one fee, one signature pass and one broadcast where there were four.
- Sweep everything reads every BSV address first, then moves all coins together, each signed by its own address key, up to 100 coins per transaction, instead of one sweep per address. One unreadable address no longer stops the cash step.

## [1.3.468] - 2026-10-06

### Fixed
- Sweep everything moves collectables up to 25 per transaction across addresses instead of one transaction per address (HandCash exports hold one item per address, so every item was its own transaction).

### Changed
- Removed the per-address item batch path and its resume cursor logic; the sweep and Collect share one bundled migrate.
- Log triage extracts phrase-sweep batch size, bundle rejects, abort refusals and unreadable tips, plus a per-tag line census.

## [1.3.467] - 2026-10-06

### Changed

- **BSV from an imported or legacy address moves in one transaction instead of one per coin.** Sweeping a wallet with many small coins now packs up to 100 into each transaction: one fee, one broadcast, and the balance lands together. If the network refuses a bundle, the wallet splits it in half and retries until the one bad coin is found, so the rest still move and the failure names the exact coin.

## [1.3.466] - 2026-10-06

### Fixed

- **Imports no longer leave a "Migrate 25 ordinals from phrase" row per transaction in Activity.** Each import transaction now writes its Activity rows the moment it broadcasts, so the import shows as one row with a bar while it runs and one "Imported …" record when it ends. Imports from older versions, and imports whose rows were trimmed to save space, fold the same way: every migrate of one run becomes one record.
- **Sweep everything is one Activity row too.** A sweep of a saved wallet shows a single row with a bar (a loading strip while the count is unknown) and its collectables fold into one record; a sweep that runs out of BSV or is stopped shows as paused.

## [1.3.465] - 2026-10-06

### Changed

- **Imports and balance heals are one Activity row each.** While a run moves, Activity shows a single row with its icon, a progress bar against the run's total ("12 / 40", or a percentage for a heal) and what it is doing; when the total is not known yet the bar runs as a loading strip. Clicking it opens Import or Wallet health. When the run ends, every item it imported (across all its transactions) folds into one record, e.g. "Imported 40 Pixel Foxes".
- **The bottom action bar leaves as soon as you confirm an import.** The run's progress, a bar and Stop sit in a banner at the top of Browse items instead of a gray dock.
- **Import Director has icons** for every source — HandCash, recovery phrase, Twetch, Yours and private key — in both your saved wallets and "Add a wallet".
- **Sound effects are on by default.** Turning them off in Settings still sticks.
- Developer keys use a key icon. Asking for a second key for the same profile now explains why: an identity signs with one key at a time, so give another server the existing key's config, or rotate the identity key to issue a new one.

### Fixed

- **Items you imported and then burned or sent no longer come back under Import.** The list forgot what had already left whenever it was swept or rebuilt, and the public index can lag a broadcast by minutes. Gone items are now remembered for good, and listed items are rechecked against the chain after each scan (and every ten minutes) so anything already spent drops off.

## [1.3.464] - 2026-10-06

### Changed

- **Importing items now runs in the background.** Choosing items in Import → Browse items hands them to the wallet's import queue, and the page stays usable: you can keep selecting and queue more while a batch moves, and leaving the page (or opening another saved wallet) no longer stops the import. Items already queued show "Importing…" or "Queued"; everything else stays clickable. Progress shows on the status pill, and Stop drops what has not started yet.
- **Imports are faster.** Items from every key of a saved wallet now share transactions (up to 25 each) instead of one batch per address, source transactions are read four at a time while the next batch is prepared, and the next batch's sources are fetched while the current one signs.

### Fixed

- An import no longer splits down to one item per transaction when the wallet's fee coin was spent elsewhere. It rebuilds the same batch once, then waits a few seconds for the coin to clear and carries on. A spent coin that had more than one storage row is now hidden everywhere, so it is not chosen again.

## [1.3.463] - 2026-10-06

### Fixed
- Collect and Import: the shelf face pile is now a compact overlapping deck of rounded cards (up to four, about 84px), so shelf names are no longer cut off. Each card holds its art whole on a solid tile; the "+N" counter is gone since the item count already sits under the name.

## [1.3.462] - 2026-10-06

### Changed

- **Collect now shows the same creator identity as Import.** Items minted by the HandCash cloud are signed by their creator's identity for that app, but Collect only recognized this wallet's own issuer stamp, so those items fell onto plain app or collection shelves. Collect now shelves them by that signer, labelled with the app and showing the same signer fingerprint you see in Import → Browse items. When the item's origin transaction is on this device, the signature is checked against it. Otherwise the shelf says the signer is as the index reports it. Items already on the device pick up their signer in the background, 100 per index request, once per session.

## [1.3.461] - 2026-10-06

### Changed

- **Item and token art has rounded corners again, as squares, never circles.** In Activity and Collect, the rounding now sits on the artwork itself, so a tall or wide piece keeps its rounded corners and is still shown whole, never cropped. Token icons and shelf face piles are rounded squares instead of circles. Borders stay off. Small pixel art scales up to fill its square.

## [1.3.460] - 2026-10-06

### Changed

- **Importing chosen items is much faster.** When you select items in Import → Browse items, they now move together, up to 25 in each transaction, instead of one transaction per item. Their source transactions are fetched in parallel, and the saved list and scan counts are updated once per batch. A selection of hundreds now takes a handful of transactions. Progress and Stop update between batches of 100. If the wallet runs out of BSV for fees, the items it could not fund stay selected so you can try again after adding funds.

## [1.3.459] - 2026-10-06

### Changed

- **Item and token art is shown whole, without frames.** In Activity and Collect (cards, list rows, the token strip, shelf face piles, and the item and payment details), artwork no longer sits in a rounded, bordered tile and is no longer cropped to a square. A tall or wide piece now fits inside its space with nothing cut off. Token icons are no longer clipped to circles. Activity rows without art (payments, events) keep their usual tile.

## [1.3.458] - 2026-10-06

### Changed

- **Browse items keeps its list.** The items a saved wallet holds are now saved on this device as they are found and read back a page at a time, instead of being held in memory and lost on close. Closing the browser, or the app, keeps everything found so far; the next visit paints the saved list at once and asks the 1Sat index only about outputs it has never checked. An item stays listed as long as the source still holds it, and leaves when it moves, is spent, or the saved wallet is removed.
- **Browse items looks like Collect.** Items sit on the same shelves, with the same face pile, grid/list toggle (shared with Collect), search, and cards. Each card has **Import** and a select box; select single items or a whole shelf, then **Import (N)** from the action bar. Several items ask once, then move one transaction each, stopping at the first "add BSV" answer or when you press Stop.
- **Shelved by the identity that minted them.** HandCash signed every item it minted with the creator's identity for that app (a Sigma signature on the mint). Where the 1Sat index reports that signer, items from the same creator share a shelf with an identicon of the signing address, marked as the index's claim rather than verified. Otherwise items shelve by app, then by collection, then under "No issuer".
- **Fewer lag spikes after unlock.** Opening the vault's other accounts in the background now waits until the wallet has been idle for a while (15 s, 30 s on phones) instead of starting 5 s after unlock, so it no longer competes with the startup sync or a send. The item check also no longer keeps a second in-memory copy of every item it reads.

## [1.3.457] - 2026-10-06

### Added

- **MNEE now imports from a HandCash export.** MNEE (the USD stablecoin) is a BSV-21 token that needs MNEE's own cosignature to move, so it used to stay behind as "rejected". Import now reads your MNEE balance from MNEE's index, signs one transfer per batch with your HandCash key, and hands it to MNEE's cosigner, which adds its signature and broadcasts. The cosigner's usual fee is paid in MNEE (0.001 MNEE up to 10 MNEE, 0.01 above); no BSV is spent.
  - The wallet checks that the transaction MNEE broadcasts spends exactly your MNEE and pays exactly the amounts you signed before it files anything.
  - Received MNEE shows in **Collect** for now, as a card named by its amount (for example "4.999 MNEE"). Sending MNEE from this wallet is not supported yet, so it stays there until it is.
  - MNEE held by another key, or cosigned by anyone other than MNEE's published cosigner, stays at the source.

### Changed

- Shorter import screens: Browse items drops the "each import is its own transaction…" note and the search label, and the import preview no longer says "(valid outputs only)" or "paid by this wallet".

## [1.3.456] - 2026-10-06

### Fixed

- **Fewer lag spikes after a refresh, especially with lots of items.** After every refresh the wallet re-read and re-parsed up to 2,000 item scripts in one go, checking whether any were tokens filed in the wrong place. The screen could not respond until it finished, and importing items made the pass bigger each time. Each item is now checked once; later refreshes skip items already checked, and the check gives the screen a turn every few milliseconds.
- **Importing one item no longer fails with "no provider had raw transaction" when only one host is missing it.** If Bitails had not indexed a transaction yet, the wallet stopped asking and never tried JungleBus or WhatsOnChain. Each host now answers for itself.
- While Browse items is still finding items, each new batch no longer re-renders every card on screen, and scrolling pauses background item work the same way Collect does.

### Changed

- Diagnostics: every named wallet step that runs a quarter second or longer now logs how long it took, and the post-refresh steps (token list, misfiled-item checks, collection list, balance read) are named. The support log can now say which step froze the screen.

## [1.3.455] - 2026-10-06

### Fixed

- **Scanning or browsing a HandCash export no longer freezes the phone.** Checking HandCash's list against your keys held the screen for up to 42 seconds at a time on Android (167 seconds in all on one run).
  - Addresses the last scan already derived from your keys are reused instead of derived again; on a 2,000-address account that was most of a minute of work on every rescan and every item list.
  - Anything that still has to be derived now gives the screen a turn every few milliseconds instead of every 25 keys.
- Leaving the item browser stops its search. Opening it twice no longer runs two searches side by side.

### Changed

- **Browse items now looks like Collect.** Items use the same cards as your own collection (picture, name, and an **Import** button where Send would be), in the same grid, with the same loading placeholders.
- **Items appear as they are found.** The grid fills batch by batch instead of waiting for every item to be checked, and you can import an item while the rest are still loading.
- Long lists only draw the cards on screen, like Collect, so thousands of items scroll smoothly; "Show more" is gone.

## [1.3.454] - 2026-10-06

### Added

- **Browse a saved wallet's items and import them one at a time.** Settings → Import → a saved wallet → **Browse items** shows every item it holds as a grid with its picture and name, a search box, and an **Import** button on each.
  - Each import is its own transaction, paid by this wallet, on the same item path the full import uses (BRC-150 remittance kept).
  - An imported item leaves the list and the wallet's item count. A failure says why (not enough BSV, the item was rejected) and leaves the item there to try again.
  - Items that turn out not to be collectables (a token, for example) say so and stay at the source.
  - For a HandCash export the list comes from the scan you just ran, so it opens instantly; otherwise it is read from the 1Sat index.
  - Names and pictures come from the 1Sat index and are shown as-is; the import still checks each item against its own transaction.

### Changed

- **The saved wallet view is simpler.** The HandCash handle section, the key details, the "Find an address" tool, and the list of every used address are gone. What's left: totals, **Browse items**, **Import all…** (previously "Sweep compatible…"), **Rescan**, and **Remove this wallet**.
- The HandCash handle field is gone from the add-a-wallet form.
- "Sign in to HandCash" only appears when the HandCash account service could not be used for the scan.

## [1.3.453] - 2026-10-06

### Changed

- **Scanning a HandCash export no longer crawls through "Reading holdings".** HandCash's list already names every coin, so the app now checks those coins on chain directly, a hundred per request (a Teranode node first, then WhatsOnChain), instead of making three slow lookups per address. An account with 89 cash addresses goes from minutes of one-at-a-time progress to a request or two.
  - An address is still read in full only when it holds tokens, an inscription worth more than 1 sat, or a coin neither source could answer for.
  - Progress shows "Checking your coins on chain" for this step.
- Checking HandCash's list against your keys no longer freezes the screen on large accounts (it took 11 seconds on a phone for 2,181 addresses); it now yields to the UI as it goes.

### Fixed

- The HandCash account service now returns large accounts in full and quickly. An item's record holds its whole inscription, so only the part that pays your address is sent, and the second page of a big account no longer times out.

## [1.3.452] - 2026-10-06

### Added

- **A saved HandCash export now reads straight from your HandCash account.** Scanning a HandCash export asks HandCash which coins and items the account holds, instead of checking thousands of addresses. No sign-in needed: the export's own keys are the proof.
  - **Signed by your keys.** The request is signed by keys from the export and covers every detail of the request. A request changed in transit is refused.
  - **Encrypted to this request.** The answer comes back encrypted to a one-time key the app makes for that request and never shares, the same kind of protection History backup uses. Nobody else can read your list of coins: not a proxy, not a log, not someone replaying the request.
  - **Checked on chain.** Each coin counts only if your keys derive the address HandCash names. Cash is then read from the chain, and items are checked one by one against the 1Sat index. HandCash's list decides where to look, never what you own.
  - If HandCash doesn't know the keys or can't be reached, the scan falls back to Sign in to HandCash, then the full address check, as before.
- After a scan read this way, the export says "from your HandCash account, checked on chain" and no longer offers Sign in to HandCash.

## [1.3.451] - 2026-10-06

### Changed

- **Signing in to HandCash makes the scan read only what you still own.** A large account used to download its whole transaction history (up to 10,000 transactions, about 500 requests) and then often throw that work away and check every address anyway. Now:
  - **Items** are found straight from the item list HandCash sends: the 1Sat index is asked where each item is now, a hundred at a time. An item the index no longer knows (burned, or never indexed) is skipped instead of failing the other 99 in its batch.
  - **Coins** come from the newest 500 transactions first, then 2,500, then the rest, stopping as soon as the chain shows your HandCash balance and items.
  - **Only addresses that may still hold something are read.** If a later transaction spent everything an address received, it isn't checked again. An address already read is never read twice in one scan, including when the full address check has to run after all.
- The scan's progress now says "Locating your items" and "Finding your coins in recent history". "Rescan with it" names how many items and transactions arrived.

## [1.3.450] - 2026-10-06

### Added

- **Sign in to HandCash works on the phone too.** A saved HandCash export on Android now has the same button. It opens the HandCash key recovery page in Chrome. Once you sign in, the page sends your history to the HandCash app over its own local bridge, the app comes back to the front, and the export rescans from the addresses you've used. The phone has to be unlocked; if the app is locked, the page says so.

## [1.3.449] - 2026-10-06

### Added

- **Faster HandCash scans from Settings → Import.** A saved HandCash export has a new **Sign in to HandCash** button. It opens the HandCash key recovery page in your browser. Once you sign in, the page sends your HandCash transaction list, balance and item count to Desktop, and the export rescans by reading the addresses you've used instead of checking thousands. As before, the result is kept only if the chain shows everything HandCash reports; otherwise the full address check runs. Nothing moves, and your keys never leave this computer.
- While it waits, the export shows "Waiting for your HandCash history" with buttons to reopen the page or cancel. History that arrives after the last scan shows **Rescan with it**. If you sign in as a different handle than the one the keys prove, it names both and asks you to sign in as the right one.
- Desktop only for now. The browser can't reach the phone app the way it reaches Desktop's local bridge.

### Changed

- Key recovery opened from the HandCash page while a HandCash export is already on screen now stays on that export instead of starting a new form.

## [1.3.448] - 2026-10-06

### Fixed

- **A sub-account's published identity now shows on your other accounts.** Identity cards were shared only with contacts, and each account keeps its own contact list. A sub-account that hadn't added your main account as a friend never answered its card request and never sent its card unasked, so the main account showed that contact with no identity. Accounts of the same vault now count as contacts for card exchange. On the same device, the main account reads the sub-account's presented identity directly, with no card needed.

### Added

- Every identity-card step is logged: sent, not delivered, asked, could not ask, request ignored because the sender isn't a contact, asked when this account presents no identity, kept, and refused with the reason.
- Triage: an **Identity cards** section that lists each peer key's counts and the last step its card reached.

## [1.3.447] - 2026-10-06

### Added

- **Custody journal: the wallet can no longer forget how to spend a coin.** Change and BRC-29 receipts are locked by a random derivation the seed cannot regenerate, and basket outputs need their basket. That knowledge lived only in the wallet database, which a wipe, a restore from an older backup, or a lost device replaces wholesale. Every output the wallet learns is now also written to a journal that only grows. Each entry is exactly the `internalizeAction` instruction that brings that output back. Entries are never edited or removed. A spend is recorded only when the chain shows one, and two copies always merge into their union, so no copy can overwrite another or be "thinner" than it.
- The journal is written inside the wallet's own `createAction`, `signAction` and `internalizeAction` before each returns, so your own sends are journaled before they are broadcast. A full sweep also runs before any wipe or History replace. It survives a factory wipe.
- **It is backed up beside your History backup** as `custody.journal`, encrypted with a key derived from your account key (no password). It syncs within seconds of growing, with conditional writes so two devices never overwrite each other. The server accepts it only from requests signed by your identity.
- **After every unlock, restore or Pair Sync,** the wallet merges the backed-up journal in, asks the chain about every journaled output it has no record of, and restores each one that is still unspent. Settings → Heal does the same. Outputs the database already holds are never touched, so an output reserved by an unbroadcast send can't be spent twice. An item you relinquished stays relinquished, but money always comes back.
- Item recipes keep what's needed to restore the item and drop the BRC-150 proof, which is rebuilt from chain on demand. The SDK refuses anything longer anyway.
- Triage: a **Custody journal** section with captures, refused writes, write-ahead failures, backup syncs and recovery results.

### Changed

- The derived-change echo now feeds the journal, and its recovery entry points run journal recovery, so there's one recovery path.

## [1.3.446] - 2026-10-05

### Fixed

- **Mobile kept losing token icons, contact IDs and publisher info on every cold start.** The wallet core decided where to store data before the Android shell had installed its file store. It then wrote the whole session to WebView storage, and on the next launch the shell deleted every WebView value over 64KB. That included the token list, the icon cache, retained token deploys, and issuer and contact identity packages. The core now waits until a shell bridge answers before choosing a store. Reads made before then are forgotten, and writes made before then are handed to the shell. `[durable] shell store attached after N early read(s)` shows in a support upload when this happens. Mobile 0.1.604 installs its bridge first and recovers the last session's data once.
- **BRC-162 tokens show their real name and icon.** Binary deploys were never decoded for the token list, so a received token could show `00f654…aa_0` for good. The name, decimals and icon pointer now come from the retained deploy, or from the deploy body fetched by txid. A deploy that can't be found is asked for again after 10 minutes, not on every pass.
- **Retained deploys of tokens you hold are kept.** The deploy store dropped its oldest entries first once it passed 1MB, whether or not you still held the token. Deploys of held tokens now give way only above 4MB. `[bsv21] deploy store evicted N deploy(s), M held` logs every eviction.
- **Lineage heal works on the tokens that need it.** Each pass spent its four proofs re-proving tips that were already bound. It now skips tokens a walk cannot improve (unsigned mints, attested tokens), so tokens missing their deploy get proven.
- Triage: per-launch token-card timeline (`holdings.tokens.byLaunch`), plus late shell attach, one-time recovery and deploy eviction facts under `storage`.

## [1.3.445] - 2026-10-05

### Changed

- **HandCash key recovery in seconds, not minutes.** When you're signed in on the HandCash migrate page, **Open key recovery in Desktop** also sends your HandCash transaction list, BSV balance and item list. Your keys never go through the page. When you paste the export, Desktop first reads your own transactions (20 per WhatsOnChain request) and matches the HandCash key paths against the addresses in them on your computer. Before, it asked the network about thousands of addresses one batch at a time.
- That faster result is kept only if HandCash's whole history was read, and the chain shows at least the balance and the number of items your HandCash account reports. Otherwise Desktop checks every address, as before. Hints never decide what you own: every coin and item shown is read from the chain. Hints for one handle are ignored for keys whose HandCash handle is different, and they expire after 6 hours.
- The scan shows **Reading your HandCash history · N/M transactions**. A saved wallet found this way reads **matched to your HandCash balance**.
- `openKeyRecovery` (HandCash hosts only) takes optional `{ hints }` and returns `hints: 'accepted' | 'none'`. Mirrored in items-market `docs/migrate-brc100.md`.
- Log lines `[import] hinted history done …`, `[import] hinted scan settled …` and `[import] hinted scan refused reason=…` show in a support upload which path a scan took.

## [1.3.444] - 2026-10-05

### Fixed

- **Contacts forgetting their published identity, and tokens losing their verified-issuer badge.** The device kept identity packages for only 8 people or issuers. Each new one deleted the one it had held longest, and the people you deal with most were usually the oldest. Contacts' identity cards and the issuer badge on tokens and items both read those packages, so they went blank as soon as a ninth identity arrived. Now a package is kept for as long as a contact presents it or a token or item you hold names it, on every account. The limit of 8 applies only to identities nothing on the device refers to.
- A contact whose identity was already lost asks for its card again from the contacts list, not only when you open it. A token or item badge lost before this release comes back the next time that issuer's package is delivered.
- The identity store logs `[identity] evicted N identity package(s)` when it removes one, so a support upload shows it.

## [1.3.443] - 2026-10-05

### Changed

- **Developer keys, redesigned.** Settings → Connected apps → Developer keys now opens on a summary showing how many keys you have, how many hold a server wallet, and how much your servers hold in total. Each key is a card showing what it can do (**Signs as …**, **Wallet**, **Signing retired**), its short public key (click to copy) and the date it was created.
- A server wallet shows its balance (in your currency and in BSV), items and tokens side by side. One status line says where the wallet is stored, what is on its way to or back from the server, or that its storage host can't be reached. A wallet whose host is unreachable shows dashes and an amber border, not a loading skeleton that never ends.
- Fund opens inline in the card, with an amount field, 1,000 / 10,000 / 100,000 sat presets and a preview of what it costs in your currency. Fund is the main action on a wallet key. Copy server config and Recover come after it, then Refresh. Remove appears only for a key that no longer signs and whose wallet is empty.

## [1.3.442] - 2026-10-05

### Fixed

- **"Backup failed" while the backup host was down.** The history backup host had used up its daily database write quota, and every signed request — backup checks, uploads and messagebox polls — returned an error. The host is fixed separately: backup checks and inbox polls no longer write to its database. Your backups were never lost. Existing backups stayed stored and readable the whole time.
- One check for every caller. Every check for whether a history backup exists goes through a single request: callers that ask at the same time share one request. When the host returns a server error or rate limit, or can't be reached, every caller waits for the host's `Retry-After` or a backoff from 30 s up to 15 min, instead of asking again. A failed upload sets the same wait.
- A host outage now reads **Backup delayed** (amber) and says when it will retry. **Backup failed** (red) is kept for a backup the host actually rejected, such as a bad signature or the wrong identity.

### Changed

- Log triage keeps HTTP status codes such as `(500)` and `(429: rate-limit)` in error families instead of collapsing them to `<n>`.

## [1.3.441] - 2026-10-05

### Changed

- The in-app browser is back on Desktop by default. Labs no longer gates it there, and the Labs row for it appears only on Mobile.
- Mobile now uses the same in-app browser as Desktop, with the same panel, tabs, toolbar and tab previews. The shell draws each tab with a native WebView laid over the panel instead of opening a separate browser screen. As on Desktop and in Chrome, the page reaches the wallet over the local bridge. The page gets no wallet interface. It is moved off screen whenever wallet UI covers the panel, and always while a permission prompt is open, so it can never sit on top of an approval. On Mobile it stays behind Settings → Labs → In-app browser, off by default, until it has been proven on phones.

### Removed

- Desktop's unused standalone app window (`openAppBrowser`). Connected apps open in a tab or in the system browser.

## [1.3.440] - 2026-10-05

### Added

- **Settings → Labs** holds experimental features. Each one is off until you turn it on on this device, and wiping the wallet turns them all off again.

### Changed

- The in-app browser is now a Labs feature and is off by default. With it off, apps open in your system browser on Desktop, and the "Open in HandCash" action and the Apps browser button are hidden. Turning it off closes any open in-app tabs. On Mobile the in-app browser is how web apps reach the wallet, so app connections on a phone need Labs → In-app browser turned on.

### Security

- Shipped builds no longer treat pages on `localhost` as HandCash sites for migrate, handle claim or market listing. Any program on the computer can serve `localhost`, so it could have posed as HandCash and used those methods. Development builds still trust it, and Labs → Local HandCash hosts turns it back on for local testing.

## [1.3.439] - 2026-10-05

### Added

- The HandCash migrate page now leads to key recovery. A new HandCash-only bridge method, `openKeyRecovery`, brings Desktop forward on Settings → Import with the HandCash export form already chosen, ready for the user to paste the two keys. It reads nothing and moves nothing. If a scan, a sweep or a half-typed secret is in progress, the form waits until that screen is idle. The cloud's automatic migrate is no longer part of the web flow.

## [1.3.438] - 2026-10-05

### Added

- **Settings → Import** keeps your old wallets in one place, separate from your BRC-100 identity. An imported wallet never signs for apps and never appears in the account switcher. Supported sources, HandCash first:
  - **HandCash export (the two `xprv` keys from the recovery tool).** The spending key is the product of the two shares at each path. The wallet scans `m/0` to `m/9` with HandCash's 1000-address gap, and checks the items root `m/9` against the ordinals index, because minted items never appear in address history.
  - **Recovery phrase**, checked against the common BSV, BTC, BCH, HandCash v1, Yours, 1Sat, Electrum and bare-branch layouts.
  - **Twetch phrase**, with its identity address shown as a read-only identity.
  - **Yours backup** (file or JSON) and **private keys (WIF)**.
- Secrets are stored encrypted with AES-GCM under a key derived from this account, so they stay readable only by this account on this device.
- The scan finds used addresses with a gap walk. A failed lookup marks the scan incomplete instead of ending the walk early. It reports cash, items and tokens per address, with a reason for each holding the wallet cannot take: listed, cosigned (MNEE), RUN jig, covenant, BSV-20 v1, pending or invalid token, uncompressed key, or dust.
- **Sweep never runs on its own.** "Sweep compatible…" first shows exactly what will move and what it will cost, then asks you to confirm. Only three kinds of asset move: plain cash, 1-sat collectables, and BSV-21 tokens that the indexer marks valid and unlisted, whose on-chain script carries the same token id and amount and is locked to that key alone. Each token's tips merge into one output at their exact total. Everything else stays where it is, and the sweep can be paused.
- HandCash imports can check a `$handle`. The wallet compares the handle's published key with keys derived from the export, then links to the claim page to bind the same handle.

### Changed

- The Items page lists items from unknown publishers, and tokens without an issuer, after everything else.
- The Import section replaces the old "Import phrase" panel. If an item import was paused there, add that wallet in Import and sweep it again to resume, or forget the paused import.

## [1.3.437] - 2026-10-05

### Fixed

- Importing from another wallet no longer destroys assets the wallet cannot hold. The item import moved every one-sat output on the source address into a plain collectable output. For a BSV-20 or BSV-21 token, that is a burn. The cash sweep treated any output above the fee floor as money, including a RUN jig, which looks like a plain payment but is destroyed by any spend outside RUN. Imports now move only what this wallet holds natively:
  - plain P2PKH cash that no RUN marker in its transaction claims;
  - 1-sat collectables whose script is the key's P2PKH with an inscription and optional `OP_RETURN` data.
- Tokens, RUN jigs and contracts that merely contain the key (Sigils, STAS) stay on the source address, refused by name and never marked imported. The same check guards the wallet's own legacy-address deposits.

## [1.3.436] - 2026-10-05

### Fixed

- Token tips no longer show "encoding unverified" when the wallet database stored the output without its locking script. BRC-162 puts the token fields in the on-chain locking script, and BRC-163 admits a tip only if that script parses. Some rows had only the remittance claim, so the wallet could not prove the encoding. The wallet now reads the script from the transaction itself. It uses the local copy when there is one. Otherwise it fetches from the chain in the background, at most 20 per pass and once per output per session. It accepts the body only if it hashes to the tip's txid and the output carries a valid 162 lock. The script is then written back to the row, so the next listing proves it from storage. Unconfirmed chained token sends were never affected.

### Changed

- Triage traces each dead payment: what it lost to and the wallet lines just before and after it. It also compacts its facts step by step when they are too large for Jev, so the verdict no longer fails on busy uploads.

## [1.3.435] - 2026-10-04

### Fixed

- The History backup no longer grows without bound. Each confirmed transaction kept a pending-proof record with a full copy of the transaction and every input it spent, long after its proof was stored. On a busy wallet those records were 29 MB of a 40 MB backup, and they filled the phone's database too. Before each backup, the wallet now deletes a record once it is three days old and its proof is safely stored. The server version of the wallet library already does this, but the version the app uses never did. The proof keeps everything needed to show or spend the transaction, and triage logs how much each cleanup freed.

## [1.3.434] - 2026-10-04

### Changed

- Triage now reports where Mobile keeps wallet state. Mobile 0.1.592 moves it out of WebView storage, which is capped at about 5 MB, into app files. Triage shows how many keys moved on first launch and how much WebView storage that freed. It also flags a build still running without the file store.
- Storage comments now treat WebView-only storage as a fallback for builds without a file store, not as how Mobile works.

## [1.3.433] - 2026-10-04

### Fixed

- A token send can no longer hang on "Waiting to send token" while holding up every send queued behind it. Before signing, a send clears reservations, resolves the recipient, loads its tip and parent transactions, and checks the token's ancestry. All of that now shares one 45-second deadline. A step that runs past it fails the send with the step's name ("Token send stalled while loading the tip transactions — nothing was signed"). Nothing is reserved at that point, so the next send starts right away. Before, a wait during that work held the spend lock until the 4-minute region ceiling, and on Android the app was killed first.
- Chain ingest no longer drops the pending record of a send this session is still preparing. A token send can take a minute to reach its txid, and the old 5-second cutoff treated it as interrupted.

### Changed

- Each pre-sign step that takes over 250 ms logs `[bsv21] pre-sign <step> done <N>ms`. The wait for the spend lock and the change-promote step log too, and triage traces a planned send that never signed or failed up to the end of the upload.

## [1.3.432] - 2026-10-04

### Fixed

- Listing a freshly minted item no longer fails with "Payment was signed but does not verify — nothing was sent". This device's script engine checked already-verified ancestors at block height 0, which applies pre-Genesis rules. Under those rules the MAP metadata after a Mint Studio item's P2PKH (an executed `OP_RETURN`), or any inscription over 10 KB, fails. Those ancestors are now checked at a recent height under today's rules.
- The market index accepts an item whose lock carries `OP_RETURN` MAP metadata after its P2PKH, instead of refusing the listing with `invalid-previous-item-tip`.
- A listing that no miner ever took is retired instead of being offered for Cancel. Cancelling one used to fail with "inputs[0] … appears to have been spent". The item stays in your wallet and can be listed again, and triage counts these listings.

## [1.3.431] - 2026-10-04

### Fixed

- A token send or burn no longer fails with "The inputBEEF parameter must be valid Beef when factoring options.trustSelf". The token-ancestry fill pulled the funding parent of the spent tip into the package. When that parent was unconfirmed change, it arrived with none of its own parents, and the Toolbox refuses the whole package if any body cannot reach a proof. The send now folds in the unconfirmed parents this wallet signed. It then drops whatever still cannot reach a proof, and the Toolbox reads those inputs from storage. If a chain tracker still refuses a proof root, the send signs once more from storage-held tips and logs it.
- A send whose tip was claimed from its transaction, but listed without its BRC-162 lock, reads the lock from the transaction this wallet signed. A claimed 800-unit tip no longer ends "Need 500 units; only 0 available".
- Each token tip shown from remittance metadata alone logs its listed script state once. Triage counts those states, counts `inputBEEF` framing, and traces every planned send that failed before it had a txid.

## [1.3.430] - 2026-10-04

### Fixed

- Two different tokens that share an issuer and ticker no longer merge into one card. A card's balance is now always one token id's tips, which is all a transfer can spend. A merged card could show a total that Send could not move, and history that mixed both tokens. Merged cards cached by earlier builds split into one card per token id when they load. The Deploys chip and the Deploy ID rows are gone from token details.

## [1.3.429] - 2026-10-04

### Fixed

- A token received from another account on this device no longer vanishes from Activity and token history. The payee's redundant re-post of a landed transfer failed local SPV, and that local refusal marked the transaction dead for every account on the device. Local SPV now keeps any transaction Arcade already accepted or the chain already holds, and only an Arcade hard reject marks a transaction dead. A transaction reported landed outranks an older dead mark, which heals transfers already hidden this way.
- A token card that shows a tip with no storage row (a send whose write was dropped before 1.3.428) files that tip for a chain-proven claim. A send that cannot cover its amount from the basket claims those tips first, so a token that showed 800 but sent "listed 0, recovered 0" spends again.
- Triage counts unstored and failed-send holdings filings, and local SPV verdicts the network disputes.

## [1.3.428] - 2026-10-04

### Fixed

- A token, item or burn sent once could not be spent again — on the sender
  (its change) or, after their own first send, on the receiver. Toolbox 2.13
  stages a `noSend` action with ≤ 8 inputs in an in-memory action batch that
  reaches storage only through `sendWith`; every signed send then called
  `actionBatch.abort()`, which discarded the signed action, its token change,
  its BSV change and the spent marks on its inputs, while the transaction was
  still broadcast. The session wallet now runs the Toolbox in `legacy` batch
  mode, so each signed `noSend` action is written as a `nosend` row the Arcade
  pin seals, and the post-sign aborts are gone.
- The token and item change of a send storage never recorded is filed with the
  holdings reconcile, which proves it unspent and claims it from the
  transaction — at the Arcade pin, and from the signed-cheque archive when
  Settings → Wallet health heal runs. BSV change of those sends cannot be
  re-derived: its key lived only in the discarded batch.

### Added

- Triage reports `broadcast.unstoredSends`: sends pinned after broadcast with
  no local transaction row.

## [1.3.427] - 2026-10-04

### Changed

- **Each token card logs what its balance is made of.** A card can show more than its history explains. The REF card showed a balance while a REF send found no spendable tips. A card adds up three kinds of tip: BRC-162 value locks, which send can spend; legacy JSON tips, which are read-only; and remittance rows, plain scripts whose amount comes from row metadata alone. The wallet now logs one `[bsv21] ledger` line per token whenever it changes. The line gives the total, the split by kind, the largest tips, and the token's Activity received minus sent. `npm run triage` reports each card beside its history and what the history does not cover, and Jev judges whether the excess is metadata claims, read-only legacy tips, or real tips that arrived without an Activity row.
- The collectable seed tests stub the background lineage walk, so it can no longer log while the test worker shuts down. That race failed the 1.3.426 Linux release run once.

## [1.3.426] - 2026-10-04

### Fixed

- **Token burns keep exact change and are checked before they leave the wallet.** The burn read the typed amount as a JavaScript number, so change above 2^53 was locked to the wrong unit count. Amounts are bigint end to end now. The signed transaction must send every token output back to this wallet for exactly the planned change, or the action is aborted before broadcast.
- **Binary token burns run on the burn chart.** A BRC-162 burn skipped tip classification and `burnMachine`, so a cosigned or unknown lock failed only at signing. It now plans once, refuses with a named reason (`cosigner_required`, `mixed_tips`, `unknown_lock`) before anything is reserved, and runs build → sign → broadcast → internalize → refresh on the same chart as item burns. Token send obeys `bsv21SendMachine` at runtime instead of only in the compose panel, and a cosigned tip is named as one rather than as an unknown lock.
- **A funding coin that is already dead is never chosen twice.** Rebuilding over dead funding now remembers every coin it retired and stops if the toolbox picks one of them again. Hiding those coins also matches rows linked only by transaction id, and warns when a row cannot be found.
- **Failed sends give their items back.** A send already marked failed, or forced dead with no row left, now releases the items it had hidden. A send that completed keeps them hidden.
- **A received item can no longer vanish from the list.** A repaint rebuilt the list from the last basket read alone and could drop a receipt shown before the first read. Receipts stay until the basket confirms them. An empty basket read must hold for 30 seconds before items or tokens are cleared, so one slow read never blanks the inventory.
- **Holdings reconcile waits for the wallet to be idle.** A claim no longer competes with a send in progress. It is deferred and retried, and a fresh departure brings the next pass forward. A restored token row stays reserved while one of the wallet's own unsent transactions still spends it.
- **Token imports need proof.** Imported bytes must match the token id and amount, and recovering a token from a transaction id requires the BRC-176 walk to its deploy. Ownership checks read the script opcode by opcode, so a P2PKH template inside push data or a listing contract no longer counts as owned.
- **Market list splits use the signed-send lifecycle.** Once the split is signed it is registered for miner retry and BUMP finality. It is never aborted.
- **Sending a token to yourself no longer detaches change.** When your own send comes back through the box, the token is accepted from the basket instead of being internalized a second time.
- **Bulk item sends notify the recipient in linear time.** Local unconfirmed ancestry is merged into the package once per batch, not once per item. With no item cap, the old way cost n² merges.
- **Tokens minted before Sigma issuance are labelled correctly.** A deploy whose only issuer claim is this wallet's remittance shows as remittance-only instead of "unsigned".

### Changed

- Triage reports tokens held but missing from the card list, and dead funding coins found and rebuilt around.

## [1.3.425] - 2026-10-04

### Fixed

- **Bulk send and bulk burn take any number of items in one transaction.** The old five-item ceiling (25 per run) measured how `Transaction.sign()` works in this SDK, not the cost of signing. It deep-copies the whole transaction graph, inscriptions included, once for every input, so a send of n items cost n² copies in a single task. Item, burn and token tips are now signed one template at a time on the live transaction (`signTipInputs`), with byte-identical output, and the UI gets a turn between inputs. The send's preparation loop yields per item. Burn fetches its source transactions four at a time instead of all at once. The Activity rows of a bulk send or burn land in one storage write instead of one full-ledger rewrite per item. A run still halves the transaction only when an item conflict rejects it.
- **Combine tips spends exactly the tips it counted.** Combine added up amounts as JavaScript numbers, which round past 2^53, and left the send to pick tips again. It now passes the exact tips and the exact bigint total, and logs `combine start / done / failed` so the next upload names any refusal.
- **Token cards no longer count tips the chain already spent.** Two REF tips were confirmed 547 blocks ago and spent since. The card kept adding them back on every read because the local transaction record still said "unconfirmed", which inflated the balance and the tip count that Combine is offered on. That record alone now only covers an output storage has not projected yet. A row the basket released needs the chain.
- **"Already spent" on a send whose funding coin was spent elsewhere.** When the toolbox builds a signable transaction over a funding coin the chain shows spent by another transaction, the wallet retires that coin and builds again over live coins, up to five times, before any signature. Before, it handed the dead coin to the signer and the send failed as "already spent" every time.
- **Items the chain says are gone leave the inventory.** A card missing from the basket stayed on screen whenever the address scan still listed it, so spent items lived on in the database. A complete read now drops and files every card the basket let go. Items that an index keeps re-listing no longer reset their own check, so the reconcile actually comes due and retires the spent ones.

### Changed

- Triage counts combine attempts and their failure reasons under token sends.

## [1.3.424] - 2026-10-03

### Fixed

- **Token outputs the chain proves unspent now come back on that proof.** The holdings reconcile asked Teranode and WhatsOnChain about eleven REF outputs missing from the wallet's records, and both said unspent. All eleven are mined and unspent. The restore step then asked a second set of explorers (Bitails, then BananaBlocks) all over again. On the phone those timed out, so every restore failed and was logged as "row missing". The claim from the transaction re-asked the same explorers and would have counted each output as spent. Restore and claim now act on the chain answer the reconcile just took. Restore also finds a row its transaction links only by numeric id, and after a claim the same pass makes any row the claim found already in storage spendable.
- **A token sealed under one of the wallet's own transactions is no longer written off as sent.** The reconcile closed an entry as "sent here" whenever a local seal named a spender, even when the chain said the output was unspent. A seal can outlive a transaction that never landed, and closing the entry hid that token for good. A seal now holds the row until the chain answers; only a proven spend closes the entry.

### Changed

- When the reconcile cannot restore a row, it logs why (`no-row`, `reserved`, `sent-here`). A restore records what the row looked like before (`spendable`, spender status). A refused input names each coin and the transaction that spent it. `npm run triage` counts restore refusals by reason and claims that never finished before the upload. `--trace <txid> --all` also lists what the wallet did in the five minutes before an output was first reported missing.

## [1.3.423] - 2026-10-03

### Fixed

- **Tokens missing from the wallet's records are claimed back instead of skipped.** On one phone, eleven BRC-162 token outputs were unspent on chain at the wallet's own address, but their basket rows were gone. The holdings reconcile correctly asked to claim each one from its transaction. The claim used the same import guard as Refresh, and that guard still marked them "already imported", so the claim brought back nothing and the tokens never returned. Because no public index can find a BRC-162 output by owner, Refresh could never bring them back either. A reconcile claim now clears that stale mark for exactly the outputs it proved unspent and unlisted, then imports them. A token or item the wallet still holds keeps its mark, so its BRC-150 remittance is never overwritten.

### Changed

- Claims log how many outputs were already spent and how many the import guard passed over. `npm run triage` prints those counts, plus the log lines about each token output the reconcile still has open or retired.

## [1.3.422] - 2026-10-03

### Fixed

- **A Refresh no longer freezes token sends and the wallet's records behind slow explorers.** Before reading balances, every Refresh checks that no pending transaction builds on a failed one. That check asked explorers about each affected transaction one at a time, sometimes tens of seconds each, while holding the wallet's storage lock. Every send, listing and signature waited behind it. On one phone a token send sat for over 30 seconds without starting, the Syncing pill timed out, and releasing unsigned reservations timed out four times. Explorers are now asked with the lock released, four at a time. A transaction they confirm isn't asked about again for 30 minutes, and the result is applied in a short second step. A pending transaction that appears while the explorers are answering waits for the next Refresh instead of being judged on an answer nobody asked for.

### Changed

- `npm run triage` lists every token send that never reached planning, with what the wallet was doing meanwhile. Token sends now log how long they took to find their outputs.

## [1.3.421] - 2026-10-03

### Fixed

- **Tokens and items now show exactly what the wallet holds.** 1.3.420 still kept a multi-output token card forever (each output inherited the card's fresh timestamp) and asked the chain about every absent card on every refresh. Both lists are now a direct reading of the wallet's own records. Tokens are read in full, in both encodings, and include your own unconfirmed sends. A new output that hasn't been listed yet stays visible for up to 10 minutes. A read that fails, comes back incomplete, or overlaps a send, sync or restore (even a send that starts and finishes during the read) changes nothing and runs again once the wallet is idle.
- **Nothing leaves the lists silently.** Every token or item the wallet stops listing, and every item an address index no longer shows, is recorded and checked on chain once per backoff step (2 minutes, then 1 minute, 5 minutes, 15 minutes, 1 hour, 6 hours, 24 hours), never on every read. If the chain shows it spent, the record closes. If it shows it unspent, the wallet's record is restored, or the output is reclaimed from its transaction. No answer keeps the record open. The record survives restarts.
- **Asset safety.** An output only counts as spent when the spending transaction's own data shows it consuming that output, so an index's word alone isn't enough. An output that a pending app action or one of your own unconfirmed sends still holds is never released back into the balance because an explorer reports it unspent.
- Restoring a history backup from a file or an on-device snapshot now pauses sends and wallet reads while it writes, as a cloud restore already did.

### Changed

- Token ownership proofs build on earlier ones. An output this wallet already proved is a finished step, so a received or repaired token checks only its new transfers instead of re-reading the same ancestry. Sends and market listings still ship the full proof the other side needs.
- `npm run triage` shows each recorded output's state (filed, closed, restored, reclaimed, refused because reserved) and lists those still open.

## [1.3.420] - 2026-10-03

### Fixed

- **Token cards the wallet no longer holds now correct themselves.** A BRC-162 token card stayed forever once the wallet's records stopped listing it, and so did every card when the wallet listed no tokens at all; Send then failed with "Need N units; only 0 available". (One phone showed 14 tokens while holding 3.) Past its settle grace, an absent card's outputs are now checked on chain: every output spent retires the card, an unspent output that pays this wallet is reclaimed and becomes spendable, and no answer keeps the card for the next check.
- `npm run triage` reports holdings against the wallet's records: token reads that showed more cards than held, cards retired, reclaimed or kept, and item reads that kept cards the basket no longer listed.

## [1.3.419] - 2026-10-03

### Changed

- Developer keys moved from Settings to Connected apps. A `</>` button beside the open-pages button opens it as a page under Connected apps.
- The Messages button on Friends is no longer the accent colour; it matches Add friend.

## [1.3.418] - 2026-10-03

### Changed

- **Wallet key vs profile ID.** Copy now uses two plain names: the **wallet key** is what people pay or add as a friend, and the **profile ID** is your public profile's fingerprint (formerly "identity key" and "BAP ID"). Identity explains the difference in one line, and the profile ID's identicon stays beside every issuer and profile name, because a copycat can borrow a name and picture but never that ID.
- The wallet switcher no longer shows a "Root" tag. Long profile names truncate with an ellipsis instead of squashing, and the second line reads the handle, the wallet's name under a profile, or "No public profile" instead of a raw key.

### Fixed

- Incoming payments, tokens and items in Activity now show the sender's public profile picture in the badge, as your own sends already did. The picture comes from the profile card the sender presented to this device. A name that looks like a verified issuer's but isn't shows the profile ID's identicon instead of the picture.

## [1.3.417] - 2026-10-03

### Added

- **Settings → Recover from transaction.** Paste the sender's txid and the wallet claims every unspent token or item in it that pays this wallet, proving lineage exactly as on receive. No public index finds an unspent BRC-162 token by owner, so a reinstall whose history backup never held a received token had no way back until now.

### Changed

- **Wipe no longer dead-ends on "History not synced".** The blocked state now says what the backup lacks (held tokens and peer-to-peer payments, which the recovery phrase alone cannot bring back) and offers **Wipe anyway** behind a confirmation that names the loss. Refusing outright only sent people to uninstall, which loses the same state with no warning. Refusal detail and overrides are logged.

### Fixed

- Token send failures and panel blocks (lock refusal, amount/recipient review, token not found) are now logged as `[send-token]` lines; `npm run triage` reports token sends end to end — attempts, panel blocks, refusals and each signed send's path through broadcast — plus chain-ingest and recovery outcomes.

## [1.3.416] - 2026-10-03

### Changed

- Developer keys have their own Settings page (Settings → Developer keys). New key opens a step where you tick what the key may do — sign as your identity, a wallet your server spends, or both — each with one line on what it means. Fund is a step on the key itself, then the payment approval prompt.
- Activity rows for the wallet's own sends and payments show your public profile picture where an app's badge usually sits.

### Fixed

- "Item arriving" no longer sticks. It counted every unidentified one-sat output whose indexer retry came due, so long-held dust kept the pill lit indefinitely. A held output is now "arriving" only for 10 minutes after it first appears; dust already held before this update is never counted.
- Recover from a dev key's wallet failed with "Insufficient funds" when the storage charged more fee than estimated. It now pays exactly what the storage's shortfall allows.

## [1.3.415] - 2026-10-03

### Changed

- Settings → Developer is a list of dev keys. Generate one with **Sign** (as your presented identity), **Wallet**, or both ticked. BAP allows one current signing key per identity, so one key at a time signs; rotating on Identity retires it and frees Sign for a new key. Copy gives the BSVA env (`SERVER_PRIVATE_KEY`, plus `WALLET_STORAGE_URL` and/or `BAP_ID`). A key is removable once it no longer signs and its wallet is empty. The 1.3.414 server wallet carries over as a numbered key with the same key and storage.
- Every payment the wallet makes on its own behalf now goes through the payment approval prompt: funding a dev key's wallet, and publishing, updating or rotating an identity. Declining pays nothing.

### Fixed

- Funding a dev wallet on Android now lands. Its wallet is built on this session's services; the Toolbox default used an unbound `fetch` that Android WebView refused with "Illegal invocation", so Fund and refresh failed silently.
- A received item no longer shows "Receiving…" again when the receipt is replayed (cache re-entry, inbox re-delivery, ingest retry). A settled receive stays settled; a replay can only replace a placeholder name with the real one.

## [1.3.414] - 2026-10-03

### Changed

- Server wallet is now a stock BRC-100 Toolbox wallet. Your server runs it from `SERVER_PRIVATE_KEY` + `WALLET_STORAGE_URL` (Copy key gives exactly that env), and HandCash opens the same key against the same storage. The messagebox report protocol, its polling and its custom ledger are gone; a 1.3.412 ledger's fund payments migrate into the server's storage on first read.
- Settings → Developer shows the server wallet as money · items · tokens. Fund is a BRC-29 payment internalized into its storage; Recover has it pay this wallet by BRC-29 (money only — items and tokens stay with the server). Storage work is serialized so a pending fund can never be internalized twice.
- Removed narration copy flagged by a Jev review (`npm run copy:review`): the account menu's "Balances and sync stay separate", send-panel ledes and recipient hints that repeated the placeholder, history-host hints, empty-state and pairing explanations, and the About / Import phrase blurbs.

## [1.3.413] - 2026-10-03

### Fixed

- BRC-246 session offers, hellos and welcomes draw their nonces from `crypto.getRandomValues` instead of `Math.random`.

### Changed

- BRC drafts in `docs/bsva/brcs` cleaned up after a Jev review: BRC-246 now specifies the handshake frames, signature scheme and timestamp units the code uses, and has a security section; BRC-230 drops its emphasis and pins down sync, manifest signatures and paging; BRC-147/150/156 lose restatements and HandCash-only lines.
- `npm run docs:review` (`scripts/jev-doc-review.mjs`) reviews BRC drafts with Jev: code counts and cross-checks, Jev judges each sentence and section.

## [1.3.412] - 2026-10-03

### Added

- Settings → Developer → **Server wallet**: a key the wallet derives and your server spends. This wallet tracks it and never spends it except on Recover. It is a BRC-42 self child of the account root, separate from the BAP developer key and from the Toolbox. Its outputs are never in the balance, never selectable by a send and never swept by Refresh.
- **Copy key** gives the server one JSON line: its key, the identity to report to, and the `server_wallet` BRC-33 box.
- **Fund** sends a BRC-29 payment to the server key, and the wallet tracks it from the moment it is signed.
- **Recover** moves every tracked output back into the wallet as a self payment through `signedSendLifecycle` (`serverWalletRecoverMachine`). If internalize is interrupted, the next Recover finishes it.
- **Rotate** retires the key, and is refused while any output is still tracked.
- The server reports each transaction, as Atomic BEEF with output derivations, sealed to the wallet in the `server_wallet` box or over a live BRC-246 session:
  - Reports count only from a derived server key. A later generation is adopted, which covers a restore from seed.
  - Each report is checked by SPV.
  - An output is tracked only when its lock matches its derivation.
  - A report is acknowledged only after ingest. An incomplete package waits for the next poll.

## [1.3.411] - 2026-10-03

### Changed

- Switching wallets reuses each account's already-open wallet instead of rebuilding it. Every account keeps its own Toolbox store, services and monitor, so a switch back is near-instant, the other accounts open in the background after unlock, and a switched-away account keeps confirming its own transactions while another one is in front.
- The account you are switching to opens while the previous one winds down, rather than after it.
- Backup is now one setting for the whole vault. The backup host and the "history backed up" confirmation no longer change between sub-accounts. Each account still tracks its own last upload and spend-down guard, because each has its own backup file.

### Added

- Settings → Developer key copies the BAP signing key of the identity this account shares, so a server can sign as that identity. It holds no funds and cannot reveal any wallet key; the identity root never leaves the wallet. It can sign a key rotation, so the copy step says so, and Rotate retires the key.

### Fixed

- Work cancelled by an account switch or lock is logged as a cancellation, not as an error.

## [1.3.410] - 2026-10-03

### Fixed

- Items you received days ago no longer look like they are arriving again. The last few received items were re-announced on most refreshes (about 20 times each per hour on Android), rewriting their Activity row to "Receiving Collectable". Announcing or verifying a tip whose receive row is already settled now leaves that row alone.
- Inventory no longer treats a quarantined fungible row as a new arrival every time the cache is written. Arrivals are judged on what the cache actually keeps.

### Added

- `[collectables] re-entered N announced card(s)` log line, and a "Receipt replays" section in `npm run triage`.

## [1.3.409] - 2026-10-03

### Changed

- The wallet switcher shows each account's `$handle` under its name, instead of the identity key, when that account has claimed one.

### Fixed

- Copying your handle (on the switcher and on Identity) copies the full address `@handle@handcash.io`. `$handle` is only how it is displayed.

## [1.3.408] - 2026-10-03

### Changed

- The wallet switcher shows each account's published profile (avatar and name) instead of its label, including on the switcher button. Accounts without a profile keep their label.
- The switcher's edit button opens Publish identity for that account, switching to it first when needed. Inline renaming is gone.
- Published identities are always shared with contacts. Publishing shares automatically and there is no "Stop showing". With several published identities, "Share this one instead" picks which one; removing it falls back to the wallet's own.
- A profile image may be an ordinal: the ALIAS may name `ord://<txid>_<vout>`, and the identity package carries the inscription transaction. WebP, PNG, JPEG or GIF, up to 64 KB. The ordinal is only the picture; whoever later holds it does not gain the identity. There is no picker yet.

## [1.3.407] - 2026-10-02

### Fixed

- BAP identicons no longer change with the theme. They were drawn in `currentColor` over a see-through plate, so the theme background bled through; the fingerprint now uses fixed colours from the BAP ID on an opaque plate.

## [1.3.406] - 2026-10-02

### Fixed

- Less lag on phones with more than one account: the signed-cheque archive cached one account at a time, so background miner retries for another account re-parsed up to ~1MB of JSON on every switch, and every local BEEF lookup re-decoded and re-parsed the archived cheque. Each account's archive is now cached separately and each cheque is verified once.

## [1.3.405] - 2026-10-02

### Fixed

- Restore no longer comes up empty: the history pull and chain scan were aborted when the app swapped in a fresh wallet runtime after restore ("Wallet runtime disposed"). Recovery now reruns on the replacement runtime for the same identity.
- Wipe works with no device lock (it demanded Touch ID).

### Changed

- Wipe is blocked while history backup is on until this device's history has uploaded and the cloud copy is confirmed. Empty wallets and devices with backup off are not gated.
- Removed the BIP39 passphrase field from phrase restore.
- Log triage reports why a recovery's history or chain step failed and whether a cloud backup exists.

## [1.3.404] - 2026-10-02

### Fixed

- Emergency key reveal on a sub-account now exports the master key, so restoring it recovers every account (it used to export only that account's key).
- Sealed vault values are no longer mirrored into browser storage; old plaintext-adjacent copies are purged once the shell store holds them.
- History backup: an upload the thin-overwrite guard refuses now asks before overwriting the cloud copy (showing cloud vs device balance and actions). Replace from cloud asks first too.
- History badge reflects the last upload: warns on errors, never-uploaded, or more than 14 days stale, instead of "cloud ready" on a URL alone.
- Device recovery copies: sealing and opening work on sub-accounts (master key and identity), with Touch ID, and with no lock. A copy counts as a backup only after you confirm the other device stored it.
- Key-backup confirmation and BRC-140 issued slices are scoped to the vault, not the active account.

### Changed

- Profiles: compact identity rows with chips and an overflow menu; explanatory text removed from the profile and publish flow.

## [1.3.403] - 2026-10-02

### Fixed

- Restoring from key slices no longer fails with a bare "Integrity hash
  mismatch". Every time slices were shown, the wallet made a fresh BRC-140
  split with the same integrity tag, so slices saved on different days looked
  alike but could not combine. The wallet now keeps the set it handed out and
  shows that same set on every reveal; only Replace slice set makes a new one.
- Restore takes every slice the holder has — pasted one per line, from email
  bodies or from several slice files — and tries each pair until two from the
  same set fit. When none do, it says the slices come from different sets of
  one wallet, different wallets, or copies of one slice.
- After restoring from slices, the wallet re-issues its set on the holder's
  own split: the slices used, plus the one they kept, still combine with every
  slice shown in Settings.
- Shared, emailed and saved slices carry the date their set was issued, so two
  sets of one wallet can be told apart. Replace slice set no longer claims the
  integrity tag changes; it names the wallet, not the set.

## [1.3.402] - 2026-10-01

### Changed

- Identities read as one compact pill everywhere they appear: issuer marks on
  item and token details, Send, Burn and app approvals, the market listing
  detail, inventory shelf fingerprints, and contacts in Friends, Add friend and
  Messages. Each pill is 20px tall with the identity's image or BAP identicon,
  its name, the HandCash checkmark and the short BAP ID. Verified identities
  tint green, look-alike names amber with a wavy underline, and unconfirmed or
  unsigned claims show a dashed outline.
- The market listing detail now names the item's issuer.

## [1.3.401] - 2026-10-01

### Fixed

- **Received tokens find their issuer shelf.** On a phone, tokens received from another wallet stayed on the plain Tokens shelf. There were four causes. The background check skipped tokens whose issuer was not known yet, and a received token's issuer is not known until the wallet holds its deploy. It only read transactions stored on this device, but a received token's history lives on the sender's device. An attested token that was missing its BAP ID never got one. And the check never ran while the wallet was busy. It now checks every unattested token, and fetches missing history by transaction ID when needed. That history is hash-checked, so a provider can withhold it but never forge it. The issuer and BAP ID now come from the deploy itself.
- **Uploaded logs say why a token is off its shelf.** Each check logs a one-line attestation census and a named result for every repair attempt, and `npm run triage` reports both.

### Changed

- **The issuer shows wherever you act on an asset.** Item details, token details, Send, Burn and app approvals (market list and buy included) now show who issued the asset. When an identity package proves the signer, that is its BAP identity: image, name, HandCash checkmark and fingerprint. Otherwise it is the signing key or an unsigned issuer claim, never a handle. A batch shows each distinct issuer.

## [1.3.400] - 2026-10-01

Same wallet as 1.3.399, released from `master`. No changes.

## [1.3.399] - 2026-10-01

### Fixed

- **Tokens you minted stay on your issuer shelf.** A token was attested only while its mint transaction sat in a short-lived cache. Once that aged out, the token fell back to an "Issuer claim" shelf away from your items. The wallet now keeps the deploy from its own storage and re-attests the card in the background, so the token stays under your identity.

## [1.3.398] - 2026-10-01

Tokens carry their issuer's signature from wallet to wallet, the way items already did.

### Fixed

- **Received tokens are attested like items.** A BSV-21 token you receive now shows Attested and sits on its issuer's shelf, beside that issuer's items. Before, only the wallet that minted a token could attest it. A token transfer now carries its lineage back to the deploy, and the payee proves it offline (BRC-176). The payee then keeps the deploy, which holds the issuer's signature. A tip is attested only when that walk bound it to a deploy the issuer signed; a tip that only names a real token ID stays an issuer claim. Tokens held before this update are proven in the background from this wallet's own transactions.

## [1.3.397] - 2026-10-01

Your issuer identity travels peer to peer: contacts get it straight from your wallet as a signed card, with no HandCash server in between. Publishing or rotating an identity now goes through a real transaction approval.

### Added

- **Identity cards, peer to peer.** Choose a published identity under Settings → Public identities → Show to contacts. Saved contacts you message or pay then receive a card with its name, image and BAP ID. The card is signed by your wallet key and the identity's key and carries the identity's BEEF proof. It travels over the messagebox or a direct session; no indexer or HandCash server is involved. Cards go only to saved contacts, never to market counterparties or strangers. They are sent once per version, and Stop showing tells contacts who saw the card. Received cards are verified before they are stored: both signatures, the proof against block headers, an active signer, not revoked, and never older than one already held.
- **Contacts show who they are.** Friends, chat threads, friend details and Add friend show a contact's presented identity, with its image, the HandCash checkmark or look-alike caution, and the BAP fingerprint. Friend details can ask a contact for their card, or import a card file. **Share identity card** downloads yours as a file.
- **Identity mint approval.** Publish, update and key rotation open a review before anything is signed. It lists every record transaction (image, ID, ALIAS), each output's size, the estimated network fee and a per-transaction fee ceiling, the key that will sign your assets, and whether the image is new or already on-chain.

### Fixed

- **Identity publishing fails closed.** An approved plan is rebuilt under the spend lock and refused (`plan-changed`) if anything moved since review. Each record transaction is staged unsigned and checked to carry exactly the approved records. It is aborted with its change released when its fee exceeds the approved ceiling (`fee-over-plan`).
- **BRC-100 issuance always shows the signer.** Any action signed by an issuer identity always prompts, never Auto-pay. The prompt always names the signing identity and the extra Sigma anchor transaction; before, these could be cut from the detail lines.
- **Support triage groups bridge errors.** Local desktop triage now groups BRC-100 bridge errors by method and reason.

## [1.3.396] - 2026-10-01

Handles carry real signed certificates, and every issuer identity shows a fingerprint that a look-alike cannot copy. Issuers that HandCash verifies get a checkmark.

### Added

- **BAP fingerprint.** Each issuer identity now shows a short BAP ID with an identicon drawn from its hash. This appears on Collect shelves, in item and token details, under Settings → Public identities, and on the Identity panel. Two identities with the same name and image no longer look alike.
- **Verified by HandCash.** An issuer whose BAP ID is on HandCash's signed verified-issuer list gets a checkmark. BRC-CLOUD serves the list at `GET /v1/identities/verified`, signed by the handle certifier the wallet already pins. The wallet refuses a list that is unsigned, mis-signed or older than one it has seen. The checkmark only adds to an identity whose package already proves the signer.
- **Look-alike caution.** An unlisted identity whose name reads like a verified issuer's name, after folding case, accents, spacing and characters such as `rn`/`m` and `0`/`o`, shows a warning instead of a checkmark. So does a name shared with another identity on the device. Item and token details explain the reason in a Verification row.

### Fixed

- **Handle certificates are verified.** Resolve, reverse lookup and claim now require a BRC-52 certificate (BRC-169 §4.1) signed by the certifier pinned for `handcash.io`. A placeholder, wrong certifier, wrong subject, mismatched field or bad signature is refused with a named reason. Until now the wallet checked only the certificate's shape.
- **Your handle certificate lives in the wallet.** Claiming or confirming a handle acquires its certificate through `acquireCertificate` (BRC-169 §4.6). The wallet keeps exactly one current certificate and relinquishes stale ones when the handle changes or is cleared.

### Server (BRC-CLOUD)

- **Real handle certifier.** Claims are signed with a dedicated certifier key held as a worker secret. Older placeholder rows are re-signed the first time they are read. A claim fails with `503 certifier-unavailable` rather than issuing an unsigned certificate.
- **Verified-issuer list.** `src/verifiedIssuers.json` is signed at request time and cached for 5 minutes. It starts empty.

## [1.3.395] - 2026-10-01

Handles are harder to hijack. The resolver's answer is checked against what you asked for, a saved friend's key is pinned, and a flaky network no longer wipes your claimed handle.

### Fixed

- **Resolve answers are checked.** A resolver that answers for a different handle is refused. So is a `$name@domain` on a domain the resolver does not serve, which used to resolve silently on the default domain.
- **Saved friends pin their key.** If a friend's handle starts resolving to another identity key, sending to it and re-adding it refuse with a named reason. Removing the friend accepts the new key.
- **Claimed handle survives a network error.** Only a not-found answer from the resolver clears this device's claim; a timeout or `5xx` keeps it.
- **Flaky timing test.** A provenance hydrate test no longer asserts wall-clock time; it already asserts the fetches overlap.

### Server (BRC-CLOUD)

- **Handle claims are atomic.** Two first claims racing for the same handle can no longer both succeed; the loser gets `409 handle-taken`.

## [1.3.394] - 2026-10-01

Collect groups everything by BAP ID and shows the newest identity details the wallet holds, on shelves, token chips and item and token details. Token and item refreshes no longer pay for issuer attribution on every tip.

### Fixed

- **Token refresh lag since 1.3.390.** On 0.1.553, Android froze for 26.5 s across 100 minutes, against 2.6 s across 26 minutes on 0.1.550. Triage named the BSV-21 refresh as the owner. Issuer attribution was re-parsing whole retained BEEF packages, ancestry included, on the main thread:
  - **Tips:** each token tip used to parse its BEEF and run a Sigma check, sometimes twice, every time it was listed. A retained output is now parsed once and its Sigma signer verified once. A transfer tip, which never carries the issuer's Sigma, is no longer checked; the deploy output alone attests the issuer.
  - **Inscribed items:** an unmoved item no longer rehashes its whole inscribed script on every refresh.
  - **Unmined origins:** an unmined origin's height is re-read at most once a minute.
  - **Signer addresses:** issuer addresses are derived once per key.
- **Collect regrouping** reads the public identity store once per pass, not once per asset, and judges each issuer or stamped origin once (`issuerAttributionResolver`).
- **Legacy BSV-21 recovery** no longer re-proves the same tip with a provider round trip and a storage write on every refresh.
  - A proven tip is remembered for 10 minutes.
  - Any spend clears what is remembered.
  - If the spend watch cannot start, nothing is remembered.

### Changed

- **One shelf per BAP ID.** Signed assets that name a BAP ID share one shelf per BAP ID, across key rotations.
  - When a stored identity package proves the signer, the shelf shows the identity's newest image and name.
  - Until a package proves the signer, the asset sits on an "Unconfirmed BAP …" shelf with no name or image, because anyone can copy a stamp. This covers a missing package, a signer the package does not list, or an unknown height.
  - A key the package retires or revokes before the asset was mined keeps a shelf of its own key.
- **Identity everywhere in Collect.**
  - Token chips on a BAP shelf use the identity's name instead of a cached handle.
  - Item and token details show the issuer's image and name, with Issuer and BAP ID rows that copy on click.
  - Item details show the issuer for the first time.
- `issuerAttribution` returns `verified`, `unconfirmed` or `refused` with a named reason, in place of identity-or-nothing.

### Tests

- `issuerIdentities.test.ts`:
  - no package;
  - verified at a height before the rotation, showing the rotated profile;
  - retired after it;
  - height unknown;
  - stranger key.
- `collectableGroups.test.ts`: unconfirmed stamps from several signers share one BAP shelf without the verified identity's name, image or a handle; a refused signer stays on its key shelf.
- `issuerAttribution.test.ts`:
  - fifty listing passes read a retained output's BEEF once (it used to be twice);
  - an output with no Sigma is never re-read;
  - an unmined height is re-read only after a minute;
  - a matched script still refuses a different one.

## [1.3.393] - 2026-10-01

Issuer identities are now BAP identities with an uploaded image and key rotation. Assets name the BAP ID in their signed script, and the identity's proof is stored once and travels beside items.

### Changed

- **Your issuer identity is a BAP identity.** Under ID → Public identities, choose an image, a name and an optional bio, then publish.
  - The records are standard BAP: a root-signed `ID` declaring the first signing key, an `ALIAS` schema.org profile, and the image as a B:// file. Each record is a 0-sat AIP-signed data output, so nothing can be moved or sold.
  - The image is uploaded, not linked: it is cropped square, re-encoded to WebP under 64 KB, and stripped of EXIF and location metadata.
  - Publishing asks you to confirm that it is public and permanent, and goes through the signed-send lifecycle (flow `identity_publish`).
  - **Publish update** re-signs only the profile and reuses an unchanged image.
  - The same master key gives the same BAP ID as 1Sat wallets.
  - The ID panel's separate BAP compose is gone; its records are adopted.
- **Key rotation.** **Rotate signing key** declares the next BAP key, signed by the current one, and re-signs the profile. New assets are signed by the new key. Assets the old key signed keep their attribution when they were mined before the rotation was. A root-signed BAP revocation written elsewhere is honoured, and a revoked identity can no longer issue.
- **Works with 1Sat apps on this wallet.** The wallet's own identity sits in basket `bap` with the 1Sat SDK's tags and key derivation. An imported issuer's records sit in `bap issuer`, so 1Sat apps never mistake them for the wallet's key. Before each BRC-100 issuance, the wallet follows a rotation that such an app wrote, so it never signs with a retired key.
- **Assets name the identity inside their signed script.**
  - New items and BSV-21 deploys carry `MAP SET issuer <signing key> bapId <BAP ID>` before their Sigma signature, so any later holder recovers it from the item's BRC-150 package.
  - Issuing requires a published identity.
  - Mints no longer carry the self-signed `issuerProfile` JSON or an icon URL. Older assets that carry one are read with it ignored: they still group under their verified key, without a name or image.
- **One copy per identity, attached only when needed.**
  - An identity's proof is a minimal BEEF of its key chain, profile and image, with merkle proofs once mined. It is stored once per BAP ID, and assets hold only the BAP ID.
  - Your own identities are pinned, upgraded to mined proofs, and included in the identity backup.
  - A peer's package is kept only after its proofs match block headers. It merges with what is stored, keeping the first rotation on chain. Peers' packages are capped at 8.
- **Identity travels beside items.** An item or token delivery attaches the package for the BAP ID it names as `meta.identities`. It goes in last, so the custody BEEF and the item's provenance keep the box cap first. The receiver verifies and stores it off the receive path; it never gates ingest or ACK and never enters the chat transcript.
- **Collect shows the verified identity.** An issuer shelf, keyed by BAP ID, shows the identity's image and name only when the asset's Sigma signer is its `issuer` and was an active key of that identity when the asset was mined. Assets from before and after a rotation share one shelf, and a copied claim stays on its own.
- **Drafts.** The asset stamp is BRC-247; the package, verdict and delivery rules are drafted as BRC-248 (`BRCs/peer-to-peer/0248.md`). Wallet details: `docs/public-identities.md`.

### Tests

- The real-toolbox issuance suite covers the full lifecycle against a real wallet:
  - publishing 0-sat records in `bap`, with 1Sat key parity over BRC-100 and the 1Sat ID custom instructions;
  - an update that reuses the image;
  - refusal before publishing;
  - mints signed by the current BAP key;
  - an imported master's records kept in `bap issuer`;
  - release on failure;
  - one shelf across a rotation;
  - adopting the earlier compose's records;
  - following a rotation another app wrote into `bap`;
  - delivery to a receiver with empty storage.
- New unit suites cover:
  - BAP record parsing, AIP recovery and byte equality with the earlier compose;
  - key chains, retired keys, unmined and rival rotations, forks, and revocation, mined and unmined;
  - image reuse and profile ordering;
  - URL and oversized image refusal;
  - store-once, merge and eviction;
  - backup round-trips and the envelope field.

## [1.3.392] - 2026-10-01

Same app as 1.3.391. Its tag was published before the commit reached master, so this version carries that commit onto master.

## [1.3.391] - 2026-10-01

Identity issuance is now tested end to end against a real wallet. No change to app behaviour.

### Tests

- **Identity issuance runs through a real toolbox wallet** (`src/wallet/identityIssuance.toolbox.test.ts`): a funded IndexedDB wallet with only the network stubbed. Minting an item and a BSV-21 token with the wallet's issuer key gives a mint that spends the `noSend` anchor and carries it in its Atomic BEEF. Both outputs verify Sigma and the MAP `issuer` / `issuerProfile`. Nothing is broadcast until the wallet's broadcaster runs; it then posts the anchor and the mint together. An imported issuer key signs while the wallet funds. A failed mint releases the anchor, returns every satoshi and broadcasts nothing. The minted item and token land on the verified issuer shelf with the profile's name and icon, and a copied, unsigned claim to the same key gets its own shelf with no icon.

## [1.3.390] - 2026-10-01

Public issuer identities: assets you issue carry a signed name and icon.

### Added

- **ID → Public identities.** Define the wallet's public name, icon and description, or import an existing issuer's hex or WIF Sigma signing key, and choose which key signs new issuance. Profiles are signed (`handcash-public-identity` v1, `docs/public-identities.md`) and are attribution only: they grant no spend authority and do not prove a real-world identity. Imported keys are sealed to the wallet account with BRC-78 and never enter chart state, metadata or app responses. The recovery phrase cannot derive them, so the identity backup is separate from BRC-39 history.
- **Issuance signs with the selected issuer.** New items and BSV-21 deploys carry a standard Bitcom MAP `issuer` / `issuerProfile` tape and a Sigma (BRC-77) signature bound to a real funding input. A request with no input uses the 1Sat SDK anchor flow (`noSend` 2-sat anchor, then `sendWith`), and approval shows the issuer and the anchor fee. A name and icon are required before issuing. Selection is checked again after the anchor is made, and a failed signature refuses the mint instead of sending it unsigned.
- **Collect groups by issuer key.** Shelves are keyed by the issuer's public key, with the signed profile's name and icon. An unverified `issuer:` remittance claim gets its own "Issuer claim" shelf and cannot land on an attested issuer's shelf.

### Fixed

- **Sigma signatures verify.** The old deploy signer appended a second `OP_RETURN` instead of the `|` separator and produced signatures no verifier accepted. Signing and verification now follow the 1Sat SDK hash rules (`@1sat/templates`), and attestation requires the actual transaction's signature, input binding and embedded signing key.
- **Issuer attribution does not slow listing.** Each outpoint's retained transaction is parsed and its Sigma verified once per session (`src/wallet/issuerAttribution.ts`), and profile signatures are verified once per exact signed bytes. Doing it per tip on every refresh re-parsed whole BEEF packages and origin inscriptions.
- **A failed mint releases its anchor.** When signing or the mint fails before broadcast, the signable mint and the `noSend` anchor are aborted, so the anchor's change is not left locked.

## [1.3.389] - 2026-09-30

Fixes lag and crashes introduced by the last few releases.

### Fixed

- **Phone backups no longer crash the app.** BRC-39 encryption and decryption now run on WebCrypto AES-GCM over one byte buffer (`src/wallet/brc39Lean.ts`). The old toolbox path held about twenty copies of the backup as JavaScript number arrays, so a 28 MB history ran the Android WebView out of memory mid-backup and the backup never finished. Peak memory is now three to four times the document. The file format is unchanged and interoperates both ways with the toolbox. The toolbox encryptor is kept only as a fallback when WebCrypto is missing.
- **Large history restores fit in memory.** The same decryptor lets an ~80 MB backup restore on Desktop without exhausting the renderer.
- **Activity no longer freezes the wallet as history grows.** Each Activity refresh read every settled transaction record, and IndexedDB clones the whole record, raw transaction and input BEEF included, on the UI thread. The ledger now lists ids from the `status_userId` index, fetches only records it has not seen this session in small batches that yield between them, and reads them outside the storage lock so a spend is never stuck behind it. A recompose still rereads everything.

## [1.3.388] - 2026-09-30

Release builds enforce code signing.

### Security

- **Mac and Windows packaging requires code signing** (`package.json` `forceCodeSigning`, hardened runtime, notarization; `scripts/check-release-signing.cjs`). A Mac build without Apple notarization credentials and a Developer ID identity refuses to package. Unsigned builds need the explicit `HANDCASH_ALLOW_UNSIGNED=1` opt-out, which `launch:mac` uses for local runs.
- **Release workflows sign as soon as the secrets exist.** Mac uses `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`; Windows uses `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`. Until then each run builds through the opt-out and shows an "Unsigned release" warning.

## [1.3.387] - 2026-09-30

Rest of the 2026-09-30 security review. Cloud backup and messages are signed per request.

### Security

- **Cloud history and messagebox requests prove the whole request** (`identityRequestAuth.signedIdentityFetch`). The signature covers the method, path, exact body bytes, relevant headers, a timestamp and a random nonce. BRC-CLOUD consumes each nonce once and rate limits per identity. Earlier proofs covered only the method, box and time, so they could be replayed with a different body.
- **Uploading a backup can no longer overwrite a newer one** (`historyBackup`). Uploads send `If-Match` with the ETag of the backup this device last saw. The server keeps every upload as a version that only its owner can list or read.
- **History restore goes into a new database** (`replaceLocalHistoryFromCloud`, `vaultAccounts.selectToolboxDatabase`). A restore downloads, decrypts and validates the backup, merges it into a fresh local database, then switches to it through a pointer that is written to disk. If the new database fails to boot, the switch is rolled back. The original database is kept. Recovery shows each stage (download, validate, merge, reboot, recompose, balance).
- **Critical records and archive snapshots reach disk before success** (`electron/durableStore`, `electron/brc39Archive`). The file and its directory are both synced.

### Fixed

- **Existing large backups stay restorable.** Downloads accept backups up to 96 MB, the server's cap, and the backup document budget stays at 64 MB.
- **Activity ledger reads back off when they keep failing** (`activityLedger`). A read that keeps failing now waits up to five minutes between tries instead of warning every ten seconds.

### Changed

- Triage reports every backup push that did not upload, grouped by reason (`historyReplica.pushMisses`). A wallet showing zero uploads now says why.
- Electron 43.7.7, Vitest 4.

## [1.3.386] - 2026-09-30

Activity no longer loses history.

### Fixed

- **Activity is a view of the wallet's own ledger** (`activityLedger`, `appActivity.listActivityFeed`). Its base is the Toolbox transaction table, read live, which the BRC-39 backup already carries. Stored rows only add what that table cannot say: which app, which item, pending and failed sends, and events. Rows that storage dropped reappear at their real time. Nothing comes from an indexer and nothing is persisted twice. Wallet logic (rebroadcast, peer re-delivery, item verification) still reads stored rows only.
- **One transaction can be several activities.** A send to yourself or a purchase from yourself keeps both legs. Each item's direction comes from the output it moved, so a mint reads as received rather than sent.
- **Full storage sheds what the ledger still shows** (`appActivity.writeAll`). It sheds plain settled rows first, then annotated ones. The oldest rows are dropped only after that, and the log says which of the two happened. Inlined `data:` item art is no longer stored. 19 pictures had filled the whole 512 KB budget and pushed every older row out.
- **Verification never moves a row in time.** A late annotation, such as an item finishing verification, keeps the transaction's own time instead of jumping to the top.
- **Cloud backup backoff clears after an upgrade** (`accountLocalStores`). The watchdog is reconciled once the account's keys exist; before unlock it silently did nothing, leaving backups paused for up to 12 hours.

## [1.3.385] - 2026-09-30

First fixes from the 2026-09-30 security review.

### Security

- **One approval never authorizes another action** (`brc100Contract`, `permissions.requestActionApproval`). Every action gets its own prompt, including byte-identical payments. Previously a second payment from the same app could ride the first payment's approval, with a different amount or destination. The coalescing path is removed.
- **Auto-pay reserves its spend before approving** (`autoPay.reserveAutoPayPayment`). The reservation is written to disk (`handcash.autoPayReservations.v1`) before consent is returned, so concurrent or crashed payments cannot exceed the window or the monthly BRC spending grant. A failed or uncertain payment stays charged until its window ends. Settling records the txid so the same spend is not counted twice.
- **Auto-pay no longer signs `signAction` on its own.** Turning auto-pay on is not authority to sign an arbitrary prepared action. The window is clamped to 1–744 hours.
- **"Windows Hello" / "Mac password" unlock is withdrawn where it did no authentication** (`electron/deviceAuth`). Device unlock is offered only on macOS with Touch ID. Elsewhere it reads "Device unlock unavailable"; use your wallet password or recovery phrase.
- **Signed bodies, outboxes, the lock list and device keys are written to disk before success is returned** (`electron/durableStore.requiresCommittedWrite`). On Linux, secrets are not sealed with the plaintext `basic_text` keyring backend.

### Changed

- Triage prints a history timeline (replaces, restores, uploads, recomposes) beside pins that missed their local row, plus what triggered each keep-change pass. `--history` reads every retained upload.

## [1.3.384] - 2026-09-30

On 0.1.545 a 1,000-sat payment to an app failed as a double spend. The app's refund, which depended on that payment, failed with it. Three of the payment's inputs had already been spent by the wallet's own market listing. That listing's Arcade pin never found its local row, so only the lock list recorded the spend. A later "keep change" pass on the listing's parent then marked those coins spendable again. The pre-send check trusted them because their parent was certified.

### Fixed

- **Change is never re-offered after another of the wallet's own sends spent it** (`staleOutputRelease.keepChangeOfSignedTx`). An output the lock list has sealed under a named spender stays sealed. The wallet logs `[stale-output] left N output(s) of X sealed — already spent by …`.
- **The pre-send check reads the lock list** (`inputCertainty.judgeSignedInputs`, `utxoLockManager.sealedSpenderOf`). An input sealed under another transaction counts as spent, even when its parent is certified. The signature is retired and the send re-signs with live coins. The `[certainty]` line now reports `sealed=`.
- Triage reports native Android crashes from the `[native-crash]` lines that Mobile 0.1.546 records.

## [1.3.383] - 2026-09-30

On 0.1.543 a BSV-21 listing was accepted by Arcade, but the market app lost its connection before it could index it ("Failed to fetch"). The market then tried to cancel. The wallet refused with `offer-not-held`, and Inventory kept showing the token as "Listed". Pressing Try again in the market signed a second listing. On the same phone, every Arcade pin (30 of 30 across uploads) logged `pin found no local row`. Tokens also switched between Tokens and NFTs on each Refresh.

### Fixed

- **A listing the market never indexed shows as "Not published", not "Listed"** (`marketListing.MarketPublishState`, `marketListingMark`). `markMarketListingPublishFailed` now keeps the listing authorization and records it as unpublished with the reason. Inventory, the token chip and token details show a warning-colour "Not published · price". The activity row reads "Not published: reason" and still offers Cancel listing. A new market-origin method, `markMarketListingPublished`, clears the mark once the index accepts the listing.
- **Cancelling a listing no longer depends on the offer's basket row** (`signedListingCarriesOffer`). When the market-offers row is missing, the wallet accepts the offer if its own signed listing proves it: output 1 carries the deposit and the recorded offer script.
- **Arcade pins find their local row after a store rebuild** (`staleOutputRelease.lookupLocalTxOnProvider`). A lookup that misses re-resolves the storage user. If the user id changed, the wallet logs `[stale-output] storage user moved A → B` and retries under the new id.
- **Tokens no longer flip between Tokens and NFTs on Refresh.** A BRC-162 lock with an amount stays a token, even if a stale collectable mark says otherwise (`healMisfiledCollectables`). A bare P2PKH tip is not moved to Tokens on token tags alone (`healMisfiledBsv21`).
- Legacy failed-listing rows whose listing is still live now offer Cancel listing next to Clear from Activity.

### Changed

- **Triage reports listing outcomes and pins** (`latest.listingOutcomes`): listings whose publish failed, how many were republished, which are still unpublished, cancel refusals by code, cancels proven by the signed listing, and Arcade pin hits, misses and storage-user moves.

Ships with BRC-MARKET, where a publish that cannot reach the index keeps the signed listing. Publish again re-submits the same advert, Cancel listing returns the item, and only an overlay refusal withdraws the listing automatically.

## [1.3.382] - 2026-09-30

Ships with Mobile 0.1.544, which keeps the wallet answering apps while it is in the background. The Desktop app is unchanged.

### Changed

- **Triage counts background delivery failures** (`scripts/triage-logs.mjs`, `latest.notifications`):
  - `bridgeDeliversParked` / `bridgeDeliversParkedUntilResume`: BRC-100 requests that took 5s or more to get from the native socket into the WebView, and how many were released only when HandCash came back on screen. On 0.1.543, all four such requests (worst 75s) waited for the user to reopen the app.
  - `onScreenSkipsThenHidden` / `postedWithinGrace`: activity skipped as "on screen" when the user left within 3s.
- An action is no longer reported as silent when the wallet logged its own skip for it. The log ring can drop a `[lifecycle] visible` line.

## [1.3.381] - 2026-09-30

On 0.1.542 a phone went from 1,007,412 sats to zero. Its history backup had not uploaded for a week: every push logged `skip schedule: no session password`, because the wallet had been unlocked with the device key, not a password. The wallet was then wiped and the seed reimported. The wipe deleted the toolbox store, and the reimport restored the week-old backup: 4.3M sats of coins that were long spent, which the dead-coin sweep then hid (125 coins). Change made after that backup is locked to keys derived from random BRC-29 prefixes and suffixes that lived only in the deleted store. The seed cannot regenerate them.

### Fixed

- **History backups upload under device unlock** (`sessionBackupAuth.sessionBackupCredential`). BRC-39 blobs are sealed to the root key; a password is only needed to read old password-sealed blobs. Push, flush, auto-sync and recompose now skip only when the wallet is locked.
- **Change derivations survive a wipe and an older restore** (`reimportDerivedChange.ts`, `wipePolicy.ts`). Before a factory wipe or a History replace deletes the store, every output's prefix and suffix is echoed to the durable store. That key is scoped to the identity and holds no keys, so a factory wipe now keeps it (Desktop renderer, Electron store and Android bridge). After every recompose, the wallet re-imports each echoed coin the chain shows unspent but the store lacks (up to 400 per pass, largest first), forgets the spent ones, and refreshes the echo. Manual heal runs the same recovery. The echo cannot help this incident's phone: the wipe that caused it deleted the echo too.
- **History replace on a subwallet wiped the primary wallet.** `replaceLocalHistoryFromCloud` deleted `handcash-brc100-<chain>-<handle>` whatever the account, then rebooted as account 0. It now deletes and reboots that account's own store.
- **Change locking scripts are rebuilt from BRC-29 keys** (`changeScriptFate.derivedLockingScript`). A restored change row without a script gets it from its own derivation (own change, or a BRC-29 payment from a sender). A body whose output does not match is refused as `derivation-mismatch`. The identity-address guess no longer marks a written-off row spendable.
- **Legacy deposits import with a proof** (`legacyBeef.ts`). A P2PKH deposit to a subwallet's address was built as a bare raw tx, and the toolbox refused it ("inputBEEF must be valid Beef when factoring trustSelf"), so the 10c never arrived. Now a mined deposit ships its own merkle path, and a mempool deposit ships its proven parents. With neither, it waits for a block.
- **A subwallet no longer inherits the previous account's items.** A chain scan that started under account 0 imported its collectables into account 3 after the switch. Legacy ingest is pinned to its runtime and stops at the first await after a switch. `listCollectablesNow` will not list a basket whose identity is not the current account.

### Changed

- Log lines: `[derived-change] echoed N derivation(s) from M output row(s) done Nms`, `[derived-change] echo recovery checked= live= sats= imported= failed= spent= unknown= done Nms`, `[change-script] derived N change locking script(s) from BRC-29 keys`, `[change-revive] <txid> revived= sats=`, `[legacy-beef] <txid> via=proof|parents`.
- Triage `derivations` counts history replaces, echoes, recoveries, live outputs with no derivation, rebuilt scripts and legacy deposit proof sources. `--trace <text>` prints every matching line of the latest two sessions, once each.

This release also comes from an audit against BSVA sources: Arcade `adfa78b`, Teranode, `@bsv/sdk` 2.8.1, wallet-toolbox 2.13.2 and the BRC index. Two findings change how 1.3.380 reads the network.

First, why Arcade sat on the dead-coin sends. Teranode drops a transaction once every output is spent and mined past its 288-block retention. A later spend of one of those outputs then finds no parent, and the node answers with an opaque `PROCESSING (4)`. Arcade files that as a missing parent: `PENDING_RETRY`, retried 288 times (about a day) before it writes `REJECTED` with "no network verdict". A spend of a coin whose parent is still held gets `UTXO_SPENT` back at once, as Arcade 466, with the spender named.

Second, nothing in the SDK, the toolbox or the wallet checked finality, which is BRC-67 step 4.

### Fixed

- **Coins are checked against a Teranode node as well as WhatsOnChain** (`createActionInputFate.ts`). Each check posts to Teranode's bulk `/api/v1/utxos/json` (GorillaPool mainnet, then mainnet2) alongside WhatsOnChain's `/utxos/spent`, in parallel and on the same timeout. The node sees mempool spenders; WhatsOnChain names only confirmed ones. So a coin another unconfirmed transaction already holds is now retired and the payment signed again, where it used to refuse as "explorer silent". A spender named by either source wins. Otherwise an unspent answer from either clears the coin. A node's `NOT_FOUND` is not an answer, because a pruned parent reads the same as one the node never saw. The payment check, the landing evidence and the dead-coin sweep all use this.
- **Arcade's give-up is not a rejection** (`arcadeV2.ts`). `REJECTED` with "no network verdict after N durable retry attempts" now reads as `stalled`. Before, it failed the transaction and released its inputs. A valid body that never reached a node would then have had its coins re-spent, while it could still land. The landing watch now asks for the coins instead.
- **Arcade 466 names the spender.** A node's `UTXO_SPENT` / `TX_CONFLICTING` carries `<parent>:<vout> utxo already spent by tx <spender>`. The landing watch hides that coin under that spender even when no probe answered, and labels the send "a coin it spent was already spent".
- **More Arcade statuses are read correctly.** 476 (not final yet) is retryable, not dead. `STUMP_PROCESSING` (a block holds it while its BUMP is built) is landed. `SENT_TO_NETWORK` is queued.
- **Incoming packages must be final before they are credited** (`incomingFinality.ts`, `kernel/txFinality.ts`; BRC-67 step 4, BRC-9). `internalizeAction` credits from the BEEF before any miner sees the body, so no miner's finality gate ever ran. Every unmined transaction in the package is now judged. If an input's sequence is below `0xFFFFFFFF` and the lock time is still ahead (the next block's height, or median time past for a time lock), the sender can still replace it, and the package is refused with `non-final`. The chain height is fetched only when a lock time is live. If no height is available, the package is refused with `finality-unknown`. Ordinary payments (lock time 0 or all-final sequences) cost nothing extra.
- **Permission prompts are never timed out** (BRC-219). The Desktop bridge gave every request 120s, or 300s for a spend, then cancelled the prompt the user was reading. The Android bridge answered 504 after 120s and left the prompt up, so an approval that came later signed a transaction whose reply had nowhere to go. Now the renderer reports when a prompt is on screen (`notePromptOpen`), and both bridges re-arm their deadline instead of firing while one is open. A client that disconnects still cancels.

### Changed

- The probe kinds `noConfirmedSpender` / `confirmedSpender` are now `unspent` / `spent`, since node answers include mempool spenders.
- BSV-21 ancestry treats an Arcade give-up as `ancestor-pending`, as it treats a retryable rejection.
- Log lines: `[internalize] <txid> refused reason=non-final lockTime= by=height|time`, `[internalize] refused reason=finality-unknown`, and `[HTTP] request_id=N <path> deadline held — a permission prompt is open`.
- Triage `incomingFinality` counts non-final and finality-unknown refusals.

## [1.3.380] - 2026-09-30

On the night of Sep 29, app payments on 0.1.533–0.1.540 all logged `Arcade accepted — tx pinned`, about 100 distinct transactions, and none reached the chain. Arcade's POST `/tx` answers 202 once it has *queued* a body. Every sampled one then read `PENDING_RETRY` on `GET /tx/{txid}` ("failed to validate transaction", 130–190 retries) and was 404 on WhatsOnChain. Each spent a coin that a transaction mined on Aug 17 or Sep 22 had already spent, or change from such a send. The wallet took the 202 as the send, so Activity said sent, the dead coins stayed sealed, and later payments chained on dead change. `classifyArcadeTxStatus` read `PENDING_RETRY` as `unknown`, and the Arcade pin holds on `unknown`, so no later pass ever released them.

### Fixed

- **Every Arcade-accepted cheque is followed until a node holds it** (`arcadeLanding.ts`, `kernel/landingFate.ts`). The watch runs after the reply, so signing stays as fast as before. It reads Arcade at 5s, 15s, 30s, 1m, 2m, 4m, 8m and 15m. `SEEN_ON_NETWORK`, `SEEN_MULTIPLE_NODES`, `ACCEPTED_BY_NETWORK`, `MINED` and `IMMUTABLE` count as landed, and so does anything WhatsOnChain has.
- **A cheque the chain can never take is failed, on proof only.** Proof is one of: Arcade rejected it; a confirmed foreign transaction already spent one of its inputs; or it spends change of a cheque already proven dead. The failure is a closure: descendants go with it, the dead coins are hidden under their named spender *after* the fail (which restores inputs), the pool is swept, and Activity reads "Not on chain — a coin it spent was already spent". `PENDING_RETRY` or silence without proof keeps waiting.
- **A stalled cheque reaches the other miners.** Arcade's first success ends the toolbox round, so a stall inside Arcade reached nobody else. Once per watch, a stalled body with no dead input is re-posted to GorillaPool, Bitails, WhatsOnChain and TAAL.
- **Unlock repairs cheques that never landed.** About 8s after unlock, once recompose has finished, every pinned cheque with no landing verdict is checked, oldest first (up to 200), so a dead parent is proven before its children. Instead of one toast per send, a single toast gives the count.
- `classifyArcadeTxStatus` reads `PENDING_RETRY` as `stalled`. The pin still holds on it; only the landing evidence retires a stalled pin.
- **Where the dead coins came from: consolidation released inputs of a body it had already queued.** `59a99dc7` (70 inputs, one output back to us, mined Sep 22) was this wallet's own change consolidation. When its miner round came back as anything other than "accepted with full ancestry", `internalizeConsolidated` released all 70 inputs. The signed body was still in the durable miner outbox, which later landed it, so 70 mined-spent coins came back as spendable. Now a consolidation that was posted or queued keeps its seal. Inputs are released only when local SPV held the body before any miner saw it.
- **A released transaction leaves the miner outbox.** `releaseSealedInputsOfUnsentTx` now removes the queued body, so a retry can never post it over coins the next payment spends.
- **Before an app hears a txid, every coin it spends is proven unspent** (`inputCertainty.ts`, `kernel/inputCertainty.ts`, `spendCertainty.ts`). SPV proves a parent exists; it cannot prove a coin unspent. So a coin under a mined parent must be cleared by an explorer, and a coin under an unmined parent must be change of a transaction this wallet signed from proven coins ("certified"), or of one a node already holds. Coins a confirmed transaction spent, or change of an Arcade-rejected parent, are retired and the payment is signed again (up to 3 signs). A coin nobody can answer for refuses the payment with `INPUTS_UNVERIFIED`. The fresh signature is failed locally and nothing is sent. The earlier probe let "unknown" through. Cleared coins persist for 6h and are forgotten the moment this wallet signs over them. The unlock sweep pre-clears the pool, so a normal payment asks nobody.
- **The coin check covers every signature, not only app payments.** `installSpendCertainty` gates `createAction` and `signAction` on the toolbox instance at boot. BSV and BRC-29 sends, items, market list, buy and cancel, tokens, burns, legacy and phrase sweeps, identity mints and consolidation all pass the same proof, and no caller can sign around it. `signAction` is judged *before* it signs, from the signable its `createAction` returned. A dead or unanswered coin aborts the action, so a market cancel that broadcasts inline never starts. If the dead coin is one the caller named in `inputs` (an item tip, a listing, a legacy UTXO), the action is refused with `input-spent` rather than re-signed around a coin it cannot drop.
- **Spends from a second install of the same key are read from the history backup** (`peerDeviceSpends.ts`, `kernel/peerDeviceSpends.ts`, `peerSnapshot.ts`). Two installs are not a supported setup, but the second install is the one spender this wallet's ledger cannot see. Both installs upload BRC-39 to the same object. When its `exportedAt` is not the one this install last wrote (checked by `HEAD` on unlock, every 90s, and at most every 15s while signing), the snapshot is decrypted in the BRC-39 worker and read, never imported. Each signed, not-failed transaction there that this device does not hold, and that spends a coin still spendable here, retires that coin under the other install's txid. This happens even when no explorer has seen that transaction yet, and the gate treats the coin as spent. A later snapshot that shows the transaction failed withdraws the claim. A snapshot from this install's own storage identity is ignored. Two installs signing within the same backup debounce are still a race that only a node can settle.
- **Nothing is posted that this device has not SPV-verified** (`spvPackage.ts`, `kernel/spvVerdict.ts`). Before any miner round, the package passes full SPV: every unmined transaction's scripts and amounts, and every merkle proof against the header sources. A package that cannot be judged yet (missing body, header not served) waits in the outbox (`queued: unverified`). An invalid one is never posted, and its inputs are freed unless an earlier round already sent it. Parents verified once are not re-walked on the next chained payment.

### Changed

- Log lines: `[landing] <txid> landed|dead|re-posted outside Arcade|still unlanded`, and `[landing] unlock pass checked= landed= dead= waiting=`.
- Triage has a `broadcast` section: per-txid miner outcomes, `landed`, `dead` and `arcadeQueuedOnly`. An Arcade 202 alone no longer counts as landed. `gated` counts sends refused before any miner saw them (`[certainty] … refused`, `[spv] … invalid`), and `[spv] … held` is tracked per txid.
- Log lines: `[certainty] <txid> certain|retire|uncertain reason= inputs= asked= parents= peer=`, `[certainty] <txid> refused`, `[certainty] <txid> unjudged — … broadcast inline`, `[spv] <txid> held|invalid`, `[spv] <txid> verify txs= done Nms`, `[peer-device] snapshot <exportedAt> read|own spent= withdrawn= txs= done Nms`, `[peer-device] <n> coin(s) spent by another install`. `[brc100] createAction inputs spent elsewhere` is now `[spend] <txid> inputs spent elsewhere`.
- Triage `deadCoins.peerDevice` counts snapshot reads, coins another install spent, withdrawals and unread snapshots. Resigns are counted from the `[certainty]` line.

## [1.3.379] - 2026-09-30

The 0.1.540 upload: background payments that signed once took 4.2–4.3s. The other 6 of 8 resigned over coins a confirmed foreign tx had already spent, and took 8–41s. The sweep meant to clear those coins asked WhatsOnChain one coin per request. 21 of 50 went unanswered (rate limits, and timeouts while the WebView was hidden), were never asked again, and the next payments kept picking them.

### Fixed

- **The dead-coin sweep runs at unlock, before the first payment.** About 8s after unlock, once any recompose has finished, the managed-change pool is swept. Previously the sweep only started after a payment had already resigned.
- **Coins are asked about twenty at a time.** Both the per-sign input check and the sweep use WhatsOnChain's bulk `/utxos/spent`, so a 50-coin sweep is 3 requests instead of 50, and a sign with several inputs is one request. The evidence rule is unchanged: only a named, confirmed, foreign spender hides a coin, and only the unspent answer clears one.
- **Unanswered coins are asked again.** After 5s, then after 20s. A sweep that still leaves coins unanswered may run again after 60s instead of 10 minutes.
- **Hidden-coin spenders are not re-asked every launch.** Restored, live and missing outcomes are remembered for 30 days, and `notOnChain` for a day. Previously the unlock replay made ~120 explorer lookups on every launch, competing with the first payments.

### Changed

- `[spend] retire done Nms fail=Nms hide=Nms`. Triage reports `medianPartMs` for any step line that carries `part=Nms` spans.

## [1.3.378] - 2026-09-30

The 0.1.539 upload: after about ten penny payments, the balance dropped about 2.5M sats more than the 700k sats actually paid to lilb.it. The extra drop came from hiding coins that WhatsOnChain showed were spent by confirmed txs: 9 hidden on resign and 3 by the sweep. If the spender was this wallet's own send, marked failed locally but actually mined, then the fail had put its inputs back as phantom coins and hidden its change. Hiding the phantoms without reviving the spender left real change stranded.

### Fixed

- **Hiding a dead coin now also restores its spender.** For each named confirmed spender, `adoptConfirmedSpender` looks the tx up locally. If it is a failed or unsigned row that the chain has, `restoreOnChainLocalTx` seals its inputs and makes its change spendable again. Live rows, spenders with no local row, and spenders the chain does not have are left alone. Adoption runs after the retire and after each sweep, outside the spend region, with one queue per account.
- **Coins already hidden are replayed at unlock.** 45s after an account unlocks, once any recompose has finished, the named spenders of hidden coins in the UTXO overlay (up to 200) go through the same adoption. This brings back change stranded by earlier builds.

### Changed

- Triage reports the spender adoption tally (`restored`, `live`, `missing`, `notOnChain`, `unreadable`).

## [1.3.377] - 2026-09-30

The 0.1.538 upload: a backgrounded bridge payment took ~11.6s. It broke down as a first sign whose `storage_plan` waited ~6s on IndexedDB, ~3s retiring coins a confirmed foreign tx had spent, and a second sign. Every payment resigned; the dead coins came from a stale pool (3, 3, 3, 1 per payment), not from one coin coming back.

### Fixed

- **The hero read no longer runs under a hidden sign.** `bumpBalanceAfterHeal` does a full display balance read after every bridge receive and send seal. While the WebView was hidden that read held IndexedDB for ~6s under the next `createAction` (first `storage_plan` 6.1s, the resign seconds later 0.45s). While hidden it now publishes once when the page is next visible (`deferWhileHidden`).
- **A covered balance gate starts no storage read.** When the proven confirmed total already covers the amount, the gate used to start `balance()`, wait 150ms, and leave the read scanning the outputs store under the sign. That happened twice per payment. It now answers from the proven total and debits the committed amount, so the figure can only drift low; the next short gate reads storage.
- **The dead-coin pool is swept once, not three coins per payment.** When a sign finds a coin a confirmed foreign tx spent, `deadCoinSweep` probes the rest of the spendable managed change in the background: two at a time, pausing for spends, skipping change of unmined local txs. It hides only on a named, confirmed, foreign spender. A 404, timeout, rate limit or unconfirmed spender never writes a coin off.
- **The retire of a just-signed tx skips the global closure.** A tx signed inside the current exclusive spend region cannot have descendants, so `failUnsentLocalTx(..., { noDescendants })` no longer walks every failed tx in history (~2s of the retire). Miner-reject retires still run the closure.

### Changed

- The per-sign input probe skips coins the explorer cleared (404) in the last 10 minutes.
- `[spend] retire done Nms` and `[dead-coins] sweep checked=… hidden=… unknown=… done Nms` log lines. Triage now reports `deadCoins` (resigns and sweeps) and `notifications`: posted, skipped by reason, failed, and hidden-WebView value actions that raised no notification.

## [1.3.376] - 2026-09-29

Same-key device parity is gone (one install per identity), so its guardrails go too.

### Removed

- **Cross-device spend lease.** Every payment took a lock on the backup host — three sequential round trips before signing (~1.7s from a backgrounded phone in the 0.1.537 upload) plus a release. `spendLease.ts` is deleted and the coordinator's `runExclusiveSpend` no longer takes a lease; the local exclusive spend region is unchanged.
- **Soft history pull.** `softPullHistoryIfRemoteNewer` ran on the Dashboard poll (every 5 min) and on manual Refresh whenever a History backup URL was set. With one install the remote is never newer than this device, and pulling a stale install's blob would overwrite live state. Refresh is chain ingest only.
- `isDeviceParityEnabled` and the "sync History if you share a backup URL" offline-payment copy; the unused parity chain-poll interval.

### Unchanged

- History backup push after spends and empty-local recovery at unlock / restore — backup, not parity.

## [1.3.375] - 2026-09-29

The 0.1.537 upload: preflight is down to ~150ms, but the slowest payments (22–24s) re-signed over the same dead coins, and the cross-device lease cost ~1.7s per acquire from a backgrounded phone.

### Fixed

- **Re-sign no longer reselects the dead coins.** `retireCreateActionSpentElsewhere` hid the confirmed-spent inputs and *then* failed the signed tx — and failing a tx restores its inputs to spendable, so the hide was undone and the next sign picked the same coins (11 re-signs, 8× `count=4` in one upload). It now fails first, then hides.

### Changed

- **Receive skips the cross-device lease.** `internalizeAction` selects no inputs, so another install cannot pick the same coins; it keeps the local exclusive region but no longer pays three backup-host round trips. `runExclusiveSpend(..., { crossDevice: false })`.
- Spend lease linger 3s → 10s, so a bet → payout → bet cycle reuses the held lease now that receive no longer refreshes it.

### Added

- Mobile bridge logs `[spend] bridge_deliver done <N>ms` (native :3321 accept → WebView listener), folded into triage `spend.*` rows.

## [1.3.374] - 2026-09-29

Faster app payments. The 0.1.535 upload showed the whole Toolbox `createAction` (coin selection, signing, script checks, commit) at 0.8–1.6s median; the rest of the ~6.5s spend phase was wallet round trips around it.

### Changed

- **Spend lease no longer holds the reply.** Releasing the cross-device lease used to be a backup-host read + write awaited before the app got its txid. Release now returns at once; the lease lingers 3s and drops in the background, and the next acquire waits for that drop so it can never clear a fresher lease.
- **Back-to-back payments reuse the lease.** A lease this device still holds with 15s+ TTL is reused instead of three sequential round trips (read, write, read back) per payment.
- **Balance gate answers from a covering proven total.** When the last proven confirmed total already covers the amount, the in-region gate waits 150ms for the live read instead of 1.5s. The long budget only ever ended in that same total; coin selection still refuses a real shortfall.
- **Post-sign spender probe skips unmined parents.** A confirmed foreign spend needs a mined parent, so inputs whose parent rides the BEEF as a raw tx without a proof (this wallet's unconfirmed change) are no longer probed on WhatsOnChain. Txid-only or missing parents are still probed.

### Added

- `[spend] lease|balance|input_fate|internalize done <N>ms` timing lines; triage folds them into `toolboxSteps` as `spend.*` rows and Jev can name `network_waits` as the signing-time owner.

## [1.3.373] - 2026-09-29

BSV-21 conformance pass against BRC-162 / BRC-163 / BRC-176 (Jev audit, 22 clauses).

### Fixed

- **Receive verifies lineage (BRC-176).** `internalizePeerFungibleSettle` now walks every accepted tip to its deploy with per-id conservation before `internalizeAction`, filling token-parent bodies from local/network raw transactions. An unprovable tip is refused as `lineage-unproven:<reason>` instead of painting a balance from the sender's claim. `sym` / `dec` / `icon` are inherited from the proven deploy (binary CBOR or JSON body), not the envelope.
- **Combine / self-send no longer forgets the token.** A payee that resolves to this wallet keeps its output in basket `bsv21` (`payeeIsSelf`), and the card is repainted with every held output. Previously combine sent the full amount to a basket-less output, change was 0, and `paintFungibleAfterSpend` dropped the card with no recovery path.
- **Non-plain locks refuse before signing (BRC-163).** Every selected input's rest script is classified (`chooseBsv21BatchSendPath`) before `createAction`; cosigner, covenant and unknown locks are a named refusal. Listed tips now carry `cosign` detected from the script.
- **Market listing proof is a record, not a claim (BRC-176).** `buildBsv21ListingProof` emits `v:176` only after `prove()` succeeds over a token-parent-complete BEEF; missing BEEF or a failed walk is `ITEM_ORIGIN_UNPROVEN` (it used to fall through to `deployOutpoint = tokenId`).
- **Issuer attestation** requires the Sigma signer address to *be* the claimed issuer; a Sigma block by anyone else no longer marks a remittance claim attested.
- **`dec` propagates** from the token card through send remittance, burn change, the Activity row and the peer envelope (was hard-coded `0`).

### Changed

- `prove176` decodes both BRC-161 JSON and BRC-162 binary (binary wins per output) so mixed lineages prove; `burn` counts toward outputs and contributes nothing as an input; authority paths still fail closed by name. Limits are split into `MAX_PROVE_DEPTH` (256) and `MAX_PACKET_TXS` (2048); tripping either reads *unproven*.
- BRC-162 CBOR reader consumes every well-formed item (negatives, arrays, floats, tags, 8-byte lengths, indefinite lengths) and ignores unknown keys, per spec; it used to reject the whole token for any type it did not model.

## [1.3.372] - 2026-09-29

### Changed

- Signing and script checks run on `@bsv/verifast` (libsecp256k1 + the BSV BDK script engine in WebAssembly) once it has loaded: about 8× faster to sign and 12× faster to verify than the pure-JS SDK in Chromium. `cryptoBackend.ts` registers it as the SDK's backend (P2PKH signing, BRC-42 derivation) and hands it to the Toolbox as `scriptVerifier`. Until the module is warm the JS path runs; once selected, its verdict is final. CSP allows `'wasm-unsafe-eval'` (WebAssembly compilation only).
- App `createAction` / `signAction` read the balance once before consent. Auto-approved payments used to read it a second time back to back, and each read may wait out its 1.5s budget — about 1.8s median preflight while the phone had HandCash in the background.

### Added

- Slow Wallet Toolbox steps log as `[toolbox] <step> done <N>ms` (`toolboxTelemetry.ts`). Triage splits app actions by method and page visibility (`workByVisibility`), summarises Toolbox steps, and asks Jev which step owns signing time.

## [1.3.371] - 2026-09-29

### Fixed

- App `createAction` could sign against coins an explorer had already confirmed spent elsewhere; the reply carried a txid, the miner reject retired the output, and the next call (list the mint) found nothing. The wallet now probes inputs after signing (`createActionInputFate.ts`), hides confirmed-foreign-spent coins, fails the dead local tx, and signs once more with live coins. A hard miner reject no longer releases those coins back to spendable.
- Background BEEF assembly for a miner chase held the toolbox storage-provider lock in front of the next `createAction` signature (a timeout did not release it). Hydration now skips the local walk while a send needs storage (`spendNeedsStorage`), and one miner round per txid is shared by every joiner.
- Self-buy (buyer and seller on this device) folded both sides of the settlement into one Activity record and hid the sale. Purchase and sale now stay separate rows; the sale + proceeds are recorded at buy time instead of only on the deferred seller sweep.

### Changed

- Activity rows: a txid means the send is assumed. "Signed" until a chain proof moves it to Unconfirmed/Confirmed — miner acceptance no longer paints a pending state.
- BSV-21 market copy: permission prompt and Activity show `Buy 1,000 SYM` / `Bought` / `Sold` / `Listed` with the token icon (listing `icon` or BRC-150 provenance fallback) instead of generic "market collectable".

## [1.3.370] - 2026-09-29

### Fixed

- Demo / BRC-100 app loading no longer hangs on a “broadcasting” phase waiting for Arcade. `createAction` / `signAction` stay on preparing through sign, clear when preparing ends, and return once the Atomic BEEF is packaged; cheque archive + miner cashing run after the HTTP reply (`funnelAppSignedCheque` starts background propagation).

## [1.3.369] - 2026-09-29

### Fixed

- BSV-21 burn failed with rotating excuses (`Token inventory… while wallet repair is active`, then `action batch outputs are no longer spendable`). Burns now light-promote fee coins, recover tips from session/network BEEF (not only local), fall through to the same live-tip list send uses, retry once after healing sealed parents, and market buys paint the new tip so the Tokens card is not stuck on the sold outpoint.

## [1.3.368] - 2026-09-29

### Fixed

- Market sold-announce was refused `seller-payment-mismatch`: the overlay expected a separate 1-sat deposit refund at output 3, while the wallet (and list-time SINGLE unlocks) fold that sat into seller proceeds at output 1. Overlay now matches the wallet shape.
- BRC-100 mapped a freed spend region (`The send stopped responding`) to `INSUFFICIENT_OR_STALE_FUNDS`, so a BSV-21 demo buy looked like an empty wallet. It now returns `SPEND_REGION_ABANDONED`.

### Changed

- Newly painted collectables (Activity, inbox, market buy) jump the BRC-150 verify queue immediately — no wait for opening the item. Item market purchases await tip→origin prove before `COMMITTED`; BSV-21 buys refresh token inventory before answering.

## [1.3.367] - 2026-09-29

### Fixed

- Miners no longer sit on any reply. The toolbox awaited an Arcade `postBeef` inside every `internalizeAction` for a new txid and refused the payment on a miss — 4.7s per bounce refund, and an Arcade outage turned an SPV-valid payment into a refusal. The wallet now credits from the BEEF and posts to miners after the reply (`internalizeMinerDeferral.ts`); its own miner rounds still go to the configured service.
- A market listing waited on `propagateSignedSend` (5.4s "miner accepted") before returning the advert, and a purchase waited up to 5s for an acknowledgement. Both now register the signed cheque, send `BROADCASTED`, and propagate in the background like cancel and every other signed send; a late hard-reject rewrites the row through the existing lifecycle.
- `broadcastAtomicBeef` joins an in-flight round for the same txid instead of paying a second multi-provider RTT.

## [1.3.366] - 2026-09-29

### Fixed

- The first app `createAction` of a session spent ~19s proving every parent before it answered. The wallet now tells the toolbox `trustSelf: 'known'` and attaches local parent bodies itself, and a bounce refund no longer holds the deposit's reply.
- A listing of a freshly inscribed item was refused `invalid-previous-item-tip`. The advert BEEF now includes the spent output, and the overlay accepts an ord envelope whose spendable branch is P2PKH.

## [1.3.365] - 2026-09-29

### Changed

- The push gate (`.cursor/hooks/require-version-on-push.mjs`, `.githooks/pre-push`) runs `tsc -p tsconfig.json --noEmit` after the version check and denies the push with the first error. This is the same check every release job runs; it now happens before the phone gets the build.

## [1.3.364] - 2026-09-29

### Fixed

- 1.3.363 answered every bounce-deposit `createAction` with `INSUFFICIENT_OR_STALE_FUNDS · actionArgs is not defined` after the deposit had already been signed and handed to miners: the bounce continuation read a variable scoped inside the spend. It now reads the request itself, and nothing after the signed spend can turn it into an app-visible error.
- A refused market listing showed a fixed "amount or origin mismatch" sentence whatever the overlay actually said. The row now shows the overlay's own reason.

### Changed

- The wallet logs the overlay's refusal (`[market-list] publish failed txid=… reason=…`) when an app reports it back, and every refused bridge reply is a triage fact: `appFlow.refusals` (method, code, wallet detail, repeat count, or the overlay's code), with Jev asked which refusal to fix first and on which side.
- `git push` to master now typechecks the UI core, and `scripts/build-apk.sh` refuses to bundle a core Desktop's release CI would reject.

## [1.3.363] - 2026-09-29

### Changed

- A transaction-bounce deposit now finishes inside the wallet. System Chrome freezes the page the moment HandCash is in front, so the page never starts the refund until the user tabs back. After the deposit is signed, the wallet posts it to the app's `/v1/tx-bounce/refund` and credits the refund itself. The page's later call reads the cached refund and accepts an output that is already credited.

## [1.3.362] - 2026-09-29

### Changed

- Bridge action lines now carry `page-gap <ms> (<origin>)` — the time between the wallet answering an app's previous action and the app sending its next one — so a connected-app flow that only moves when the user re-opens the browser is attributed to the page, never to approval or wallet work. Triage reads it as `appFlow` (steps, page stalls ≥20s, longest gap by origin) and asks Jev who held the flow up.

## [1.3.361] - 2026-09-29

### Fixed

- A newly minted token keeps its icon. Issuance paints the token from the
  BRC-162 lock, and that paint was dropping the icon the payload names, so
  Collectables showed the placeholder. The icon outpoint now rides on the
  painted token. Bytes already kept as the inscription's item art are used
  as the token face. A lookup that missed before the transaction was stored
  no longer hides the body, and a provider 404 on a mint the indexer has not
  seen yet is not pinned as "this transaction never existed".
- The in-app browser keeps running while the wallet covers it. Approving a
  request and staying on the wallet was freezing the page, so the reference
  app's next transaction (the token mint bound to the icon) did not start
  until the browser was brought back.
- The app mark on the left of an Activity row no longer redraws. The badge is
  16px and was rejecting every favicon that small, then retrying and blanking
  the mark on a timer.

## [1.3.360] - 2026-09-29

### Changed

- Changelog only: the 1.3.359 build shipped with the bump placeholder in
  place of its note. No wallet code changed since 1.3.359.

## [1.3.359] - 2026-09-29

### Fixed

- Received tokens now show their icon in Collectables. Icons resolved only
  from transaction bodies this wallet holds, and a token someone else issued
  names an icon on the issuer's inscription transaction — never local — so
  every received token painted blank. When the body is not held, the wallet
  fetches the raw transaction by txid from its own providers and checks it
  hashes to that txid before decoding the image. Still no indexer `/content/`
  and no identicon; a transaction nobody has is remembered as a miss, not
  re-asked on every paint. Deploy metadata recovery (symbol, decimals, issuer)
  uses the same lookup.
- Activity no longer lists an app request before the user approves it. The
  permission prompt is the request's whole presence until then; denying it
  leaves no row.
- Activity no longer flashes "Unconfirmed" as a request finishes. The
  synthesized live row read its own placeholder as a chain record once the
  transaction had a txid; it now keeps the action's phase (Broadcasting,
  Verifying) until the durable row lands.

## [1.3.358] - 2026-09-29

### Fixed

- The failure closure (1.3.356) stopped one hop short when a descendant was
  already on chain: it kept that transaction but still failed the live
  transactions that spent it, and the live parent it was built on — restoring
  outputs the chain has consumed, which is the doubled balance one hop further
  down. A confirmed descendant is now a cut: it stays, its spends stay, the
  live ancestor it spent stays; a sibling that spends the failed transaction
  directly still fails.
- A token or item deposit whose package spends a transaction nobody has no
  longer retries forever. The wallet holds the body, so the hint counted as
  deliverable; but a parent absent at every provider and positively absent on
  chain means the package can never be internalized or broadcast. After the
  two-hour grace the row retires as "Unavailable — spends a transaction the
  network never saw". Silence about the parent keeps retrying, and a later
  envelope carrying it revives the hint (hc-a580a, `438497125f03` →
  `6aa054b3`, pending 47 h).

### Changed

- The failure closure is a pure plan the storage layer executes:
  `planFailureClosure` names what fails (leaves first), what is kept and the
  one reason for each (`onChain` / `ancestorOfOnChain`), and which dead
  transactions' outputs to retire again. Chain answers are a tagged
  `present | unknown`; only `present` is evidence.
- Settle results carry `missingParents` structurally; the inbound hint fate
  kernel takes a `missingAncestor` fact with the parent's own durable lookups.
- One fewer runtime compatibility accessor call (ratchet 195 → 194).

## [1.3.357] - 2026-09-29

### Fixed

- The status pill no longer keeps its own phase clock beside the action
  lifecycle. It paints that action, and it goes idle the moment the action
  has a txid — sealing and notifying the payee do not bring "Broadcasting"
  back. There is one 90-second watchdog: an unsigned stall still aborts the
  spend; a signed one settles. Approving a bridge action no longer starts a
  second wallet action alongside the request's own.

## [1.3.356] - 2026-09-29

### Fixed

- Failing a local transaction is now a closure, not a row. The toolbox fails a
  transaction alone — it restores that transaction's inputs and retires its
  outputs, but a live child that already spent one of those outputs keeps its
  status and its change stays spendable. Both were counted at once: the
  balance doubled (hc-a580a: 4,323,084 → 8,652,598 sats), a consolidation
  swept the phantom change into one output, and the next send died because a
  failed parent cannot be sourced for the BEEF. Every live local descendant of
  a failed transaction now fails with it — leaves first, then every output of
  a dead transaction an orphan spent from is retired again, so the toolbox
  releasing a child's inputs cannot resurrect a dead parent's outputs. A
  descendant the chain already has is left alone and named: it proves the
  parent verdict wrong. The pass runs at the head of chain ingest, before
  every send's coin selection, before consolidation measures the pool, and
  inside the wallet's own fail path.
- Change consolidation only collapses settled change. A fragment whose own
  transaction the chain has not decided (`unproven`, `sending`, `nosend`, …)
  stands the pass down (`unsettledChange`) — a self-payment built on a parent
  still in flight only deepens what one failed parent can take down. If
  storage cannot say which local transactions are unsettled, the pass does not
  run.
- A third-party app's `listOutputs` on a token or item basket no longer stalls
  silently when the toolbox is slow. The view gate ran an unbounded 1000-row
  basket read *before* checking whether the origin was already granted — with
  storage held, the wallet demo's "read token and item inventory" sat for
  minutes with no prompt, no log line and no reply. Granted origins now answer
  from memory; a new prompt names its tokens or collections from a read
  bounded to six seconds, falling back to the basket the wallet last painted.
  A gate still open after eight seconds names itself in the log.
- Activity rows no longer read "Broadcasting" or "Verifying" with a spinner
  after a payment is signed. Signed is a fact: once the action has a txid, the
  row projects the transaction's standing (sent · unconfirmed · confirmed ·
  failed) and whatever the wallet still files afterwards — hand-off, sealing,
  notifying the payee — is not the row's story. The stuck watchdog settles a
  signed action instead of painting "Timed out while broadcasting" over a
  payment that went through; a later Arcade rejection repaints the row through
  its record.

### Changed

- Live-phase text in Activity no longer grows and shrinks. The row-state slot
  breathes in opacity only; nothing scales.

## [1.3.355] - 2026-09-29

### Fixed

- Collect no longer keeps a card the basket has stopped listing forever. The
  short-page guard (there so a half-restored database cannot wipe the grid)
  treated the cache as the truth whenever the basket returned fewer rows than
  cached, so one stale card made every later read "short" and the card never
  left — the log showed `kept 21 cached item(s) while basket listed 20` on
  every pass. A card omitted from three consecutive complete basket reads
  spanning five minutes, and absent from the address scan, is now retired.
  Empty pages, truncated pages, seeded tips and protected tips are never
  judged.
- A basket read deferred because chain ingest held the wallet now runs once
  the wallet goes idle instead of quietly serving the cache. Ingest asked for
  the list while it still held the region, so its own request always deferred
  and the grid only reconciled on the next visit or five-minute poll.
- Returning to Collect within 30 seconds of a real basket answer reuses it
  instead of reading `1sat` and `bsv21` again.

## [1.3.354] - 2026-09-29

### Changed

- Activity is a projection of one action lifecycle. Every action that can end
  in a transaction — an app's `createAction`, a wallet send, a listing, a burn,
  a receive — walks the same chart (approving → preparing → signing →
  broadcasting → verifying → settled | failed), and each row carries that one
  state in `data-aeon-state`. An approved app request appears as a row the
  moment the prompt opens and advances through signing to its settled record;
  a wallet send's row is joined to its live phase by the id it was written
  with, never by time, amount, or label sniffing. The heuristic "Sending…"
  live-row merge is gone.
- A self-mint verifies its BRC-150 lineage from the transaction the wallet
  just signed, so the card reads as proven when it appears instead of waiting
  on an indexer that has not seen the transaction yet.

## [1.3.353] - 2026-09-29

### Fixed

- A token or item deposit whose sender shipped a lean package no longer sits on
  Receiving forever. The toolbox refuses any Atomic BEEF whose unproven parents
  are absent ("a complete, exactly framed Atomic BEEF transaction"); settle
  now folds those parents in first — our own signed bodies, then a proven copy
  — and internalizes the completed package. A parent nobody can supply yet is
  a named `ancestry-incomplete:<txid>` refusal that retries, not a permanent
  one (hc-a580a, `438497125f03`, pending 46 h).
- Triage: token-deposit facts count parents folded in and name parents still
  unavailable; Jev can now say `parent_unavailable` instead of `settle_refused`.

## [1.3.352] - 2026-09-29

### Changed

- The feature map now documents the 1Sat stack an integrator builds on:
  BRC-147 storage profile, BRC-150 provenance, BRC-164 held-row key, BRC-165
  view and spend grammar, the fail-closed view rules, and the `oneSat`
  capability block `GET /health` and `GET /manifest.json` advertise. Views are
  described as they behave: tags plus `originVerified`, never provenance BEEF.
  Each task page now links its published `.md`. Mirrors docs.handcash.io.

## [1.3.351] - 2026-09-29

### Changed

- The BRC wallet feature map now leads with the path to hand an integrator:
  auth, payments, items, and plain BSV-21, plus ordinary signing. Certificates,
  identity discovery, and key-linkage reveals stay on the map as forwarded and
  unproven, and cosigned token tips are called out as not that path.

## [1.3.350] - 2026-09-29

### Added

- `docs/brc-wallet-feature-map.md`: a docs-site page mapping every Connect,
  Items, and Wallet API feature to the BRC-100 call that does the same job on
  the BRC wallet, with the "no equivalent" rows stated plainly. It also
  documents how BRC-100 grows in three layers (core methods, protocols carried
  by those methods, HandCash-only methods), what `GET /health` and
  `GET /manifest.json` advertise, and how an app feature-detects extensions
  without ever triggering a prompt.

## [1.3.349] - 2026-09-29

### Fixed

- Legacy address ingest no longer freezes the window right after the scan line.
  Classifying the scanned outputs walked every unrecognized one-sat and, once its
  backoff had expired, rewrote the whole miss map through synchronous storage
  once per tip. Expired misses are now dropped in memory and written once, and
  the walk yields back to the UI on the same budget as the rest of ingest.
  `[chain-ingest] classify done Nms` is logged when that walk exceeds 250ms.

## [1.3.348] - 2026-09-29

### Fixed

- Activity no longer paints phantom "Signed / Approving" rows above transactions
  that already settled. Two records for one spent txid (an app-origin "Paid" row
  beside the wallet's own row) shared a single feed key, and React kept stale
  rows on screen under the colliding key (`Encountered two children with the same
  key` was the last line before an 8.7s freeze in local triage). Record keys are
  now unique per feed, and a send that completes after its pending row was swept
  settles onto the transaction's existing row instead of writing a second one.

### Changed

- `npm run triage desktop-local` triages this machine without an upload: the
  renderer ring mirrored in `durable-prefs.json` plus the electron `main.log`.
  Triage now extracts activity facts (stuck-row census with `item=`, placeholder
  writes, sweeps survived), React duplicate-key facts, and BRC-100 bridge facts
  (per-method latency, error codes, renderer-not-ready); `--file` triages a saved
  upload body.

## [1.3.347] - 2026-09-28

### Fixed

- A token or item self-send that echoed back through the inbox could sit on
  "Receiving" forever with no Sent row beside it. `selfSendReceive` now settles
  the echo once the original send has had a minute: a cheque whose inputs can
  still land is broadcast again and its missing Sent row (to myself) restored;
  a spend that is already dead — proven competing input spend or Arcade
  hard-reject — hides the receive and suppresses the txid so the next poll
  cannot pin it again. Explorer absence alone never hides it. Runs on every
  refused self-send settle and on each chain-ingest pass.

## [1.3.346] - 2026-09-27

### Fixed

- A self-send of a BSV-21 no longer stays on Receiving. The payment and the
  change are both outputs paying the same address; when they carry the same
  token amount, settle treated the second as ambiguous and refused the whole
  transaction (hc-a580a, 438497125f03, 500 out and 500 back). Every output that
  pays us that amount is internalized.

## [1.3.345] - 2026-09-27

### Changed

- Restore: the history recovery page is a live progress view driven by
  `historyRecoveryMachine` — probe, then wipe → reboot → download → merge →
  recompose → balance, each stage reported by the domain path as it runs, with
  the legacy-password ask and retry as chart states instead of a static page.
- Collect hierarchy is now issuer identity → tokens → items. A `$handle` that
  minted both a fungible and a set shows once: its tokens sit on a horizontal
  row carousel of circle faces (symbol and balance underneath, same shelf in
  grid and list view), its collections and loose items stack under them.
  Tokens-only issuers get a folder of their own; tokens with no issuer keep a
  top shelf. Folder meta reads "2 tokens · 12 items · 3 verified".
- Fungible cards are circles in both views; Send / Burn live in the token's
  details face.

### Fixed

- Inside an issuer folder the item grid is pinned to two columns with fluid
  media, so two cards fit any panel width; the auto-fill grid used to collapse
  to one column behind the folder's padding.
- One-sat tips of a fungible no longer paint as NFTs: the Tokens shelf now
  claims every held tip (`tipOutpoints`, `heldTips`, every member deploy id)
  and any `application/bsv-20` tip, not just the representative outpoint —
  and the split re-runs when the fungibles cache hydrates.

## [1.3.344] - 2026-09-27

### Fixed

- Multi-wallet, second lock: `staleOutputRelease` resolves every wallet
  through `pinnedActiveWallet()`. The pinned wallet's `storage` — and the
  provider handed out inside `runAsStorageProvider` — throws `AbortError` the
  moment its runtime is disposed, so 3k lines of repair code cannot write into
  the next account without a guard past every await.
- `refreshFromChainExclusive` captures its runtime and guards each mutation
  phase (nosend release, action-batch abort, maintenance, legacy ingest,
  spendable audit); an aborted pass returns quietly instead of stamping an
  error onto the account that did not start it.

## [1.3.343] - 2026-09-27

### Fixed

- Multi-wallet: a heal pass is pinned to the vault account it started on.
  `runUtxoHealPass` captures the `WalletRuntime`, re-asserts it after every
  await (`AbortError` on change) and keys its checkpoint by that account —
  never the ambient one. Field case hc-a580a (2026-09-27): a manual heal begun
  on one account finished on the next, rehid 78 inputs, reclaimed ~25 of the
  first account's txids against the second account's toolbox and wrote the
  skip list there; the second account then read 0 sats and timed out on
  `listOutputs`.
- Account switch owns the ordering: dispose the runtime (aborts every pinned
  occupant), await chain ingest idle (bounded, 8 s, logged on timeout), then
  boot. The switch is logged (`[vault-account] switch from → to`).
- Heal singletons are per runtime: `isUtxoHealRunning` answers for the current
  account only, the manual-heal dedupe promise and the chained change-heal
  state (stuck sats, cooldown, in-flight) no longer leak across accounts.
- Sync-health binding moved into the wallet runtime lifecycle so it rebinds in
  the same tick as every other account store.
- Judged with Jev on extracted facts: contamination 0.67 → 0.37; root-cause
  confidence 0.59 → below review threshold.

## [1.3.342] - 2026-09-27

### Changed

- Vendored `@aeon-ui/tree` (aeon-ui-engine 1.8.0) into `vendor/aeon-ui-engine`.
- `ExclusiveActionRegion` renders the `asyncAction` mutation face once through
  `exclusiveActionWidget`: form root with chart state, error line, primary with
  pending label, secondary, and the `AsyncActionPrompt` slot. Change password
  and Add friend use it instead of restating that chrome.
- `exclusiveActionRegion.test.ts` asserts every `asyncAction` state has a face.

## [1.3.341] - 2026-09-27

### Changed

- One chart for every panel mutation. `activityActionMachine` is now the generic
  `asyncActionMachine` (`useAsyncAction<Kind>()`, `AsyncActionPrompt`): idle →
  confirming → busy → idle | failure, with the confirm copy held in chart context.
  Sixteen panels dropped their `busy` / `submitting` / `checking` / `combining` /
  `forgetting` / `uploading` booleans and `try/finally` plumbing for it: Add friend,
  Change password, Confirm password gate, Onboard protect, History recovery,
  Import phrase, Log viewer, Unlock settings, Wallet backup, Wallet health,
  Collectable details, Fungible details, Messages, Create-keys backup, Wallet setup.
  Buttons project `data-aeon-state` from the chart; sibling buttons disable together.
- `sendMachine` owns the pre-review balance check as `editing.checking`
  (`CHECK` / `REFUSE`); the form stays mounted, Review locks, a refusal returns to
  `editing.idle` with the draft intact.
- `assetBurnUiMachine` gained `forgetting` (`FORGET` → `FORGOTTEN` | `FAIL`).
  Burn and local forget are now exclusive in the chart and the "Forgetting…"
  label is actually reachable — before, `FORGET` closed the chart and hid the button.
- Import phrase "Forget pending import" and Wallet backup "Rotate slices" and
  Fungible "Combine tips" confirm through the Aeon `Prompt` compound driven by the
  chart's `confirming` state; the last `window.confirm` in the renderer is gone.

### Fixed

- Device-unlock dismissal in the confirm-password gate no longer passes through a
  failure state; it simply falls back to the password factor.
- Wallet setup "Continue" and Create-keys "Replace slice set" no longer carry a
  busy flag that was set and cleared in the same tick.
- `scripts/ui-facts.mjs` recognises `useAsyncAction<'kind'>()` as a chart binding.

## [1.3.340] - 2026-09-27

### Fixed

- Payment details: retry, clear, take-back and unlock could overlap — the
  retry button only checked two of the four in-flight flags. One
  `activityAction` chart holds the single running action, so every sibling
  button disables for the same reason and the failure reason lives in the
  chart, not a parallel `useState`.
- Activity header: rebroadcast-all, clear-all and publish-pending each only
  disabled themselves and could run against the same failed-spend set at
  once; the same chart keeps them exclusive. A rejected publish now surfaces
  a toast instead of resetting silently.
- QR scanner and app-browser launcher projected a raw machine `.value` onto
  `data-aeon-state`; both go through `stateToAttr`.

### Changed

- Every `window.confirm` in Activity is an Aeon `Prompt` opened by the chart's
  `confirming` state (`ActivityActionPrompt`).
- `npm run ui:review`: Jev (TypeSafe System One) reviews changed components
  against the Aeon trajectory. Code extracts every fact
  (`scripts/ui-facts.mjs`); Jev answers narrow typed questions; code composes
  a 0–4 debt score and a ladder-ordered fix. Baseline over 102 components:
  two needed attention, both fixed here.
- Aeon ratchet gains two allowlists that only shrink — exclusive busy
  booleans and raw `.value` projections — sharing the fact extractor with the
  review. Skill: `.cursor/skills/jev-ui-review`.
- Triage and review scripts accept `JEV_KEY` as well as `JEV_API_KEY`.

## [1.3.339] - 2026-09-27

### Fixed

- An Arcade rejection inherited through a chain of parents now names the
  root ancestor and the miner's own reason. Nesting "ancestor X rejected:
  ancestor Y rejected: …" ran past the 240-character cap by the second
  generation and cut off the reason — Jev on 0.1.511 saw 30 refused
  transactions under six roots with every root reason truncated, so nothing
  could say why four coins were quarantined.
- The UTXO evidence heal names the outpoints it quarantines, so triage can
  join them to refused chains in code.

### Changed

- Log triage derives custody facts: miner refusals grouped by root ancestor
  with the root's reason, re-asked verdicts, heal runs and quarantined
  coins, and whether quarantined coins are outputs of a refused transaction.
  Jev answers why the chain was refused and what to do about the quarantine.

## [1.3.338] - 2026-09-27

### Changed

- A BRC-100 prompt that pulled the wallet in front of the browser hands the
  desktop back once it is answered and nothing else is waiting. The request
  keeps processing while the wallet is hidden (background throttling is
  already off), so the app the user was in — the wallet reference demo, a
  game, a market — continues in view instead of behind the wallet. A prompt
  approved from inside the wallet never hides it. macOS hides the app;
  other platforms give up focus.
- Bridge `createAction` / `signAction` / `internalizeAction` log their phases
  when wallet work passes 250ms: `[brc100] createAction done <N>ms —
  preflight · spend · package · cheque · seal`, with the user's approval time
  beside the span, not inside it. Triage can now name which part of the tx
  step an app waited on.

## [1.3.337] - 2026-09-27

### Fixed

- Script probes no longer assemble a toolbox BEEF. Legacy scan, BSV-21
  deploy caps, encoding proofs, legacy-tip recovery, icon hydrate and the
  change-script sweep only need one output script, but each asked toolbox
  storage to build the full ancestry with merkle paths — synchronous
  IndexedDB on the renderer thread, once per scanned UTXO. Jev on 0.1.510
  still put 89% of blocked time inside `beef local-lookup`, with the same
  txids answered from `toolbox-storage` burst after burst. Those callers now
  read the raw body (two indexed rows), memoised for the session.
- The session BEEF cache holds trees, not txids. A forty-hop lineage took
  forty of two hundred slots, so a launch that walked a few lineages evicted
  what it had just loaded and went back to the toolbox. Each tree is stored
  once as compact bytes, indexed by every transaction it contains, and a
  confirmed local absence is remembered for five minutes instead of one.

### Changed

- Log triage: a timed span longer than sixty seconds is a wait (hidden
  WebView, storage lock), not work. It is reported as `waitsExcluded` and no
  longer absorbs every freeze that happened meanwhile — one 439s lookup had
  been credited with 22 unrelated freezes.

## [1.3.336] - 2026-09-27

### Fixed

- Opening Collectables no longer re-walks local BEEF storage for every hop.
  Jev on 0.1.509 put 97% of blocked time inside `beef local-lookup`: each miss
  parsed every cached tree and all 16 durable bodies, then ran a synchronous
  toolbox scan, and the same txid was asked again by the next hop. A miss is
  now one map lookup, the durable index is parsed once per change, identical
  lookups join one in-flight read, and a confirmed absence is remembered for
  a minute. While chain ingest is active the collectables screen skips the
  toolbox scan entirely and uses the network fetch it was already going to
  make.

## [1.3.335] - 2026-09-27

### Fixed

- The signed-cheque archive — the largest key on a phone (888KB on the lab
  device) — is parsed once per stored value instead of on every local BEEF
  lookup. Encoding proofs, deploy-cap lookups, stale-output restores and outbox
  checks each re-parsed it synchronously, multiplying main-thread time by every
  held tip. Same identity-keyed memo the Activity store already uses; the one
  writer copies before mutating so a refused save cannot poison the shared rows.
- Token list work yields to the UI between tips: per-row decode (Sigma
  signature checks), per-token deploy-cap BEEF walks and per-card chain-fate
  probes now hand the thread back whenever the 24ms hold budget is spent.

### Changed

- Token list phases are timed in the log — `activity-recovery`, `basket-read`,
  `tip-decode`, `deploy-caps`, `live-tokens`, `legacy-tip-recovery`,
  `chain-fate`, `encoding-proofs`, `icon-hydrate` — alongside `[beef]
  local-lookup` (naming which store answered) and `[stale-output] restore`
  (proof vs storage split). Only phases over 250ms log, so the next upload
  attributes freezes to a phase without anyone reading the file.
- `npm run triage` now extracts workloads (blocked time inside every timed
  span), the last line before each freeze began, freeze bursts and origin
  storage pressure, and asks Jev for the freeze owner among the workloads code
  actually found, whether storage contributes, and which fix to make first.
  Concurrent runs of one workload are unioned so a share never exceeds 100%.

## [1.3.334] - 2026-09-25

### Fixed

- Payments no longer fail at random when storage is busy. The send gate gave the
  confirmed-balance read 1500ms and, with no previously proven total to stand
  on, refused the payment — while the abandoned read finished moments later and
  populated the cache, so the retry sailed through. Slow is now distinguished
  from failed: a read still in flight is waited out to a hard 8s ceiling, and
  only a genuine read failure refuses the send.
- The send gate no longer manufactures the storage contention it times out on.
  `assertSendableBalance` read confirmed spendable up to four times per payment,
  each an uncoalesced toolbox read queued onto the same IndexedDB alongside the
  display poller. All confirmed reads now join one in-flight read per wallet.
- The spend-failure diagnostic snapshot is coalesced too. It is taken exactly
  when a payment fails, so its two fresh reads were deepening the queue they
  were measuring.

## [1.3.333] - 2026-09-25

### Fixed

- Mobile origin storage no longer lets reconstructable item art and token icon
  caches crowd out custody-critical UTXO locks, derived-change remittance, BEEF,
  queues, or user history. Storage records are authoritative by default; only
  registry entries explicitly marked `rebuildable` may be reclaimed after a
  quota refusal, then the exact wallet write is retried once.
- Item art and token icon caches now have total byte budgets, not only entry
  counts. A few large bitmaps can no longer consume Android's shared ~5MB
  origin quota.
- Settings → Logs batches live updates and renders only the latest 300 lines.
  Copy and Upload still include the full session; diagnostics no longer create
  their own idle long task while support collects a busy log.

## [1.3.332] - 2026-09-25

### Fixed

- Transaction history no longer rewrites every row through a synchronous write
  on each status change — the same whole-blob-per-mutation shape that froze the
  UTXO overlay, now coalesced to one write per task.

### Changed

- Freeze reports name the step, not just the layer: `active: chainIngest · in:
  restore-spendable`. Chain maintenance runs several steps at once, so the
  report lists every one in flight.
- Freeze reports attribute the block to what was running when it *started*.
  Sampling at detection time named whatever the wallet moved on to once the
  thread came back, which is usually not the step that blocked.
- A synchronous durable read or write over 50ms now names its key and size, so
  one slow store stops looking like "the app froze".

## [1.3.331] - 2026-09-25

### Fixed

- The UI no longer freezes for seconds at a time after unlock. Sealing a
  transaction's inputs wrote the whole UTXO overlay to disk synchronously once
  per coin, inside loops that yielded every 8 iterations — eight full writes in
  one uninterrupted task (lab phone hc-a580a: 4s tasks at a 90% duty cycle,
  sustained for over a minute of recompose and chain ingest). The overlay write
  is now coalesced to one per task, and the seal loops yield on a time budget
  instead of an iteration count.
- The freeze detector stopped making freezes worse. It persisted the log
  synchronously on every detection, adding a blocking write per tick to the
  thread it was measuring.

## [1.3.330] - 2026-09-24

### Fixed

- Permission prompts and app requests no longer sit behind unlock recompose /
  BRC-39 work: history yields when a spend/permission hold is raised, and
  recompose yields paint turns around history and funding ingest.
- Stop re-sealing the same signed tx on every createAction. Crediting new
  change no longer invalidates the seal memo, and an already-sealed overlay
  skips the IndexedDB hide walk (lab: one tx sealed 16× while the UI lagged).

## [1.3.329] - 2026-09-24

### Fixed

- Arcade go-chaintracks no longer throws `TypeError: Illegal invocation` on
  Android WebView. Monitor `_init` → `getChain` was calling unbound window
  `fetch`; the client now uses a bound fetch wrapper.

## [1.3.328] - 2026-09-24

### Fixed

- Reverts accidental launch-default changes. Open in browser stays the default;
  Open in-app remains an explicit choice on every surface.

## [1.3.327] - 2026-09-24

### Fixed

- App `createAction` / mint progress no longer paints a stuck `Signed` /
  `Approving` Activity row. Bridge work uses a Working… pill only, and a
  completed mint earned row retires any leftover live outbound projection.
- Mobile Apps restores the in-app URL launcher and adds Back/Forward to the
  native wallet browser toolbar (same controls as Desktop's in-app panel).
- Fresh mint activity prefers the local inscription bytes for the card image.

## [1.3.326] - 2026-09-24

### Fixed

- A completed collectable send now retires its live `Approving` / `Signed`
  projection by exact outpoint even when the durable Activity row retains an
  older timestamp.
- Freshly issued collectables use the `Mint` action and `Minted` detail copy,
  keep each output's own name in multi-item transactions, and prefer the
  full-resolution inscription bytes already held by the wallet over an
  indexer thumbnail.

## [1.3.325] - 2026-09-24

### Fixed

- Timed-out Collect and Tokens basket reads no longer create replacement
  `listOutputs` calls while the uncancellable Toolbox work is still alive.
  Android had three reads stacked at 36s, 62s, and 83s; each repeatedly walked
  cached token restoration and blocked the renderer in four-second chunks.
  Callers now fall back to durable paint while the one raw read retains the
  single-flight lock, busy chain-ingest/recompose always serves cache, and a
  timed-out token read does not run evidence repair without live evidence.
- Collectables issued by an app `createAction` are recorded as `Minted`, and a
  later chain-ingest receipt merge preserves that classification instead of
  rewriting it to `Received`.

## [1.3.324] - 2026-09-24

### Changed

- Patch release (every push must ship a new version).

## [1.3.323] - 2026-09-24

### Fixed

- The main source of the lag and of slow app comms since 1.3.311. Ingest
  persists one BRC-150 remittance per item tip, and each of those re-read the
  whole durable cache, re-encoded it about ten times to decide whether it
  needed trimming, and wrote up to 384KB back to storage — quadratic work on
  the main thread, which is also the thread the BRC-100 bridge answers on. The
  trim search now runs only when the cache is actually over budget, the cache
  is held in memory instead of parsed per tip, and the write is coalesced to
  one per burst. A deferred write is keyed to the account it was read from, so
  an account switch cannot land one account's cache under another's key.

## [1.3.322] - 2026-09-24

### Fixed

- Protected-basket `listOutputs` no longer fails a cold read that is still
  running. The 20s cap exists so a concurrent refresh can fill the durable
  paint; with nothing painted it abandoned a scan that does finish — a cold
  basket on a busy wallet has taken over 40s. The read is now held rather than
  raced away, and waited out to a 90s ceiling when there is no paint to serve.
- BRC-100 failures are always logged. `listOutputs` and the other chatty reads
  were on a quiet list that suppressed the line entirely, so a failed
  inventory read left no trace in the support tail.
- A BRC-100 handler that throws is logged before the shell turns it into a
  500. Previously only the return path logged, so thrown failures were silent.

## [1.3.321] - 2026-09-24

### Fixed

- The real UI lag regression from 1.3.314. Chat history was re-serialized on
  every read and every write to decide whether it needed trimming, and that
  decision is a binary search that re-encodes on each probe — a `log2(n)`
  multiple of a `JSON.stringify` over history allowed to reach 768KB. History
  that already fits is now returned after a single encode, and the trim search
  runs only when the blob is actually over budget.
- Parsed chat history is cached against the exact stored blob, so callers that
  walk every thread parse it once instead of once per thread.
- `markInboundPaymentStatus` makes one flat pass over history rather than
  reading it again for every thread while invalidating it on every update.
  This ran per transaction during chain ingest, which is what the multi-second
  `active: chainIngest` stalls were.

## [1.3.320] - 2026-09-24

### Fixed

- UI lag introduced in 1.3.314. The compact-layout store notified its
  listeners once on subscribe, which `useSyncExternalStore` reads as a store
  change during commit and answers with a synchronous, non-interruptible
  re-render of the subscribing subtree — in this case the whole activity feed.
  It also rewrote `layout-compact` on the document element on every resize,
  invalidating style for the entire document, and Android fires resize
  constantly for the URL bar, keyboard and system insets.

### Changed

- The compact-shell subscription moved from `ActivityFeed` down into
  `TopBarPopover`, so a layout change re-renders the popover rather than a long
  activity list. Panels hand the popover a `compactAnchorRef` and it owns its
  own positioning policy.

## [1.3.319] - 2026-09-24

### Fixed

- Identity proofs bind to the requesting host again. `normalizeOrigin`
  collapses every HandCash catalog host onto `handcash.io` so one view grant
  covers the market; handing that alias to the proof validator rejected honest
  proofs (`INVALID_IDENTITY_PROOF` from `brc-cloud.bcryderman.workers.dev`) and
  would have let a proof minted for one catalog host verify as another.
- Activity filters panel is sized to the header in JS (`matchAnchorWidth`)
  rather than through a CSS variable the positioner writes after measuring. A
  panel that missed that pass collapsed to the width of the toggle.

### Added

- `matchAnchorWidth` on Aeon `Popover.Positioner`.

## [1.3.318] - 2026-09-24

### Changed

- Patch release (every push must ship a new version).

## [1.3.317] - 2026-09-24

### Changed

- Replaced the placeholder changelog entries for 1.3.313 through 1.3.316 with
  what those releases actually changed.

## [1.3.316] - 2026-09-24

### Added

- Aeon `FloatingPositioner` / `Popover.Positioner` accept an `anchorRef`, so a
  floating surface can align to the region it belongs to rather than to its
  trigger.

### Fixed

- Activity filters anchor to the activity header on compact shells. Hanging a
  420px panel off a 28px toggle pinned to the screen edge left the panel
  starting off-screen; the viewport clamp could only slide it back to the edge.

## [1.3.315] - 2026-09-24

### Fixed

- Change outputs whose raw transaction the device never kept are no longer
  written off permanently. `sweepChangeScripts` still quarantines a script-less
  row so `allocateChangeInput` cannot crash on it, but Refresh now rebuilds the
  locking script from the chain and returns the coin to the spendable balance.
  The rebuild runs between storage sessions, so explorer latency never holds the
  provider open, and each script is matched against its row's own satoshis. The
  spend path stays local-only.

## [1.3.314] - 2026-09-24

### Fixed

- Activity filters panel no longer renders off the right edge of a phone.

## [1.3.313] - 2026-09-24

### Changed

- Connect and connected-app screens show the permissions the wallet actually
  grants. The static eight-scope list advertised spending, signing, encryption
  and identity proofs as standing grants; those are per-action approvals.
  `grantedPermissionScopes()` is now the single source for what is displayed.

## [1.3.312] - 2026-09-24

### Added

- Every completed outgoing transaction now emits one wallet-level spend
  announcement. BSV, collectable, token, market, and BRC-100 app spends all
  converge at the settled Activity boundary, with transaction-id deduplication
  so a multi-item batch produces one notification rather than one per leg.
- The Mobile shell turns spend announcements into audible Wallet activity
  notifications while HandCash is backgrounded, matching existing receive
  notifications.

## [1.3.311] - 2026-09-24

### Fixed

- Mobile now reclaims every duplicate left by the old copy-only account
  migration as soon as any store for that account is read. Cleanup no longer
  waits for each feature to open, so cold stores such as the 536KB BRC-150
  remittance copy cannot keep the WebView pinned at its 5MB origin quota.
- Activity, Messages, and the BRC-150 remittance cache now have independent
  serialized-size budgets (512KB, 768KB, and 384KB). They retain the newest
  complete records and compact before writing, rather than discovering the
  limit only after origin storage refuses custody queues, miner retries, or
  diagnostics. Activity and Messages remain projections/history; transaction
  custody stays in Toolbox, signed outboxes, and BRC-39.

## [1.3.310] - 2026-09-24

### Fixed

- A BRC-100 app payment no longer refuses with "insufficient funds" on a
  funded wallet. Toolbox funding only draws on outputs whose parent
  transaction is `completed`, `unproven` or `sending`; an app that signs with
  `noSend` and never finalizes left that parent `nosend`, hiding the wallet's
  entire managed change while the balance still counted it. The wallet now
  frees change held behind any app parent the network has already accepted,
  before a Refresh aborts it and again if an app action cannot be funded.
- The transaction lookup behind every pin and change-promotion gate now uses
  the `txid_userId` index. A txid-only query degraded to a full cursor scan of
  every stored transaction and its raw body, which on a loaded phone came back
  empty; each gate read that silence as proof the transaction did not exist and
  gave up permanently, stranding the change of a broadcast payment. An
  unreadable store is now retried and never treated as an answer.
- Activity never projects a stale `Signed / APPROVING` placeholder, instead of
  relying on a cleanup pass that yields to live spends and needs a storage
  write a full store refuses. Those placeholders are also swept while a spend
  holds priority now; only priced rows wait, since only they could be the send
  still in flight.

### Changed

- The Transaction Bounce app and the BRC-100 reference demo let the wallet
  broadcast their BRC-29 deposit. `signAndProcess` returns no reference, so a
  `noSend` deposit could never be released by `processAction` — it is not a
  pattern other apps should copy.

## [1.3.309] - 2026-09-24

### Fixed

- Old zero-sat `Signed / APPROVING` placeholders are now removed after 90
  seconds. They name no amount, item, or transaction and are only abandoned UI
  state; priced sends still become explicit failed rows with their reason. The
  Activity feed retries cleanup every five seconds after spend priority is
  released, so a successful row arriving during a live spend cannot leave its
  approval placeholder painted forever.
- Mobile origin storage now removes old unscoped wallet values after their
  account-scoped replacement is present. Earlier migration copied rather than
  moved them; on the affected phone duplicate BRC-150 and message stores used
  over 1 MB and pushed the WebView to its exact 5 MB quota. That made custody
  retry queues, Activity cleanup, and diagnostic logs refuse writes.

## [1.3.308] - 2026-09-24

### Fixed

- Signing for a connected app is seconds faster on a device whose storage is
  full. The signed-cheque archive shed one cheque per attempt when a write was
  refused, re-serializing the whole megabyte-capped archive each time. A full
  store refuses every write regardless of size, so a single failed archive cost
  hundreds of serialize-and-throw passes — around four seconds of blocked main
  thread, twice per send, inside a `createAction` the app was waiting on. It now
  halves the archive per pass and gives up in under a dozen.
- Activity rows are no longer lost without a word when durable storage is full.
  The write result was discarded and the refusal also drops the cached value, so
  a payment that really happened could leave no row at all, and a stuck
  `Sending…` row marked failed reverted to pending on the next read. The oldest
  history is shed to make room instead — it is also in the BRC-39 replica — and
  a genuinely unstorable row says so.

### Added

- A refused durable write now reports storage pressure once a minute: total
  bytes held, key count, and the five largest keys. Below that layer callers
  only see `false`, so a full device surfaced as unrelated custody and Activity
  symptoms with nothing naming the cause.
- Outbound Activity rows stuck past 90 seconds are logged with their age,
  method, and whether the expiry pass reached them or yielded to a live spend.
  A stuck row is drawn exactly like a live send, so there was no way to tell
  debris from a hung spend.

## [1.3.307] - 2026-09-24

### Added

- Activity writes are traced. Every money row now logs whether it was written
  as a new row, merged into an existing one, or skipped — with the reason, the
  txid, and, for a merge, which row it landed in and when that row was first
  seen. A merge keeps the matched row's timestamp, so a receive folded into an
  older row does not surface at the top of the feed and is indistinguishable
  from a row that was never written at all. `internalizeAction` also says so
  explicitly when it credits no measurable amount and therefore writes nothing.

## [1.3.306] - 2026-09-24

### Fixed

- Money an app credited raised the balance but wrote no Activity row. A BRC-29
  remittance names the output it is paying into but not its value, and the
  toolbox answers a bare `{ accepted: true }`, so the bridge could not tell how
  much had landed and skipped the row, the receive sound, and the notification
  — only the balance moved. The credited amount was reported on one path only:
  re-internalizing a transaction the wallet already had. `internalizeAction`
  now prices the requested outputs from the BEEF it already parsed and reports
  the txid and amount on every path, which also lets change from the receive be
  kept for the next spend.
- Receiving coins raised no notification on Android. The shell turns a
  `handcash:receive` event into a system notification, but only legacy-address
  sweeps and item arrivals ever dispatched one; coin receives merely raised an
  in-app toast, which is invisible when the wallet is in the background. BRC-29
  receives, receives resolved by txid, and app-credited funds now announce
  themselves through `announceCoinsReceived`.

## [1.3.305] - 2026-09-24

### Added

- The bridge now checks its own `createAction` / `processAction` reply before
  returning it. A structurally wrong package still answers `200`, so it was
  invisible in our logs and surfaced only in the calling app's verifier — which
  is exactly how the dropped BRC-95 prefix in 1.3.304 went unnoticed. The reply
  is verified to be AtomicBEEF for its subject txid, re-framed when the subject
  is still recoverable, and logged as an error when it is not.

## [1.3.304] - 2026-09-24

### Fixed

- Apps could not parse the transaction `createAction` handed back. The reply is
  packaged as AtomicBEEF, then passed through `hydrateInputBeef` to fill in any
  missing parent bodies — but that shaper exists to build an `inputBEEF`, so it
  clears `atomicTxid` and returns plain BEEF. Those bytes were accepted
  unframed, dropping the BRC-95 prefix, and hydration returns on its first pass
  whenever the package is already broadcast-safe, so this was the common path
  rather than an edge case. Verifiers that re-derive the subject rejected the
  reply with "BEEF must conform to BRC-95 and must contain the subject txid".
  The hydrated package is now re-framed through `atomicBeefForSubject` before
  it is accepted, and the merged atomic package is kept when it will not
  re-frame. The same bytes feed `funnelAppSignedCheque` and the BEEF cache, so
  app-signed cheques and follow-up spends were carrying the unframed package
  too.
- Transaction details stayed on a skeleton forever for app transactions. The
  panel gated its whole body on an `iconReady` flag that only the event branch
  ever set, and that branch returns before the gate — so a row that was neither
  wallet-origin nor an item could never become ready. The panel now renders
  immediately and the avatar skeletons only its own slot, per `deferred-images`.

## [1.3.303] - 2026-09-24

### Fixed

- A payment received from a subwallet no longer goes missing from Activity.
  Activity is stored per account, and with no owner given it resolves against
  whichever account is bound at the instant of the write. Ingest spans seconds
  of awaits, so switching wallets during it filed the row under the account
  that was open rather than the one the coin landed in — balance correct, no
  row. Receive ingest now pins the owning account up front, as it already did
  for sync health and balance, across BSV, SPV-by-txid, item and BSV-21
  settles.
- `pinAccountKeyScope` returns no scope rather than throwing when a wallet
  carries no identity, so an inbound row can never be lost to account scoping.

## [1.3.302] - 2026-09-24

### Fixed

- Wallet repair no longer starves while a send is in flight. The change-script
  sweep checked the yield before its first batch, so a pass paid for the whole
  output scan and then returned having classified nothing — the next pass began
  in exactly the same place (`yielding mid-sweep — send waiting (scanned
  0/168)`). Every pass now classifies a short batch before it yields, so repair
  always moves forward; callers see `deferred` and stop reading a cut-short
  pass as completion.
- A sweep pass that healed nothing is logged instead of dropped, so a stalled
  repair is visible in diagnostics rather than looking idle.

## [1.3.301] - 2026-09-24

### Added

- Deep links now cover both vendor-neutral BRC schemes the wallet already reads
  from Scan and paste. A tapped `brc29:` settlement receipt opens the claim path
  (SPV internalize) alongside the existing `peerpay:` pay request; Android
  registers both. A malformed receipt refuses as `malformed-brc29` rather than
  falling through to `unknown-scheme`.

## [1.3.300] - 2026-09-23

### Fixed

- Wallet repair now finishes. The change-script sweep ordered every pass by
  coin size, so a block of rows whose raw transaction nobody has took the whole
  batch, and the rows behind them were never reached — each pass redid the same
  refusals. Refused rows now sort last, so every pass moves the sweep forward.
- A pass that healed nothing no longer ends the sweep while script-less rows
  remain unattempted; the diagnostic reports `attempted` and `remaining`.

## [1.3.299] - 2026-09-23

### Fixed

- BSV-21 burns no longer interpret a Toolbox read timeout during Heal as a
  zero token balance. They recover exact held tips from local Atomic BEEF and
  fail as inventory unavailable—not “0 available”—when neither source can
  prove a spend.
- Local BEEF recovery now considers every held tip on an aggregated token,
  rather than only its representative outpoint.

## [1.3.298] - 2026-09-23

### Fixed

- Build: drop the burn / list / cancel pending-label locals the settlement copy
  replaced. 1.3.297 failed typecheck, so it has no installers — use this.

## [1.3.297] - 2026-09-23

### Changed

- Activity and payment details now say **Signed** / **Unconfirmed** /
  **Confirmed** (with block depth when we have it) instead of “pending” or
  “Sending…”. That is the evidence on this device, not a processor queue.
- Wallet health calls leftover change unconfirmed. “Publish signed” is the
  outbox verb.

### Added

- SPV safety tests: silence is not cancel, missing parent bodies refuse a
  spend, and an indexer cannot clobber local history.

## [1.3.296] - 2026-09-23

### Changed

- A signed cheque is now accounted from local SPV at sign (`unsent` is live
  change for Pay; the dual-layer chart may enter mempool without a miner hop).
  Arcade pin remains the broadcast-hold so the next spend does not chain a
  parent no miner has seen. Headers plus unconfirmed bodies stay the store;
  explorers stay rumours.

## [1.3.295] - 2026-09-23

### Fixed

- Wallet health now rebuilds locking scripts from the chain when change rows
  have lost them. A change row with no script counts as neither spendable nor
  pending, so a wallet in that state shows zero for both — and the previous
  pass read that zero as "nothing to repair" and stopped before the only step
  that refetches the transaction that created the coin. One affected phone had
  its entire confirmed balance in 40 such rows.
- The chain script sweep now runs until it stops making progress, instead of
  once, so a wallet with more script-less rows than a single pass can fetch
  recovers in one health check.
- Activity toolbar buttons wrap instead of pushing the filters button off the
  right edge of the screen.

## [1.3.294] - 2026-09-23

### Fixed

- A self-send no longer internalizes its own item transaction a second time.
  That merge detached the managed-change row and made the cash balance return
  to zero after restart even though 899,280 sats were still owned.
- Arcade pin and Heal can reconnect a detached managed-change row to the exact
  transaction body the wallet signed, rebuilding its script and restoring it
  durably.
- Wallet health checks archived signed transactions before auditing old output
  history, probes failed transactions concurrently, and caps the interactive
  evidence pass. The affected wallet previously checked 873 outputs for 195
  seconds before reaching its current change.
- Activity filters now flip and clamp inside the viewport, with a bounded
  scroll area instead of opening mostly below the phone screen.

## [1.3.293] - 2026-09-23

### Security

- Upgraded `@bsv/sdk` to 2.8.1 and `@bsv/wallet-toolbox-client` to 2.13.2,
  remediating GHSA-5vmp-9hjc-rfwp.
- Removed the global `Beef.prototype.verify` override and every Toolbox
  verification bypass keyed by `__HANDCASH_INTERNAL_BEEF_SCOPE`. A transaction
  body is no longer treated as proof that a BEEF package is valid.
- Added a negative control that keeps invalid BEEF invalid through the legacy
  compatibility wrapper.

### Changed

- Retained only the Toolbox input-reservation and change-script hydration
  compatibility patches, re-derived against Toolbox 2.13.2.

## [1.3.292] - 2026-09-23

### Fixed

- The hero balance now updates when a connected app credits BSV through the
  BRC-100 bridge. The output was accepted and spendable, but nothing published
  a fresh balance, so the wallet kept painting the pre-receive figure — through
  Refresh and restart — until an unrelated chain ingest happened to publish
  ([#2](https://github.com/HandCash/HANDCASH-DESKTOP/issues/2)).

## [1.3.291] - 2026-09-23

### Fixed

- A run of item transfers no longer drains the spendable balance. Each send
  withholds its change until the broadcast is accepted, and the change row of a
  freshly signed transaction has no locking script yet, so promotion skipped it
  and the whole funding coin vanished from both the spendable and pending
  buckets. Change is now rebuilt from the transaction the wallet just signed.
- Heal frees the change of an accepted send whose signed template was evicted
  from the archive under storage pressure.

### Changed

- Every path that declines to promote change now says so in the log instead of
  returning silently.

## [1.3.290] - 2026-09-23

### Changed

- A new toast now replaces the one on screen instead of queueing behind it, so
  an older message can no longer reappear after a newer one expires.
- Inventory selection checkboxes moved to the right edge beside the Send
  button, in list rows and collection headers as well as grid cards.

### Fixed

- The inventory and friends search fields no longer let list content paint
  through them while scrolling.

## [1.3.289] - 2026-09-23

### Fixed

- Self-sends now retain both the outbound and inbound Activity perspectives,
  including when the send finishes after switching to another wallet.
- Receive Activity is no longer suppressed by toast deduplication; notification
  state can stay quiet while the wallet-owned custody record is repaired.

## [1.3.288] - 2026-09-23

### Fixed

- Signing is now an irreversible wallet boundary. Archive pressure, retry-queue
  pressure, temporarily missing parent bodies, or a projection failure can no
  longer rewrite a signed transaction as unsigned, unseal its inputs, or remove
  it from the wallet lifecycle.
- Signed transactions continue immediate propagation even when auxiliary retry
  persistence is degraded. The Toolbox transaction remains wallet history and
  later ancestry/retry work may recover around it.
- BRC-100 app actions now enter the same invariant directly instead of refusing
  the signed action when the auxiliary archive cannot accept another copy.

## [1.3.287] - 2026-09-23

### Fixed

- Miner retry rows no longer duplicate the full Atomic BEEF already held by
  the signed-cheque archive. On Android that duplicate exhausted origin
  storage, refused the propagation queue after signing, and temporarily hid
  the sealed collectable.
- Existing full-body retry rows compact in place to recover storage. Archived
  cheques referenced by a live retry are protected from eviction.
- If any durable registration step still fails, the wallet now unseals the
  transaction inputs before returning the error, so the collectable remains
  visible and spendable.

## [1.3.286] - 2026-09-23

### Fixed

- Signed transactions now retain their originating wallet runtime while miner
  propagation continues in the background. Account switching waits only for
  the foreground spend critical section, then leaves the signed cheque running
  without allowing its late callbacks to mutate the newly selected wallet.
- Miner, item-remittance, and BRC-29 retry queues are keyed to the immutable
  signing account. Receive verification and Activity completion carry the same
  captured ownership, so a late result settles the correct wallet without
  showing a toast or progress state in another account.
- Collectable inventory no longer collapses when Toolbox briefly returns a
  short basket page during a send. A card remains visible until its exact
  outpoint is positively spent or retired by the wallet's signed transaction.
- Received collectables remain in Activity while BRC-150 verification is
  pending. Verification work is fenced by the account epoch, preventing stale
  cache, progress, and Activity writes after an account switch.

## [1.3.285] - 2026-09-23

### Fixed

- Collectable sends no longer refuse every item with "no longer unspent on
  your address". The ownership set behind that gate was refreshed from the
  bare address-provider scan, which cannot see an inscription envelope, so
  every index-only tip dropped out at once. The provider scan, ordinal index
  and token index are now merged in one place (`scanLiveTipUtxos`) that both
  chain ingest and the send gate read.
- Absence from that scan no longer hides a collectable. The send gate now
  demands a positive on-chain spend before marking a tip sent, and refuses
  without hiding anything when the chain is inconclusive. Tips already hidden
  this way are given back by a new chain-ingest heal — their marks carry no
  txid, so the existing ghost heal could never reach them.
- The signed-cheque archive evicts its oldest cheques instead of refusing a
  write to a full store. Origin storage is the durable store on mobile, and an
  unbounded archive of Atomic BEEFs exhausted the quota; since the archive
  became fail-closed in 1.3.283 that stopped the wallet signing at all.

## [1.3.284] - 2026-09-23

### Fixed

- Collectable transfers now sign against the complete source locking script,
  including inscription and legacy metadata envelopes. The remaining ordinary
  item-send path used a bare-P2PKH helper, so locally valid items failed
  CHECKSIG before reaching the signed-cheque/miner propagation lifecycle with
  “the top stack element must be truthy.”

## [1.3.283] - 2026-09-23

### Fixed

- Signed transaction recovery is now bound to the immutable chain, vault
  account index, and identity key captured before async send preparation.
  Changing accounts while a cheque is being prepared aborts the lifecycle
  rather than sealing, archiving, or replaying it under another derivation
  scope.
- Outbound signing now fails closed when the durable Atomic BEEF archive
  refuses a write. A signed transaction can no longer continue into Activity
  and miner propagation without the exact template heal requires.

## [1.3.282] - 2026-09-23

### Fixed

- Balance heal no longer resurrects coins the chain has already spent. When a
  change row's creating transaction is mined (or missing) locally, an empty
  `spentBy` means the wallet lost track of the spend, not that the coin is
  still there — heal read that silence as "unspent" and re-enabled it. The
  next payment swept those phantoms in, the network answered `UTXO_SPENT`, and
  the resulting double-spend mark took the honest change in that same
  transaction down with it, showing a zero balance. Heal now requires
  affirmative proof from a UTXO service that the outpoint is unspent before
  re-enabling it, and refuses when no provider can confirm.
- Proving those coins runs in a batch between storage sessions instead of
  inside one, so explorer latency no longer holds the wallet database open or
  stalls a send.

## [1.3.281] - 2026-09-22

### Fixed

- Every locally signed transaction now keeps its Atomic BEEF in a durable
  cheque archive. The miner outbox dropped the body once Arcade accepted it,
  so balance heal had to guess a transaction's fate from Activity hashes and
  explorer lookups — which is how a valid payment's change could stop being
  counted. Heal replays the archived templates instead: it reseals the exact
  inputs of each signed cheque, promotes that transaction's change, and
  re-queues propagation when no explorer has seen it yet. An Activity row
  with no signed template is no longer treated as something to heal.
- App `createAction`, `signAction`, and `processAction` go through that same
  funnel. BRC-100 spends used to seal locally and keep their body in a
  16-slot cache, so an app payment left no template for heal to work from.
  Bodies already held by the miner outbox or the old cache are absorbed into
  the archive on first read.

## [1.3.280] - 2026-09-22

### Changed

- Patch release (every push must ship a new version).

## [1.3.279] - 2026-09-22

### Changed

- Patch release (every push must ship a new version).

## [1.3.278] - 2026-09-22

### Fixed

- Treat Arcade's propagated lifecycle states, including
  `SEEN_MULTIPLE_NODES`, as accepted. A valid BRC-100 payment no longer looks
  stuck while it waits for its mined proof.

## [1.3.277] - 2026-09-22

### Fixed

- Restored mobile's real in-app browser route. Android does not host Electron's
  `<webview>` tabs, but it does expose `DappBrowserActivity`: a native WebView
  with an anti-phishing host bar and a CWI proxy to the wallet's local BRC-100
  bridge on `127.0.0.1:3321`. The UI now treats that native surface as a real
  in-app option instead of falling through to the system browser. The companion
  Mobile release repairs the native plugin that had bypassed the Activity.

## [1.3.276] - 2026-09-22

### Fixed

- The in-app browser never loaded on mobile. "Open in-app" was enabled
  whenever the shell exposed `openAppBrowser`, but both shells do — on mobile
  it hands the URL to the system browser. The embedded tab is an Electron
  `<webview>`, which Android has no element for, so the tab mounted as an
  inert node that never loaded and never errored and the panel sat on its
  spinner. The shell now declares `embeddedAppBrowser`, and `AppLaunchPanel`
  routes mobile to the system browser instead.
- A browser tab only ever remembered the URL it was opened with, so closing a
  tab and reopening the app dropped you back on its landing page. Tabs now
  record where they browsed to. The `<webview>` stays keyed to the URL it
  mounted with, so this never rebuilds the guest mid-session.
- A tab that fails to load says so, with an "Open in browser" escape, instead
  of showing an endless loading bar. `did-fail-load` was not handled at all.

## [1.3.275] - 2026-09-22

### Changed

- Reverted the wallet's own collectables gem to the `diamond-stone` it has
  always used. 1.3.272 changed two separate icon sets; only the Aeon engine's
  is the market's, and the app's was never meant to move. The market keeps the
  corrected `diamond` and `search_off`.

## [1.3.274] - 2026-09-22

### Fixed

- The app-browser tab switcher painted each tab screenshot through a bare
  `<img>`, so a card flashed an empty frame before the bitmap decoded. It now
  goes through `DeferredImage`, falling back to the app avatar. This also
  un-breaks the release build: the Aeon ratchet had been failing on it since
  the tab switcher landed in 1.3.270.

## [1.3.273] - 2026-09-22

### Fixed

- A refused BSV-21 listing now says which refusal it is. Three unrelated
  causes — the basket row carrying no locking script, a read-only legacy JSON
  `bsv-20` inscription, and an output that is not a token — all reported
  "BSV-21 listing requires a 162 value lock", which reads as a transient
  wallet fault when a legacy JSON holding can never be listed: settlement
  builds the buyer output with `buildBsv21ValueLock`, so only a BRC-162 tip
  has a listing to publish. `chooseBsv21ListingLock` now names the reason and
  logs it.

## [1.3.272] - 2026-09-22

### Fixed

- The collectables gem icon is the real Material `diamond` again. Its path had
  MDI's *stroke* facet lines spliced onto a filled outline, so with
  `fill="currentColor"` each open subpath closed itself into a blob and the
  facets punched notches out of a solid diamond. Market's `search_off` is now
  the official glyph too, rather than a hand-drawn approximation.

## [1.3.271] - 2026-09-22

### Changed

- Agent docs now name `handcash-market` (`HandCash/BRC-MARKET`) as the live
  storefront. `items-market` remains the `/migrate` client only; wallet list,
  buy, and settle stay in this repo.

## [1.3.270] - 2026-09-22

### Changed

- Open web pages are managed from a tab-count button in the Connected apps
  label bar, immediately left of the list/grid selector. The browser toolbar no
  longer repeats that control.
- The page switcher is now a horizontal, screen-proportioned carousel. It
  captures each live webview when opened, centers and enlarges the selected
  page, leaves neighboring pages visible at a smaller scale, and provides
  previous/next controls alongside direct card selection.

## [1.3.269] - 2026-09-22

### Added

- The in-app browser keeps every launched app open. Each origin is its own live
  tab: leaving Apps, opening a wallet flow, or answering a request parks the
  webview at full size instead of tearing it down, so app state survives. The
  browser toolbar carries the open-tab count and opens a card switcher for
  changing tabs or closing one; closing the foreground tab falls through to the
  next open app rather than ending the session.
- Approval flows have their own resolution sound, distinct from connect.

### Changed

- Desktop wallet requests raised by an in-app app now float above the browser
  on a translucent scrim instead of shrinking it into a side column. The
  requesting app is brought to the foreground first, so the prompt is always
  over the app that asked.
- Activity filters open as an anchored overlay hanging from the toolbar button,
  so the label bar and the rows beneath it no longer shift when filters open.
  End-aligned placement is now supported by the Aeon anchor primitive.
- Root-page search fields (Collectables, Friends, Apps, Chat) share one field
  shape, rhythm, and focus treatment.
- Recipient suggestion lists in the send flows use the available vertical space
  instead of capping at a short scroll region.

### Fixed

- Send and Receive in the balance hero, and asset links in Activity, now
  navigate from any section. Cross-section navigation read a stale snapshot
  inside a transition, so the first click could be dropped.
- Approving a permission no longer redirects to the app's homepage in the
  system browser.
- Launching a connected app asks again where to open it (browser, in-app, or
  cancel) instead of going straight to the system browser.
- Identity no longer squeezes its QR into a strip or breaks the copy action
  across lines on compact and mid-width windows: the QR column holds its size,
  the hero stacks below the compact breakpoint, and the scroll body clears the
  tab dock.

## [1.3.268] - 2026-09-22

### Fixed

- Activity, chat, and inventory survive a mobile relaunch again. The mobile
  shell answered `storageSetSync` with `true` while storing nothing, so the
  shared durable layer treated it as the owner of a file store: every write
  reported success, and anything over the 64KB small-key mirror cap — Activity
  first, at several hundred KB — reached no store at all. Durable storage now
  verifies the claim once by reading a write back, and treats origin storage as
  the store (no size cap) whenever the shell cannot.
- The mobile shell no longer advertises the synchronous storage bridge it does
  not implement.

## [1.3.267] - 2026-09-22

### Fixed

- Grouped NFT burns now persist one Activity leg per destroyed NFT and compose
  those legs into one transaction record. The feed can therefore show the
  correct count, shared collection name, icon cluster, and member breakdown
  instead of a synthetic row linked only to the first NFT.
- Pending, completed, and failed grouped burns remain grouped consistently, and
  burn details report the composed item count.

## [1.3.266] - 2026-09-22

### Fixed

- Burning a BSV-21 token no longer reports "Waiting to send" in the status
  pill. That path took the spend-priority hold without publishing progress of
  its own, so the pill fell through to the coordinator, which labels every
  priority hold as a queued send. Burns now announce "Burning" from before the
  spend region is acquired until the destroy settles or fails.
- Burn reconciliation no longer pays for the report-only spendable audit, which
  costs one indexer request per spendable output and never writes anything
  back. Sends already refuse it; the burn was holding both the spend region and
  the pill while it ran.

## [1.3.265] - 2026-09-22

### Fixed

- BSV-21 inventory is now projected from an exact per-outpoint holding ledger
  instead of mutating aggregate cards. Receive, live basket, send, and burn
  paths therefore share one custody representation.
- A basket read that began before a receive now reconciles newly painted tips
  even when it already returned the same token ID, preventing a received
  amount such as `+50` from appearing and then reverting to the older balance.
- Authoritative spend and burn paint now replaces the ledger with the exact
  surviving tips and change, while durable UI state omits bulky locking scripts.

## [1.3.264] - 2026-09-22

### Fixed

- Receiving another BSV-21 tip now adds its amount to the held token balance
  instead of replacing the aggregate with the newest tip.
- Token aggregates persist their exact held outpoints, making repeated inbox
  paint idempotent while authoritative spend/change projections still replace
  consumed tips without double-counting.
- Token diagnostics now report both token-card and held-tip counts so custody
  projection disagreements are visible in support logs.

## [1.3.263] - 2026-09-22

### Fixed

- Vault switching now replaces the entire account projection in one render.
  Inventory subscriptions/timers remount for the selected runtime, and the
  prior wallet's balance is hidden until the selected Toolbox answers.
- Deferred item-arrival notifications are fenced by account generation, so a
  primary-wallet receive cannot resume after a switch and write false Activity
  or toast state into a secondary wallet.
- Initial account inventory reconciliation no longer announces existing
  holdings as newly received, and post-switch chain catch-up stays silent.

## [1.3.262] - 2026-09-22

### Fixed

- The architecture ratchet now normalizes Windows path separators, so Release
  Windows excludes `session.ts` exactly as macOS/Linux do.

## [1.3.261] - 2026-09-22

### Changed

- **Every wallet feature now belongs to one account runtime.** Unlock publishes
  a `WalletRuntime` containing the toolbox instance, account storage namespace,
  generation, abort signal, and feature lifecycle. Switch and lock dispose the
  old runtime before publishing another, abort live spends/direct sessions,
  reset prompts, timers, caches and coordinator queues, and fence queued work
  from completing into the next account.
- **Wallet-owned durable state is namespaced for every account, including the
  primary.** Transaction/UTXO overlays, miner and remittance outboxes, import
  guards, market state, remittance, backup preferences, permissions, arrivals,
  and recovery checkpoints no longer share device-global ownership. Legacy
  primary and child keys migrate once into their owning namespace.
- **Storage ownership is now mechanically enforced.** The registry declares
  `device`, `chain`, or `wallet` scope for every production HandCash key, and
  architecture ratchets reject unregistered keys or wallet key literals outside
  that authority.

### Fixed

- Switching accounts while ingest, recompose, backup, or a send is queued can
  no longer let stale work mutate the newly selected wallet.
- Same-device accounts cannot see or flush each other's BRC-29/item/miner
  outboxes, transaction records, UTXO locks, or inventory hide/import marks.

## [1.3.260] - 2026-09-22

### Fixed

- **Tokens already received under the shared guard heal on the next read.**
  Scoping the marks per account fixes new transfers, but the primary account
  keeps the historical unscoped key, so a tip it received before the fix stayed
  hidden until the 24h expiry. A mark is now cleared when two facts make it
  impossible: the basket returned the tip, it pays **us**, and the hiding
  transaction is the tip's *own*. A spent input is never an output of the
  transaction that spent it, and a payee output a sender hid pays the payee —
  so nothing a send legitimately hides can match.

## [1.3.259] - 2026-09-22

### Fixed

- **A transfer between two wallets on the same device now paints for the
  receiver.** The marks that hide an outpoint from inventory — sent, burned,
  abandoned, already-imported — were stored once per device while every basket
  and inventory is per account. Account A sending to account B recorded B's
  incoming tip as "sent", so B's own basket read filtered out the tip it had
  just internalized (`live 0`) and the merge deleted the card paint had put
  there. The transfer was on chain, in B's basket, and invisible. All four
  marks are now scoped to the vault account that made them, and the scope is
  rebound on account switch before the inventories reload.
- **A receive heals a stale mark left by an older build.** Internalizing a tip
  is this account holding it, so the receive path drops any hide mark standing
  against that outpoint, and re-claims an import the device-wide guard had
  already marked done when this account's basket does not actually hold it.
  Both the token and item receive paths do this.
- **A card the read never saw is no longer a card the read refuted.** Cards
  painted while a basket read was in flight are carried onto the published
  list instead of being erased by a merge computed before they existed.
- The probe that retires a mint no chain has ever seen was unreachable: it
  asked for the fate with `onChain: null`, which always answers
  `chain-unknown`, so the lookup it guards never ran. It now asks with the
  answer that would retire the card, which is what "only pay for a lookup when
  absence would otherwise retire it" meant.

## [1.3.258] - 2026-09-22

### Fixed

- **Tokens can no longer stop tracking the wallet for a whole session.** Reads
  of basket `bsv21` were coalesced without a deadline, so one read that never
  settled — a basket call parked behind a spend, an account switch taken
  mid-send — was handed to every later caller forever. Collect kept refreshing
  beside it while Tokens showed whatever it held at the moment of the stall,
  including nothing for an account that had just received a transfer. A caller
  now waits on someone else's read for at most 20s before running its own.
- **A basket read that stalls is unavailable, not empty.** The live read is
  bounded at 12s and a timeout resolves to `live-read-unavailable`, which keeps
  every cached card instead of retiring cards a silent read never spoke about.
  An abandoned read may still finish; it observes and never publishes, so a
  late answer cannot overwrite the list that replaced it.
- Tokens now logs each completed read (`listOutputs done … live N, showing M`)
  and names a timed-out one, so a stalled list is visible in a session log
  rather than absent from it.

## [1.3.257] - 2026-09-22

### Changed

- **A mint is now born provable.** An app `deploy+mint` written as a legacy
  JSON inscription can never be proven — BRC-176 reads BRC-162 locks, so a JSON
  genesis paints as "Legacy" and offers Burn where Send belongs, for the life
  of the token. The bridge now re-expresses that genesis as a BRC-162 lock
  before signing, carrying the same supply, symbol, decimals, icon and P2PKH
  owner, so `prove` succeeds the moment the transaction exists. The wire cannot
  be repaired after signing, which is why the decision moved to issuance.
- A genesis that cannot be re-expressed exactly — an authority deploy, a
  non-integer amount, a non-P2PKH tail — is issued as the app wrote it and the
  refusal is logged with its reason. Round-trip is verified before use: supply,
  role and spend conditions must decode back identically.

## [1.3.256] - 2026-09-22

### Fixed

- **A freshly minted token no longer flashes onto Tokens and vanishes.** The
  card painted from the mint's own `createAction` was deleted by the first
  basket read that returned any other token — a read that could not have
  included a mint the toolbox had not projected yet. Retirement now belongs to
  `chooseFungibleChainFate` alone: a card keeps its settle grace, and only an
  aged card the chain has never seen is dropped.
- **A legacy JSON `deploy+mint` is read from its own inscription.** The
  one-sat probe recognised the `application/bsv-20` mime but returned no token
  id or amount, so our own JSON mints fell past token import into the
  unrecognized one-sat pile and never reached basket `bsv21`.
- **A proven BSV-21 tip is never rescued into the collectable route.** A stale
  one-sat mark could outrank the inscription itself and file a fungible as an
  NFT, which hides it from Tokens and corrupts that token's balance. The
  decoded locking script now wins, and the rescue log names the outpoints.

## [1.3.255] - 2026-09-22

### Fixed

- **A transfer Arcade rejected can now be cleared, and gives its coins back.**
  The Arcade submit pin held the Activity row and the inputs it sealed until
  chain proof showed the spend had failed — proof that can never arrive for a
  transaction that will never be mined. Arcade issued the pin, so Arcade's own
  root-resolved rejection now retires it: the row clears, the sealed inputs are
  written off, and the cash returns to spendable. Acceptance, a parent Arcade is
  still working, and silence all keep the cheque exactly as before.
- **Rejection is recorded where it is discovered.** The proof-request settle and
  the BSV-21 pre-sign gate both remember a rejected txid, so Activity, the
  sealer sweep, and reclaim agree without re-asking Arcade per row.

## [1.3.254] - 2026-09-22

### Fixed

- **BSV-21 sends now fail closed before signing when token ancestry is
  rejected.** The pre-sign gate first proves BRC-176 token grammar and
  conservation, then checks only the token transaction lineage against Arcade.
  A hard-rejected token ancestor refuses the send before `createAction`;
  unrelated cash-history noise cannot veto it, and complete unknown/unconfirmed
  ancestry remains valid SPV state.
- **Retryable parent rejection now resolves to its root cause.** Arcade's
  `parent rejected … retryable` response is followed through the ancestor chain
  instead of being mistaken first for acceptance and later for a generic hard
  rejection. A truly rejected root retires descendant proof requests and false
  spend history; a genuinely pending parent stays retryable.
- **Exact-amount token sends require the signed subject body.** The no-change
  path can no longer bypass the final signed-output and BRC-176 proof gate.

## [1.3.253] - 2026-09-22

### Fixed

- **Raw-only inbound token envelopes now retire.** A stale BEEF URL is no
  longer treated as delivered AtomicBEEF, and an explorer raw-transaction hit
  no longer keeps an item/token card alive when the sender failed to deliver
  the spend proof required for internalization. Old envelopes retire as
  unavailable and are ACKed instead of re-running settle work during unlock.
- **Failed inbound settlement is observable.** Logs now include the exact
  item/token settle refusal, while a newly delivered inline AtomicBEEF revives
  a retired transfer and clears its retry backoff.

## [1.3.252] - 2026-09-22

### Fixed

- **Undeliverable inbound transfers stop burning the UI thread.** A tip card
  whose sender never broadcast used to be re-chased on every five-second poll,
  because messagebox redelivery reset the card's arrival time and the
  two-hour retirement grace never expired. First-seen is now durable and only
  ever moves backwards, a body-less miss backs off for fifteen minutes, and the
  hint retires once the grace window closes with no body at any provider.
- **Token change stays in inventory right after a send.** When `listOutputs`
  has not projected the BRC-162 lock yet, the just-signed change output is
  recovered from local BEEF instead of being read as spent.
- **Sending tokens to your own address no longer empties the card.** The payee
  output of a self-addressed transfer is not marked sent or relinquished.

## [1.3.251] - 2026-09-21

### Changed

- **Unified finality is now ratcheted.** A repository test requires every
  outbound payment, token, collectable, burn, and marketplace module to use
  `signedSendLifecycle` and rejects direct sealing or miner-submit copies.

## [1.3.250] - 2026-09-21

### Changed

- **Marketplace assets use the same transaction lifecycle.** Listing, purchase,
  settlement, and cancellation transactions now enter the shared sealed,
  durable miner, Arcade rejection, and BUMP-finality path too.

## [1.3.249] - 2026-09-21

### Changed

- **One transaction lifecycle for BSV and assets.** BSV, BRC-29, BSV-21,
  collectable, and burn transactions now share input sealing, durable Atomic
  BEEF submission, Arcade acceptance/rejection, late-failure reporting, and
  header-verified BUMP finality. Asset remittance is asynchronous metadata and
  no longer changes or gates the underlying Bitcoin communication rules.

## [1.3.248] - 2026-09-21

### Fixed

- **Rejected transactions no longer ingest forever.** Old proof, no-send, and
  send-waiting rows now consult Arcade for an explicit transaction verdict.
  `REJECTED` transactions transition to SPV-failed/invalid and stop polling;
  explorer 404s and unavailable providers remain safely retryable.

## [1.3.247] - 2026-09-21

### Fixed

- **Older fungible envelopes internalize correctly.** BSV-21 receive now
  re-frames every supplied BEEF as AtomicBEEF for the transfer txid before
  calling `internalizeAction`, matching the collectable boundary and falling
  through when a source does not contain the subject.

## [1.3.246] - 2026-09-21

### Fixed

- **Body-less fungible transfers stop loading forever.** After a two-hour
  grace, a BSV-21 inbox hint with no AtomicBEEF is retired only when the durable
  multi-provider body lookup misses and an explorer confirms the tx is absent.
  The messagebox envelope is then acknowledged; a later real AtomicBEEF revives
  the transfer.
- **Header monitoring rides through network outages.** `TaskNewHeader` holds
  the last verified chain tip while every live provider is unreachable instead
  of emitting `WERR_UNKNOWN No chain tip header provider` every poll.

## [1.3.245] - 2026-09-19

### Changed

- **Support tooling:** `npm run triage [bucket]` reads a device's uploaded
  session logs, derives the facts in code (freezes by active wallet layer,
  blocked milliseconds, grouped error families, coincidence with unexplained
  freezes) and asks Jev for the judgments — user-visible freeze, primary
  driver, custody risk, regression against the previous session, severity.
  No wallet behaviour changes.

## [1.3.244] - 2026-09-19

### Fixed

- **Incoming BSV-21 sends settle again.** A token hop's Atomic BEEF no longer
  overruns the messagebox body cap, so the payee gets the BEEF inline instead
  of `beefInBox: false` and a fallback to an indexer that never saw the tx.
  A BSV-21 envelope will never trade its BEEF away to fit provenance — for a
  fungible payee the BEEF *is* custody. A peer box that still caps lower gets
  the card without the BEEF, and the sender reports that honestly.
- **The item outbox no longer thrashes the main thread.** A failed remittance
  backs off instead of retrying the identical payload on every flush tick;
  field logs showed 2–6s stalls interleaved one-for-one with those retries.
- **"Preparing payment" no longer re-seals work it already did.** Promotion
  skips live txs it has settled this session and redoes them whenever a coin
  is un-sealed, cutting an 18.8s spend preparation without reintroducing the
  timer race that let `createAction` reselect a spent input.

## [1.3.243] - 2026-09-19

### Fixed

- **Every live signed cheque remains durably queued until an objective
  accept/reject verdict.** The miner outbox no longer expires after forty
  attempts or silently evicts its oldest row.
- **Durable-write failures are explicit.** A cheque that could not be stored
  returns `untracked`, keeps its inputs sealed, and warns immediately instead
  of claiming automatic retry protection.
- **The P2P cheque contract is explicit at the boundary:** signed BEEF is the
  payment, dependent hops chain parent bodies, miner silence is not rejection,
  and proven rejects update locks and Activity immediately.

## [1.3.242] - 2026-09-19

### Fixed

- **Miner submit now returns one tagged fate:** `accepted`, `queued`, or
  `unproven-conflict`. Callers no longer infer success from overlapping
  `submitted` / `confirmed` booleans.
- **An unproven miner conflict keeps inputs sealed** while the same signed
  body stays in the outbox, so a later send cannot pick those coins.

## [1.3.241] - 2026-09-19

### Fixed

- **Miner-outbox persistence now has one explicit verdict:** refuse,
  recoverable ancestry, or SPV-ready. Old invalid rows written by byte-only
  checks are removed on load, while signed transactions with recoverable
  missing ancestry remain eligible for hydration and retry.

## [1.3.240] - 2026-09-19

### Fixed

- **The durable miner outbox no longer stores a body it cannot verify.** A row
  is persisted only when the bytes parse as BEEF and carry the signed subject
  transaction, so unparseable bytes, txid-only stubs, and bodies for a
  different transaction are refused instead of retried for hours.
- **A queued body is upgraded once ancestry is merged or hydrated**, so retries
  post the complete package instead of repeatedly re-sending the thin one.

## [1.3.239] - 2026-09-19

### Fixed

- **Token sends no longer select funding while local output promotion is still
  mutating wallet storage.** The spend waits for that operation to settle,
  preventing stale or already-spent funding from racing into `createAction`.
- **Explicit Arcade `UTXO_SPENT` and `PARENT_REJECTED` verdicts override an
  HTTP/service success envelope.** Rejected transactions are no longer logged
  or pinned as accepted.

## [1.3.238] - 2026-09-18

### Fixed

- **BSV-21 remittance stays on the inbox BEEF**, so the payee can settle from
  the package without an indexer walk. Send still attaches provenance on the
  envelope; receive and the pending outbox keep that hop's Atomic BEEF.

## [1.3.237] - 2026-09-18

### Fixed

- **Received BSV-21 tips are filed on Refresh** instead of waiting for a later
  list, and peer token capability is resolved before the send offer.
- **Token chrome no longer bleeds into labels** on the fungible face and the
  Send panel.

## [1.3.236] - 2026-09-18

### Fixed

- **Transaction tracing stops dialling a telemetry sink that is not
  deployed.** BRC-CLOUD has no `/v1/telemetry/events` route, so every boot,
  `online` event, and 60s tick re-posted the same batch, took a 404, and kept
  the queue — pinning `MAX_QUEUE` events in durable storage and burying real
  warnings under ~50 `[tx-trace] flush deferred HTTP 404` lines per session.
  A 404/410 now names the sink absent once and drops the queue; 5xx and
  network errors still retry.

## [1.3.235] - 2026-09-18

### Fixed

- **Completed BRC-29 payments no longer leave a ghost "Sending…" Activity
  row.** Payment progress now carries the current operation's start boundary,
  and the live Activity projection stands down when a settled outbound row
  from that operation exists. A prior payment cannot hide a genuinely new send.

## [1.3.234] - 2026-09-18

### Fixed

- **A "Legacy BSV-21 — burn only" verdict is falsifiable again.** Only a proven
  `binarySupply` is terminal; a bare `legacy-json` stamp is now re-checked
  against the held tip's locally retained locking script. Earlier releases
  tightened *who may write* that stamp, but a device that already carried one
  could never re-examine it: the local script proof returned early on any
  `encoding`, the v2 display cache treats the stamp as trusted, and the list
  read counts a stamped row as classified and defers the live basket decode. A
  token whose lock really is a JSON `application/bsv-20` inscription keeps the
  same read-only verdict — sends stay retired for legacy JSON.

## [1.3.233] - 2026-09-18

### Changed

- **Restored the v1.3.227–v1.3.230 product changes on top of the recovery
  fixes.** This brings back preservation of every P2P batch item, AtomicBEEF
  framing for inline delivery, activity/listing deduplication, bulk item-run
  execution beyond the old 25-item cap, and publication of unresolved peer
  transfers. The restored source paths do not overlap the renderer-freeze,
  abandoned-spend, inbound-hint, or derived-change recovery fixes shipped in
  v1.3.231. The combined tree passes TypeScript and all 1,892 unit tests.

## [1.3.232] - 2026-09-17

### Fixed

- **Restored the Linux activity visual baseline.** No product change. The v1.3.231
  recovery took the whole v1.3.226 tree, which pulled the activity badge snapshot
  back to a baseline that predates v1.3.228 — the release whose only content was
  re-aligning that PNG to what the Linux CI runner actually renders. The smoke test
  spec is byte-identical between v1.3.226 and v1.3.230 and the fixture is isolated
  from the activity feed, so this is purely the newer reference image (334 pixels of
  anti-aliasing, 2% of the fixture).

## [1.3.231] - 2026-09-17

Recovery release. The tree is v1.3.226 — the last build confirmed working — plus
the fixes below. It **supersedes v1.3.227 through v1.3.230**, which is where the
freezing, permanently-behind wallet and missing balance came from; that window
also carried the bulk item-run work that lifted the 25-item send cap. Those four
releases are still in history and their features come back once the regression in
them is named, rather than being shipped again untested. Every source file touched
below was byte-identical between v1.3.226 and v1.3.230, so none of these fixes are
undoing that window's work.

### Fixed

- **Ordinary preference traffic no longer freezes the window.** `durableGet` /
  `durableSet` re-read, re-parsed and re-serialized the whole of
  `durable-prefs.json` to touch one key, and the renderer reaches them over
  `ipcRenderer.sendSync` — so the entire store's cost was charged to the renderer
  thread on every lookup, and no stall warning was possible because the watchdog
  could not run either. On a working wallet that file is several megabytes. The
  store is now held in memory (this process is its only writer), preference writes
  coalesce into one debounced file replace, the vault and factory reset write
  straight through, and quit flushes. The renderer only mirrors small values into
  `localStorage`; multi-megabyte mirrors were synchronous there and over quota
  regardless.
- **Durable caches stopped re-parsing their whole JSON blob per call.** The reads
  sat inside per-item loops and per-card renders, and `localItemArt` holds base64
  image bodies, so a single navigation paid that cost once per card.
- **Two Touch ID prompts no longer race each other.** The OS cancelled one and the
  wallet simply stayed locked. `deviceAuthUnlock` now single-flights.
- **Unpromotable change no longer loops forever.** A promotion that moved nothing
  invalidated the balance breakdown log, and that log is what arms the promotion.
- **Cash sealed by a written-off transaction is counted again.** It fell into
  neither balance bucket and no path revived it from storage.
- **A spend that never reached the network can now conclude.** A signed tx with
  status `unsent`, no Arcade contact and no proven competing spend was left
  unclassified — neither live nor dead — so its inputs stayed sealed and its change
  stayed unpromotable, outside both spendable and `pendingChange`, permanently. The
  Arcade pin is the exit: without one the cheque was never handed to a broadcaster,
  so nobody else can present it, and with every input still verifiably unspent
  there is nothing to conflict with. Reclaimed behind a six hour grace; any
  genuinely unknown input still keeps the cheque.
- **Chains of never-broadcast spends collapse instead of sealing each other.** The
  stranded coins were not one stuck transaction but three, none on chain and none
  Arcade-pinned, each sealing the next. An input whose funding tx is itself
  definitively absent read as `unknown`, when it is not: a nonexistent output
  cannot be spent by anyone, so a transaction consuming one can never become valid.
  It is now `phantom` and collapses, while a merely unconfirmed or moved input still
  keeps the cheque. Input enumeration also no longer stalls on `inputs unknown` when
  the never-landed body is missing from storage — it falls back to the prevouts our
  own lock records name.
- **An inbound BRC-29 payment the sender never broadcast can be retired.** Tip
  validity is Arcade's call, so a hint was only ever retired when Arcade hard
  rejected *our* broadcast — a path an inbound payment never reaches, because we
  hold no body to broadcast. The card sat on Receiving (SPV) while every poll re-ran
  a full BEEF chase that could not succeed. Retirement now requires corroboration:
  nothing deliverable on our side, a durable multi-provider body miss, a definite
  on-chain absence, and a two hour grace. An unanswered explorer stays `unknown` and
  keeps the hint pending, so a provider outage cannot discard real money, and a later
  AtomicBEEF revives the card. Retiring also suppresses the txid so the inbox ACKs
  the envelope away — it carries no BEEF, which is why it was unresolvable — instead
  of the messagebox re-delivering it as a fresh hint on the next poll.
- **Derived change whose toolbox row is gone can be re-imported.** Reclaim only
  `updateOutput`s. After a BRC-39 restore from an older snapshot the coins stay
  on chain at BRC-29 addresses while IndexedDB has nothing to spend with.
  Successful sweeps and `keepChangeOfSignedTx` now echo prefix/suffix into
  durable prefs; a missing row is internalized as a self wallet-payment instead
  of un-sealing nothing. Reclaim also ranks by value and rotates past
  `RECLAIM_MAX`, so 200+ blank seals are not permanently skipped.

## [1.3.226] - 2026-09-17

### Changed

- **Receive-side BRC-150 verification stops paying full timeouts in series.**
  Two costs dominated a cold verify. The BEEF fetch asked the indexer alone and
  waited out its 8s ceiling before trying anyone else, even though WhatsOnChain
  is equally proof-carrying and usually answers in a few hundred ms; the fetch
  now keeps the indexer's preference but lets WhatsOnChain race it after 1.2s,
  which turns an 8s stall into ~1.2s. And `hydrateMissingPathTxs` fetched lean
  path bodies one at a time, although the whole missing set is known up front and
  the requests have nothing to discover from each other; the round trips now
  overlap. Merging stays sequential and yields between bodies — that is what
  keeps a fat mint origin from freezing input, and it was the only reason the
  loop was serial.

## [1.3.225] - 2026-09-17

### Fixed

- **An Arcade-accepted item send no longer strands its own change.** Every
  `peerDeliver` item settle is `createAction({ noSend: true })`, and app-held
  `nosend` change is deliberately withheld from the next spend. Nothing moved
  the row off `nosend` once Arcade accepted it, so change was withheld forever:
  `05c22bf13b06` spent a 1,070,736 sat funding output and parked 1,070,674 sats
  across eight confirmed change outputs that the wallet counted as neither
  spendable nor pending. Balance read 8,626 sats and the next leg of the run
  failed for want of 20. Arcade acceptance now pins the row — status leaves
  app-held, inputs stay sealed, change becomes spendable — and the bulk run
  awaits that pin before signing the leg it funds.
- **Heal Balance can now see stranded app-held change.** The pending scan was
  gated on projected `pendingChange`, which excludes `nosend` change, so a
  wallet whose whole balance was stranded that way could not heal. The gate is
  now the Arcade pin registry, and Arcade-pinned `nosend` rows join the pending
  scan so a pin lost to a crash mid-broadcast still recovers.
- **Bulk item failures no longer cascade into retry storms and failed-row
  debris.** The real-device run showed a large leg failing, silently splitting,
  and leaving every temporary attempt as a permanent failed Activity row before
  smaller legs succeeded. Multi-tip probes are now ephemeral; only a terminal
  single-tip failure is recorded.
- **Unknown, network, timeout and incomplete-ancestry failures stop once.**
  Only recognized item-local conflicts may split a leg. The old default treated
  every unfamiliar exception as item-specific, multiplying one outage into
  repeated 2/4/8-way attempts.
- **Provenance-heavy atomic legs are capped at the measured safe size of five.**
  The phrase-migration ceiling of 25 was not representative: a real ten-item
  transfer blocked the renderer repeatedly for 1.5–3.4 seconds and failed,
  while the five-item half signed. Post-send BRC-150 extension is now one
  sequential worker per transaction rather than one competing BEEF walk per
  item.
- **Stopped-run progress counts items, not queued transactions.** Diagnostics
  now name run start, each accepted leg, and each classified rejection.

## [1.3.224] - 2026-09-17

### Fixed

- **Collectable send now instantiates `assetSendMachine` with explicit input.**
  The 1.3.223 compose-chart refactor correctly separated item/token UI from the
  BSV payment form, but the collectable panel omitted the machine's required
  input object and failed CI typecheck. It now names
  `needsQuantity: false`; BSV-21 continues to name `true`.

## [1.3.223] - 2026-09-17

### Changed

- Patch release (every push must ship a new version).

## [1.3.222] - 2026-09-17

### Changed

- **Item send panels now project the existing send statechart.** Collectable and
  BSV-21 panels no longer keep parallel `useState('edit' | 'confirm')` stages;
  Review and Confirm send XState events, and Aeon state attributes come directly
  from the chart snapshot.
- **The machine manifest is exhaustive and self-ratcheting.** All 27
  `*Machine.ts` exports are registered. The manifest test discovers source
  machines automatically, so adding a chart without cataloging it now fails CI.
- **Bulk-send orchestration left the collectables god file.**
  `collectableSendRunExecutor.ts` now drives `collectableSendRunMachine` and the
  bounded atomic legs; `collectables.ts` retains the single-transaction domain
  operation rather than also owning the multi-transaction queue.

## [1.3.221] - 2026-09-17

### Fixed

- **Change consolidation no longer empties the displayed balance.** The
  background pass seals the inputs it spent, then internalizes their single
  replacement a few seconds later. A balance read in that gap returned a total
  that was true of neither the wallet before nor after — on this device it
  published 1,079,500 → 8,626 sats and stayed there until a manual Heal.
  `selfFundsRewrite.ts` marks the window; the balance view answers
  `unavailable` inside it, so the hero keeps the last owned figure and spend
  gates fall back to proven confirmed sats. The settled figure is republished
  when the window closes, including when the broadcast is rejected and the
  inputs come back.

### Changed

- **A multi-item send is one Activity row while it is still sending.** Pending
  legs of one transfer share a `sendGroupId`, so 25 collectables read as
  "Sending… 25 Pixel Foxes" instead of 25 unrelated rows, and the txid takes
  over the same grouping once it lands. A failed leg still stands alone — it is
  cleared and retried on its own.

## [1.3.220] - 2026-09-17

### Added

- **Bulk item send: a big selection is a run of atomic transactions.** Selecting
  more than 25 collectables now sends them 25 at a time instead of refusing.
  `collectableSendRunMachine` owns the loop's legality and each leg is still
  all-or-nothing, so a partial run is a set of whole transactions. A leg the
  miner rejects is halved and retried down to singles, so one unspendable tip
  cannot strand the rest; a wallet-wide fault (locked, offline, out of fee
  money) halts the run instead of failing 27 more times. The confirm screen
  names the transaction count, the sidebar counts items sent, and the result
  toast reports what actually signed. Burn keeps the hard 25 ceiling — it is a
  single transaction with no leg loop.

## [1.3.219] - 2026-09-17

### Fixed

- **A huge item selection refuses instead of freezing.** One atomic 1-sat
  transaction carries up to `MAX_ITEMS_PER_ONE_SAT_TX` (25) tips — the same
  sighash ceiling the migrate bundle already used. Selecting 700 built one
  `createAction` with 700 inputs and 700 outputs on the render thread, after
  resolving metadata for every tip. Send and Burn now disable above the
  ceiling with the count to deselect, `sendCollectables` / `burnOneSat` fail
  closed with a named reason before any pending row or spend lock, and the
  send panel skips the per-tip metadata walk for a selection it will refuse.

- **Activity no longer offers Clear for a live signed cheque.** A pending
  send that already has a txid is not rewritten as failed; Arcade accept
  restores a false-failed row; Clear only counts rows that are actually
  droppable. Reservation cleanup no longer waits on a full toolbox
  `reviewStatus` pass, which was hanging Clear for 30s.

## [1.3.218] - 2026-09-17

### Changed

- Patch release (every push must ship a new version).

## [1.3.217] - 2026-09-17

### Fixed

- **UTXO overlay mutations are transaction-shaped.** Proven-spent coins are
  adopted under a named spender or quarantined until that body exists — never
  consumed with a blank `spentBy`. Draft reservations expire after 15 minutes;
  quarantine is not thawed on a timer. A local `failed` row that is actually
  on-chain is restored as that transaction.

## [1.3.216] - 2026-09-17

### Fixed

- **Signed transactions now remain local cheques until a competing spend is
  proven.** Explorer/indexer absence no longer removes Activity, restores sent
  items, retires token cards, fails pending change, or creates a competing
  legacy sweep. Mined status is likewise no longer orphaned without local
  header evidence.
- **Every outbound transaction package carries locally known unconfirmed
  ancestry.** Miner submissions, BRC-33 item/payment/market delivery, BRC-100
  `createAction` responses, token sends, and legacy/phrase sweeps now share the
  Atomic BEEF completion path.
- **Wallet Heal now uses tri-state outpoint evidence.** Proven-spent outputs are
  hidden, proven-unspent dropped outputs are restored, and unknown evidence
  leaves balance, Activity, and collectables unchanged.

## [1.3.215] - 2026-09-17

### Changed

- Activity, item, and token history: coherent corner marks, a timeline of
  events, and Sending… / Receiving… settling into Sent / Received on the same
  row instead of disappearing.

## [1.3.214] - 2026-09-17

### Fixed

- **A React update loop in Payment Details, which ended sessions in crash
  recovery.** Every Activity write rebuilds row objects, and the panel keyed its
  fate effect on that object — so an unrelated write re-resolved the fate, and a
  resolve that writes to Activity re-triggered itself until React gave up.
  `sameActivityRow` keeps the previous object when nothing a screen reads moved.
- **An Arcade pin no longer nurses a dead transaction chain.** The pin means
  "Arcade's first answer is unreliable", not "Arcade is the chain" — but Arcade
  also keeps transactions it *rejected*, so a chain rejected for `UTXO_SPENT`
  stayed pinned: its inputs were resealed on every maintenance pass and its
  Activity row could never be cleared. Absence proven by chain providers now
  overrides a pin older than ten minutes; explorer silence still keeps it.
- A local transaction proven absent whose inputs are outputs of an equally
  absent parent is now failed instead of resealed forever. Its coins are not
  revived — they cannot be proven to exist — but it stops counting as in flight.
- **A market receipt whose settlement transaction no provider has is now given
  up on after an hour** instead of retried on every inbox poll forever, and
  waiting out the backoff is silent rather than a log line every twenty seconds.

## [1.3.213] - 2026-09-17

### Fixed

- **"Confirmation status is unavailable" is no longer a dead end.** A row whose
  chain status cannot be read now still offers **Resubmit**: publishing the
  transaction this wallet already signed cannot double-spend whatever the chain
  turns out to say, because it is the same txid being re-announced. Clearing the
  row and taking its coins back still require proof, and both stay closed. Only
  a row with no signed transaction is left as-is, and it says so.
- Coin payments are deliberately excluded — their retry builds a *new* payment,
  which must never be offered without knowing the first one's fate.

### Changed

- HandCash Chain (BRC-CLOUD) no longer reports a transaction Arcade is merely
  holding as being on chain. `PENDING_RETRY` means a child was parked because its
  parent was never accepted; calling that "exists" told the wallet a parked send
  had confirmed, and "on chain" is also the answer that forbids reclaiming its
  coins — so the row had no way forward at all. Only `MINED`, `CONFIRMED`,
  `SEEN_ON_NETWORK`, and `ACCEPTED_BY_NETWORK` count as present; `REJECTED` and
  `DOUBLE_SPEND_ATTEMPTED` count as absent; queue states now fall through to a
  chain provider.

## [1.3.212] - 2026-09-17

### Fixed

- **Resubmit is offered on a peer-published transfer that has not landed.** The
  panel used to withhold every action for twelve hours on nothing but a clock,
  so a transfer sitting off chain had no way forward except taking the coins
  back. Publishing it yourself is not a race: it is the *same* signed
  transaction the recipient holds, so both copies are one txid — the sender's
  own silent postBeef, which the wallet already attempts in the background. The
  permission now comes from `itemSendMachine` (`RETRY_BROADCAST` →
  `confirmBroadcast`, where sender broadcast is legal) instead of the clock, and
  the button says **Resubmit**.
- The chain is checked before that state is described, so a transfer the
  recipient already published reads as confirmed rather than as still waiting on
  them. Clear stays refused while they may settle it — that would delete the
  sender's only record — and building a *replacement* transfer is still refused,
  because that would race a live one.
- Clear no longer appears on a retryable row that said it may not be cleared.

## [1.3.211] - 2026-09-17

### Added

- Coins sealed for a transfer nobody ever published can be taken back. When a
  recipient never broadcasts a peer-published item transfer, the sender's inputs
  stayed sealed against a transaction that does not exist on chain — the row
  could not be cleared (it is the only record of the transfer) and the coins
  could not be spent. Payment Details now offers **Take the coins back** on such
  a row: it hands the sealed inputs back to the spendable set, returns the item
  to inventory, and cancels the transfer.
- The decision is a named path (`localTxReclaimPath.ts`), re-checked against the
  chain at the moment you press it, and refuses on anything uncertain: a
  transaction that is on chain, inputs already spent, an unreadable input set, no
  explorer answer, or an Arcade submit that may still be in flight. The dialog
  states the trade plainly — if the recipient publishes their copy later it is
  rejected as a double spend.

## [1.3.210] - 2026-09-17

### Changed

- A collectable the recipient has not published yet no longer reads like a
  problem. Handing an item to a peer is a normal outcome: their wallet publishes
  the signed transfer, so the panel now says that plainly, in neutral chrome
  rather than warning amber, and explains that the row is your record until it
  confirms. It no longer narrates what retrying or clearing would do to a live
  transaction, and the reserved-coin action says what it actually frees — coins
  from sends that were never signed — instead of implying this transfer is
  holding funds. Retry and clear still refuse, each with its own reason.

## [1.3.209] - 2026-09-17

### Fixed

- Sending spends the coins you already have. A send used to run change
  promotion, sealed-input reclaim, and a script sweep across the whole change
  history *before* building the transaction — on a wallet with hundreds of rows
  that spent the entire 90-second watchdog while 1.5M confirmed sats sat ready.
  Recovery is now demand-driven: it runs only when the local balance is actually
  short of the amount.
- Toolbox reconciliation no longer competes with the transaction it is
  reconciling. Its tasks share IndexedDB with `createAction`, and their reviews
  were landing as multi-second main-thread stalls mid-send; they pause for the
  spend region and resume after it releases.
- Activity stops going blank past a few screens. The list is its own scroll
  container, so the windowed slice was measuring how far the list had scrolled
  past itself — always zero — and kept the first rows mounted while the
  scrollbar travelled through the end spacer.

### Changed

- A transaction that moves several collectables reads as one batch: "Sent 3
  Pixel Foxes", with the pile shown behind the thumbnail and an exact count,
  instead of naming one arbitrary member and listing the rest as footnotes. A
  batch is only named after a series every member shares; mixed sends say
  "3 collectables". The individual names moved to the detail panel, which now
  lists the other items in the same transfer.

### Internal

- Architecture hardening: frozen BRC-100 method and handler contracts, a durable
  storage registry with versioned envelopes, typed wallet outcomes and a cache
  registry behind account rebinds, feature facades for collectables, market,
  activity, and messages, an executable statechart manifest, selector-based read
  models, and `@handcash/wallet-ui` narrowed to explicit entrypoints.

## [1.3.208] - 2026-09-16

### Changed

- Deferred images decide visibility from an observer instead of measuring layout
  while they render. Every row of a long list used to ask the browser for its
  position on each render, and the release path measured again on top of that;
  both now read state the observers already maintain.

## [1.3.207] - 2026-09-16

### Fixed

- Paying yourself is two records again — coins out and coins in. Folding every
  leg of a transaction into one record is right for a market deal, where the
  coins and the item are one thing that happened, but it hid half of an ordinary
  self-send behind the other half.
- Scrolling a long list no longer re-renders every row on each scroll event. The
  windowed slice is measured at most once per frame and published only when it
  actually moves.
- Feeds share one "is scrolling" flag with a single settle timer. Two owners on
  different timers had been clearing it mid-fling, and one list unmounting
  cleared it for the rest.
- Rows mounted while the list was moving now prefetch their images normally once
  it settles, instead of staying in a shrunken-margin mode that painted
  skeletons as you scrolled.

## [1.3.206] - 2026-09-16

### Fixed

- A send that stops responding no longer blocks every later payment. The
  exclusive spend region is released when the send watchdog gives up (or after a
  hard ceiling), the wallet reports a named failure instead of spinning, and the
  next send clears any reserved batch before it selects inputs.
- Market sale receipts that can never become valid — a cancelled listing, a
  settlement already spent by another transaction, a payout mismatch — are
  acknowledged and dropped instead of re-verified on every inbox poll and
  navigation. Receipts still waiting on transaction data now back off.
- A BSV-21 mint that never reached the chain no longer lingers in the inventory
  as a burn-only card, while a tip the chain confirmed stays visible until the
  basket catches up.
- The fingerprint prompt follows the unlock factors actually enrolled in the
  vault, so a device wrap always prompts, and the chosen factor is logged.
- Freeze reports name the wallet layer that was running when the thread blocked.

## [1.3.205] - 2026-09-16

### Fixed

- Fresh BRC-162 mints now retry their local locking-script proof across the
  createAction/cache race, so an unverified token card resolves in seconds
  instead of waiting for a later full basket refresh.
- Background inbox polling no longer waits for market recovery or reparses the
  complete chat history once per friend. This removes recurring main-thread
  work that could interrupt navigation and scrolling on Android.
- Large asset paints are coalesced and projected as non-urgent UI updates, and
  mobile payment recovery yields between hints instead of monopolizing the
  WebView thread.

## [1.3.204] - 2026-09-16

### Fixed

- A freshly minted BSV-21 token is no longer labelled burn-only legacy. Only a
  decoded locking script may name the wire format: a BRC-162 lock is `brc162`,
  an ord inscription is `legacy-json`, and remittance or tags alone leave the
  card unclassified until the live basket read decides.
- Token display caches written by 1.3.203 drop their inferred legacy stamp on
  read, so an already-minted token recovers Send without a reinstall.

## [1.3.203] - 2026-09-16

### Fixed

- Old token cache rows are no longer assumed to be legacy JSON BSV-21. Collect
  verifies the live locking script before enabling Send or legacy Burn.
- Android inbox recovery now internalizes one payment hint per UI turn, and app
  resume no longer starts a forced spendable-output audit. Navigation remains
  responsive while wallet maintenance catches up.

## [1.3.202] - 2026-09-16

### Added

- Friend chat is sealed with BRC-169 §7 / BRC-78 envelopes so a messagebox
  operator cannot read bodies. A live IPv6 session (draft BRC-246) carries the
  same sealed chat when both wallets are reachable; inbound lines land on the
  friend thread, not the identity-key id. Android uses the same socket protocol
  through a Capacitor plugin when the phone has a global unicast IPv6 address.

### Changed

- Park BRC-230 catalog expansion packs outside the public-beta wallet until
  their protocol and product surface are ready.

## [1.3.201] - 2026-09-16

### Fixed

- Windows release checks now normalize SVG line endings before verifying tray
  icon source hashes. CRLF checkout conversion no longer rejects unchanged art.

## [1.3.200] - 2026-09-16

### Fixed

- Freshly minted and received 1Sat items now paint artwork from local
  transaction or BRC-150 proof bytes before using an indexer to fill missing
  metadata.
- Item fallback icons are vertically centered in their square image frames.
- Existing and newly imported BRC-162 holdings retain their binary supply
  classification, so Mobile no longer presents them as burn-only legacy BSV-21.

### Changed

- Removed the retired `1sat-ft` wallet paths, protocol aliases, and documentation.

## [1.3.199] - 2026-09-16

### Fixed

- System tray showed the retired HandCash mark. `nativeImage` cannot decode SVG,
  so the tray only ever loads PNG — and the PNGs were a logo generation behind
  `handcash-tray*.svg`, which the code called the source of truth. They are now
  rasterized from that SVG by `npm run icons:tray`, pinned, and checked by
  `electron/trayAssets.test.ts`, so the tray cannot silently fall behind again.
- A missing tray PNG now logs what to run instead of dropping through a dead SVG
  branch that could never decode.

## [1.3.198] - 2026-09-16

### Fixed

- Release notes: the Activity action-mark change shipped in 1.3.197 and is now
  recorded there instead of under a 1.3.196 heading that was never tagged.

## [1.3.197] - 2026-09-16

### Changed

- Every Activity action now owns its own mark. A sale no longer borrows the
  listing's price tag: listing is a tag, a withdrawn listing is a struck tag, a
  sale is a banknote, a purchase is a dollar sign, and all four wear the market
  accent — the glyph names the action, not the colour.
- The action vocabulary moved to `activityActionMark.ts` and the icon table is
  exhaustive by type, so a new action cannot ship wearing another one's icon.

## [1.3.195] - 2026-09-16

### Changed

- One transaction is now one Activity record. A listing and the held item it
  created, a purchase and what it bought, a sale and its proceeds each read as a
  single button instead of two unrelated rows, and the record is priced from the
  money leg of that transaction (`activityRecords.ts`).
- A transaction that moved several distinct assets keeps a row per asset, folded
  inside that one record rather than fragmenting the feed.
- A bought collectable reads "Bought <name>", and payment details show Paid /
  Proceeds for the transaction the open row belongs to.

## [1.3.194] - 2026-09-16

### Fixed

- Accept a sale receipt for a listing that shipped list-time unlocks. A buyer
  using pre-signed unlocks never reserves the listing, so the seller refused
  every receipt and the sale sat unacknowledged in messagebox: no proceeds, no
  Sold activity. Authority is now explicit — the settlement must spend the
  listed item and its offer and pay the listing's own payTo plus market fee.
- Only the selling account may ingest a receipt (authorizations are shared
  across accounts), and every refusal now logs a named reason.

## [1.3.193] - 2026-09-16

### Fixed

- Read the listed tip by its origin tag instead of scanning the whole 1sat
  basket with locking scripts and remittance, and probe tip liveness alongside
  that read rather than after it.

### Added

- Phase timings for a market listing (`[market-list] +Nms …`) covering spend
  queue wait, basket read, liveness probe, BRC-150 rebuild and publish package,
  signing, and miner acknowledgement.

## [1.3.192] - 2026-09-16

### Fixed

- Keep oversized market receipts inline in BRC-33 instead of using `/files`;
  sellers now fetch settlement BEEF by txid and poll their inbox immediately
  when their wallet account becomes active.
- Extend the admitted BRC-150 proof across a purchase locally, avoiding duplicate
  indexer walks and stale Verifying status for a just-purchased item.
- Show removed market items as Sold activity with a distinct green sale
  subscript, preserved item identity, and seller proceeds alongside it.

## [1.3.191] - 2026-09-16

### Fixed

- Complete market purchases after a bounded miner handoff instead of waiting
  indefinitely for provider acknowledgement.
- Keep seller receipts durable until delivery or local proceeds ingestion
  succeeds, with account-safe retries after the buyer spend lease exits.
- Paint the purchased NFT in the receiving wallet immediately after broadcast;
  self-purchases retire the exact sold tip before inserting the new output.

## [1.3.190] - 2026-09-16

### Fixed

- Restore yellow price-tag and dollar-sign action subscripts to listing,
  cancellation, purchase, and received-item Activity rows and detail heroes.
- Self-purchases no longer post the same settlement twice from buyer and seller
  roles, removing the extra miner timeout from the purchase path.
- Sold announcements include the active wallet payment address, allowing the
  overlay to validate output 0 and remove the listing from the public catalog.

## [1.3.189] - 2026-09-16

### Fixed

- Inventory and app connect could hang or come back empty. The self-purchase
  Activity repair added in 1.3.188 ran on every collectables load, matched
  listings to purchases by origin instead of by the listing outpoint, and could
  retire a still-held item — mutating and notifying the cache re-entrantly from
  inside the load. Removed it; the settlement path already retires the seller
  tip when a sale actually settles.

## [1.3.188] - 2026-09-16

### Fixed

- The sold-listing announce now targets the BRC-22 overlay host. `market.handcash.io` redirects to the storefront, so `/submit` there answered HTML and the de-list never landed.

## [1.3.187] - 2026-09-16

### Fixed

- A sold listing is now de-listed from the market. The settlement is submitted to the overlay with the buyer context it requires, and the cached catalog row is dropped immediately.
- Listing and purchase now use the same subscript badge convention as send/receive/mint/burn — a yellow price tag for listings and a yellow dollar sign for purchases — instead of replacing the row artwork.

## [1.3.186] - 2026-09-15

### Fixed

- On upgrade, completed self-purchases recover from Activity and retire seller tips left stale by older builds.

## [1.3.185] - 2026-09-15

### Fixed

- Self-purchases now reconcile seller proceeds and the listing deposit locally, retire the old seller tip immediately, and publish the corrected balance.
- Spent collectables leave the verification queue immediately instead of consuming UI/network work.

### Changed

- Market listings use a yellow price-tag icon; purchases use a distinct yellow dollar icon in Activity and transaction details.

## [1.3.184] - 2026-09-15

### Fixed

- Prevented Activity cleanup and delayed change healing from aborting an NFT action batch while `signAction` is committing it.

## [1.3.183] - 2026-09-15

### Fixed

- Made the market-offer fixture suite hermetic so tagged Mac and Linux packaging jobs do not depend on a sibling BRC-CLOUD checkout.

## [1.3.182] - 2026-09-15

### Fixed

- Rebuilt the wallet selector on an explicit Aeon/XState interaction model.
- Isolated sync, progress, and delayed collectable publications by wallet account.
- Removed the slow pre-send change scan and fenced late cleanup from aborting active NFT sends.
- Smoothed long activity and collectable feeds without hiding Recent Activity or shifting desktop controls.

### Changed

- Added named wallet modules for spend verdicts, chain probes, market offers, and UI feeds.

## [1.3.181] - 2026-09-15

### Changed

- Patch release (every push must ship a new version).

## [1.3.180] - 2026-09-15

### Fixed

- Market listing no longer treats Arcade `MINED` / indexer `isUtxo=false` as proof that funding coins were spent. That false verdict was wiping live change after MissingInputs and surfacing “A coin that was going to pay for this listing had already been spent.”
- Ghost MissingInputs on a list attempt aborts cleanly and keeps the tip; only explicit already-spent / double-spend answers may retire coins.

## [1.3.179] - 2026-09-15

### Changed

- Patch release (every push must ship a new version).

## [1.3.178] - 2026-09-15

### Fixed

- Market offers now encode one-byte script-number fields with minimal opcodes (`OP_1` / `OP_2`). The previous `01 01` version push was accepted by the overlay but could never be spent under miner `MINIMALDATA` policy, causing Mobile buys to fail on offer input 1 with “This data is not minimally-encoded.”
- Buyers reject legacy malformed offers before wallet signing with a clear “seller must relist” error. A VM-level regression test spends the corrected offer script under `Spend.validate()`.
- Market buy is one buyer-side wallet request. `purchaseMarketListing` now verifies provenance and creates the buyer-signed intent itself when omitted, preserving compatibility with older clients that still provide an intent.

## [1.3.177] - 2026-09-15

### Fixed

- Release Linux no longer dies on `sentItemGuard`. The listing-auth invalidate waitFor was 15s while the test still used Vitest’s default 5s timeout.

## [1.3.176] - 2026-09-15

### Fixed

- Release Windows builds again. The regression suite imports `scripts/require-toolbox-patch.mjs`, so Vite transformed it and its `#!/usr/bin/env node` line was invalid JS on windows-latest; mac and linux stripped it silently. The pre-push hook already invokes the script as `node <path>`, so the shebang is gone.
- Release Mac no longer flakes on `sentItemGuard`. The market-authorization assertion waits on an invalidate that loads `marketListing` through a dynamic import, which does not fit the default 1s `waitFor` budget on a cold runner.

## [1.3.175] - 2026-09-15

### Fixed

- Release Windows can build again. `toolboxChangeScriptPatch.test.ts` imported `scripts/require-toolbox-patch.mjs` by static specifier, so Vite transformed a plain ESM file from outside `src/` and threw `SyntaxError` on windows-latest; it is loaded by file URL at runtime now.

## [1.3.174] - 2026-09-15

### Fixed

- Release workflows no longer exit 1 while reporting a green suite. Four collectable tests stubbed `sentItemGuard` with a fixed set of exports, so the `isItemAbandoned` read on the relinquish path threw an unhandled rejection; those mocks are partial now. 1.3.173 shipped no installers because of this.

## [1.3.173] - 2026-09-15

### Fixed

- Market list no longer reports "Already spent" for a tip it can still spend. Miner MissingInputs is now attributed to our own BEEF when we could not complete its ancestry, and only names a spend conflict once chain proof shows an input is gone.
- Signed AtomicBEEF is hydrated to broadcast-safe before postBeef instead of being posted after a 2s race, which guaranteed MissingInputs from every provider.
- An Arcade service that merely errored (no txid-row defect) no longer counts as a hard reject that drops the local spend.
- postBeef `detail` records provider reasons, not just statuses.
- BSV-21 list no longer stalls after a cover split. The listing carried the split txid to `getBeefForTxidCached`, which asked GorillaPool, then WhatsOnChain, then raw + a nested hydrate for a merkle proof of a transaction broadcast seconds earlier; it now reuses the signed split BEEF it already holds.
- The pre-postBeef hydrate is skipped when every remaining gap is a proof for a parent whose body the BEEF already carries — mining is the only thing that can close that gap, so waiting only cost fetch timeouts. Genuinely fetchable gaps wait 8s, not 15s.

## [1.3.172] - 2026-09-15

### Changed

- Offline market buy: list-time settlementUnlocks + messagebox remittance; overlay admits the same BEEF without a second sendMessage.
- Durable list: exclusive spend, abort unsent noSend after Arcade hard-reject, restore tip when basket misses.
- Dev Arcade TLS: Vite proxy `secure: false` and Electron CERT_ERR bypass for local market.

## [1.3.171] - 2026-09-15

### Changed

- Market buys: list-time settlement unlocks and same-wallet self-buy (no seller messagebox wait); broadcast once with delayed sign.
- BEEF is the BRC-100 exchange; Arcade is a non-blocking double-check. Credit internalize locally.
- Nav: drop jumpy section skeletons; breadcrumb follows the tab. Two-line sync pill.
- Reload after Chromium render-process-gone so the wallet bridge comes back.

## [1.3.170] - 2026-09-15

### Changed

- Arcade hard-reject no longer soft-submits (transport catch was swallowing the drop).

## [1.3.169] - 2026-09-15

### Changed

- Apps must request scoped inventory (`p 1sat all` / `p bsv21 all`); bare `1sat`/`bsv21` listOutputs is refused.
- Market Cloudflare build rebuilt to use BRC-165 `p 1sat all` (was still bare `1sat`).

## [1.3.168] - 2026-09-15

### Changed

- Nav: instant tab click SFX + section skeleton while panel catches up (PR #7).
- Arcade success finishes send immediately (no explorer wait).
- Arcade invalid/missing-UTXO reject drops local spend so phantom pendingChange cannot paint.
- Ancestor BEEF hydrate before postBeef capped at 2s.

## [1.3.167] - 2026-09-15

### Changed

- Market listing: accept on Arcade broadcast (not SPV on-chain), keep Activity history after a successful pin, and allow unproven input BEEF for recent parents.

## [1.3.166] - 2026-09-15

### Changed

- App auth/pay: use proven confirmed balance when storage is busy (1.5s live read budget).
- Defer promoting unsent/noSend app change so the next app prefers fresh UTXOs.
- Hydrate ancestor BEEF before Arcade postBeef; promote change on processAction/Arcade pin.
- Identity: label bar without back button; list-mode-only square connected-apps actions.

## [1.3.165] - 2026-09-15

### Changed

- Market buys: list-time pre-signed settlement unlocks so purchases complete without a live seller messagebox wait; longer seller wait and local BRC-150 verify remain for older listings.

## [1.3.164] - 2026-09-15

### Changed

- Identity label bar + back to Activity; no tall empty gap under Handle.
- Compose identity fields full width.
- Connected-apps settings/launch buttons fixed ~40×40 (not squished).

## [1.3.163] - 2026-09-15

### Changed

- Identity undocked: pre-dock card layout with tighter padding (no action-bar chrome).
- Connect/launch opens the system browser by default; in-app only when chosen.
- Connected-apps settings/launch buttons stay square (~40×40).
- Explorer 404 / not-found is unknown (lag), not absent — seals stay until hard absence.

## [1.3.162] - 2026-09-15

### Changed

- Stop sealed-spend reclaim from bouncing the hero (47¢→23¢→70¢ with no Activity).
- Display/chained heal promotes pending change only — balance stays Σ spendable UTXOs.

## [1.3.161] - 2026-09-15

### Changed

- Detail views dock Send/Save/Burn (and ID Publish/Copy/Claim) into the nav action bar.
- Denser identity page with larger QR; list Send icon-only; tighter connected-apps spent column on mobile.
- Paint BSV-21 createAction mints into Tokens immediately; keep genesis rows when listOutputs is empty.
- Bump hero balance after app createAction seal; permission heads-up on mobile even when foregrounded.

## [1.3.160] - 2026-09-15

### Changed

- Durable block-header cache + demote lagging HandCash Chain; soft-deadline shed; adaptive tip poll.
- Send Fungible warns when peer identity does not advertise BSV-21 protocols.
- Tip ingest: Arcade hard-reject discards (ghost/ACK); explorer lag does not.

## [1.3.159] - 2026-09-14

### Fixed

- Double balance after promote: seal spent inputs before keeping change (Arcade-pin / heal / restore).

## [1.3.158] - 2026-09-14

### Changed

- Hero identity: full \$handle, clearer caret/copy spacing on mobile.
- Tip ingest: Arcade is validity truth (no ghost on explorer 404).
- Balance: invalidate stale coalesced reads after ingest; promote live change onto spendable UTXOs once.
- Sync: stop 30s full UTXO rescans driven by collectables-awaiting-origin.

## [1.3.157] - 2026-09-14

### Changed

- Hero identity chip shows the full $handle / mid-truncated id — no more clipping the last letters under the caret.

## [1.3.156] - 2026-09-14

### Changed

- Tip ingest treats Arcade as validity truth — Bitails/WoC 404 no longer ghosts inbound tips or restores Arcade-accepted spends.

## [1.3.155] - 2026-09-14

### Fixed

- Hero identity label no longer covered by the dropdown arrow.

## [1.3.154] - 2026-09-14

### Fixed

- Mobile sync pill no longer too wide / off-screen; capped and shrinkable with ellipsis.

## [1.3.153] - 2026-09-14

### Fixed

- CI typecheck: strip unused vault sibling credit implementation (disabled stub only).

## [1.3.152] - 2026-09-14

### Fixed

- Doubled balance after v1.3.146 sibling credit: heal reseals spent inputs before promoting change; sibling credit hard-disabled.

## [1.3.151] - 2026-09-14

### Fixed

- Titlebar sync pill keeps a fixed width on mobile so Catching up cannot grow the bar.

## [1.3.150] - 2026-09-14

### Fixed

- Hero balance can drop after heal/refresh (keep-high only mid-send).
- Heal republishes toolbox display balance and rewrites trusted snapshot.

## [1.3.149] - 2026-09-14

### Fixed

- Remove same-vault sibling-credit from BRC-29 send (was failing txs / doubling balance).
- Account switch paints from local toolbox spendable, not poisoned trusted snapshot.

## [1.3.148] - 2026-09-14

### Fixed

- Revert titlebar to prior layout; sync status pill capped so it cannot squish chrome.

## [1.3.147] - 2026-09-14

### Fixed

- Vault sibling credit no longer doubles balance or hangs the send.
- Activity / pending-send / payment progress scoped per vault account.
- Faster switch paint from trusted local balance; mobile titlebar actions on-screen.

## [1.3.146] - 2026-09-14

### Fixed

- Per-account sync health; local UTXO balance on vault switch (no 800ms→0).
- Same-vault root→child BRC-29 credits the child’s toolbox on-device.

## [1.3.145] - 2026-09-14

### Fixed

- Restore mobile titlebar HandCash / Mobile / version labels; sync pill shrinks first.

## [1.3.144] - 2026-09-14

### Fixed

- Mobile titlebar: scan/lock stay on-screen; wordmark hidden; sync pill shrinks.

## [1.3.143] - 2026-09-14

### Fixed

- Collectables and tokens no longer spill across vault accounts after switch (in-flight list race).
- Mobile titlebar keeps scan/lock + sync on-screen; update toast sits above the bottom nav.
- Identity chip no longer stacks ellipsis dots.
- Account menu: Root tag, icon rename control, dropdown padding.

## [1.3.142] - 2026-09-14

### Fixed

- Scope activity, inventory, connected apps, friends, and messages to the active vault sub-account.
- Titlebar status pill no longer stretches the window or squeezes the logo.
- Account menu dropdown spans the hero head edge-to-edge.

## [1.3.141] - 2026-09-14

### Added

- Vault sub-accounts (BRC-146): named wallets under one unlock; hero identity dropdown to switch / create / rename.
- In-app BAP compose on Identity: publish ID + ALIAS profile (name / about / image) for the active account.

### Removed

- Parallel Sigma identity personas (`sigmaIdentity`). Keep BRC-246 IPv6 session upgrade. Issuer stamps stay BAP-backed (BRC-247).

## [1.3.140] - 2026-09-14

### Fixed

- Sigma identity inscription signing: hash the ordinal prefix and append the OP_RETURN / `|` / SIGMA tail as hex so release tests and VIN verify pass.

## [1.3.139] - 2026-09-14

### Fixed

- Sigma identity TypeScript errors that blocked macOS/Linux/Windows release builds (duplicate `v`, missing `fundVout`, invalid payment phase).

## [1.3.138] - 2026-09-14

### Added

- BRC-246 session upgrade: signed IPv6 wallet-to-wallet delivery over a short-lived authenticated socket (messagebox remains rendezvous / offline inbox).
- BRC-247 Sigma identity: VIN-bound issuer personas on BRC-100, with Identity panel publish / rotate / revoke.

## [1.3.137] - 2026-09-09

### Added

- Connect **Authorize** includes **auto-accept incoming plain BSV** by default (listed under Receive — no extra checkbox). **Auto-pay** can be enabled on the same Connect prompt so the first payment need not redirect. Auto-pay stores a **sat snapshot** of the dollar limit so silent pay can continue if FX is temporarily missing. Shared Auto-pay / Connect scope UI. Chip + turn-off remain in Connected apps. Collectables still need separate receive grants.

### Changed

- App identity proofs are [BRC-138](https://bsv.brc.dev/peer-to-peer/0138.md) (`[2, "bsv auth proof"]` via `createSignature`). The HandCash challenge recipe is refused. A proof does not authorize spend. Multi-identity and BRC-174 name tokens stay deferred.

### Fixed

- Collect: spending a listed tip actually cancels its market listing auth (underscore outpoint filter made invalidate a no-op).
- Collect: after a send clears the live UTXO cache, same-origin tips no longer collapse — both held foxes stay visible.

## [1.3.136] - 2026-09-09

### Fixed

- BRC-100 connect: stop clearing bridge readiness on `did-start-loading` (Vite/soft loads left `/getVersion` as `renderer-not-ready` until restart). Renderer re-announces readiness on a heartbeat while listening.

## [1.3.135] - 2026-09-09

### Fixed

- In-app browser stays alive when you leave Apps or an incoming request appears: the webview session is parked (not destroyed) and shows under the permission overlay until you Close it.

## [1.3.134] - 2026-09-09

### Fixed

- BRC-100 connect: revert the HTTPS UI `loadURL` / `webRequest` / recovery path that cleared bridge readiness after 1.3.131. Keep HTTPS-First disabled and the in-app browser launch; `/getVersion` uses the pre-regression navigation + readiness wiring again.

## [1.3.133] - 2026-09-09

### Fixed

- Wallet UI stays HTTP-only: rewrite `https://localhost:5173` at the network layer before TLS, never `loadURL` on HTTPS upgrades, and stop clearing bridge readiness on soft reloads.

## [1.3.132] - 2026-09-09

### Fixed

- BRC-100 connect: blocking Chromium HTTPS-First redirects no longer calls `loadURL` (that cleared bridge readiness and left every `/getVersion` as `renderer-not-ready`).
- Soft UI reloads no longer fail in-flight bridge requests; readiness returns when the renderer re-registers.

## [1.3.131] - 2026-09-09

### Fixed

- Request-dock Cancel no longer picks up neon green bleed: idle slots are opaque charcoal; danger/primary use black ink on bright fills.
- Chromium HTTPS-First can no longer blank the wallet UI (`https://localhost:5173`) and leave BRC-100 connects as `renderer-not-ready`.
- After Accept / Visit site / Connected apps launch, apps open in the embedded in-app browser.
- Spent tips clear local market listing auth so Collect does not keep a stale Listed badge.

### Added

- Collect search bar (name, traits, origin, ids; comma-separated AND filters).
- App-connect guardrail tests covering HTTPS UI upgrade, bridge readiness, and CORS.

## [1.3.130] - 2026-09-09

### Fixed

- Item receive activity no longer invents tip `.0` when the outpoint is still unknown.

## [1.3.129] - 2026-09-09

### Fixed

- Dark-mode Cancel/danger request-dock CTAs use black ink on red for readable contrast.
- Keep the request-dock CTA colour ring when hovering secondary actions.
- Peer item settle internalizes every 1-sat tip in a batch BEEF (second NFT no longer dropped).
- Origin dedupe keeps both inventory cards when both tips are still live UTXOs.

## [1.3.128] - 2026-09-09

### Fixed

- Hermetic CI skips overlay contract tests that need a sibling BRC-CLOUD checkout so GitHub can attach installers.

## [1.3.127] - 2026-09-09

### Fixed

- Review / primary request-dock actions use dark ink on neon green in dark mode so the label stays readable.

## [1.3.126] - 2026-09-09

### Fixed

- Allow spends while chain ingest is running; stop painting Synced while the spend lock is still held.
- Item send `signAction` knownTxids come from the full input BEEF (no more false “unable to merge txid”).
- Activity matches same-txid item rows by outpoint so a multi-NFT receive shows every item.
- Drop ghost Unattested token cards invented from activity when the live list has none.
- Request dock: Cancel/Back stay muted until hovered; opaque unselected slots so CTA green does not bleed under Cancel.

### Changed

- Compact Send BSV and app-launch panels; launch choices live only on the action dock.
- Prefer Open in-app as the launch CTA when the embedded browser is available.
- Tighter Identity / Receive / chat / apps layout on desktop.

## [1.3.125] - 2026-09-09

### Fixed

- Resolve leftover `fungibles` / list imports after the token-stack move so Desktop and Mobile both build.

## [1.3.124] - 2026-09-09

### Fixed

- Keep 1-sat BSV-21 (162) tips in Tokens, not Collect; recover misfiled token receives from activity.
- UTXO heal is Settings-only so sends always run first.
- Item send `signAction` BEEF merge context.

### Changed

- Single BRC-162/163 token stack (`src/wallet/token`) for Collect, market, and BRC-100 issuer.
- Connected apps: Friends-style search and a 3-wide grid on widescreen desktop.

## [1.3.123] - 2026-09-09

### Fixed

- Unstick stalled sends: abort leftover action-batch reservations, heal UTXOs from history, and keep Pay / BRC-29 moving.
- Handle resolution no longer hangs the recipient field.

## [1.3.122] - 2026-09-09

### Fixed

- Burned tokens leave inventory; stale burn recovery no longer re-locks spends.
- Contextual action bar hierarchy and slot transitions; clearer action feedback.
- Widen desktop connected-app cards.

## [1.3.121] - 2026-09-09

### Fixed

- Paint received BSV-21 tokens immediately and recover them from activity with metadata intact.
- Keep wallet transactions active in the background.
- Legacy BSV-21 burn: restore inputs, recover P2PKH / leftover tips without blocking verification, and avoid a recursive spend lock.
- Verify inbound peer NFTs; ship large market settlements without truncating BEEF.
- Keep approvals and burns responsive, including destructive-approval contrast.
- Desktop item selection, embedded app browsing, action progress, and navigation polish.

## [1.3.120] - 2026-09-08

### Fixed

- **Missing token parent body** — fill raw 162 parent transactions into the send BEEF (still no merkle-proof hunt) so BRC-176 prove can walk back to deploy after an unmined mint.
- **Partial token send subtracted too much** — classify payee vs change from the signed tx instead of assuming vout 1. Leave the payee out of the sender's `bsv21` basket so leftover change stays on the balance.

## [1.3.119] - 2026-09-08

### Fixed

- **BSV-21 send of a freshly minted token** — do not hunt merkle proofs for an unmined 162 genesis, or run a full UTXO promote, before `createAction`. Sign against local BEEF (`trustSelf`) the same way mint does. Recover the locking script from that BEEF when `listOutputs` has no 162 lock.

## [1.3.118] - 2026-09-08

### Fixed

- **Market inventory via BRC-165** — catalog `listOutputs` is `p 1sat all` / `p bsv21 all` (item-view permission), not storage basket `1sat`. Live and cached rows skip remittance BEEF so a ~700-item wallet does not stall on “Loading wallet items…”.
- Allow verified unconfirmed collectable sends.

## [1.3.117] - 2026-09-08

### Fixed

- **Large collectable proofs** — when Atomic BEEF does not fit in `sendMessage`, attach it on the messagebox file store so the payee can ingest without waiting on an explorer 404.
- Restore inventory swipe and collectable media layout.

## [1.3.116] - 2026-09-08

### Fixed

- **Item send stays Not found after Arcade ACK** — 1.3.114 posted BEEF only to Arcade. Explorers 404, and the payee SPV-fetches because large fox proofs do not fit in the inbox. Arcade stays first; Bitails / WhatsOnChain / GorillaPool postBeef again so the tx is findable.

## [1.3.115] - 2026-09-08

### Fixed

- **Item send sat 30s in Preparing** — light prepare no longer walks explorers or restores the 800-item UTXO set before `createAction`. Pending change is promoted locally; leftover action-batch abort is capped at 1.5s.

### Changed

- Invert desktop approval dock; normalize app amount container.

## [1.3.114] - 2026-09-08

### Fixed

- **Item send 404 / payee never ingested** — `noSend` collectable rows stay `unsent` after Arcade accepts the BEEF. Heal treated that as a ghost, unsealed the inputs, and explorers 404'd the txid so the recipient's SPV fetch had nothing to internalize. Arcade-pinned sends stay sealed and are promoted to `unproven`.
- Bound market seller settlement wait; connected-app rows stay inline with reserved progress space and a consistent spend color.

### Changed

- Arcade is the sole postBeef broadcaster.
- Standard box for the apps icon.

## [1.3.113] - 2026-09-08

### Fixed

- **Verified collectables can send** — BRC-150 Verified is enough to enable Send. Missing remittance BEEF (omitted when over budget) is not treated as unconfirmed, so 700+ foxes no longer all have gray Sends.
- **Sending vanished from Activity** — the 90s watchdog marked Send timed out while the spend was still hung on a backup-host lease / change heal. Sending stays in the feed while spend priority is held; hung exclusive spends abort instead of becoming a zombie.
- **Incoming funds approval** — persist and settle app wallet requests deterministically; broadcast accepted ingests through Arcade.
- **Transaction status latency** — durable observability for in-flight payments; remove false wait-on-status stalls.

### Changed

- Wallet decisions live in the action dock; app and asset cards share one layout; AutoPay utilization shows on app cards.
- Official OS application icon.

## [1.3.112] - 2026-09-08

### Changed

- Patch release (every push must ship a new version).

## [1.3.111] - 2026-09-07

### Fixed

- **Ghost-failed on-chain tx blocked BRC-29 ingest** — hc-a580a `ad40b4db` landed but local status stayed `failed`, so `internalizeAction` refused merge and the phone looped on “Importing BRC-29 payment.” Restore that one row only when explorers prove it exists (`txExistsOnChain === true`); unlock heal scans failed txs the same way. No blanket `listFailedActions(unfail)`.

## [1.3.110] - 2026-09-07

### Fixed

- **Send success is Arcade POST `/tx` ACK** — boot now installs ArcadeBeef first (it was chaintracks-only, so phones never posted to Arcade). Drop `XDeployment-ID` so Capacitor `https://localhost` CORS can submit. No SSE / callback webhook.
- **Heal un-deducted a just-submitted tx** — send-cleanup treated Bitails `exists=false` as a ghost and failed live `unmined` rows (hc-a580a `ad40b4db`). Explorer lag no longer retires pending change after a successful submit.

## [1.3.109] - 2026-09-07

### Fixed

- **Plinko / Arcade createAction hung on seen-on-chain** — third-party `createAction` now returns once Arcade accepts the BEEF (`acceptDelayedBroadcast`). Apps deduct change immediately instead of waiting minutes for a merkle callback.
- **Market buy refused on indexer timeout** — overlay already has the listing BEEF at admit time; prefer that over `getBeefForTxid` so an 8s indexer timeout cannot block the purchase.

## [1.3.108] - 2026-09-06

### Fixed

- **Legacy address scan starved on mobile** — leftover BRC-29 ingest flooded the WebView network stack; BananaBlocks probes then hit the 7s `AbortError` and entered a 45s cooldown, so funding never swept. Prefer Bitails first with BananaBlocks last-resort only, do not cooldown on abort timeouts, and give phone scans a longer deadline.
- **Wipe left ghost tokens / activity** — factory wipe only cleared `handcash.brc100.*`, so `handcash.fungibles.list.v1` (BSV-21 King token paint), `handcash.brc29.pendingOutbox.v1`, BRC-150 remittance maps, and the cloud-backup watchdog survived. A new or reinstalled wallet reused those caches: collectables showed King, Activity filled with failed remittance noise. Wipe now clears all `handcash.*` wallet state (appearance / SFX / update mode / log-upload URL still survive).

## [1.3.107] - 2026-09-05

### Removed

- **Kallubi (bsv.cx)** — dropped from legacy scan, Settings health probes, and HandCash Chain upstream (never reliable on lab devices).

### Fixed

- **Ghost sealer reclaim** — when a local sealer is proven off-chain, fail that tx so pending change retires and sealed inputs can return to spendable.

## [1.3.106] - 2026-09-05

### Fixed

- **Bottom nav end caps** — connected muted runs stay joined; outer corners use the dock’s `--wallet-nav-pill-radius` (not `999px` floating capsules).

## [1.3.105] - 2026-09-05

### Fixed

- **Bottom nav connected pills** — restore joined unselected runs (square mid-edges + capped ends). 1.3.104’s per-tab gap/radius split adjacent muted tabs into separate pills.

## [1.3.104] - 2026-09-05

### Fixed

- **Heal vs burn deadlock** — manual UTXO heal yields to spend between batches so burns/sends are not wedged behind a 10-minute chainIngest hold.
- **Ghost pending change** — local sends explorers prove never landed (e.g. miner hard-reject) are failed and retired instead of keepChange forever (`pendingChange=2614` stuck on `cb36a9099dfc`).

### Changed

- **Loading rings** — shared `LoadingSpinner`; burn pending marks use the same accent as send.
- **Bottom nav pills** — (superseded in 1.3.105 — connected adjacent runs restored).

## [1.3.103] - 2026-09-05

### Changed

- **Wallet chrome** — docked nav pills, top breadcrumbs, full-width hero; Send/Receive restructure with foot labels.

## [1.3.102] - 2026-09-05

### Fixed

- **Mobile Connect hung** — never await app `manifest.json` before showing the Connect prompt; spendingAuthorization loads in the background (regression from 1.3.100).

## [1.3.101] - 2026-09-05

### Fixed

- **Connect spendingAuthorization fetch** — `requestOriginPermission` is async so Vite/Rollup can bundle the manifest lookup (Mobile APK build).

## [1.3.100] - 2026-09-05

### Fixed

- **App rapid createAction / Plinko chaining** — after `createAction` and `internalizeAction`, promote unspent default-basket outs (change + received) so the next spend can select them without waiting on confirmation; spend gate retries a light promote and adds a fee buffer.

### Added

- **BRC spendingAuthorization** — Connect reads app `manifest.json` monthly sat grant in the background (never blocks the Connect prompt); Authorize stores the grant. Auto-pay is still chosen on a payment approve prompt.
- **Clearer BRC-100 spend codes** — `CHANGE_CHAINING_REQUIRED`, `INSUFFICIENT_FUNDS`, `DOUBLE_SPENT` (replacing a catch-all stale-funds code for those cases).
- **TLS `::1` SAN** — Desktop self-signed cert includes IPv6 loopback; regenerates if an old cert lacks it.
- **Partner FAQ** — `docs/partner-brc100-faq.md`.

## [1.3.99] - 2026-09-04

### Fixed

- **Mobile nav dock shadow** — remove the soft drop shadow that bled onto the sheet behind the bottom bar.

## [1.3.98] - 2026-09-04

### Fixed

- **Balance zeroed after failed consolidate** — hard-reject / ghost miner noise releases seals instead of hiding inputs when the signed tx is not on chain; consolidate refuses to internalize unconfirmed broadcasts; reclaim treats local failed/unsent sealers as dead without waiting on explorers.

### Changed

- **Friend labels** — custom local labels for identity-key / peerpay friends; handle-identified friends keep a fixed `$handle` display (no rename).

## [1.3.97] - 2026-09-04

### Fixed

- **Light-mode balance green** — restore very dark HandCash green (`#0a3d22`) on balance and up-change figures (was mid `#0c8f3e`).

## [1.3.96] - 2026-09-04

### Fixed

- **Missing ~967k sats after ghost consolidate** — reclaim named + blank seals together; unseal clears `spentBy`; restore revives unspent coins under inconclusive explorers / `unsent` sealers; service-only miner errors no longer call `onAlreadySpentSend`.

## [1.3.95] - 2026-09-04

### Fixed

- **Burns hung behind auto UTXO heal** — background heal yields when a burn/send raises spend priority (no longer holds `chainIngest` through a long script sweep); burn leases heartbeat so priority does not expire mid-wait; `onAlreadySpentSend` keeps sealer `txid` on overlay locks; reclaim can revive blank-sealer coins still unspent on the indexer.

## [1.3.94] - 2026-09-04

### Fixed

- **Reclaim after ghost consolidate** — when a sealing tx is proven off-chain, revive sealed inputs without waiting on indexer `isUtxo`; restore also clears overlay blocks for unsent sealers (phone stuck at 7.78M / 144 locally-spent).

## [1.3.93] - 2026-09-04

### Fixed

- **Failed change consolidate hiding spendable sats** — ghost / unproven miner “Already spent” no longer calls `onAlreadySpentSend`; reclaim unseals inputs whose sealing tx never landed on chain (up to 200); consolidate releases seals on broadcast failure.

## [1.3.92] - 2026-09-04

### Fixed

- **Linux / CI package builds** — TypeScript errors that blocked Release Linux/Mac/Windows packaging.

### Changed

- **Wallet shared helpers** — extract common base64 / ord-script / peer-ingest helpers without changing custody paths; BRC-100 activity side-effects split out of the handler.

## [1.3.91] - 2026-09-02

### Fixed

- **Stuck pending change heal** — promote live pending change and script-heal **before** historical txid scan; batch txids (24/pass) with incremental checkpoint so interrupted heals resume without re-walking 206 network lookups.

## [1.3.90] - 2026-09-02

### Fixed

- **Heal vs Sync overlap** — UTXO heal runs inside the chain-ingest coordinator mutex; manual Sync refuses while heal is in flight.

### Changed

- **BSV-21 misfile heal** — `healMisfiledBsv21()` runs after Refresh (beside collectables heal).

### Added

- **BSV-21 architecture doc** — `docs/bsv21-handling-architecture.md` (ingress, send/burn gaps, intentional vs incomplete paths).

## [1.3.89] - 2026-09-02

### Changed

- **UTXO heal checkpoint** — durable txid checkpoint with 6h overlap; auto passes after send cleanup and pending-change background; Settings shows OK / last-healed hint (no Activity progress bar).
- **Wallet health UX** — heal row matches dependency probes; Activity only logs manual heals that move sats.

### Added

- **Bitcoin interaction architecture** — `docs/bitcoin-interaction-architecture.md` (layers, Refresh order, send paths, heal rules).

## [1.3.88] - 2026-09-02

### Added

- **Heal UTXO from history** — Settings → Wallet health scans Activity (including archived rows) and session logs for signed txids, releases stuck reservations, credits change, and runs change-heal paths.

### Changed

- **Activity archive** — clearing a row or bulk-clearing failed sends hides it from the feed but keeps it in storage (`archivedAt`) so heal scans and history backup still see txids.

## [1.3.87] - 2026-09-02

### Fixed

- **Balance after clearing sends** — expiring stuck Activity rows or clearing failed sends now releases toolbox reservations and runs change promotion/script heal so pending change becomes spendable again.
- **Chat layout** — Friends → Chat stays inside the normal nav panel (same container as Activity); balance + BSV row hide for extra height without breaking panel chrome.

## [1.3.86] - 2026-09-02

### Fixed

- **Chat vertical space** — Friends → Chat hides the balance hero (and BSV side panel) so the thread fills to the top of the dashboard.
- **Chat back navigation** — breadcrumb Back and Chat crumb sync with nav state; leaving a thread returns to the inbox instead of staying on the stale peer.

## [1.3.85] - 2026-09-02

### Changed

- **Chat in nav** — Messages live under Friends → Chat inside the normal nav panel (no fullscreen dashboard breakout); breadcrumbs show Friends / Chat / thread.
- **Chat payments** — Send-panel BRC-29 notifies stay in the Payments tab only; in-thread `/pay` and `/tip` cards use `chatRef` and still appear in Messages. New Payments tab lists all money moves between you and a friend (chat cards + Activity).
- **Add friend** — Handle/key field first; label prompt only for `peerpay:` URIs; resolved handles show a verified badge when the registry certificate is real.

## [1.3.84] - 2026-09-02

### Changed

- Patch release (every push must ship a new version).

## [1.3.84] - 2026-09-02

### Fixed

- **CI typecheck** — restore `tokenMarketPriceHistory` import, `InboundPaymentHint` item origin fields, and collectable seed paint fallback typing so release workflows pass.

## [1.3.83] - 2026-09-02

### Fixed

- **Friends / Collectables scroll on mobile** — pinned section heads with inner scroll bodies (same flex chain as Settings).
- **Messages layout** — nested under Friends with breadcrumb + bottom tab bar kept; chat fills remaining nav height; composer pinned to thread bottom; peer row date/badge alignment; slim Friends toolbar (icon-only actions).

### Changed

- **Messages chrome** — removed duplicate fullscreen top bar; inbox uses Friends breadcrumb instead of hiding the dock.

## [1.3.82] - 2026-09-02

### Added

- **Fullscreen Messages** — Telegram-style immersive chat (split-pane desktop, list/thread mobile), HandCash-branded chrome, Friends → Messages inbox entry.

### Fixed

- **Collectables grouping** — solo collection items label as **Singles**, not “Not in a collection”.
- **Burn UX** — in-flight burns use warm amber (not error red) on Activity; Burn buttons and BSV-21 inventory show **Burning…** with live overlay via pending Activity rows.

## [1.3.81] - 2026-09-02

### Fixed

- **Settings scroll on mobile** — "Settings" header stays pinned like Activity; Security/Preferences/Support scroll underneath (flex height chain + mobile touch scroll).

### Changed

- **BRC-230 draft** — revised Index Catalog Mirrors spec: wallet-internal install/sync, read-only `p index read` via `listOutputs` (Babbage feedback alignment).

## [1.3.80] - 2026-09-02

### Fixed

- **Re-entered collectables** — tips landing again pick up `collectionId` from remittance tags/CI and origin-keyed inscription cache, so they fold back into the right collection instead of loose/uncategorized; P2P notify carries `itemOrigin` + `itemCollectionId` for the payee.
- **Art while verifying** — received/re-listed items keep genesis content URLs and painted thumbnails during BRC-150 walks instead of flashing skeletons on tip-as-origin placeholders; identity mismatch clears another wallet’s durable inventory cache.
- **Send UX polish** — BSV-panel toasts center long send copy; Settings header stays pinned like Activity while the list scrolls; Add friend uses primary CTA styling; stuck sends say “Send timed out” (not bare “Timed out”) and spent collectables show “Already sent” instead of a vague unavailable state.

## [1.3.79] - 2026-09-02

### Fixed

- **Collectable send speed** — verified NFT sends skip the full change-script sweep (~2k rows) that blocked “Preparing payment” for minutes; light promote reclaims pending change only. Progress keeps “Waiting to send the collectable” instead of resetting to generic copy.
- **BRC-150 offline + fast detail** — durable remittance store (`path` + slim `beefB64`), instant verified badges from `provenCache`, non-blocking item detail/indexer enrich, `trustProven` send path reuses cached proof without re-walking lineage.
- **Collect / send UX** — instant child-panel nav (Send no longer deferred via `startTransition`); send panel seeds from inventory cache (no “not found” flash); detail/send images use `retainDecoded`; decoded thumbnail LRU raised to 1500 for large wallets.

## [1.3.78] - 2026-09-02

### Fixed

- **Large inventory performance** — market inventory serves the durable cache immediately (700+ NFT wallets no longer block items-market on a 20s `listOutputs`); BRC-150 verdict projection yields in chunks; Collect defers ownership refresh and live scans while sending.
- **Input lag** — BSV send amount uses local draft state; collectable grid grouping uses `useDeferredValue`; large cache updates notify subscribers after a UI yield.

## [1.3.77] - 2026-09-02

### Fixed

- **Large inventory performance** — market inventory serves the durable cache immediately (700+ NFT wallets no longer block items-market on a 20s `listOutputs`); BRC-150 verdict projection yields in chunks; Collect defers ownership refresh and live scans while sending.
- **Input lag** — BSV send amount uses local draft state; collectable grid grouping uses `useDeferredValue`; large cache updates notify subscribers after a UI yield.

## [1.3.75] - 2026-09-02

### Fixed

- **Large inventory performance** — market inventory serves the durable cache immediately (700+ NFT wallets no longer block items-market on a 20s `listOutputs`); BRC-150 verdict projection yields in chunks; Collect defers ownership refresh and live scans while sending.
- **Input lag** — BSV send amount uses local draft state; collectable grid grouping uses `useDeferredValue`; large cache updates notify subscribers after a UI yield.

## [1.3.74] - 2026-09-02

### Changed

- Patch release (every push must ship a new version).

## [1.3.73] - 2026-09-02

### Fixed

- **Arcade pin (defense in depth)** — `noteOutboundSendBroadcastFailed` and `removeActivityForTxids` also refuse to drop rows when Arcade was contacted on the initial `postBeef` round.

## [1.3.72] - 2026-09-02

### Fixed

- **Arcade submit pinning** — once the initial `postBeef` round contacts Arcade, a signed tx is not cancelable, not pruned from Activity, and inputs stay sealed unless chain proof shows the spend failed (inputs spent elsewhere). Arcade false `missingInputs` / `doubleSpend` no longer roll back the send.

## [1.3.71] - 2026-09-02

### Changed

- **Collectable send speed** — finish as soon as the tx is signed and sealed (same optimistic miner path as BSV); messagebox delivery and BRC-150 remittance extend run in the background.
- **Cached BRC-150** — reuse remembered or proven tip remittance instead of rebuilding the full proof before every send.
- **Inventory trust** — skip the 1000-row basket scan when the in-memory collectables list already holds the tip.

### Added

- **Item remittance outbox** — retries failed peer inbox delivery without a second payment tx (Dashboard poll flushes alongside BRC-29).

## [1.3.70] - 2026-09-02

### Fixed

- **Send prepare hang** — spend path no longer runs full change-script sweeps (1865+ rows) before `createAction`; Review uses a fast local balance read.
- **Ghost miner doubleSpend** — background `minerSubmit` ignores Arcade/Bitails false conflicts when inputs are still unspent on-chain.
- **Balance during proofs** — `unmined` / `callback` / `unconfirmed` toolbox statuses count as live local spends so pending change does not drop mid-proof.
- **Chaintracks** — Bitails-first header failover when Babbage chain host stalls; Arcade V2 chaintracks-only mode (no broadcast reorder).
- **CI typecheck** — PaymentDetailsPanel `isWallet` ordering, send path `realTxid` guard, unused imports.

### Changed

- **Maintenance gating** — full chain script heal runs on explicit Dashboard Refresh only, not unlock/background poll.
- **Inventory / activity** — listed badges, burn overlays, failed market listing rows, payment detail recipient labels.

## [1.3.69] - 2026-09-01

### Fixed

- **Payment details UI** — BSV rows use the coin logo + direction badge (not two arrows); titles show the recipient name instead of a raw identity key.

## [1.3.68] - 2026-09-01

### Fixed

- **Collectable send after receive** — do not treat a fresh basket tip as already spent when the address scan has not caught up yet; failed sends no longer leave a false `spent-on-chain` hide on the item.

## [1.3.67] - 2026-09-01

### Changed

- **Optimistic send UX** — BSV, BRC-29, and collectable sends complete as soon as the signed tx exists; miner submit runs in the background instead of blocking the progress bar.
- **Late broadcast errors** — if background miner submit hard-fails (e.g. already spent), Activity rewrites the row as failed and shows a toast.

## [1.3.66] - 2026-09-01

### Changed

- Patch release (every push must ship a new version).

## [1.3.66] - 2026-09-01

### Fixed

- **Spend-path reclaim** — `reclaimSealedInputsNeverSpent({ forSpendChain: true })` no longer yields on the first sealed input while spend priority is held (was always returning 0 during send/burn).

## [1.3.65] - 2026-09-01

### Fixed

- **Mobile burn timeouts** — burn holds spend priority before FIFO acquire so collectables/fungibles `listOutputs` yields during the queue wait; no more 100s+ “Wallet is busy” on destroy.
- **Spend path speed** — `spendGate` is local-only (reclaim + promote + restore); full script sweeps and chain raw-tx fetches stay on Refresh / last-resort chaining heal, matching the fast Babbage-style spend path.
- **Balance after heal** — promoted change invalidates cached breakdown and spendable cache so display reconciles spendable vs pending credit.

### Added

- **`chainedChangeHeal`** — single SSoT for change-heal paths with CI tests (`spendGate` must not sweep scripts).

## [1.3.64] - 2026-09-01

### Changed

- Patch release (every push must ship a new version).

## [1.3.63] - 2026-09-01

### Changed

- Patch release (every push must ship a new version).

## [1.3.62] - 2026-09-01

### Fixed

- **CI green** — wallet core test gate, BRC-CLOUD sibling checkout for market proof tests, sendPayment/actionReview mocks.
- **Fresh wallet setup in dev** — HandCash history URL falls back when Vite dev proxy leaves cloud base empty.
- **Log upload in vitest/node** — no crash when `window.location` is absent; log bucket URL uses cloud fallback in dev.

## [1.3.61] - 2026-09-01

### Fixed

- **Send timeout while Refresh running** — chain-ingest maintenance now skips or aborts when a send is waiting, instead of holding the spend region for 15s+.
- **Missing spendable balance** — send path reclaims ghost-sealed inputs, and tries one bounded chain heal for script-less change rows credited in the hero balance but not selectable.
- **Clearer send refusal** — coordinator acquire timeout surfaces as “still syncing / nothing was sent” instead of hanging on “Waiting to send…”.

## [1.3.60] - 2026-09-01

### Fixed

- **Build break in v1.3.59** — restore missing `DisplayCurrency` / `formatBsvSignificant` imports in `fx.ts` (CI tsc was failing on all platforms).

## [1.3.59] - 2026-09-01

### Fixed

- **Clear failed sends hung forever** — Activity bulk clear no longer runs the full change-script sweep (~15s+ IDB page); it uses lightweight `releaseUnsignedSpendReservations` with a 30s wall-clock budget so "Clearing…" always finishes.
- **Chained unconfirmed change** — documented layering in `layers.ts`; `runExclusiveSpend` skips a redundant second `promoteSpendableChange` when balance check runs inside the spend queue.
- **Signed-but-never-broadcast clears** — failed sends whose inputs never left the wallet can be dropped from Activity without undoing coins.

## [1.3.58] - 2026-09-01

### Fixed

- **Tab switch input lag** — balance sync no longer re-renders all mounted nav tabs; nav updates run as transitions with optimistic tab highlight; Send reads balance via a scoped subscription instead of through `WalletNav`.
- **Identity QR shadow** — removed drop shadow from the identity key QR frame.

## [1.3.57] - 2026-09-01

### Fixed

- **Send pane scroll** — BSV, collectable, fungible, and burn send panels scroll when content exceeds the nav column (mirrors receive panel behaviour).

## [1.3.56] - 2026-09-01

### Fixed

- **Wrong balance after Refresh** — legacy address scan now hits BananaBlocks/Kallubi first (not slow HandCash Chain/Bitails); when a send/app request arrives mid-scan, funding UTXOs still sweep into managed change instead of being discarded.
- **BRC-100 listOutputs wedged 120s** — all basket reads use the busy-aware timeout + cache path, not only market listing origins.
- **HandCash Chain skip** — when dependency health marks the cloud proxy down, direct explorers are used without waiting on a 7s cloud timeout.

## [1.3.55] - 2026-09-01

### Added

- **BananaBlocks + Kallubi explorers** — legacy address scan, tx existence, and spent-status checks use GorillaPool BananaBlocks and Kallubi (bsv.cx) before WhatsOnChain; HandCash Chain server-side waterfall updated to match.
- **Dependency health** — Settings probes now include BananaBlocks and Kallubi alongside Arcade V2, HandCash Chain, Bitails, and Ordinals.

### Fixed

- **Log upload 405** — normalize stored upload URLs that mistakenly include `/latest` or `/all` (POST target is the bucket root only).
- **Mobile price bar + toasts** — dashboard side column renders `WhatIsBsvPanel` on phone shells (toast viewport + BSV price strip).
- **Arcade monitor stale host** — sync toolbox monitor chaintracks URL when Arcade V2 is installed.
- **Clear failed sends** — clearer per-row cleanup and toast when nothing removable remains.

## [1.3.54] - 2026-09-01

### Fixed

- **Blank wallet after unlock** — restore missing `preferServiceOrder` import in `session.ts` and `useChunkedCount` import in Activity feed (both caused runtime ReferenceErrors that crashed the dashboard).

## [1.3.53] - 2026-09-01

### Fixed

- **Index packs panel** — import `listStoredIndexPacks` from `indexExpansionStore` so Mobile Vite builds succeed.

## [1.3.52] - 2026-09-01

### Added

- **HandCash Chain (BRC-CLOUD)** — SPV header service and chain probe routes (`/v1/chain/*`) with Arcade V2 → Bitails → WhatsOnChain waterfall; Desktop legacy scan and block headers use it before direct providers.
- **Arcade V2 boot** — toolbox chaintracks + Teranode broadcaster pointed at public `arcade-v2-*.bsvblockchain.tech` hosts; Arcade SSE wired for tx status.
- **Wallet health** — Settings nests network probes under **Wallet health** with caution badge; flat network panel removed.
- **Index packs** — Settings panel + Activity progress during BRC-100 manifest install; manifest URL prefetch on permission grant.
- **Activity** — rebroadcast failed sends; Success/Failed status filter.

### Changed

- **Legacy scan** — Bitails-first address UTXO scan; HandCash Chain cooldown; WoC FX fallback removed.
- **Chain ingest** — explicit Refresh re-enables spendable indexer review (`forceReview`); background polls skip audit to avoid racing sends.

### Fixed

- **App avatar** — `object-fit: cover` for favicon crops.

## [1.3.51] - 2026-09-01

### Changed

- Patch release (every push must ship a new version).

## [1.3.51] - 2026-09-01

### Fixed

- **Settings network health import** — correct wallet-ui bundle path so Mobile builds succeed.

## [1.3.50] - 2026-09-01

### Fixed

- **NFT / collectable send timeouts** — spend region fails fast after 45s instead of wedging silently; fungibles list defers like collectables when sync/send is active; Collectables ownership refresh skips while a send is waiting; inbound BRC-100 traffic no longer holds `permission-prompt` spend priority without a visible prompt.
- **Market inventory** — BRC-100 `listOutputs` for market hosts caps at 20s and serves cached collectables/tokens when the wallet is busy; market originator host normalization fixed.

### Added

- **Network dependency health** — Settings → Support probes Chaintracks, Bitails, and GorillaPool on open and during Refresh; logs `[dependency-health]` for support.
- **`scripts/sync-reference-repos.sh`** — refresh local Babbage SDK + BSV Desktop reference clones under `~/reference`.

## [1.3.49] - 2026-09-01

### Fixed

- **Send timeouts** — pre-send change promotion no longer runs chain raw-tx heal (Refresh-only); collectable sends time out `listOutputs` and keep spend priority alive while queued.
- **Stuck mobile balance after BRC-39 restore** — wallet P2PKH fallback now marks orphan change spendable; restore promotes change rows even when creator tx status is missing.

## [1.3.48] - 2026-09-01

### Fixed

- **Sends blocked by long Refresh** — legacy 1sat import chunks abort when a payment is waiting so chain ingest releases the spend region instead of holding it for minutes.
- **Coordinator wait visibility** — log when spend acquire waits >5s on an active layer.

## [1.3.47] - 2026-09-01

### Fixed

- **Market wallet connect from Cloudflare hosts** — allow `handcash-market-v2.pages.dev` and `brc-cloud.bcryderman.workers.dev` as catalog/market listing origins so BRC-100 connect grants match the canonical `market.handcash.io` permission.

## [1.3.46] - 2026-09-01

### Fixed

- **Handle resolve while typing** — wait until the local-part is ≥3 characters and debounce 400ms before calling BRC-CLOUD; stops `resolve?handle=s` 404 spam in send panels.
- **Collectables list during sync/send** — defer full-basket `listOutputs` while spend is active; log cache fallback at info instead of warn on timeout.

## [1.3.45] - 2026-09-01

### Fixed

- **Sync blocking sends** — batched change-script heal (40 rows per IDB session) with mid-sweep yield when a send is waiting; skip full-basket `listOutputs` during active chain ingest when cache is warm; raise spend priority before collectable/token sends queue on the coordinator.

### Added

- **BSV-21 market UI** — list price on token carousel and detail hero; local listing price sparkline on token detail; stacked “Listed on market” cards in Collect (items-market layout, not side-by-side hero).

## [1.3.44] - 2026-09-01

### Fixed

- **Stuck change after BRC-39 restore (no outpoint)** — when change rows lack `txid`/`vout`/`transactionId`, assign the wallet P2PKH locking script as a last resort so ~162k sats become spendable again; log `addressFallback` count for triage.

## [1.3.43] - 2026-09-01

### Fixed

- **Stuck change after BRC-39 restore** — heal locking scripts using `transactionId` when output rows lack `txid`/`vout`; multi-pass chain sweep + restore on spend; refuse-reason diagnostics in logs.

## [1.3.42] - 2026-09-01

### Fixed

- **Website connect regression** — remove blocking change-script heal from unlock/recompose; break diagnosticLog → permissions circular import; never let BRC-100 diagnostic logging throw on connect paths.

## [1.3.41] - 2026-09-01

### Fixed

- **Script-less change balance** — stop crediting unscripted BRC-39 change in the hero balance; heal locking scripts on unlock/recompose with a higher chain fetch budget; log sweep outcomes for remote triage.

## [1.3.40] - 2026-09-01

### Changed

- Version bump (corrected v1.3.39 CHANGELOG; diagnostics shipped in v1.3.39).

## [1.3.39] - 2026-09-01

### Changed

- **Support diagnostics** — structured wallet logs (`[scope] event key=value`) on spend failures, BRC-100 mutations, connect/permission edges, balance breakdowns, and script-less change skips; spend/burn/market failures auto-upload logs with balance snapshots; larger ring buffer and richer upload headers for remote `/latest` triage.

## [1.3.38] - 2026-08-31

### Fixed

- **Script-less change heal** — sweep and restore rebuild locking scripts from toolbox transaction rows (not only getProvenOrRawTx / chain); change sweep includes `sats > 1` rows.
- **Mobile update UX** — Settings shows Updates on Android; update toasts use HandCash Mobile copy; auto update-check failures stay silent.

## [1.3.37] - 2026-08-31

### Fixed

- **Market / chained spends on script-less change** — spend promotion sweeps locking scripts before restore (local then chain) so BRC-39–restored change rows without raw tx can fund the next `createAction`; restore on the spend path may fetch raw tx from chain when healing scripts.

## [1.3.36] - 2026-08-31

### Fixed

- **Input lag** — isolate the desktop side column (permissions, payment progress, activity) so progress ticks no longer re-render `WalletNav` and mounted tabs; statechart Mermaid pan updates the DOM imperatively during drag; idle-lock listeners depend on `ready` only; `WalletNav` is memoized.
- **Unconfirmed spend chaining** — `promoteSpendableChange` runs at exclusive-spend entry and inside `assertSendableBalance`; the gate fails closed on confirmed selectable rows instead of passing on display credit alone; restore treats `sats > 1` outputs as change.
- **Insufficient funds copy** — when pending change covers the amount, explain that the wallet chains unconfirmed change automatically instead of "still confirming."

## [1.3.35] - 2026-08-31

### Fixed

- **Catalog packs placement** — BRC-230 index packs live under each connected app's details (manage/remove per app), not in Settings.
- **Settings input lag** — removed the global 2s catalog poll from Settings; pack list updates via event subscription only when app details are open.
- **Market purchase funds** — buyer settlement runs `prepareSpendHeal` and promotes unconfirmed change before `createAction`, with the same insufficient-funds copy as Send when toolbox cannot fund the listing price.
- **Spend queue** — every exclusive spend restores live change at region entry so queued market/burn/send txs can chain confirming balance.
- **Connect notifications (Mobile)** — background connect shows **Connect to {app}**; after approval, **Wallet connected to {app}** replaces the stale request notification.

## [1.3.34] - 2026-08-31

### Fixed

- **Burning UX** — collectable cards show **Burning** while destroy is in flight (including burns queued behind an active burn); burned items drop from inventory immediately after broadcast.
- **Unconfirmed spend chaining** — fee change from a just-signed tx is promoted immediately; the spend gate restores live change inside the exclusive spend queue so back-to-back burns/sends chain on unconfirmed change without "insufficient funds" while the hero balance looks funded.

## [1.3.33] - 2026-08-31

### Fixed

- **Chained collectable burns** — back-to-back burns reuse only unspent fee change from the immediately prior burn tx (`creatorTxid`-scoped restore); never re-enable outputs already promised elsewhere.
- **Burn progress** — collectable burns surface **Burning…** in payment/activity progress while the destroy tx is building.
- **Insufficient funds copy** — burn failures explain the confirmed vs still-confirming balance split instead of raw toolbox text.

### Added

- **Index pack catalog context** — manifests and installed packs carry `catalogContext` (1Sat ordinal, BSV-21, …) and sync reports download progress on the wallet progress bus.

## [1.3.32] - 2026-08-31

### Added

- **Overlay-native index expansion** — SLAP host discovery, multi-host BRC-24 failover, live `overlayLookup`, and `listIndexExpansionEntries({ live: true })`; manifest `discovery` field; HandCash Market query `{ mode: 'active', limit: 500 }`.

## [1.3.31] - 2026-08-31

### Added

- **BRC-230 Index Expansion Packs** — `installIndexExpansion`, `listIndexExpansions`, `syncIndexExpansion`, `removeIndexExpansion`, `listIndexExpansionEntries`, `p index` permissions, basket `index` local cache, Activity install/sync events, Settings → Catalog packs, bridge capabilities, and [developer guide](docs/bsva/brcs/wallet/index-expansion-guide.md).

### Fixed

- Collect list short-page merge dedupes by origin again (ghost duplicate cards when cache exceeds one basket page).

## [1.3.30] - 2026-08-31

### Fixed

- Market purchase confirmation shows the listed item name and image from the market listing (buyer does not hold the tip pre-purchase).
- Market settlement accepts buyer BSV change from inscription-wrapped toolbox outputs instead of rejecting with “non-buyer change output”.
- Market purchase remittance uses the listing name; busy-state tracks `listing.outpoint`.

## [1.3.29] - 2026-08-31

### Fixed

- Strip dead 1sat-ft address-scan routing after BRC-175 removal: beta FT-shaped tips stay **held** on Refresh instead of misfileing into basket `1sat` or looping reimport.
- Collect list again shows bare P2PKH NFT transfer tips (self-sent / received ordinals) — ord envelope is not required at the live outpoint.
- Drop 1sat-ft basket scans from ingest heal paths; tokens remain BRC-162 / basket `bsv21` only.

## [1.3.26] - 2026-08-30

### Fixed

- Mobile Collect no longer flashes empty during sync: a short or empty `listOutputs` page keeps the durable cache and merges new outpoints instead of replacing 777 cards with zero.
- View items / View tokens Allow persists on the originator (creates the connected row if missing; market hosts share one grant) so catalog reloads, reconnect, and `getTokenIcon` do not re-prompt. Send/list/buy still prompt.

## [1.3.25] - 2026-08-30

### Changed

- Split BSV-21 listAmt to an exact 162 lock before listing so advert.amt matches the 176 proof. Mobile Collect shortLabel. Inbound :3321 requests yield cloud-backup so the permission prompt is not stuck behind Argon2.


## [1.3.24] - 2026-08-29

### Changed

- Patch release (every push must ship a new version).

## [1.3.23] - 2026-08-29

### Changed

- Patch release (every push must ship a new version).

## [1.3.22] - 2026-08-29

### Changed

- Patch release (every push must ship a new version).

## [1.3.21] - 2026-08-29

### Changed

- Patch release (every push must ship a new version).

## [1.3.20] - 2026-08-29

### Changed

- Purchase intents last 15 minutes so a slow phone approval still posts.

## [1.3.19] - 2026-08-29

### Fixed

- Token cards keep the deploy cap as held / max instead of infinity.
- Approve preview no longer imports a missing TokensIcon (black screen).

### Changed

- Token UI hides origin/outpoint.

## [1.3.18] - 2026-08-29

### Fixed

- Market list/buy/cancel: 162 unlock hashes the full script, overlay listings carry the offer PushDrop, failed overlay publish marks Activity failed, cancel logs a failed row instead of dying silent.
- List/send approve and the Working panel show the same item card (collectable or token) in the side column.

### Changed

- Permission list title uses ticker/units. Duplicate generic "List item for sale" Activity rows are gone.

## [1.3.17] - 2026-08-29

### Changed

- Tokens are BRC-162 / basket bsv21. List and buy keep the 162 lock. Messagebox remittance re-signs a fresh timestamp. Collect stays 1sat. Token details paint issuer from Sigma or remittance. Activity is one history row.

## [1.3.16] - 2026-08-29

### Fixed

- **Leftover 1sat-ft keeps mint ticker and supply.** After a send, Tokens still show KING and the locked cap instead of a blank origin / no supply cap.
- **Fingerprint lock icon is the official Material filled 24px path.**


## [1.3.15] - 2026-08-29

### Fixed

- **1sat-ft mint icons no longer list as NFTs.** The image sibling on a colour genesis stays decorative. Refresh drops ones already filed in Collectables.


## [1.3.14] - 2026-08-29

### Changed

- Leftover 1sat-ft tips now inscribe {amt} on chain. Origin comes from the BRC-150 spend-chain walk. Remittance is a fast path only.

## [1.3.13] - 2026-08-29

### Changed

- Patch release (every push must ship a new version).

## [1.3.12] - 2026-08-29

### Changed

- Patch release (every push must ship a new version).

## [1.3.11] - 2026-08-28

### Fixed

- **Leftover 1sat-ft no longer lists under Collectables.** Hashed origin-only cards and misfiled FT tips stay on Tokens. Named 1sat items still paint during sync.
- **Fungible identity is the origin.** Cards, details, and send show the 1sat-ft origin (middle-ellipsis `txid…txid_vout`), not the local held outpoint.
- **History-less 1sat items can finish BRC-150.** Parent hops fetch WhatsOnChain / indexer BEEF when local storage misses. Same-origin siblings reuse that cached origin tx; each tip still proves its own hops down to origin.

## [1.3.10] - 2026-08-28

### Fixed

- **Sync no longer beeps without a toast.** Rediscovered 1sat items stay silent unless a new receive actually toasts.
- **Unverified 1sat cards stay on Collectables during sync.** A longer live list wins over a shorter cache; BRC-150 can fetch BEEF from the network instead of hiding on a local miss.
- **Issuer row is omitted when the mint has none.** No "Not supplied". Leftover remittance still copies `issuer:` when the origin JSON had it.

### Changed

- Nav and inventory say Collectables. Dashboard identity chip has no pfp next to the balance.
- Settings appearance and updates are icon pills (Monitor / Moon / Sun, Repeat / Touch / Block).
- Screenshot is a real **Take screenshot** button with the shortcut under it. Check update is a real button.


## [1.3.9] - 2026-08-28

### Fixed

- **KING leftover follows the live tip.** After send `2a562450`, remittance is change `68931` — never re-seed spent `9abe8bdb` `69000`.
- **Dashboard tip-chase backs off.** Stale inbox/chat hints no longer re-run funding-only Refresh every 5s; new txids still ingest immediately.
- **Animated QR no longer burns CPU.** Frame assembly is incremental instead of a full redraw chase.

### Changed

- Settings uses Aeon controls. Send, burn, camera, and QR share the same sheet language.
- Identity chip shows handle, then BRC-169 key, then PeerPay — one label.
- Collect stays 1sat. Token details paint issuer from Sigma or remittance. Activity is one history row. Tokens stays 1sat-ft. FOX / BSV-21 is dead.

## [1.3.8] - 2026-08-28

### Fixed

- **Linux AppImage `tsc` is clean again.** Unused locals (`opts`, leftover imports, `BEEF_TIMEOUT_MS`) and reclaim/icon type errors no longer fail `build:renderer`.

## [1.3.7] - 2026-08-28

### Fixed

- **Tokens balances match the live UTXO set.** After send/burn, leftover 1sat-ft tips show remaining `amt` (KING `69000 / 69420`) instead of the spent mint total.
- **Spent genesis burns stay hidden.** Burned KING origins are marked spent-forever and cannot come back from cache.
- **Bare leftover change still lists.** Toolbox often drops the 1-sat P2PKH change; leftover remittance is seeded so Tokens still paints the held tip.

## [1.3.6] - 2026-08-28

### Fixed

- **Tokens list is 1sat-ft only.** Durable cache drops leftover Collectable / FOX / Pixel Foxes rows so they cannot return on reload.
- **Refresh no longer hammers WhatsOnChain `/unspent/all`.** Spendable indexer review is report-only and is skipped (WOC 429 + CORS were stalling sync).
- **CoinGecko / WhatsOnChain FX cools down for 15 minutes after a 429.** Price panel keeps the last cached rate instead of retrying in a loop.

### Changed

- Collect stays 1sat collectables. Tokens stays BRC-175 `1sat-ft`. BSV-21 / FOX is leftover and is not listed.
- Desktop Scan lives off main nav. Touch ID circle sits under the password field.

## [1.3.5] - 2026-08-28

### Fixed

- **1Sat FT tips unlock correctly on send/burn.** Inscribed tip sighash uses the
  full locking script (inscription ‖ P2PKH), matching collectables / BSV-21.
- **Bare FT transfer tips are no longer painted as collectables.** Address scan
  walks tip lineage; `application/1sat-ft+json` ancestors hold instead of basket
  `1sat` (stops “Received ITEM” spam after FT sends).
- **Misfiled FT tips reclaim into `1sat-ft`.** Refresh drops NFT duplicates and
  moves bare FT-lineage tips out of basket `1sat`.
- **Touch ID no longer prompts on window close / alt-tab.** Hide locks after a
  grace period; device unlock waits until the lock screen is visible again.
- **Chaintracks hangs fail over in ~3s** to Bitails/public headers; Taal ARC is
  demoted so 401 noise is not first on every broadcast.

### Changed

- Colour (1sat-ft) burn path + amount preview; click-to-copy error banners on
  burn/send fungible.
- Docs: BRC-175 mirror + BRC-147 bare-transfer coexistence notes.


## [1.3.4] - 2026-08-27

### Fixed

- **Self-sent 1Sat ordinals now appear on Refresh.** Inscribed tips are invisible
  to WhatsOnChain/Bitails address UTXO lists; Refresh also queries GorillaPool
  for unfiltered 1-sat tips (alongside the existing BSV-21 `bsv20` probe) and
  imports them into basket `1sat`.

## [1.3.3] - 2026-08-27

### Changed

- **Peer remittance asset kind is `1sat-ft`.** Same id as the storage basket
  (renamed from the brief `onesat-ft` alias).

## [1.3.2] - 2026-08-27

### Changed

- **Peer remittance asset kind is `onesat-ft`.** Replaces wire `colour` so P2P
  settle matches basket `1sat-ft`.

## [1.3.1] - 2026-08-27

### Changed

- **1Sat fungibles use basket `1sat-ft` only.** Removed the legacy `colour`
  basket dual-read from list, permissions, and layer counts.

## [1.3.0] - 2026-08-27

### Added

- **1Sat fungibles (BRC-175).** Tip→origin tokens in basket `1sat-ft` with
  face-value `amt` (balance = Σ amt). Sends spend tips and create payee + change
  tips with conserved units; locked supply on the origin is optional.
- **Combine tips** on token details when you hold 2+ tips — same balance, one tip,
  small network fee (self-send, no peer notify).
- **Device unlock factors** for vault v3 (Desktop + shared unlock settings).

### Changed

- Legacy BSV-21 Collect rows stay read-only; native fungible send uses the 1Sat
  path only.

## [1.2.303] - 2026-08-23

### Fixed

- **Settings scroll works on Linux.** Nested `overflow` on the settings body was
  eating wheel events while the outer stage could not scroll. The main settings
  list now scrolls on `wallet-nav-stage` only; detail screens scroll on
  `nav-child-body`. Horizontal overflow from the sticky header plate is clipped.

## [1.2.302] - 2026-08-23

### Fixed

- **Settings scrolls on Linux and Windows.** Detail screens now use the same flex
  scroll container as Send/Receive; the main list no longer traps overflow.

### Changed

- **Settings layout simplified.** Removed list/grid toggle (inline controls do not
  fit a grid). Sections are Security, Preferences, Support, and About. Log upload
  and folder actions moved into the session log viewer; the index is shorter.

## [1.2.301] - 2026-08-23

### Fixed

- **BSV-21 sends no longer remain stuck on “Preparing”.** Fungible sends declared
  custom token inputs without supplying their source BEEF, so the toolbox could
  reserve the action and wait indefinitely while resolving them. Token sends now
  provide the selected transactions explicitly, continue through the manual
  signing path, and abort any preparation still stalled after 45 seconds.

## [1.2.300] - 2026-08-23

### Fixed

- **BSV-21 sends no longer remain stuck on “Preparing”.** Fungible sends declared
  custom token inputs without supplying their source BEEF, so the toolbox could
  reserve the action and wait indefinitely while resolving them. Token sends now
  provide the selected transactions explicitly, continue through the manual
  signing path, and abort any preparation still stalled after 45 seconds.

## [1.2.299] - 2026-08-23

### Fixed

- **BSV-21 sends no longer refuse as “unrecognized lock”.** `listOutputs` often
  omits the locking script (same toolbox `scriptOffset` gap as collectables), and
  inscribed tips can carry the ord envelope before or after the P2PKH branch.
  Basket-held plain tips now send; foreign locks still refuse when the script is
  present and does not pay this wallet.
- **Windows scrollbars show and drag again.** Hover-only scrollbar thumbs stayed
  invisible in Electron on Windows (and Linux). Nav panels, activity lists, and
  the main stage now keep a visible thumb and a normal 10px track.

## [1.2.298] - 2026-08-23

### Changed

- **Settings list or grid.** Security and About destinations match Connected apps /
  Friends — toggle in the header; Application and Logs stay full-width rows.
- **BSV logo easter egg everywhere.** Triple-tap the market logo for the classic dragon;
  Recent activity follows; no selected chrome on the hidden toggle.
- **Flatter send surfaces.** BSV panel and recipient picker drop extra box shadows.
- **Clearer log upload copy.** “Upload logs” explains when to send and that the URL is
  pre-filled unless support gives you another.

## [1.2.297] - 2026-08-23

### Fixed

- **Windows builds publish again.** The build step ran under PowerShell, which rejects
  `rm -rf`, and the checksum verifier was unparseable by node — so no Windows installer
  has shipped since those landed. Same app code as 1.2.296, which reached macOS and Linux
  only.

## [1.2.296] - 2026-08-23

### Fixed

- **Incoming BSV-21 tokens now arrive.** A token transfer re-inscribes its JSON, so the
  output is P2PKH plus an ord envelope — a shape the address explorers report as
  nonstandard and list against no address. Every provider behind the address scan missed
  it, so tokens sent from outside the wallet never appeared. The ordinal index is now
  asked alongside the address scan and finds them.
- **Token balances credit the transferred amount.** Import read the amount from the
  token's origin, which holds the mint's balance or an earlier hop's, so a transfer could
  land showing the sender's prior total instead of what they sent.

### Changed

- **Collectables paint on arrival** when an app hands one over, instead of waiting for the
  next Refresh to notice the tip.

## [1.2.295] - 2026-08-23

### Fixed

- **Windows OTA checksum mismatches.** CI regenerates `latest.yml` from the NSIS
  installer before upload and verifies sha512; channel metadata publishes after
  the `.exe`. Updater clears stale cache and retries once on checksum failure.

## [1.2.294] - 2026-08-23

### Changed

- **Settings rows** now use standard Material icons with a consistent leading slot.
- **Identity tab** compacts to a hero row (QR + handle) and field list — less wasted
  vertical space on mobile, aligned with Settings / Apps density.
- **Light-mode skeletons** use a dark shimmer so connected-app loading states stay
  visible on white sheets.

## [1.2.293] - 2026-08-23

### Fixed

- **Light mode Messages uses the paper sheet.** Chat scope tokens for the
  messages shell and sidebar head now follow the light brand surface instead of
  leftover dark rail colors.

## [1.2.292] - 2026-08-23

### Fixed

- **The hero balance updates when a payment lands outside Dashboard Refresh.**
  BRC-29 internalize, SPV tip ingest, and inbox poll now push the display balance
  to the session chart so mobile and desktop paint the new total without waiting
  for the next manual sync.
- **Receive toasts fire only when the balance actually rises.** Re-internalizing
  an already-swept payment, or crediting money that was already in the wallet,
  no longer announces "Payment received."
- **A failed item send releases sealed funding inputs.** After sign+seal, any
  failure path (including inbox errors) now un-seals inputs so the balance does
  not stay artificially low until the next maintenance pass.

### Changed

- **Wallet progress lives on the phrase sweep panel only.** The Activity feed no
  longer shows a generic "Importing" row with a progress bar — that chrome is on
  Settings → Import phrase while a sweep runs.

## [1.2.291] - 2026-08-23

### Fixed

- **Refresh no longer toasts "Payment received" for money you already had.**
  Any balance rise during Refresh used to announce a new payment — including
  when sealed inputs were reclaimed, pending change was restored, or a thin
  Toolbox was healed. The toast now fires only when this pass actually swept new
  funding from your legacy address.
- **The hero balance no longer drops when a confirmed-only read omits pending
  change.** A live local send credits pending change on the display path only;
  a lower confirmed total is normal and must not paint $0.03 when the wallet
  still holds $0.15 including in-flight change. The partner-app balance cache
  now keeps the full display total instead of shrinking on confirmed-only reads.
- **Unlock no longer downgrades the hero from a confirmed-only read** while the
  display path is still crediting pending change from live local sends.

## [1.2.290] - 2026-08-23

### Fixed

- **Collectables stranded by stale import marks heal on large inventories.**
  Orphan 1-sat mark healing only listed the first 2000 basket rows, so wallets
  with more items never cleared stale "already imported" marks and Refresh could
  not re-claim tips still live on the address. Healing now pages through the
  full basket the same way Collect does.
- **Deposits marked imported without a sweep txid can sweep again.** Legacy v1
  import marks and sweeps that never recorded a txid blocked every retry. When
  the outpoint is still on the address scan, Refresh now forgets the mark and
  sweeps again instead of leaving funds stranded behind a permanent guard.
- **Sync health reports tips still awaiting indexer identity.** `pendingTips`
  was always empty, so the status pill and poll cadence never reflected 1-sat
  outs held while the indexer names them.

## [1.2.289] - 2026-08-22

### Fixed

- **Refresh now rebuilds missing change scripts before restoring spendable
  balance.** BRC-39 merges and device sync can leave change outputs with
  satoshis but no locking script. Maintenance tried to promote those rows back
  to spendable, skipped them as unscripted, and moved on — so spendable stayed
  at zero while the display still credited the same coins as pending change. Pay
  could not select them. Refresh now runs a chain-backed script rebuild (looped
  until a pass heals nothing) before the spendable-restore loop.

## [1.2.288] - 2026-08-22

### Changed

- Patch release (every push must ship a new version).

## [1.2.287] - 2026-08-22

### Fixed

- Ship the 1.2.286 stdout crash fix, whose installers never built: the new
  test imported a relative path without a file extension, which the renderer
  typecheck accepts but the Electron build (`nodenext`) rejects.

## [1.2.286] - 2026-08-22

### Fixed

- **A lost log stream no longer looks like a crash.** When HandCash outlived
  whatever was reading its output — a terminal the holder closed, a launcher
  that exited — the next diagnostic line failed with `write EPIPE`, and because
  nothing was listening for that error it escalated into an "Uncaught Exception"
  dialog over a wallet that was working fine. Write failures on the output
  streams are now handled where they happen. The file log, which is what support
  actually reads, is unaffected.

## [1.2.285] - 2026-08-22

### Changed

- **Sweep** replaces “Import phrase” in Settings for moving another wallet in.
- **Removed “Open a web app” URL field** on mobile (apps open via Scan / deep
  links / connected apps). Dropped the balance hero sync subtitle.

## [1.2.284] - 2026-08-22

### Fixed

- **Phrase import now auto-restores history when a cloud backup exists.** Second
  devices with the same seed pull BRC-39 automatically instead of waiting for a
  manual tap or showing a stale zero balance. Skip is only offered when no backup
  is on the host. Restore uses wipe-local-then-pull; auto push still refuses to
  overwrite a protected remote with empty or thin local state.

## [1.2.283] - 2026-08-22

### Changed

- **Tighter empty states and nav padding.** Empty tabs no longer scroll on
  nothing; connected-apps drops the inline URL launcher (apps still open via
  Scan and deep links).

## [1.2.282] - 2026-08-22

### Fixed

- **Collectables that vanished from a device now come back on Refresh.** The
  wallet keeps a durable note of every 1-sat tip it has imported so the same
  item is never internalized twice. That note lives outside the item database,
  so when the database was replaced or restored thin, the note survived and
  Refresh skipped hundreds of items as "already imported" — leaving them
  invisible even though they were sitting unspent on the address. Refresh now
  clears the note for any tip that is live on the address but missing from the
  basket, and re-imports it. Items the holder deliberately forgot, and tips a
  send just spent, are left alone.
- **A large re-import paints as it goes.** Items are imported in batches, and
  the inventory now refreshes after each one instead of after all of them, so a
  recovery of several hundred items no longer looks frozen on a stale count.

### Changed

- Refresh reports its own progress — including the phase after the status pill
  clears — so a long import reads as work in progress rather than as finished.

## [1.2.281] - 2026-08-22

### Fixed

- **A cold launch no longer shows a balance of zero.** Unlock raced the local
  read against a 500 ms timer that resolved to a literal zero, so an identity
  without a stored figure entered the wallet looking empty until a later read
  healed it. Unlock now opens on this identity's last confirmed figure when one
  exists, waits for a real answer when it does not, and refuses rather than
  reporting zero when the store cannot be read. A balance that is genuinely
  zero still shows zero.
- **Collectables stay on screen while history restores.** Recompose replaces
  local state before pulling BRC-39, and a basket read in that window succeeded
  against a half-restored database — so a launch holding hundreds of items
  painted them, replaced them with none, then rebuilt to a handful, persisting
  the empty list for next time. Only the relist that runs after local state is
  replaced can now empty the view, and a truly empty inventory still reads as
  empty.

## [1.2.280] - 2026-08-22

### Fixed

- **"Internal error." when unlocking a wallet that is open elsewhere.** Chromium
  locks the IndexedDB partition holding toolbox state, so a second copy of
  HandCash on one profile could not read it and the unlock screen showed
  Chromium's raw text — a correct password looked rejected and the wallet looked
  corrupt. A second instance now focuses the running window and exits, so the
  collision cannot happen; opening an old copy before an upgraded one was enough
  to trigger it.
- **An unlock failure explains itself.** A store that cannot be opened now says
  to quit any other copy or restore with the recovery phrase, and notes that
  coins are on-chain rather than in that file; a full disk says so instead of
  implicating the wallet. An unreadable store opens the recovery form the way a
  phrase mismatch already does, and the untranslated error stays in the app log
  for support.

## [1.2.279] - 2026-08-22

### Added

- **Phrase import finds Centi funds.** Centi keeps its coins under
  `m/44'/145'/0'/0/n`, and only coin type `236'` was ever scanned, so a Centi
  phrase came back empty. Both Centi chains are now scanned — receive and
  change, twenty addresses each — and every hit is signed with the child key
  that locks it. Use Settings → Import phrase; wallet Restore still expects a
  HandCash phrase.

### Changed

- **A market listing reads as a listing.** Creating an offer said "Sending…",
  the crumb read "Activity / Activity", and the detail body showed the internal
  method name as "ACTION: approve". A listing now says "Listing…", a
  cancellation "Cancelling…", and a purchase "Buying…", the crumb carries the
  row's own title, and the detail shows status and app instead of a method.

## [1.2.278] - 2026-08-21

### Fixed

- **Listing an item no longer rebuilds its origin.** Publishing inlined every
  BRC-150 path body the proof carried by reference — for a batch-mint item, a
  multi-megabyte origin — and inlining it is what pushed the proof past the
  overlay's size budget, so the result was measured, discarded, and the proof
  the wallet already held was published instead. The wallet now checks what the
  overlay will fetch for itself before spending anything on it.

## [1.2.277] - 2026-08-21

### Fixed

- **Apps that look for `localhost` can find the wallet.** The BRC-100 bridge now
  also listens on the IPv6 loopback. `WalletClient('auto')` from `@bsv/sdk`
  dials `localhost`, which resolves to `::1` before `127.0.0.1` on most hosts,
  so a client that did not retry the IPv4 address saw no wallet at all. Only the
  loopback is added, and a host without IPv6 keeps the existing listeners.

## [1.2.276] - 2026-08-21

### Fixed

- **Release builds typecheck again.** Cross-repo overlay contract tests stay in
  `vitest` and are no longer compiled as part of the app, so CI no longer
  requires a sibling BRC-CLOUD checkout.


## [1.2.275] - 2026-08-21

### Fixed

- **Listing approval can no longer be clicked twice, and a timed-out request no longer stays on Approving…** One permission prompt accepts one decision. After approve, the wallet paints the processing panel before provenance work starts. A bridge timeout cancels the orphaned prompt.
- **Market inventory shows origin-verified collectables, not only items that arrived with remittance.** The wallet projects its durable BRC-150 verdict and the origin it walked to. A minted or imported tip rebuilds a publishable proof at listing time.
- **BRC-100 discovery is `POST /getVersion`, matching WalletClient.** Method responses are labelled `application/json`.
- **Listings emit the overlay's 20-field signed BRC-48 PushDrop and a self-contained BRC-150 proof.** Batch-mint origins that exceed 1 MB JSON may slim to txid-only; the overlay hydrates those bodies itself within a bound.
- **Collectable sends seal their inputs** so a later BSV send cannot pick the same coins. Sealed inputs of a transaction that never reached a node can be released, and Refresh reclaims coins the indexer still reports unspent.
- **History backup refuses to encrypt a BRC-38 document over 64 MiB**, so a large inventory cannot OOM the renderer.


## [1.2.274] - 2026-08-21

### Changed

- Patch release (every push must ship a new version).

## [1.2.273] - 2026-08-21

### Fixed

- **Market listings now use revocable on-chain BRC-48 offer tokens.** Listing,
  cancellation, purchase, and seller settlement follow explicit state machines
  with durable crash recovery.
- **Signed settlements cannot be aborted or erased by general no-send cleanup.**
  Buyers retain the transaction data needed to rebroadcast, and sellers ingest
  proceeds and retire the item and offer before acknowledging a sale.
- **Applications can no longer trigger the wallet's internal SPV bypass through
  labels.** The exception is scoped to wallet-owned BEEF ingestion.

## [1.2.272] - 2026-08-21

### Changed

- Version opened so Mobile can publish an APK against a clean UI-core pin. No
  wallet behaviour changed; the push-time version guard runs as a Node hook.

## [1.2.271] - 2026-08-21

### Fixed

- **Release builds produce installers again.** The Toolbox patch was still pinned
  to 2.4.4 while the wallet installs 2.10.2, so `npm ci` failed in `postinstall`
  and 1.2.268 through 1.2.270 shipped no downloads. The patch is regenerated for
  2.10.2, and a stale patch now fails `npm test` and the pre-push hook instead of
  a release workflow nobody was watching.
- **Legacy P2PKH sweeps and BRC-29 receipts no longer need a merkle proof of a
  just-seen output.** Those Toolbox edits had silently stopped applying, so
  importing visible funds and internalizing a fresh payment could refuse work
  the wallet is meant to do.

## [1.2.270] - 2026-08-21

### Changed

- **Collect groups items by collection.** A collection is one facepile and a
  quantity, not a flat list of every output. Loose items stay on their own.
- **This wallet can list and buy collectables on HandCash Market.** A listing is
  a seller-signed advert with a BRC-150 origin proof. Buy is gated on that proof.
  The advertised price is what the buyer pays; 5% of it is the market fee and
  the rest is the seller. Settlement is atomic between the two wallets — the
  market never holds keys or funds.
- **Phrase import can resume an item sweep** instead of starting over after a
  stop. PeerPay links open Send as a request, and a phone can open a BRC-100 app
  in the wallet's own browser when Chrome cannot reach loopback.
- **A burn appears in Activity the moment you confirm it**, and ends there as
  burned or as a named failure, instead of only after the spend queue and the
  network had their turn. A burn also reuses the tip the wallet already holds,
  so an item no longer fails to burn because an indexer was slow.
- **You can forget an item instead of burning it.** Forget removes it from this
  wallet without broadcasting anything; the output stays where it is on chain.
  Listing, cancelling, buying, and selling on Market are recorded in Activity.

## [1.2.269] - 2026-08-20

### Changed

- **Collect now scales by paging instead of loading the wallet into the
  renderer.** It opens on the newest 1,000 outputs, loads older pages only when
  requested, bounds its durable startup cache, and avoids cloning very large
  address scans into redundant in-memory ownership sets.
- **Hosted key custody has been removed.** Cloud trustholder enrollment,
  deposit, retrieval, OTP restore, provider endpoints, and their feature flags
  are gone, and stale enrollment/share-plan records are purged locally.
  Recovery remains local through phrase, emergency root key, or any two
  offline BRC-140 slices; BRC-39 continues to back up history only.
- **Burn is now the last action on a token and on an item, never the button next
  to Send.** Both asset pages order their actions the same way — the everyday
  action first, then copy/save, then the destructive one set apart at the end of
  the row. Removing an unrecoverable device backup follows the same rule.
- **Device backup says what it holds in plain sentences.** The screen headings
  are now “This wallet is backed up to N devices” and “This wallet is storing N
  backups”, each row adds the device platform instead of repeating its heading,
  and an empty section is one line rather than a paragraph. “Link” is gone from
  the feature: the QR is this device’s code, adding a device is “Add a device”,
  and opening a stored copy is “Restore”. Add sits below the state it changes.

### Fixed

- **The token page no longer runs its heading text under the token icon.** The
  hero reserved a 96px column while the avatar size buckets forced 112px, so the
  eyebrow, symbol, balance, issuer, and attestation badge stacked into whatever
  space was left. The icon is now pinned to its column and the heading is three
  lines: symbol with the attestation badge beside it, balance, issuer. Decimals,
  outputs, and deploys read as three equal cards instead of loose text.
- **A ticker icon this wallet inscribed itself now shows up.** Resolving icon
  bytes required a live indexer service, so a freshly minted token fell back to
  the hash identicon even though the inscription was sitting in local storage.
  The lookup now goes through the local-first BEEF path, and the icon cache
  accepts the larger bitmaps a real uploaded image produces.

## [1.2.268] - 2026-08-20

### Changed

- **Device backup now reads as two physical locations, not one abstract device
  list.** The screen separately shows where this wallet is backed up and which
  wallet backups are stored on this device, including a plain empty state for
  each side. Unconfigured, same-wallet, missing-copy, and unsafe reciprocal
  devices sit in their own small sections instead of blurring those two facts.
  Direction choices now say exactly where the encrypted copy will be stored,
  and the Settings row summarizes copies “elsewhere” versus “stored here.”

### Fixed

- **A token mint no longer stalls on proofs that cannot exist yet.** Minting
  supply spends the auth tip of a genesis deployed seconds earlier, so that tip
  and whichever change ancestors are still in the mempool have no merkle proof.
  Enrichment asked the indexer for them anyway — one eight-second timeout per
  ancestor, unbounded — and the whole `createAction` outran the bridge deadline
  while the issuing app was told the mint had failed. Proof hydration now has a
  fixed budget, after which the mint signs against the raw BEEF it already
  holds; every spend body is present, so signing is unaffected, and the monitor
  still broadcasts once headers land.
- **An in-flight spend is no longer reported as a failure.** The bridge waited a
  flat two minutes for any method and then answered
  `WALLET_BRIDGE_TIMEOUT` — the same code it uses for a read that never ran,
  even though `createAction` / `signAction` / `internalizeAction` may already
  have signed. Those three now get a five-minute budget and, past it, a distinct
  `WALLET_BRIDGE_PENDING` that tells the caller to reconcile rather than retry.
  A renderer reply that arrives after the HTTP call was answered is logged
  instead of dropped silently.
- **A long spend keeps the scheduling priority it was given.** The spend-priority
  hold expired after ninety seconds so a leaked one could not disable item
  ingest forever, but a mint waiting on an unmined ancestry legitimately runs
  past that — and when the hold lapsed, chain ingest and history backup piled
  back on top of the spend they were meant to yield to. The hold now takes a
  heartbeat from the work itself: expiry catches an abandoned hold, never a busy
  one, and stall reports still quote the real held duration.

- **A funded wallet no longer opens at zero while Mobile reads local state.**
  Cold unlock raced the owned-cash scan against a 2.5-second timeout and wrote
  literal zero into the app machine. The phone then finished the real read
  (`710,091 sats` in the reported session) but only logged it, leaving the hero
  at zero. The last successful display balance is now durably scoped to the
  wallet identity and painted during sync; the completed fresh read always
  replaces it. Confirm/send still reads Toolbox and fails closed, so stale
  display state is never spend authority.

## [1.2.267] - 2026-08-20

### Fixed

- **Identity-key item deliveries no longer disappear behind a ten-minute
  retry.** A large AtomicBEEF can exceed the messagebox body limit, leaving the
  recipient to fetch it by txid. If that first fetch raced the sender's silent
  `postBeef`, the ordinary indexer-failure cache suppressed every five-second
  inbox poll for ten minutes. Durable, un-ACK'd item and token hints now use a
  ten-second backoff while ordinary indexer failures retain their conservative
  backoff. Once accepted, the temporary inventory card is also durable across
  renderer restarts, scoped to the receiving identity, and retained for the
  full settlement window until the real basket row appears.

## [1.2.266] - 2026-08-20

### Added

- **A 3D collectable renders as a 3D object.** An item whose body is a GLB or GLTF was shown as a broken image frame, because the panel only knew how to paint bitmaps. Such an item now mounts an interactive viewer — drag to orbit, scroll to zoom, with a slow auto-rotate and studio lighting — behind the same deferral rule as every other image: a skeleton holds the space until the first frame is actually drawn, a render that fails or hangs says so by name and offers a retry, and the media action becomes Save model instead of Copy / Save image. Detection is by MIME and by body extension, so a JPEG item keeps the bitmap path exactly as before.

### Changed

- **Burning is a screen, not a dialog.** A burn is composed like a payment, so it now lives where payments live: its own side panel with a breadcrumb (Items → token → Burn), not a modal floating over the page it came from. The chart is unchanged — amount is writable only while editing, confirm restates one fixed amount, confirming hands off to the wallet — but the flow can now be backed out of the way every other flow can, and the destination after a token burn is the token page whose Activity the row lands in.
- **The burn panel says what it costs in one glance.** The economics are an aligned breakdown ending in a bold effect-on-Pay row with its fiat estimate, the amount field carries an All button and the held amount beside it, and the confirm face's second line tells you what survives — *Leaves 750 DEMO* for a partial token burn, or that an item's BRC-150 lineage ends with it — instead of repeating the name already above it.
- **The token page leads with the token.** Icon, ticker, balance and issuer are one card with an attestation badge, and Send / Burn / Copy ID sit directly beneath it rather than stranded below a wall of metadata. Rows that only repeated the hero or the metric chips are gone, long ids stay on one line with the full value in the tooltip and the clipboard, and values the deploy never supplied read as quiet rather than as data.

## [1.2.265] - 2026-08-20

### Changed

- **A burn is composed like a payment.** It was one dialog that let you retype the amount beside the button that destroys it, then sat spinning, then left that same button live under an error. The chart is now the send chart — `closed → editing → confirming → handoff | failure` — so the amount is writable only while editing, the confirm face restates one fixed amount with no field to change it, and confirming hands the burn to the wallet and closes: the toast and the Activity row carry the result, as with a send. A refusal returns as its own stage with Close / Edit, and cannot burn again without going back through editing.
- **A token burn no longer opens with your whole balance selected.** The field starts empty with the held amount shown beside it, Review stays blocked until an amount that you actually hold is typed, and the economics preview coalesces keystrokes instead of selecting real outputs per digit. Burns now play the wallet's success and error sounds, and the trigger reads `Burning…` while one is in flight.

### Fixed

- **Statecharts actually show a chart.** The live readout, a wrapping wall of page chips and a caption line took about 160px of header, and the diagram got whatever was left of the settings body — in a short window that was two pixels, so the page looked like text with no chart. The chart now claims a real minimum height (the body scrolls), the live readout folds to one summary line behind an Aeon disclosure, the page list scrolls in a single row that keeps the selected page in view, and the caption floats over the chart instead of taking a row from it.
- **The selected statechart page is legible on the light theme.** White on the sheet's mid green was 3.6:1 and read as a disabled pill. Which chart you are reading is chrome, not wallet state, so it takes the same near-black selection treatment as the wallet nav tabs — 16.7:1 on paper.
- Settings → Statecharts carries the burn UI chart, so the Mermaid matches the machine that ships.

## [1.2.264] - 2026-08-19

### Fixed

- **Green reads as green in Settings on the light theme.** `--hc-success` was never actually defined, so every "saved / confirmed / one-way" status fell back to the dark sheet's neon mint — 1.27:1 on white, effectively invisible. It is now a token: the neon on black, and the brand hue at L26% on paper (5.6:1). Two rules that lifted their green *toward white* now mix toward the sheet's own ink instead, which is the right direction on both sheets.
- **Settings greens are deep on the light sheet.** The palette accent (L33%, 3.5:1) is fine on a dashboard tile but pale under the dense small type in Settings, so the accent is re-pointed for that subtree only — every label, status, inline link and tag deepens at once and matches the success ink beside it.

## [1.2.263] - 2026-08-19

### Changed

- **Large collections migrate far faster.** Collectables from an imported phrase now share a transaction — up to 25 tips per broadcast instead of one each — and the source transactions for a page are fetched in parallel rather than one after another. Bundling is an explicit decision: a rejected bundle is halved by name (`bundleRejected`) and retried down to single tips, so one unspendable tip cannot stall a run and no item ever travels a protocol path other than the one it was planned for.
- **The wallet no longer re-reads the chain after every few items.** Chain ingest walks the whole wallet, so running it per batch made each later batch slower — exactly the crawl a hundred-thousand-item import hits. Migrated tips are already in the local `1sat` basket, so the chain check now runs once when a run ends, including when it is paused or stops for funds. Progress shows a live items-per-minute rate.
- **Device backup is one screen at a time.** The panel is a projection of `deviceBackupMachine`: a device list, then one device, where you choose a single recovery direction — protect this wallet there, or protect that wallet here. QR codes stay hidden until asked for, each device reads as one line naming its direction, and Recover and Remove live on the device instead of in a row of buttons.
- **Settings says less.** Ledes on History backup, Import phrase and trustholder deposits are one line each, with protocol detail left in the About footer where it belongs. Row statuses are short and honest: `Not backed up`, `2 devices · one-way`, `Both directions — unsafe`.

## [1.2.262] - 2026-08-19

### Added

- **A token now has a real detail page.** Ticker, balance, raw units, decimals, held output count, representative outpoint, every deploy id behind a merged balance, icon inscription, issuer, and cosigner terms are all shown, alongside the transactions for that token only. Issuer attestation is labelled as what it actually is — a Sigma (BRC-77) address match on deploy — rather than presented as proof of supply, which no wallet can verify.
- **Tokens and collectables can be burned, ending them on chain.** A burn is planned once as an explicit path and refuses by name for cosigned, mixed, covenant-locked, unknown, or foreign locks; it never falls through to a send, a sweep, or a local abandon. A BSV-21 burn writes the canonical `op: "burn"` record and returns token change when the amount is partial. An item burn spends its 1-sat tips into a single multi-sat output, which is what actually terminates each origin, and that output is internalized as ordinary managed change so the recovered satoshis become spendable Pay balance.
- **The burn prompt shows the economics before anything is destroyed.** Asset satoshis selected, satoshis consumed by protocol outputs, cash recovered, the estimated network fee, and the net effect on Pay are all named — small burns normally cost more in fees than they return, and the prompt says so instead of implying a profit. Completed and failed burns keep their own Activity rows with the destroyed amount, recovered satoshis, fee, and txid.
- **An app can ask this wallet to prove which identity it controls.** The proof uses only existing BRC-100 methods (`waitForAuthentication`, `getPublicKey`, `createSignature`) over a short-lived challenge bound to the requesting origin, and the wallet refuses a challenge that is cross-origin, expired, pre-hashed, weakly random, or not canonically serialized. The approval prompt states the app's purpose and that signing cannot spend. Apps discover the recipe from `/manifest.json`; the format and verification rules are documented in `docs/wallet-to-app-identity-proof.md`. This is not Sigma — Sigma remains the token issuer attestation.

## [1.2.261] - 2026-08-19

### Added

- **Collectables are now migrated per derivation branch, chosen deliberately.** A phrase can hold hundreds of thousands of tips on one branch and a handful on another. Each branch is listed with its count and its own checkbox; a branch too large to count exactly starts switched off, because destination change pays a fee per collectable and such a run can take hours and outlast the balance. Small branches stay on so a phrase can be verified cheaply first.

### Fixed

- **Running out of BSV part-way through a large migration now stops the run instead of failing every remaining tip.** A shortfall is a property of the wallet, not of the collectable being moved, so it ends the run under its own name, reports how many were moved, and leaves the resume cursor on the tip it did not reach — adding funds and running again continues from there.

## [1.2.260] - 2026-08-19

### Fixed

- **Collectables can now actually be migrated from an imported phrase.** Every tip failed CHECKSIG with "the top stack element must be truthy" because the sighash was built over a bare P2PKH, while a real tip's locking script is P2PKH followed by an inscription envelope or an `OP_RETURN` Sigma signature. The whole locking script is now used as the sighash scriptCode, the same way BSV-21 auth tips are already signed. Plain-P2PKH funding was unaffected, which is why cash swept while items never did.
- **A failed migrate no longer leaves a collectable in Collect that later vanishes.** The unsigned action kept its reserved inputs and still listed its `1sat` output — with the provenance attached, so it appeared as a verified item — until background review failed the transaction and removed it. Nothing had ever been broadcast, so the action is now aborted at the point of failure.
- **Tips carrying a Sigma signature or inscription envelope are no longer mistaken for foreign locks.** Eligibility requires the key's P2PKH to be present in the locking script rather than to be the entire script, so only genuinely unspendable tips (listed or covenant) are refused.

## [1.2.259] - 2026-08-19

### Fixed

- **Coins swept from an imported phrase now appear on Activity.** The sweep credited the balance but wrote no row, and no later pass could ever write one — Refresh only ingests this wallet's own addresses, never an imported phrase — so a completed sweep was indistinguishable from one that silently did nothing. Both paths now share one receipt recorder, and a sweep that landed before this fix is backfilled from its durable sweep mark (de-duped on the receive txid, so no coins are re-spent).
- **A phrase's cash outputs are no longer signed as if they were collectables.** The ordinal index lists every unspent output an address holds, so a Yours branch returned its 1.6M-sat cash output alongside its inscriptions; migrating it as a 1-sat tip signed the wrong sighash amount and failed script evaluation on every retry. Eligibility is now decided per output from the source transaction — value and lock must both match — and tips this phrase key cannot unlock (listed or covenant) are refused by name instead of retried forever.
- **Item counts and progress reflect collectables rather than raw index rows.** The preview counted cash outputs as items, and the migration's stop-early guard treated pages of skipped outputs as failed batches. Skips are now reported separately and only repeated failures with nothing moved end a run.
- **Migrated collectables get an Activity row of their own.**

## [1.2.257] - 2026-08-19

### Added

- **Settings → Import phrase brings an outside 12- or 24-word wallet into this one.** Both BRC-75 and legacy-HD roots are derived and previewed, so the phrase's real address is found before anything is spent. Funding is swept with the foreign key while this wallet keeps the change and pays the fee, and 1-sat items migrate in small resumable batches — a cursor is stored so a very large collection can continue across sessions instead of restarting.
- **Linked devices only count as linked once both sides hold a sealed spare.** Pairing reports each leg of the exchange separately (the spare this device made for the peer, and the peer's spare stored here) and the wizard stays open until both exist, so a link can no longer look complete while recovery would only work in one direction.

## [1.2.256] - 2026-08-18

### Fixed

- **BSV-21 peer sends now settle as tokens end to end.** The first token release reused the item messagebox card without identifying the asset, so the recipient routed the Atomic BEEF through collectable ingest and filed the output in `1sat`. The wire remittance now carries a tagged fungible payload, the payee validates the exact BSV-21 output from Atomic BEEF, broadcasts on the shared `peerDeliver` path, and internalizes it directly into `bsv21` with matching tags and custom instructions.
- **Token sends now obey the complete item send grammar instead of only its happy path.** Every selected input lock is recovered from BEEF and classified before the parent chart starts; missing, foreign, mixed, and cosigned locks fail closed by name. A signable `createAction` result follows the same explicit `signAction` edge as collectables, every settle must reach `done`, and sender broadcast remains impossible until peer delivery succeeds or takes the named fallback.
- **Spent token inputs and outbound remittance tips no longer return to the sender's balance.** The finish path records who may settle, keeps the original spent tip on Activity retries, hides pending spent rows, relinquishes the recipient output when it is not a self-send, and blocks retry or clear while the recipient can still broadcast.

## [1.2.255] - 2026-08-18

### Added

- **You can send a BSV-21 token from the wallet, the same way you send a collectable.** Tokens were listed under Collect but had no way out: a transfer could only happen through an app on the BRC-100 bridge. Token details and each card in the Collect carousel now open a Send screen with the same recipient grammar as an item send — friend, `$handle`, address, identity key, or a peer-pay URI — plus an amount field that respects the token's decimals and a Max button. The send picks tips largest-first, inscribes the transfer (and any change) as a BSV-21 output rather than a bare P2PKH, and hands the signed transfer to the same settle path items use: an identified peer receives it through their messagebox, a send to yourself settles locally, and a pasted address is broadcast by the sender. Cosigned tips (MNEE-shaped) and unrecognized locks refuse by name instead of quietly falling through to a plain spend, and a balance that mixes plain and cosigned tips says so rather than half-sending.

### Changed

- **An app that moves your tokens now asks to "Send token", not "Send item".** BSV-21 tips live in their own basket, but every permission prompt classified them as collectables, so a fungible transfer, receive, or release was described with item wording. Token spends, signs, receives, and releases are recognized on their own and read as tokens. Like item transfers, none of them are ever covered by Pay or Auto-pay.
- **A token send that dies is offered the same recovery as an item send.** A `send-token` row in Activity is now a spend attempt: the wallet re-checks whether enough of that token is still spendable before offering anything, rebroadcasts the transfer it already signed when one exists, recreates the send only when nothing was signed, and keeps the row untouched while the recipient can still broadcast it. It also inherits the longer grace period item sends get, so a peer-settled transfer is not called failed while it is still in the recipient's inbox.

## [1.2.254] - 2026-08-18

### Fixed
- **A collectable sent to your own handle now stays in Collect instead of vanishing.** A self-send settles on its own `selfReceive` path, not through item ingest, and that path only removed the tip it spent — the replacement tip is a different outpoint the basket has not listed yet, and the live address scan is invalidated by the send itself. Because the grid is rebuilt purely from the basket read, Collect came back one card short until a much later scan. The wallet now carries a tip it minted to itself through each rebuild until the basket returns it, and paints the card and its Verifying… spinner before the list read rather than a second behind it.

## [1.2.253] - 2026-08-18

### Fixed
- **A collectable sent to your own handle now paints and spins like any other receive.** 1.2.252 seeded the card and started the Verifying… spinner on the fresh-internalize path, but a send to yourself takes a different branch: `createAction` files the tip before the messagebox copy arrives, so that receive lands as "already internalized" and skipped straight to settling the Activity row — no seeded card, no spinner. Both ingest branches now share one paint step, so a self-send shows the card, the Activity row, and the spinner together, exactly like a receive from someone else.

## [1.2.252] - 2026-08-18

### Fixed
- **A received collectable lands in Collect at the same moment it lands in Activity.** 1.2.250 opened the Activity row at ingest, but ingest announced the arrival before the card existed: `internalizeAction` files the basket row while the list read and the address scan behind it take seconds, so Collect stayed empty — and with no card there was nothing to carry the Verifying… spinner. The tip is now seeded into the collectables cache as soon as it is internalized, which paints the card immediately and routes the arrival through the one place allowed to announce it, so the card, the spinner, and the Activity row all appear together. The following list replaces the seeded row, and a tip that is not ours is dropped by the ownership pass rather than guessed at. A send to your own handle no longer shows the collectable twice while the outgoing tip waits to be reviewed.

## [1.2.251] - 2026-08-18

### Fixed
- **An app's spend shows "Approving" in Activity instead of a bare dash.** The row for an app spend request is created the moment you approve, before any transaction exists, so it carries no amount — and the amount column tested for a missing USD rate before it tested for that, printing `—` (or `−…`). An unpriced pending spend now reads "Approving" and sets as a word rather than a number. Real sends are unaffected: they file a pending row with actual satoshis, which retires the placeholder.

## [1.2.250] - 2026-08-18

### Fixed
- **A balance that could not be read no longer reports itself as zero.** Every spendable-read strategy can time out at once when IndexedDB is saturated, and `fetchBalanceSats` returned `0` for that case — indistinguishable from an empty wallet. A funded wallet then looked broke, and the send gate refused the payment for insufficient funds. The read is now tagged (`ok` / `unavailable`): the hero number falls back to the last figure actually read rather than inventing a zero, and spend gates take the tagged read and refuse with "wallet storage is busy — nothing was sent" instead of a wrong arithmetic error.
- **A received collectable appears in Activity while it is being verified.** Tips discovered through the collectables cache — a peer-pay receive to your own handle, for one — only opened an Activity row once BRC-150 settled, because the row was created by the verify callback. The row is now opened the moment the card lands and shows "Verifying…", then settles in place when lineage proves; an already-proven arrival still lands settled in one step.
- **A collectable send shows a spinner in Activity, like a receive does.** Pending sends drew no progress mark at all, so the row looked inert until it settled. The sending mark reuses the receive spinner styling but stays distinct from the verify mark, so an outgoing item is never mislabelled as verified.

## [1.2.249] - 2026-08-18

### Fixed
- **Complete the BRC-165 held-row contract.** HandCash now stamps BRC-164 `id:` keys when collectables enter custody, resolves every `p 1sat input id <key>` label to exactly one held row and action input, removes the obsolete standing send grant, and advertises BRC-164/165 scopes through bridge capabilities.

## [1.2.248] - 2026-08-18

### Changed
- **P1Sat permissions now match the BRC-165 reference-wallet wire.** Collectables remain in storage basket `1sat`, while apps request `p 1sat all|collection|app|creator|id` and carry scope values in ordinary tags. Invalid or bare scopes fail closed, `app:` and `creator:` are distinct, BRC-164 id lookups stay narrowly filtered, and `p 1sat input id <key>` spends always require per-action approval outside Pay/Auto-pay.

## [1.2.247] - 2026-08-18

### Fixed
- **Friend and handle sends now get the confirming-funds message too.** 1.2.246 translated the raw insufficient-funds refusal on the plain-address path only, so a send to a friend, `$handle`, or identity key — which routes through BRC-29 peer pay — still showed the toolbox's `N more satoshis are needed` arithmetic. The wording now lives in one `insufficientFunds` module shared by both coin paths, so every payment reports the same spendable-vs-confirming split. The shared helper also refuses to say "still confirming" unless the confirming balance actually closes the gap, so it can never tell a genuinely short wallet to wait forever.
- **The friend suggestion dropdown is readable in light mode.** `.friend-suggest-list` (Send and Send collectable) hardcoded a near-black sheet that never flipped with the theme, so on the light sheet it rendered as a dark box with dark inherited text. It now uses the same light-mode surface tokens as the chat command menu; the dark theme is unchanged.

## [1.2.246] - 2026-08-18

### Fixed
- **Sends now say "still confirming" instead of a raw insufficient-funds line.** The displayed balance credits unconfirmed change of your own live sends, and the send gate credited it too — but `createAction` can only spend confirmed `spendable: true` coins. After rapid back-to-back sends, almost the whole balance can be unconfirmed change while the wallet is still syncing, so the gate green-lit the send and the toolbox then threw `N more satoshis are needed`. A coin send that fails on insufficient funds now reports the honest split ("X BSV spendable now, Y BSV waiting for confirmation — try again once it clears") when confirmed is short but confirming covers it, and a plain "not enough spendable BSV" otherwise. Coin selection is untouched; this only rewrites the failure message.

## [1.2.245] - 2026-08-18

### Fixed
- **Failed bridge calls now record why they failed.** The bridge logged only `status=400`, so an uploaded support log could show that a `signAction` or `internalizeAction` was rejected without naming the reason — the wallet's `code` / `description` never left the renderer. Non-2xx replies now log a bounded one-line summary (whitespace collapsed, truncated at 300 characters) so a BEEF-sized payload cannot flood the log while the actual refusal stays diagnosable.

### Changed
- **Withdrawn BRC-156 / soft-latch vocabulary is gone from app-facing discovery.** `/health` and `/manifest.json` advertised `1sat-latch`, `latchedSend`, and provenance `v3` for a standard that was cancelled. App capabilities now come from a single `oneSatAppCapabilities` constant that exposes only BRC-147, BRC-150, basket `1sat`, and BRC-150 `v2` provenance, with a test asserting no latch vocabulary can reappear on the wire. Token docs were updated to match: item identity and authenticity are the BRC-150 offline tip→origin proof, with no on-chain latch companion.

### Fixed
- **App permission rows fit Recent activity again.** The stored note prefixed “Approved” onto an action title that already led with a verb, while the row’s right column said “Allowed” — three ways of saying the same thing. The note now names only what was requested (“Approve payment”), and the verdict column keeps Allowed / Denied. Long app origins truncate with an ellipsis instead of pushing the row wide; the full host stays available on hover.
- **Apps hosted on a shared domain are named correctly.** `brc-cloud.bcryderman.workers.dev` displayed as “Workers” in connect prompts, activity, and app details because the name came from the second-to-last host label. Hosts such as `workers.dev`, `pages.dev`, `github.io`, `vercel.app`, and `netlify.app` are now named by the app’s own subdomain (“BRC Cloud”).

## [1.2.243] - 2026-08-18

### Changed

- **macOS update checks no longer depend on mutable ZIP channel metadata.** BETA builds already install through an architecture-matched DMG, so Mac now discovers that versioned asset directly from GitHub and bypasses electron-updater's stale ZIP cache—the source of false SHA-512 mismatch failures.
- **Mac release metadata is published last.** CI waits for every referenced DMG, ZIP, and blockmap upload to complete before exposing `latest-mac.yml`.

## [1.2.242] - 2026-08-17

### Changed
- **Key-slice backup uses the device Share sheet.** Each BRC-140 slice opens the OS share surface so the user can put it in Drive, email, a password manager, or another app they control — HandCash is not a destination and does not receive the slice. Desktop falls back to email when Web Share is unavailable; Mobile uses a native Android chooser.
- **Backup completion requires an explicit “I saved this slice” confirmation.** Sharing, copying, or downloading alone never marks a slice done. The final keys-backup confirm stays locked until two distinct slices are manually confirmed. Hosted trustholders stay behind the existing feature flag and remain hidden.

## [1.2.241] - 2026-08-17

### Added
- **Background change consolidation keeps signing fast on a fragmented wallet.** Many small BRC-29 receives leave the wallet with a large pool of little change outputs, and `createAction` coin selection walks that pool on every send. A rate-limited background pass now collapses the whole spendable change pool into a single managed-change UTXO with one self-payment, using the toolbox `maxPossibleSatoshis` "largest fundable amount" output — the same primitive the toolbox's own `sweepTo` uses, aimed at our own identity. The decision is an explicit tagged union (`changeConsolidationPath.ts`): it only fires when the pool is genuinely fragmented (≥ 30 spendable change outputs) and comfortably above the fee, and it holds otherwise. It runs in the exclusive spend region so it can never race a user send, yields when a spend is already waiting or a recompose owns the session, and only ever selects change — assets (`1sat`, `bsv21`) live in their own baskets and are never touched. Fully fail-closed and silent (no Activity row for money that never left the wallet).

## [1.2.240] - 2026-08-17

### Fixed
- **Send no longer scans the unspendable graveyard when confirmed coins already cover the payment.** The pre-`createAction` gate used to credit unconfirmed change on every Send — on a phone carrying hundreds of unspendable rows that was most of the wait before signing, even when toolbox `balance()` already had enough. Confirmed spendable is checked first; the graveyard scan only runs for the shortfall, stops once that shortfall is covered, and runs in one IndexedDB session instead of one per page.
- **BRC-29 key derivation overlaps the send prep.** The payment's two nonces and payee `getPublicKey` read only the root key and counterparty, so they now run concurrently with the nosend release and balance check rather than strictly after them. A new `keys ready` timing mark makes the derivation cost visible on the next log.
- **Legacy sweep is now an explicit tagged path.** `chooseLegacySweepPath` (`legacySweepPath.ts`) is the only decision that may admit an address UTXO into `importLegacyUtxos` — same pattern as `TipKind` / `SendPath` / `ItemSettlePath`. Classification puts sub-fee companion dust in `heldUneconomical` (never `funding`); payment-by-txid uses the same chooser; the sweep fail-closes again if anything else is passed in. A bare `satoshis > 1` test is forbidden so a future change cannot accidentally sweep assets or latch-style companions.
- **Back-to-back sends no longer reselect a just-spent coin.** The pass that marked consumed inputs unspendable (`rehideInputsOfLiveLocalTxs`) is chain-ingest maintenance and returns early while a spend is queued — exactly the state a burst of sends holds. A spend now seals its own inputs immediately after `createAction`, on both the BRC-29 and plain BSV paths, so the next send cannot pick them.

## [1.2.239] - 2026-08-17

### Fixed
- **Tiny companion outputs no longer retry their sweep forever.** Some apps park a small second output next to a 1-sat ordinal they send you. Sweeping one output builds a ~193-byte transaction and ARC charges 100 satoshis per 1000 bytes, so anything under 21 sats cannot pay its own fee — there is no transaction that moves it alone. Because a broadcast rejection is deliberately read as transient (an outage must never blacklist a live deposit), each of these was rebuilt, re-signed and re-rejected on every scan. Seven of them was enough to hold legacy ingest past its deadline every pass, which is what made sends queue behind it. The sweep now names an economic floor and holds anything below it, exactly like unrecognized 1-sat dust. Nothing is lost — the outputs stay on the address.

## [1.2.238] - 2026-08-17

### Fixed
- **Signing is much faster on phones.** Two hot loops opened a fresh IndexedDB storage session *per row* instead of one for the batch, and entering the provider — not the queries — was the cost. The phone log showed 6.5s between tapping Send and `createAction`, on a wallet carrying ~190 unspendable rows.
  - The unconfirmed-change credit behind every balance read took two sessions per output row to check transaction liveness; it now resolves a whole page of transaction ids in one session, and asks once per distinct id.
  - The stale-output restore sweep took a session per output; the whole sweep now runs in one, keeping its yield-to-spend check.
- Send now logs `nosends released` alongside `ready`, so the pre-`createAction` cost is attributable instead of a single opaque number.

## [1.2.237] - 2026-08-17

### Fixed
- **The balance snapshot uploads again after a send.** A send raises spend priority *before* it can acquire the wallet region, so while chain ingest was slow enough that sends queued for tens of seconds, every backup wake-up found another spend waiting and deferred — forever. The post-spend push now gets a bounded courtesy budget (four windows) and then takes its turn; the coordinator's region exclusion, not the deferral hint, keeps the export and the spend apart. Logs name the holder and warn when the budget is spent.
- **WhatsOnChain throttling no longer stalls chain ingest.** Its free tier is ~3 req/s and its 429 carries no CORS header, so in the renderer the throttle arrived as an opaque `TypeError: Failed to fetch` — indistinguishable from an outage. Every per-transaction probe read "unknown", so sweeps re-ran each pass, legacy ingest hit its 35s soft deadline every cycle, and sends sat behind it. WhatsOnChain calls now share a paced request budget and stop outright for 20s after a throttle, leaving Bitails to answer. "We never asked" stays distinct from "absent" — probes still fail closed.

### Changed
- The concurrent tip-ingest test gets a realistic timeout instead of flaking near the 5s default under full-suite load.

## [1.2.236] - 2026-08-17

### Changed
- **Ingest and broadcast paths run cooler.** Chain maintenance steps overlap; tip ingest / outbox flush / stuck-sweep checks use a shared bounded pool; address scans hedge providers instead of hammering them all at once; payment chase prefers tip re-ingest over repeated full refreshes; BRC-29 payee ingest overlaps on-chain confirm with `internalizeAction` and skips a redundant `postBeef` when the tip is already mined.
- **Handle display:** short form stays `$handle`; fully-qualified / email form is BRC-169 `@handle@domain` (no `$`). Input still accepts `$`, `@`, and `@$`.
- **BRC-169 for apps like Free Radio:** any authenticated BRC-100 app can read `getClaimedCloudHandle`; claim stores the registry certificate for `listCertificates`; reverse lookup by identity key on BRC-CLOUD resolve/search.
- **Live send harness** supports Alice↔Bob pingpong (`HANDCASH_LIVE_PINGPONG`) with bottleneck summaries; BRC-29 ingest logs existence-probe / internalize / balance phase timings.

### Fixed
- Stale raw-tx provider list and activity-item view identity tests; legacy-scan fixtures; chain-ingest mocks.

## [1.2.235] - 2026-08-17

### Fixed
- **Pay no longer jumps up after Refresh by resurrecting spent coins.** Restore used to trust indexer `isUtxo`, which still says yes while a spend is catching up — that flipped consumed inputs back to spendable, inflated the hero number, and hung the next send on already-spent coins. Refresh now re-hides inputs of this wallet's live local txs and only restores that tx's change. Checking the Send balance no longer pages the whole spent set.

## [1.2.234] - 2026-08-17

### Changed
- **UTXO hide/reserve overlay uses BRC-38 `spendable` / `spentBy`** instead of Cloud `available` / `selected` / `spent` / `quarantine`. In-flight sends still reserve with `lockOwnerId` (wallet-local). Refresh will not re-offer a coin with `spentBy` set.

## [1.2.233] - 2026-08-17

### Fixed
- **Clearing an "already spent" send keeps its change.** Dropping a signed Activity row whose inputs moved on chain now credits that tx's change instead of leaving it unspendable after an indexer 404.
- **Already-spent broadcasts hide those inputs without deleting them**, and no longer bulk-restore indexer-lagged coins as spendable (the path that recycled dead UTXOs into the next send). Overlay statuses match Cloud: `available` / `selected` / `spent` / `quarantine`.
- **The Pay balance no longer drops by payment plus change while Sending.** Displayed owned cash is spendable outputs plus unconfirmed change of a live local tx.

### Changed
- Failed Activity rows use a short label (`Already spent`, `Timed out`, `No network`) instead of the broadcaster dump.


## [1.2.232] - 2026-08-17

### Fixed
- **Clearing a send from Activity no longer cancels a live transaction.** A signed send stays until every one of its inputs is spent on chain. Dropping the row earlier, then repairing local spend state, is how a later Refresh could lose those coins. Unsigned failed sends (never signed) can still be cleared. Signed rows whose coins already moved can be dropped as history only — that does not undo the spend.
- **Follow-up sends after an already-spent broadcast no longer restore dead inputs** as spendable, and they keep this wallet's unconfirmed change. Outputs whose `spentBy` transaction is still live locally are left alone.
- **Send no longer waits ~15s repairing failed spends before createAction.** Stuck noSends/batches abort on the hot path; the full failed-spend repair and change-script sweep run on crash recovery instead. Refresh yields to a waiting spend instead of holding the lock through ghost-heal / prune / restore.

### Changed
- Bulk "Clear failed" keeps signed sends whose inputs are still unspent (or unknown) and reports what it kept. Confirmation copy matches: this does not cancel a live transaction.

## [1.2.231] - 2026-08-17

### Fixed
- **Desktop installer CI compiles again.** 1.2.230 failed `tsc` on the live send harness and a `globalThis` flag in tests; same wallet as 1.2.230.

## [1.2.230] - 2026-08-17

### Fixed
- **Incoming BSV is credited when it is visible on-chain**, without waiting for Arcade SEEN, merkle proofs, or walking deposit ancestry. Plain P2PKH cash is not an NFT: Refresh loads the deposit, sweeps into BRC change, and only counts it after ARC accepts the sweep (so a local-only sweep cannot look already spent).
- **BRC-29 receive no longer rejects unconfirmed payments** (`internalizeAction beef is invalid`). Same visible-on-chain gate as cash.

### Changed
- **The sending column occupies the side** while a payment is in flight, instead of stacking the spinner above Recent activity. Activity still shows the Sending… row.
- **Cloud key backup (BRC-232 trustholders) is off** unless `VITE_TRUSTHOLDERS_ENABLED=true`. Phrase, BRC-140 slices, and history backup stay.

## [1.2.229] - 2026-08-16

### Changed
- **BRC wallet broadcast is ARC again**, not Arcade. Sends go Taal ARC → GorillaPool ARC → Bitails → WhatsOnChain. Arcade SSE / callback-token wiring is out of the boot path.

## [1.2.228] - 2026-08-14

### Changed
- **Arcade is the BRC wallet broadcaster**, with status wired into the existing dual-layer confirmation path. Mainnet submits to Arcade only (legacy Taal/GP ARC stays on HandCash Cloud for free consolidations). A shared callback token filters Arcade SSE `/events`; those statuses feed `applyDualLayerArc` / SPV finalize, and balance refresh catch-up pulls missed events. No wallet webhook URL — Desktop/Mobile listen over SSE.
- **Minting a collectable asks “Mint item”**, not “Send item”. Issuance has no item tip input; the permission copy names it as mint so Auto-pay / Pay wording is not trained on the wrong verb.
- **Send amount and recipient chrome no longer jump while typing.** Reserved slots hold the USD note and resolved-handle line so the caret and buttons stay put.
- Theme prefs / HandCash mark polish and Settings surface for appearance.

## [1.2.227] - 2026-08-13

### Fixed
- **Pixel Foxes (and other batch-mint) sends no longer omit BRC-150 remittance for being over budget.** The fat part is the shared origin mint — hundreds of sibling inscriptions in one transaction — not the tip→origin path. Remittance slims those bodies to txid-only (BRC-96), keeps the tip raw, and the receiver hydrates the shared origin once (cached for the whole collection). Extending a prior remittance clears a stale AtomicBEEF subject so the next hop still verifies.

## [1.2.226] - 2026-08-13

### Fixed
- **A self-send of an already-proven item arrived unproven and took a minute to verify.** Proving a tip recorded the verdict and threw the lineage away, so the send found no tip-local path, logged `omit provenance — no tip-local path`, and left the receiver to repeat the entire discovery walk. A walk now keeps what it cost: the tip→origin path is stored on the durable verdict, and the assembled BEEF is kept as reusable remittance whenever it fits the wire budget (over it, the verdict still stands — those bytes could never travel). A send over a known path replays it against a warmed BEEF cache instead of rediscovering hop by hop, and the receiver verifies one attached package. Verifying an incoming remittance also records the path it proved, so the next hop passes it on. Verdicts written before any of this get one paced walk (`GENESIS_PATH_BACKFILL_MS`) to recover their path, so existing inventory heals rather than sending bare forever.

## [1.2.225] - 2026-08-13

### Fixed
- **33s freeze while proving an item's lineage** (one `longtask`, a whole heartbeat gap, app killed). The hop loop yielded, but the tail serialized the assembled BEEF, base64'd it, then decoded and re-parsed it purely to call a wire-format verifier — on a batch-mint origin carrying hundreds of inscriptions that is megabytes each way. Verification now runs against the in-memory `Beef` (`verifyLineageInBeef`); serializing is opt-in (`includeBeef`) for the send path that actually puts the lineage on the wire; the tail honours `shouldStop`. Receive-side verify parses a remittance BEEF once instead of up to four times.

### Changed
- **Confirming a send returns you to Activity or the collectables grid** instead of holding you on a status screen. The sidebar mirrors live progress and Activity carries the result, so the in-panel "Preparing payment" and "Sent" screens were hiding the surfaces that outlive them. Success and failure now surface as a toast plus the Activity row. `sendMachine` drops `broadcasting`/`success` for a terminal `handoff`.
- **Clearing a failed send is no longer offered while the recipient can still broadcast it.** A `peerDeliver` transfer is the payee's to settle, and that row is the sender's only record of an item that has already left; retry would race a live transaction. Both are refused for the same window `ghostHealFate` waits on, with a "Free up reserved funds" action instead — repair only fails *unsigned* transactions, so a stuck balance still clears. Bulk "Clear failed" skips protected rows and reports what it kept.

## [1.2.224] - 2026-08-13

### Fixed
- **Items stuck on “unverified” even with a healthy lineage.** GorillaPool 404s the BEEF for ordinal transfer txs and the toolbox `getBeefForTxid` hung past its 8s budget, so every BRC-150 hop failed (`indexer BEEF … timed out after 8000ms`). WhatsOnChain `/beef` returns the subject tx *with* its merkle bump in ~400ms — now used as a proof-carrying fallback on the proof path, not just raw ingest.
- **Purged BRC-156 tips showed no name, app, or traits.** Their identity lived in the removed `BRC156` OP_RETURN and their tip 404s on the indexer, while the origin has been indexed for months. Identity resolve now treats the item's own origin claim as a known origin, recovering name and traits in one request.

## [1.2.223] - 2026-08-13

### Fixed
- **Foxes stuck on Verifying forever.** Chain-provider outages looked identical to unprovable items (walker returned bare `null`), burned the 8-walk session budget, and left Collect spinning. Lineage walks now return named outcomes (`unavailable` / `invalid` / `aborted`); only conclusive misses cool down for 24h; the budget is a rolling 8 per 10 minutes; details show “Cannot be verified” with the reason when the chain says so.
- **Spend priority could leak and starve item verify + cloud backup.** Permission prompts and exclusive spends now hold named, expiring leases instead of a counter that could stick >0.
- **Failed sends (items and BSV) can be retried or cleared from Activity**, including a bulk “Clear N failed” on the full Activity panel. Retry is gated on spendability; unspendable attempts offer clear only.
- **Live “Sending…” row disagreed between Recent Activity and full Activity** — matching is now by outpoint (or coin send) via `liveOutboundRow`, not “any pending spend”.
- Peer-delivered item sends keep a settle-path grace so tips are not healed back into inventory while the payee has not broadcast yet.

## [1.2.222] - 2026-08-13

### Changed
- **BRC-156 soft-latch removed.** Item tips are plain P2PKH; authenticity is BRC-150 tip→origin remittance only. Latch dust, `BRC156` OP_RETURN, and soft-latch send/ingest paths are gone.
- **`collection:` tags on import/send** so `p 1sat collection:<id>` permission scopes match (foxplorer / Pixel Foxes).
- Instant-ingest unknown 1-sat tips from transfer shape (spend a 1-sat input or mint envelope), then verify provenance after paint.
- Settled item Activity rows are no longer pruned when the txid still 404s on-chain (`peerDeliver` is payee-broadcast).

## [1.2.221] - 2026-08-12

### Fixed
- **Every send failed with “A previous failed send is blocking this payment.”** It was never a double-spend, and the wallet state was never corrupt. `StorageIdb.allocateChangeInput` scans change candidates with `noScript: true`, which clears `lockingScript` on every row, then re-hydrates the chosen output only through `validateOutputScript` — and that returns *unchanged* unless `scriptOffset`/`scriptLength` are set. Our change rows store the script inline, so the winning coin reached `createAction` with no script and threw `undefined is not iterable` (`asString(undefined)` → `Array.from(undefined)`). Patched the toolbox to re-read the chosen change output with its script. This is why a fresh BSVA wallet worked and ours could not send at all.
- Iterator crashes now say a coin was missing its locking script instead of blaming a previous send — that wrong message hid this root cause across 1.2.217–1.2.220.

## [1.2.220] - 2026-08-12

### Fixed
- **Metanet / Pixel War / foxplorer connect dead after closing the wallet window.** The BRC-100 bridge closed over the first BrowserWindow; on macOS the app stays alive with a destroyed window, so every `/waitForAuthentication` answered `WALLET_BRIDGE_UNAVAILABLE: window is not available`. The bridge now resolves the live window per request, waits until the renderer registers its listener, and revives the window when a connect arrives.
- **Failed sends vanished from Activity.** Sending… rows were deleted on error. They now stay as failed rows with the reason (also when the 90s stuck watchdog fires).

### Changed
- Patch release (every push must ship a new version).

## [1.2.219] - 2026-08-12

### Fixed
- **“undefined is not iterable” still blocked sends after repair.** 1.2.217 only scanned the first 200 spendable rows, so a change UTXO with no lockingScript further in survived and `allocateChangeInput` handed it back to `createAction`. Every change row now gets an explicit fate: rebuild the script from the raw tx (local storage, then chain on iterator-crash recovery), or fail closed as unspendable.
- Restored change UTXOs are re-enabled after a successful rebuild, so healed coins return to the balance instead of staying written off.
- Stale-output restore no longer logs hundreds of `validateOutputScript` warnings per pass — script-less rows are left to the rebuild path.

## [1.2.218] - 2026-08-12

### Fixed
- **Eternal Verifying… / ghost Sent for 404 txs.** Tip-hint polls re-pinned Activity for inbox tips whose tx never landed (e.g. abandoned soft-latch attempts). Ghost txids are remembered, pruned from Activity, and ACKed so they stop resurfacing. Heal of ghost sent-hides also strips the matching Sent rows.
- Pending BSV Verifying… rows are pruned on confirmed 404; pending collectables stay until BEEF/ingest (peerDeliver may be off-chain).

## [1.2.217] - 2026-08-12

### Fixed
- **BRC-29 / pay stuck on “undefined is not iterable”.** Recovery now fails abandoned unsigned txs, runs toolbox `reviewStatus` to free inputs, quarantines change UTXOs with no lockingScript (offloaded-script allocate poison), and retries `createAction` once after repair — still never `listFailedActions(unfail)`.

## [1.2.216] - 2026-08-12

### Fixed
- **Payments stuck on Sending… forever.** Chain ingest yields to a waiting spend before dual-layer reconcile / UTXO restore; restore loop yields mid-pass. Stuck payment watchdog also expires durable Activity Sending… rows.
- **Activity NFT thumbs skeleton forever.** DeferredImage times out hanging content hosts and shows the collectable fallback icon.
- **Ghost Activity txs that 404 on-chain.** Refresh prunes settled rows whose txid is confirmed missing.
- **Mobile keyboard shrinks Activity.** Capacitor Keyboard resize set to `none` (adjustPan pans; layout height stays).

## [1.2.215] - 2026-08-12

### Added
- **Dual-layer Tx/UTXO confirmation.** Optimistic soft-locks + ARC status mapping sit beside settle-path machines; hard finality is `MINED` only after SPV-verified BUMP. Chain ingest reconciles pending / reject / reorg; Settings → Statecharts shows the new lifecycle chart.

## [1.2.214] - 2026-08-12

### Fixed
- **Desktop soft-latch ingest loop.** Failed AtomicBEEF builds are deduped and backed off (10m / 1h for not-on-chain ghosts); tip polls no longer fan out dozens of parallel 8s hydrates; item inbox retries cut from 15×2s to 2×4s.

## [1.2.213] - 2026-08-12

### Fixed
- **Mobile → Desktop collectable receives failing AtomicBEEF.** Soft-latch ingest preferred a raw tip-only BEEF (0 parents / 0 BUMPS), cached it, and `internalizeAction` rejected it forever. Indexer BEEF is preferred first; parents are hydrated into a valid AtomicBEEF; tip-only raw is no longer cached.
- **Activity NFT rows stuck on Verifying… with blank thumbs.** Failed item ingest clears the pending row; stale Verifying receives expire after 2 minutes; Activity thumbs fall back to the origin content URL when inventory has no `imageUrl`.

## [1.2.212] - 2026-08-12

### Fixed
- **Activity “Sending…” missing while a send is in flight.** Pin the pending row immediately on confirm (before heal / listOutputs); keep Recent Activity visible during Desktop Working; synthesize a live top row from payment progress when durable storage is late; do not collapse a re-send onto a prior settled spend of the same tip (restored after a failed broadcast).

## [Unreleased]

## [1.2.211] - 2026-08-12

### Fixed
- **Mobile keyboard must pan, not shrink.** Stop binding the app shell to visual-viewport height (that crushed Activity). Keyboard tracking only scrolls the focused field; Android uses adjustPan.

## [1.2.210] - 2026-08-12

### Changed
- **Three-part architecture.** Named `@handcash/wallet-ui` package is the shared UI core (`src/`). Desktop Electron and Mobile Capacitor are thin shells. Bump script keeps the core version locked to Desktop.

## [1.2.209] - 2026-08-12

### Fixed
- **Incoming NFTs stuck on Verifying forever.** Await authenticity clears when a lineage walk cannot run (budget / cooldown / conclusive miss) and times out after 90s; failed remittance verify falls through instead of spinning.
- **NFT thumbnails blank while metadata showed.** Broken GorillaPool content URLs no longer leave an eternal skeleton — Collect / details / Activity fall back to the collectable icon.
- **Desktop support logs missing wallet lines.** Uploads now prefer the renderer ring (collectables / BRC) and only append a short Electron main tail.
- **Outbound Activity “Sending…”.** Money, BRC-29, and collectable sends pin a pending Activity row until broadcast settles or fails.

## [1.2.208] - 2026-08-12

### Fixed
- **Keyboard covering UI.** Mobile shell tracks the visual viewport + Capacitor Keyboard so the app height and bottom bars stay above the soft keyboard on every screen (send money, send item, chat, settings).


## [1.2.207] - 2026-08-12

### Fixed
- **Balance never recovered after false UTXO write-off.** Refresh restores `spendable: false` outputs that are still on-chain.
- **Activity stuck on Verifying while Collect already verified.** Pending Activity rows reconcile from inventory; UI defers to proven inventory state.


## [1.2.206] - 2026-08-12

### Fixed
- **Restore money send layout.** Reverted the sticky-footer/keyboard-inset experiment. Item send mirrors money again (same Review/Cancel placement; To is not autofocused, matching money).


## [1.2.205] - 2026-08-12

### Fixed
- **Failed send wrote off live balance (~$0.10).** Iterator-crash recovery called `releaseStaleSpendableOutputs`, which bulk-marked UTXOs unspendable without on-chain proof. Only real already-spent network errors may release.
- **Item-send keyboard covered the bottom bar.** Collectable send autofocused the To field (full keyboard) while money focused amount (decimal pad). Pin Review/Cancel as a sticky footer, lift the tab bar with visualViewport inset, and use `adjustResize` on Android.


## [1.2.204] - 2026-08-12

### Fixed
- **Mobile→Desktop payment never arrived.** Delayed `createAction` could return a txid that later failed as `doubleSpend` (never on chain) while Activity still showed Sent and remittance never helped the payee. Sender now confirms with `postBeef` before Activity / inbox notify. Leftover failed-action unfail in recover paths stays off.

## [1.2.203] - 2026-08-12

### Fixed
- **Sent NFT bouncing back into Collect.** A lagging address scan un-hid tips that were already sent, so the same item could be sent twice and then vanish from Collect while Activity still showed the transfers.
- **Penny send “undefined is not iterable”.** Leftover doubleSpend actions were unfailed on every unlock and poisoned the next payment. Refresh no longer requeues them; that crash maps to a retry hint and local conflicts are cleared.

## [1.2.202] - 2026-08-12

### Fixed
- **Desktop CI typecheck.** Activity pending-status parse widened `status` to `string`, so `tsc` failed and no installers uploaded for 1.2.201.

## [1.2.201] - 2026-08-12

### Fixed
- **Verifying receives show in Activity.** Inbound payments and items write a pending Activity row as soon as the tip card lands, with “Verifying…” until internalize finishes — not only after success. Soft-latch / item / SPV ingest uses raw-tx BEEF so indexer timeouts no longer stall digest.

## [1.2.200] - 2026-08-12

### Fixed
- **Desktop ingest of mobile BRC-29.** Remittance arrived without Atomic BEEF and indexer `getBeefForTxid` timed out at 8s, so payments never internalized. Ingest now wraps Bitails/WoC raw tx as BEEF. Outbox retries reattach local BEEF. Duplicate ingest polls no longer stampede.

## [1.2.199] - 2026-08-12

### Fixed
- **Android remittance `Failed to fetch`.** `sendMessage` was sending `X-BRC103-*` headers that BRC-CLOUD CORS did not allow, so WebView blocked the request before it left the phone. Wire auth is `X-BRC33-*` only; BRC-103 stays signed locally. Pending outbox retries after install.

## [1.2.198] - 2026-08-12

### Fixed
- **BSV send matches toolbox/Babbage.** One `createAction` broadcasts immediately. Remittance still goes on `sendMessage`; if the box misses, retry from a local outbox — no `noSend`, no abort, no second payment (that was the double-spend). Stuck leftover noSend actions are released before the next spend. `sendMessage` failures are logged.

## [1.2.197] - 2026-08-12

### Fixed
- **Inbox-fail fallback is identity-address P2PKH, not a scan QR.** If the payee messagebox is unreachable, abort the noSend BRC-29 and broadcast to their identity address so Desktop can claim via address scan. No physical scanning / claim-receipt QR.

## [1.2.196] - 2026-08-12

### Fixed
- **BRC-29 is a real P2P settle path.** `brc29SendMachine` + `Brc29SettlePath` — no fake “recipient offline”, no `/files` on Android. Remittance (± inline Atomic BEEF) goes on `sendMessage`. After inbox delivery, sender silently `postBeef` so the tx is on-chain even if the payee never broadcasts. If the inbox is unreachable, sender broadcasts and shows a `brc29:` claim receipt (QR / copy) so the payee can still claim. Desktop does not ACK the inbox until ingest succeeds, and same-identity sends still notify our box so the other device can claim.

## [1.2.195] - 2026-08-12

### Fixed
- **Mobile BEEF upload / peer delivery.** Android `fetch(File)` fails (`Failed to fetch`), so item and BRC-29 sends posted a tip card without Atomic BEEF and skipped sender broadcast — Desktop never received them. Uploads now send a `Blob` (not `File`); a box ack without BEEF is not delivery (sender broadcasts). Payee ingest can SPV-fetch BEEF by txid after that broadcast.

## [1.2.194] - 2026-08-12

### Changed
- **Item send is P2P-first.** Soft-latch classify once into `ItemSettlePath`
  (`peerDeliver` / `selfReceive` / `externalBroadcast`). Sender signs `noSend`;
  HandCash peers get Atomic BEEF and broadcast. Sender `postBeef` only after
  `DELIVER_FAILED` or for self/external. Stuck action-batch reservations are
  aborted before the next createAction.

## [1.2.193] - 2026-08-12

### Fixed
- **Stop burning collectables after a failed self-send.** A stuck latch (`no longer spendable`) no longer ghost-relinquishes the tip from the `1sat` basket. Unknown locking scripts stay in inventory; failed sends protect the tip and retry tip-only. Settle Atomic BEEF is remembered locally so the next send can find the owning transaction.

## [1.2.192] - 2026-08-12

### Changed
- **HandCash is the default history host.** Onboarding, unlock, and cloud-health apply HandCash cloud unless you chose no backup or a custom host. Settings no longer require pasting a workers.dev URL.
- **BRC-29 payee broadcasts.** Sender signs (`noSend`) and delivers Atomic BEEF + remittance to the peer; the recipient internalizes and submits. Sender broadcasts only if delivery fails. Self-pay credits locally. Remittance QR is no longer the send-success UX.

## [1.2.191] - 2026-08-11

### Added
- **Offline BRC-29 remittance QR/URI** (`brc29:`) beside messagebox — scan or paste to claim without the box. Send success shows copy + QR.
- **BRC-103 identity headers** on messagebox alongside interim ECDSA (server accepts either). Full Authrite Peer sessions still deferred.

### Changed
- SPV receive copy is **Receiving (SPV)**; extra rawtx + merkle provider failover; GorillaPool remains CDN/display only.

## [1.2.190] - 2026-08-11

### Fixed
- **Typecheck for BRC-29 peer pay.** Tighten remittance / tip-hint types so Desktop CI `tsc` stays green after 1.2.189.

## [1.2.189] - 2026-08-11

### Changed
- **Peer tip/pay is BRC-29.** HandCash↔HandCash DM tip, chat pay, and Send-to-friend lock a BRC-29 derived P2PKH and deliver remittance (prefix/suffix + txid) on the tip/pay-sent card; the payee `internalizeAction`s as a wallet payment (SPV BEEF by txid). Plain identity-address P2PKH remains only for pasted/external addresses; address-index scan is the legacy fallback.

## [1.2.188] - 2026-08-11

### Changed
- **DM tip/pay: SPV-first receive.** Tip cards now drive `ingestPaymentByTxid` (BEEF → sweep outs that pay us) with a Receiving… indicator. Address-index polling is only the fallback / secondary verify — same custody grade as soft-latch items, messagebox is just the wake-up.

## [1.2.187] - 2026-08-11

### Fixed
- **DM tip/pay card before balance.** Messagebox tip/pay notifies now retry address ingest for ~12s until funding lands (Bitails often lags the chat card). Also treats `pay-sent` the same as `tip`.

## [1.2.186] - 2026-08-11

### Fixed
- **Messagebox tip hints now kick ingest immediately.** Tip-hint poll runs every ~1.5s in the foreground and forces a chain refresh as soon as a peer soft-latch notify lands — no waiting for the 5s address-scan tick.

## [1.2.185] - 2026-08-11

### Fixed
- **Slow peer item receives (~30–60s).** Foreground chain poll is 5s (30s only when backgrounded). Soft-latch sends also drop a messagebox tip hint with the txid so the peer’s next tick runs chain ingest immediately.

## [1.2.184] - 2026-08-11

### Fixed
- **Verify checkmark on every Collect visit.** Corner mark only spins for real authenticity work (not indexer identify) and only flashes a check when the tip is actually proven.
- **Restore missing Activity history.** Device backup now stores/merges `activity.json` beside BRC-39 and friends.
- **NFT in Activity but missing from inventory.** Tips whose locking script still pays us are no longer ghost-dropped when the address scan lags; tips still on our address are un-hidden from stale “sent” marks.

## [1.2.183] - 2026-08-11

### Changed
- **BRC-33 messagebox compliance.** Chat send/list/ack use PeerServ response shapes (`status`, `sender`, `messageIds[]`) and interim ECDSA identity headers (sender/recipient bound by proof, not spoofable body fields). BRC-169 §7 encrypted envelopes and BRC-103/104 Authrite remain deferred.
- **Stop advertising withdrawn BRC-156.** Capability / health / manifest list `147`+`150` only (`latchedSend` remains for soft-latch). Desktop BRC-156 doc matches the withdrawn notice; on-chain `BRC156` marker kept for legacy soft-latch discovery.

### Added
- **Federated messagebox addressing (Phase 1).** Handle resolve persists the peer `messagebox` URL on friends; chat send/file upload posts to that box (BRC-CLOUD remains the default fallback). Architecture SSoT: `docs/wallet-p2p-messagebox.md`. Settings statecharts gain Wallet I/O / Coordinator / Sign / Chain ingest / Messagebox maps.

### Fixed
- **Release build TypeScript.** `oneSatImport.test.ts` mock-call typing no longer fails `tsc --noEmit` (blocked v1.2.182 CI).

## [1.2.182] - 2026-08-11

### Fixed
- **Slow Collect after soft-latch P2P receives.** Latch-proven tips no longer hit GorillaPool / ancestry during address classify; tip + latch internalize in one BEEF (parallel across txs) so a burst of inbound NFTs paints without serial indexer waits.

## [1.2.181] - 2026-08-11

### Fixed
- **Broadcast “all services error” on already-spent tips.** Bitails missing-inputs was reported as every broadcaster failing. Send now detects spent tips/latches before broadcast, drops them from inventory, and shows that the item was already spent.

## [1.2.180] - 2026-08-11

### Fixed
- **“Undelayed … results require review” on mobile send.** Soft-latch / BSV sends use delayed broadcast again, but still require `postBeef` (or clean sendWith) before success. Prior ghost doubleSpends are unfailed on Refresh and on this error so the tip is spendable again.

## [1.2.179] - 2026-08-11

### Fixed
- **Ghost send hid collectables.** Delayed-broadcast 404 txids marked tips “sent” and blocked re-import for 24h. Refresh now heals hide + import marks when the spend txid is proven absent on-chain, so missing NFTs that never left the address come back.

## [1.2.178] - 2026-08-11

### Added
- **Add friend by $handle.** Friends → Add accepts `$handle` / `@handle` / bare handle (and peerpay URIs); resolves via BRC-CLOUD to an identity key and defaults the label to `$handle`.

## [1.2.177] - 2026-08-11

### Fixed
- **Mobile soft-latch ghost txids (WoC/Bitails 404).** `signAction` had been set to delayed broadcast for speed; the phone returned a txid without a successful network post. Soft-latch now sync-broadcasts and confirms via `postBeef` before success. PostBeef soft timeouts raised again so large ordinal BEEFs are not raced out.

## [1.2.176] - 2026-08-11

### Fixed
- **Collectable send “unlockingScriptLength must be at least one valid value”.** Soft-latch inputs always need `unlockingScriptLength` for the toolbox; the 1.2.175 omit-for-speed experiment is reverted. Other send speedups (no lineage hydrate, Bitails-first postBeef, deferred Argon2) stay.

## [1.2.175] - 2026-08-11

### Fixed
- **Faster soft-latch sign / broadcast.** Skip tip→origin lineage hydrate on the send hot path (it was burning seconds then omitting). Plain P2PKH tips no longer force the signable→signAction round trip. Bitails-first postBeef with tighter soft timeouts. Defer post-spend BRC-39 Argon2 so encrypt does not freeze the UI right after send.

## [1.2.174] - 2026-08-11

### Fixed
- **Outbound collectable send no longer toasts "Item received" / verified.** Soft-latch files the recipient tip in the sender's `1sat` basket for remittance; after send the live address scan was cleared so ownership fate skipped and that tip painted as a receive. Outbound tips are now marked sent immediately, and basket rows that pay someone else are dropped even before the address scan returns.

## [1.2.173] - 2026-08-11

### Fixed
- **History push fail-closed on thin overwrite** — auto BRC-39 upload refuses when local managed spendable is below the remote header / durable high-water unless `actionCount` proves UTXOs were spent. Cloud stores `X-HandCash-Spendable-Sats` + `X-HandCash-Action-Count`. Manual Settings upload remains an explicit force.

## [1.2.172] - 2026-08-11

### Fixed

- **History recovery:** one-time previous-password field when the cloud blob is still legacy password-encrypted.

## [1.2.171] - 2026-08-11

### Changed

- **History backups (BRC-39):** sealed to the wallet root key, not the unlock
  password. Restore history needs no second password. Legacy password blobs
  still decrypt once, then re-upload as root-key.

## [1.2.170] - 2026-08-11

### Fixed

- **History replace:** recovery / Settings “Replace from cloud” wipes this
  wallet’s toolbox IndexedDB then pulls BRC-39 into a clean localState — fixes
  under-restored UTXOs when soft-latch dust raced a merge pull.

## [1.2.169] - 2026-08-11

### Added

- **Restore → history gate:** after keys are sealed, prompt to restore the
  encrypted history backup (balance, activity, friends, connected apps) before
  opening the wallet. Skip remains available for chain-only.

## [1.2.168] - 2026-08-11

### Fixed

- **Restore:** skip the post-create “recommended setup” panel; apply default
  history URL and recompose so balance + TX history pull from BRC-39.
- **History pull:** empty-local BRC-39 recovery is no longer blocked by the
  backup push watchdog; soft-latch dust alone no longer counts as “has history.”

## [1.2.167] - 2026-08-11

### Added

- **Restore → Cloud:** new-device setup can retrieve HandCash / Haste trustholder
  slices (in-app OTP) plus optional offline slice — any two restore the wallet.

### Changed

- **Use on another device:** points new installs at Restore → Cloud for trustholder
  recovery.

## [1.2.166] - 2026-08-11

### Changed

- **Cloud key backup:** email registration stays in the wallet OTP prompt — no
  portal browser redirect. First deposit auto-enrolls the email with the provider.

## [1.2.165] - 2026-08-11

### Changed

- **Cloud key backup:** each trustholder is independent — deposit HandCash or Haste
  one at a time. Recommend two providers + offline slice; no coupled “both at once”
  button. Shared 2-of-3 share plan persists across enrollments.

## [1.2.164] - 2026-08-11

### Added

- **Cloud key backup:** register gate opens the trustholder portal (`openExternal`,
  email prefilled); OTP continue after portal registration; settings back-stack so
  Keys → Cloud backup → History navigates correctly.

### Changed

- **Settings Security:** Cloud key backup listed first (before Key slices).
- **Key slices / Device handoff:** cloud backup is the primary recovery CTA.

### Fixed

- Trustholder deposit no longer falls through to silent `dev-token` when email-OTP
  fails for a registered path.

## [1.2.163] - 2026-08-11

### Fixed

- **Release CI:** TypeScript errors that blocked Mac/Windows/Linux installer
  builds since 1.2.159 (unused imports, provisional inscription shape,
  service-order nullability).

## [1.2.162] - 2026-08-11

### Changed

- **Collect tokens:** one-row horizontal carousel (icon + ticker + amount) above items.

## [1.2.161] - 2026-08-11

### Fixed

- **Tokens stay loaded:** BSV-21 list uses a durable cache (like NFTs), 20s
  `listOutputs` timeout + in-flight coalesce, and keeps the last paint on
  lock / transient failures instead of wiping Collect.
- **Token re-import loop:** successful `bsv21` internalization marks outpoints
  so chain polls do not re-BEEF the same tips every tick.
- **Post-ingest token paint:** refresh + early import paths call `listFungibles`
  off the critical path (parallel with collectables).
- **Empty-wallet check:** toolbox emptiness includes basket `bsv21`.

### Changed

- **Coordinator:** per-region serial queues (chain / spend / history / recompose)
  so a waiting backup no longer blocks a queued send behind one shared FIFO.
  Machine guards still forbid unsafe overlaps.

## [1.2.160] - 2026-08-11

### Fixed

- **Handle send:** `$handle` recipients resolve through BRC-CLOUD before payment
  (no more “Invalid recipient address…” when the to-field still holds a handle).
- **Stale claim cache:** `getClaimedCloudHandle` re-checks the registry and clears
  local “claimed” state when the handle was wiped, so /claim-handle can remint.

## [1.2.159] - 2026-08-11

### Fixed

- **Collectable receive:** latch-proven tips paint immediately (quick ingest) with
  the corner loading circle while BRC-150 verifies in the background — no more
  hiding the NFT behind “Item arriving” until lineage settles.
- **Sync pill:** network refresh timeouts no longer show “Sync failed”; soft
  “Network slow” while local balance stays usable.
- **Handle claim errors:** clearer `invalid-ticket` copy when market and
  BRC-CLOUD secrets diverge.

### Changed

- **SPV-forward providers:** prefer Bitails / JungleBus / CoinGecko ahead of
  WhatsOnChain for raw tx, merkle proofs, address UTXO scan, tip headers, and FX
  so chain work is less dependent on a single WoC rate budget.

## [1.2.158] - 2026-08-11

### Fixed

- **Side column layout:** restore direct-child flex for Recent activity /
  What is BSV (1.2.157 keep-mounted wrapper broke overflow/hidden text).
- **Sync forever:** 45s syncing watchdog; poll retries soon after yielding to a
  send; stuck payment progress clears after 90s.
- **Visibility:** Settings → Statecharts shows a live layers strip (coordinator,
  sync, payment, activity). Syncing pill tooltip includes coordinator summary.

## [1.2.157] - 2026-08-11

### Fixed

- **Send feel:** Review skips toolbox balance when the painted balance already
  covers the amount; raises spend priority otherwise so sync yields. BSV send
  leaves “Waiting to send” as soon as the spend region is held.
- **Activity after send:** keep the feed mounted during Working, bust feed cache
  on every activity write, and record collectable sends as soon as the txid
  exists. Chain ingest no longer awaits `listCollectables` on the coordinator
  path (background paint instead).

## [1.2.156] - 2026-08-11

### Fixed

- **Send collectable toasts:** outbound soft-latch tips no longer toast
  “Item received” / “Authenticity verified” on the sender. Foreign locks are
  ghost-dropped immediately; self-receive still announces correctly.
- **Identity handle:** show claimed `$handle` on the Identity page (or a claim
  CTA); shorten the identity-key note and QR copy hint.

## [1.2.155] - 2026-08-11

### Fixed

- **Handle claim:** `claimCloudHandle` requires a HandCash `claimTicket` from
  items-market (Auth0 + `$alias` ownership) before minting on BRC-CLOUD.

## [1.2.154] - 2026-08-11

### Fixed

- **Activity token icons:** resolve icons from the icon inscription outpoint (and
  held fungibles), not the token id — mint/send/receive rows show the ticker
  image instead of the generic collectable glyph.
- **Activity token context:** show quantity with distinct Minted / Sent /
  Received titles, a mint badge, and amount-column `±qty`; identity mint and
  transfers record `amt`/`dec`/`icon` on the activity item.

## [1.2.153] - 2026-08-11

### Fixed

- **Mint hang / indexer outage:** bound `getBeefForTxid` and hydrate with
  timeouts; prefer local storage proofs; short-circuit when the caller's deploy
  AtomicBEEF is already broadcast-safe. Identity mint uses
  `acceptDelayedBroadcast` so WoC/Chaintracks downtime cannot surface as
  "merged Beef failed validation" on an otherwise valid BEEF.

## [1.2.152] - 2026-08-11

### Fixed

- **Mint `merged Beef failed validation`:** stop patching missing parents as
  `txidOnly`. Those stubs block toolbox broadcast hydration and fail
  `processAction` verify (no `allowTxidOnly`). Hydrate parents with full proof
  BEEF instead so tip raw bodies remain for `sourceTransaction` and broadcast
  verify passes.

## [1.2.151] - 2026-08-11

### Fixed

- **Mint `sourceTransaction`:** stop omitting tip `inputBEEF` when parents are
  missing. Tip-only / AtomicBEEF wraps are kept (raw tip bodies are required for
  signable inputs) and missing parents are patched as `txidOnly` so
  `trustSelf:'known'` still verifies — fixes "Every signableTransaction input
  must have a sourceTransaction" from the 1.2.150 omit path.
- **Permission vs sync:** while a connect/pay prompt is open, raise spend
  priority so BRC-39 history upload yields the wallet FIFO instead of gating
  Approve behind encrypt.

## [1.2.150] - 2026-08-11

### Fixed

- **Mint `inputBEEF` / trustSelf:** never attach an AtomicBEEF or tip-only wrap
  that fails `verifyValid(true)`. That was surfacing as "The inputBEEF parameter
  must be valid Beef when factoring options.trustSelf". Prefer a verifiable BEEF,
  otherwise omit and rely on `trustSelf:'known'` + `knownTxids` for tips already
  in wallet storage.

## [1.2.149] - 2026-08-11

### Fixed

- **Stale UI on mint (`sourceTransaction` / 400):** reclaim `:5173` and bind
  `::1` so Chromium cannot keep loading an old Vite / `/Applications` HandCash
  while a newer build is running (logs showed renderer v1.2.144 vs main 1.2.148).
- **Unlock freezes permission prompts:** unlock/create no longer encrypt+upload
  the ~26MB BRC-39 on the hot path; push is deferred ~60s and skipped while a
  permission prompt is pending.
- **Auth mint known tips:** identity-mint `createAction` now passes `knownTxids`
  (collectables pattern) with `trustSelf: 'known'`.

## [1.2.148] - 2026-08-11

### Fixed

- **Mint `sourceTransaction` again:** identity-mint enrich no longer swallows
  inputBEEF failures (which left tip spends unproven). Caller deploy BEEF is
  merged with cache/indexer/raw-tx fallbacks, and finished signables always
  cache the new tip for the follow-up mint.

## [1.2.147] - 2026-08-11

### Fixed

- **Auth tip CHECKSIG fail on mint:** finishing identity-mint signables now
  sighashes the full inscription‖P2PKH‖Sigma locking script (not plain P2PKH).
  Matches the on-chain auth tip scriptCode so remints unlock cleanly.

## [1.2.146] - 2026-08-11

### Fixed

- **Mint approved but no txid:** auth tip / Sigma fund inputs use
  `unlockingScriptLength`, so createAction returned a signable without a txid.
  Identity mints now complete with root-key P2PKH `signAction` (same pattern as
  soft-latch collectables) before responding to the app.

## [1.2.145] - 2026-08-11

### Fixed

- **Auth mint `sourceTransaction`:** BSV-21 remints now attach `inputBEEF` for
  auth tip (and Sigma fund) inputs; deploy createAction txs are cached so the
  follow-up mint can prove the tip immediately.
- **Token receives missing from Activity:** newly imported BSV-21 tips write a
  Received row; identity mints log as token activity (not a 1-sat payment spend).

### Changed

- **Fungible remints:** identity issuance enrich covers `deploy+auth` / `mint`;
  Collect aggregates primarily by token id (issuer+ticker merge remains for
  legacy sibling deploy+mints).

## [1.2.144] - 2026-08-11

### Fixed

- **Working / Starting… stuck after mint:** approving View items no longer
  starts the payment progress panel (only createAction / signAction do).
- **Token list:** tips that share the same issuer + ticker are one Collect
  row with a summed balance (separate deploy ids still track underneath).

## [1.2.143] - 2026-08-11

### Fixed

- **Pay hang on "Preparing payment":** BRC-39 auto-backup no longer holds the
  wallet lock through Argon2 encrypt + upload (~26MB). Snapshot export stays
  exclusive; encrypt/upload run unlocked. Post-spend backup defers while a
  send is queued, and historyReplica yields the FIFO when spend priority is
  raised. Identity-mint inputBEEF times out at 8s if the indexer is down.

## [1.2.142] - 2026-08-10

### Changed

- **Spends trust local wallet state:** no chain/address heal before send or
  BRC `createAction`. Refresh stays a Dashboard concern.
- **Identity mint permission:** BSV-21 deploy+mint prompts as **Mint token** /
  Identity mint (Sigma-backed), never Auto-pay or generic payment.

## [1.2.141] - 2026-08-10

### Changed

- **BSV-21 ticker icons are P2P-local:** mint caches inscription bytes; Collect
  resolves icons from durable cache / BEEF (no Gorilla content URL). Hash
  identicon when bytes are missing. Aligns with BRC-163 Icon media.

## [1.2.140] - 2026-08-10

### Fixed

- **Typecheck:** Dashboard processing copy only reads `title` from action prompts.

## [1.2.139] - 2026-08-10

### Fixed

- **Token icons** no longer stick on a blank loader — hash identicon shows
  immediately; on-chain `icon` overlays only after it loads (Panda `display`
  was overriding HTML `hidden` on Avatar.Image).
- **Activity history merge** keeps both send and receive rows for the same
  txid (keyed by txid+kind). Wallet coin rows title as Sent/Received coins;
  Activity filter includes **Wallet coins**.

### Changed

- **Sequential approvals:** skip pre-prompt chain heal for interactive pays
  (auto-pay still heals first); right column shows Working while broadcasting.

## [1.2.138] - 2026-08-10

### Changed

- **Desktop approvals** fill the reserved right column (replace market + recent
  activity) with scroll body and pinned Deny/Approve. Locked-wallet prompts stay
  centered modals.
- **Permission listeners** support multiple UI surfaces so prompts no longer
  vanish after lock/unlock.

### Added

- **Activity events** for non-tx actions: connect/deny/approve/decline,
  disconnect, and add friend. Unlinking an app no longer wipes that app's
  history. Filter chip: Actions.

### Fixed

- **BSV-21 Sigma fund** — any spendable default UTXO can bind issuer Sigma
  (not only ≥1000 sats).

## [1.2.137] - 2026-08-10

### Added

- **BSV-21 issuer binding.** Deploy+mint via BRC-100 is Sigma-signed with the
  wallet identity key (1Sat-compatible). CI/tag `issuer:` mirror the pubkey.
  Collect → Tokens shows issuer + token id (not symbol alone).

## [1.2.136] - 2026-08-10

### Changed

- **BSV-21 tags:** token id is `bsv21:<tokenId>`, not `id:<…>`. Tag prefix `id:`
  is reserved for per-output identity. Readers still accept legacy `id:` tags.

## [1.2.135] - 2026-08-10

### Fixed

- **Collect → Tokens empty after self-mint.** `deploy+mint` tips have no `id` in
  remittance — the tip outpoint *is* the token id. Listing no longer drops them.

## [1.2.134] - 2026-08-10

### Fixed

- **Release build** — `dialog.showSaveDialog` when no BrowserWindow is focused
  (Electron types reject `undefined` parent).

## [1.2.133] - 2026-08-10

### Fixed

- **Release build TypeScript** — narrow `saveImageFile` result before reading
  `canceled` so `tsc --noEmit` passes in CI.

### Added (from 1.2.132)

- Collect → Tokens (BSV-21) + optional cosigner tip kind.

## [1.2.132] - 2026-08-10

### Added

- **Collect → Tokens (BSV-21).** Fungible tips in basket `bsv21` (not Pay / not
  `1sat`). Import from legacy address scan, list/aggregate by token id, details
  panel. Holders verify their tips; issuer mint policy is trusted.
- **Optional cosigner tip kind.** Detect MNEE-shaped cosign locks and remittance
  (`cosign` in customInstructions / tags). Cosigned tips refuse a plain spend
  until a cosigner client is configured (`cosigner_required`).

## [1.2.131] - 2026-08-08

### Added

- **Copy image / Save image** on collectable details. Desktop copies to the
  clipboard or a save dialog; mobile uses the share sheet when the WebView
  cannot download directly.

## [1.2.130] - 2026-08-08

### Fixed

- **BRC-150 trusted spend path instead of FIFO sat mapping.** Verifiers now
  require the parent 1-sat vin to be the input whose sats land on the claimed
  vout. Preceding input sources (funding before the ordinal vin) must be in the
  remittance BEEF — fail closed if missing. AtomicBEEF is no longer preferred
  when it would drop those sources.

## [1.2.129] - 2026-08-08

### Fixed

- **Self-send “Item received” toast before the card is in inventory.** Receive
  toast / chime / OS banner now fire only when the tip paints in the collectables
  list, not when ingest first sees it on the address.

## [1.2.128] - 2026-08-08

### Fixed

- **“Waiting to send the collectable” hung on a full address rescan.** The tip
  is already in the basket; send no longer heals via WhatsOnChain (7s timeout
  when it is down). Background ingest aborts when a send is queued, and WoC is
  skipped for 45s after a failure.

## [1.2.127] - 2026-08-08

### Fixed

- **BRC-150-verified tips still refused as unrecognized.** Missing locking
  script (`listOutputs` / scriptOffset) no longer blocks send when authenticity
  is already BRC-150. Covenant tips still refuse. Send log is `[collectables]`,
  not leftover `[brc-156]`.

## [1.2.126] - 2026-08-07

### Fixed

- **Send still refused as unrecognized on 1.2.125.** `listOutputs` often
  returns no locking script (toolbox skips `scriptOffset === 0`). Soft-latch
  now recovers the tip script from the tip BEEF before classifying.

## [1.2.125] - 2026-08-07

### Fixed

- **“Collectable locking script is unrecognized” on soft ordinals.** Tip
  classification now normalizes hex (`0x` / SDK `toHex()`), and treats any
  spendable P2PKH branch (bare or inscribed) as soft-latch — not unknown /
  covenant.

### Changed

- Nav label **Apps → Connect**; panel heading **Connected apps**.

## [1.2.124] - 2026-08-07

### Fixed

- **Desktop CI release for v1.2.123.** Tag fired before `@zxing/library` was in
  the lockfile (`npm ci` failed). Retag with synced lock.

## [1.2.123] - 2026-08-07

### Changed

- **Removed hardened BRC-156 Commit/Settle** (scrypt covenant, ~14k LOC). Soft-latch
  + BRC-150 remain. Stuck covenant tips show **Remove from wallet** (local abandon;
  sat stays locked on chain — covenant cannot soft-exit or burn via hashOutputs).

## [1.2.122] - 2026-08-07

### Changed

- **BRC-150 remittance is append-first.** Soft sends reuse or extend a prior
  verified package (prepend tip + merge tip tx) before any lineage hydrate;
  post-send tip-named proofs are remembered for the next hop. BRC-150 updated
  for parent remittance inherit + sender extend.

## [1.2.121] - 2026-08-07

### Fixed

- **Activity thumb empty square while scrolling.** DeferredImage was clearing
  `src` on scroll-away while status stayed ready, so a blank `<img>` flashed.
  List thumbs now keep the decoded src once shown; paint never shows an img
  without a src.

## [1.2.120] - 2026-08-07

### Fixed

- **Covenant tips stuck with "BRC-156 not enabled".** Soft tips still soft-latch
  (hardened genesis remains off). Tips already on a hardened covenant can
  Commit/Settle resend again — soft-latch cannot unlock them.

## [1.2.119] - 2026-08-07

### Changed

- **Collectables authenticity is BRC-150 only.** Soft-latch remains the send
  mechanism; remittance verify accepts parent-tip proofs so receivers skip
  lineage walks. UI maps legacy BRC-156 pins to Verified · BRC-150. Background
  walks stamp BRC-150 for all tips; session lineage budget raised to 8.

## [1.2.118] - 2026-08-07

### Changed

- **Wallet sends use soft-latch / BRC-150 only.** Hardened BRC-156 Commit/Settle
  is disabled for live sends (covenant embeds made fees scale with prior settle
  size). Receive still verifies hardened tips from others. Protocol code and
  tests remain; `isHardenedSendEnabled()` is false.

## [1.2.117] - 2026-08-07

### Fixed

- **Hardened send false "insufficient funds".** Aborted Commit/Settle left tip and
  funding change reserved as noSend, so settle saw only a fraction of the balance.
  Release is now an explicit stage (abort refs → wipe nosends → assert clean) on
  preflight and failure. Unlock fee declaration no longer applies a 1.35× / 20k
  double-pad on top of embedded parent txs.
- **Authenticity badge flip-flop (Unverified ↔ BRC-150).** List UI was painting
  raw verify misses over durable proven tiers. Badge now only follows provenCache.

## [1.2.116] - 2026-08-07

### Fixed

- **Hardened tips still landing as BRC-150.** Background lineage walks stamped
  durable BRC-150 after settle before (or instead of) BRC-156, then never
  upgraded. Stamp BRC-156 immediately after Commit/Settle broadcast, refuse to
  walk/stamp hardened tips as BRC-150, and re-run the covenant ladder when a tip
  is stuck on BRC-150 so it can upgrade.

## [1.2.115] - 2026-08-07

### Fixed

- **Self-pay missing from Activity.** A send to your own address shares one txid;
  the receive was skipped because that txid was already logged as the send. Now
  send/receive dedupe by kind so both rows appear.
- **Activity thumbnails pop in while scrolling.** Prefetch ~one viewport ahead
  so the next rows arrive decoded instead of as skeletons.

## [1.2.114] - 2026-08-07

### Fixed

- **Hardened tips stuck on BRC-150.** After a successful Commit/Settle broadcast,
  authenticity verify raced chain indexing for the Commit, failed BRC-156, then
  stamped durable BRC-150 and never upgraded. Remember local BEEF, prefer Commit
  from settle parents, retry brief chain lag, allow 150→156 upgrade on hardened
  tips, and do not demote hardened tips to BRC-150 while covenant proof is pending.

## [1.2.113] - 2026-08-07

### Fixed

- **Settle "input was not reserved by this action batch".** Delayed-proof UTXOs
  already present in settle `inputBEEF` were skipped for batch reservation, then
  rejected at commit. Always extend-reserve explicit inputs not yet in batch
  state. Also removes the item-details loading spinner chrome.

## [1.2.112] - 2026-08-07

### Fixed

- **Settle "wallet storage was busy".** Settle `signAction` no longer sync-broadcasts
  (that path AbortError'd on Android). Signs with delayed broadcast, then
  `postBeef` Commit+Settle. StorageIdb no longer masks the real IDB error as
  `AbortError` when a transaction aborts.

## [1.2.111] - 2026-08-07

### Fixed

- **Missing BRC-150/156 traits.** Remittance/OP_RETURN `mimeType` alone no longer
  counts as a rich resolution — cards stay upgradeable until GorillaPool returns
  collection traits (Pixel Fox eyes/background/etc.).
- **Spurious "Item received · verified" on unlock.** Receive announces are
  durable across sessions; already-proven pending rediscoveries are skipped.
- **Settle AbortError.** Unlock vs `signAction` retried separately with a short
  pause and clearer step logs.

## [1.2.110] - 2026-08-07

### Fixed

- **Settle AbortError.** Pause the toolbox monitor during hardened Commit/Settle
  and retry covenant `signAction` once on IndexedDB `AbortError` (was failing
  mid-settleSign with a bare "AbortError" toast).
- **Auto support logs.** With an upload URL set, logs ship every ~45s, on
  backgrounding, and immediately after a send failure — no Settings tap needed.

## [1.2.109] - 2026-08-07

### Fixed

- **Hardened settle BEEF.** Settle no longer chain-fetches the unbroadcast
  `noSend` commit (orphan local txids like `996bf929…` 404'd and broke retries).
  Merge signed commit AtomicBEEF + tip/proof; refetch delayed proof only.
- **Stuck noSend cleanup.** Abort held settle/commit refs (settle first), then
  `listNoSendActions(abort)` before each hardened send and after failure — frees
  tip/funding locked by a prior abort / mid-flight kill.
- **Send failures log.** `failSend` and hardened catch `console.error` so remote
  support uploads capture the real abort / sourceTransaction message.

## [1.2.108] - 2026-08-07

### Fixed

- **Hardened resend refuse.** Delayed proof now resolves from remittance
  `proofOutpoint`, remittance `commitTxid_1`, and the tip settle OP_RETURN — not
  only customInstructions. Refuse reasons are logged (`send path=refuse reason=`).

### Changed

- **Wallet-wide explicit paths.** Soft-latch and BSV sends use
  `softLatchSendMachine` / `bsvSendMachine`. Cursor rule
  `explicit-wallet-paths.mdc` — no silent fallthrough.

## [1.2.107] - 2026-08-07

### Changed

- **Explicit collectable send paths.** `chooseSendPath` + `collectableSendMachine`
  classify tip kind → hardenedGenesis | hardenedResend | softLatch | refuse.
  Covenant tips can no longer fall through to soft-latch. Delayed proof comes
  only from remittance / covenant link / OP_RETURN (`DelayedProofSource`).
- **Ownership fate classifier.** Address-scan ghosting only `ghostDrop`s soft
  P2PKH tips; covenant / brc156 stay via `keepCovenant`.
- **hardenedSendMachine is phase-driven** (`advanceHardened` asserts each step).

## [1.2.106] - 2026-08-07

### Fixed

- **Hardened resend proof outpoint.** Prefer tip remittance / covenant
  `linkOutpoint` over the latch-basket row (beacons and stale soft-latches were
  fed in as the delayed proof → `sourceTransaction` / missing-txid failures).
- **No soft-latch fallback for covenant tips.** P2PKH unlock cannot spend them;
  falling through emptied inventory while the tip stayed unspent on chain.
- **Covenant tips survive address-scan ghosting.** BRC-156 tips never sit on the
  P2PKH UTXO set; list no longer relinquished them after settle grace.

### Changed

- **Log upload URL auto-provisions** a BRC-CLOUD `hc-*` bucket on first use so
  crash uploads always have a sink. Agents: see `.cursor/rules/remote-support-logs.mdc`.

## [1.2.105] - 2026-08-07

### Fixed

- **Item details loading.** Replaced skeleton blocks with the same circular
  spinner used elsewhere; cache hits paint immediately (no flash).
- **Stuck Verifying · BRC-150.** Progress walks no longer pin tips into the
  receive-awaiting set; aborted walks no longer burn the session budget; opening
  details finishes the preferred tip; proven tips clear stale spinners; empty
  traits re-fetch via origin on details open.

## [1.2.104] - 2026-08-07

### Fixed

- **CI typecheck:** `hasProvenTier` import typo that blocked Mac/Win/Linux builds.

## [1.2.103] - 2026-08-07

### Fixed

- **Hardened settle unlock budget.** `unlockingScriptLength` undersized settle
  embeds (state + tip scripts + framing), so signAction rejected spends with
  `unlockingScript length … exceeds expected length`. Estimate now includes
  extras, pads aggressively, and floors at 48k bytes.
- **BRC-150 badges survive restart.** List cache no longer paints Unverified
  over a durable `proven.v2` hit; proven tiers are monotonic (never downgraded
  to unproven); detail verify no longer short-circuits on sticky unproven misses;
  empty Electron durable keys read as absent.

### Changed

- **Authenticity + hardened send are XState machines** (`authenticityMachine`,
  `hardenedSendMachine`) with Mermaid charts under Settings → Statecharts.

## [1.2.102] - 2026-08-07

### Fixed

- **Hardened BRC-156 sends in the browser bundle.** Vite was stubbing Node
  `events` as `{ default: {} }`, so scrypt-ts `Provider extends EventEmitter`
  threw `Class extends value #<Object>` and every identity-key send fell through
  to soft-latch. Alias the real `events` (+ `buffer`) packages in Vite.
- **Sending stays visible while a transfer runs in the background.** The status
  pill prefers payment progress over Syncing / sync errors, progress starts
  before the spend queue waits, and the in-flight collectable shows a Sending
  badge on inventory and details.
- **Sends waiting on sync get priority.** In-flight chain ingest yields ordinal
  work so a queued send can begin sooner.

## [1.2.101] - 2026-08-07

### Fixed

- **BRC-156 hardened sends survive the WebView.** Full `process` shim
  (`cwd` / `version` / `nextTick`) plus a classic `index.html` bootstrap so
  scrypt-ts no longer throws into soft-latch / BRC-150 on mobile.
- **Verified BRC-150 items get traits.** Remittance-proven and soft-latch
  rebuild paths adopt the origin and fetch indexer metadata instead of leaving
  empty traits.
- **Permission Accept shows a toast.** Connect/action approval surfaces
  Connected / Approved feedback.
- **BRC-100 connect bring-to-front is more reliable** on Android
  (`AppTask.moveToFront` + retries).

### Changed

- **Permission and payment screens are tighter** — less copy, denser layout.
- **Status pill Syncing text is larger.**

## [1.2.100] - 2026-08-06

### Fixed

- **Desktop installer CI builds again.** A duplicate `toUnderscoreOutpoint`
  import broke `tsc` on Mac/Windows/Linux release jobs.
- **Item received toasts when the tip first paints**, not after media resolve —
  inventory arrivals and latch-proven tips announce immediately.
- **Hardened BRC-156 sends in the WebView.** scrypt-ts still needs Node `Buffer`
  at sign time; polyfill it (and `process.env`) so mobile no longer falls through
  to soft-latch / BRC-150.

## [1.2.99] - 2026-08-06

### Fixed

- **Item received toasts immediately**, and the corner spinner stays until
  authenticity settles — no gap between spinner and verified, and receive is
  not delayed behind the verify walk.
- **Status pill typography is consistent** and tap-to-refresh stays a button
  while unlocked (no more swapping to a non-clickable pill).

## [1.2.98] - 2026-08-06

### Fixed

- **Item toasts fire on receive and again on verify.** Latch-proven tips no
  longer wait for authenticity before "Item received"; settling proof then
  shows "Item verified".
- **Hardened collectable sends no longer fall through to soft-latch in the
  WebView.** Covenant code used Node `Buffer` and residual `process.env`, which
  threw and aborted the hardened path.

## [1.2.97] - 2026-08-06

### Fixed

- **Status pill stays short while syncing.** Phased labels like "Syncing payments"
  overflowed the bubble; the pill shows Syncing… again and puts detail in the
  tooltip.
- **Verifying on Items and Activity is a tiny corner mark** — spinner, then check,
  then gone — instead of a "Verifying…" text pill that ate the row.

## [1.2.96] - 2026-08-06

### Fixed

- **A self-sent tip no longer vanishes from inventory.** The ownership filter
  treated a lagging address scan as proof the tip was spent, so a tip that
  landed in the basket and then missed the next scan was relinquished as a
  ghost. Tips stay unjudged for a settle grace window even when the scan is
  newer, so indexer delay cannot wipe a fresh self-send.
- **Hardened collectable sends work in the browser again.** scrypt-ts reads
  `process.env.NETWORK` / `BASEURL` at call time; without a Vite shim that threw
  `process is not defined` and every send fell back to soft-latch.

### Changed

- **On mobile, a BRC-100 permission request occupies Activity** and replaces the
  bottom nav with Decline / Accept, instead of a modal over the wallet.

## [1.2.95] - 2026-08-06

### Fixed

- **A verified collectable no longer shows a truncated origin and empty traits
  while its image already paints.** The content URL is built from the proven
  origin, so the PNG loads even when the tip is still unindexed. Name and traits
  were still asked of the tip itself — which 404s for hours after a transfer —
  so the card kept `4ee07451…_33` as its title. Metadata lookup now asks the
  known origin first, and proven-but-thin cards retry on the pending cadence
  instead of waiting ten minutes.

## [1.2.94] - 2026-08-06

### Fixed

- **A collectable no longer arrives unverified with no traits.** The sender was
  dropping BRC-150 provenance whenever the BEEF it held for a mined tip stopped at
  that transaction — there was no ancestry left to derive a path from, so the item
  went out with nothing to prove it and landed as "Unverified". The send now
  hydrates the tip's lineage from chain data before giving up, and puts the whole
  assembled BEEF on the wire instead of the atomic form, which discarded the very
  ancestry the receiver has to walk.
- **A card that arrives with a proven origin but no traits now asks the indexer
  again.** An empty-traits cache entry counted as an answer and blocked the upgrade
  pass, so a name and image that were merely late never arrived at all.
- **A lineage walk gives up the moment somebody opens the panel.** Yielding between
  fetches was not enough, because merkle verification in between is synchronous
  work; the walk now checks for a waiting basket read at every hop.
- **A transient network miss no longer costs a full day of "Unverified".** The 24h
  lineage retry budget is spent only on a conclusive result.
- **Multi-minute "main thread blocked" warnings are gone.** Android freezes a
  backgrounded WebView's timers, and the first tick after resuming reported the
  whole time away as a stall — burying the real jank in eight-minute phantoms.

## [1.2.93] - 2026-08-06

### Fixed

- **A latch-proven collectable no longer sits in "Item arriving" forever when the
  indexer cannot name it.** Ingest already knew the tip had landed (its soft latch
  is local proof), but without an indexer origin it held the output out of
  Collectables and retried every 8s. It now walks the tip's own ancestry from
  chain BEEF as a last resort, pins BRC-150 with a proven origin, and lets the
  card fill in once an indexer is reachable again.
- **Lineage walks no longer starve the basket read.** A hop yields to the UI, and
  a walk backs off when a newer `listOutputs` is in flight — the path that was
  timing out the Collect panel while proofs ran in the background.
- **The "holding, awaiting origin" log no longer floods every poll.** The same
  waiting tip may repeat that line at most once a minute.

## [1.2.92] - 2026-08-06

### Fixed

- **The sending wallet's record of a transferred collectable stayed broken.** Once
  a tip is sent on it leaves the basket, and its cached identity was too thin to
  repair the row, so the transfer that sent the item away — the only trace of it
  left in this wallet — kept the wrong origin and a 404 thumbnail. Records now heal
  from the lineage verdict, which outlives the output it judged, and tips that
  survive only in the activity feed get their own lineage walk: being spent does
  not make chain data unprovable.

## [1.2.91] - 2026-08-06

### Fixed

- **A received collectable could vanish from the inventory once its lineage was
  proven.** Two listed tips sharing an origin are deduplicated to one card, and the
  survivor was picked by whichever row carried richer metadata. That was harmless
  while every mis-resolved tip claimed itself as its own origin, and wrong the
  moment proofs gave both the same correct origin: a transfer that had just landed
  lost to stale basket residue. The tip seen most recently now wins, since a
  satoshi cannot sit in two outputs. Nothing was ever spent or relinquished — the
  item was only hidden from the list.
- **The top activity row no longer blinks on every visit.** Deferred images reset
  to a skeleton on mount, so a remote ordinal thumbnail flashed while rows painting
  a bundled asset did not. URLs already decoded this session paint straight from
  cache.
- **Adopting a proven origin no longer empties the card.** The indexer is asked
  about the origin just proven, instead of blanking the name and traits until the
  upgrade pass happened to run.

### Added

- **The induction hop can now earn BRC-156.** A first hardened transfer settles
  over its Commit token alone, so the alternating-proof triangle cannot apply and
  it scored 150. It is now verified in its own right — covenant tip, Commit link,
  beacon to the recipient — and bound to a real ordinal by proving the lineage of
  the tip it inducted, since covenant continuity can only carry forward what
  induction established.
- Sends log which rung they took (`hardened send: genesis induction` or
  `soft-latch send:` with the reason).

## [1.2.90] - 2026-08-06

### Added

- **Collectables earn BRC-150 by proving their own lineage.** An ordinal imported
  from an indexer arrives with no remittance, so it could never be verified — and
  because hardened induction refuses an unproven tip, it could never climb to
  BRC-156 either. The wallet now walks such a tip back to its inscription, one
  proven transaction per hop, and verifies the assembled path. Runs behind the
  list, three items per session, never during a spend.

### Fixed

- **A confirmed item could not be proven at all.** AtomicBEEF keeps only the
  subject and its recursive dependencies, and a mined tip carrying its own merkle
  proof depends on nothing — so the BRC-150 rebuild stripped the ancestry it had
  just assembled and then failed to find it. Lineage is now verified from the
  whole BEEF, and the remittance size cap applies only to what actually travels
  in a remittance.
- **Activity rows show the item as it is now, not as it arrived.** Rows froze the
  name, origin and image URL at receive time, so a repaired collectable stayed
  broken in Activity and in transaction details forever.
- **A proven origin outranks a claimed one** wherever an item is painted or sent
  on, so a sender's wrong origin stops propagating.

## [1.2.89] - 2026-08-06

### Fixed

- **Activity no longer flashes the top row on every visit.** Seen tracking keyed
  off the clock-minted row id, so a re-recorded or remounted feed treated yesterday's
  newest entry as an arrival. Rows are now remembered by txid / tip outpoint, and
  the flash only fires for unseen events under ten minutes old.
- **Stuck collectables with a wrong remittance origin heal themselves.** Tips that
  already show a name but have no inscription content are re-walked once per retry
  window; a richer indexer answer replaces the broken image URL.

## [1.2.88] - 2026-08-06

### Fixed

- **Collectable names keep their casing in inventory and on send.** The BSV SDK
  lowercases every output tag, so painting the Collect grid from `name:` tags
  showed "pixel foxes" even when history still had "Pixel Foxes". The list and
  remittance now prefer the resolution cache / tip remittance (which preserve
  case), and imports seed that cache with the proper name.
- **Unindexed 1-sat tips are no longer adopted as their own origin.** GorillaPool
  answers "unknown sat" with a self-referential empty origin; treating that as
  identity left items stuck on a 404 image and handed the same broken claim to
  whoever received them next.

## [1.2.87] - 2026-08-06

### Changed

- **Faster collectable signing.** Tip BEEF, latch discovery, provenance, origin
  script, and settle input BEEF no longer each pay a fresh storage round trip:
  a session BEEF cache dedupes them, fetches run in parallel, settle reuses the
  commit AtomicBEEF, and soft-latch provenance reuses the tip BEEF already in
  hand. Pre-send `listOutputs` is tagged by origin instead of reading the whole
  basket, and confirm-screen warm now compiles the covenant artifact so the
  first unlock does not.

## [1.2.86] - 2026-08-06

### Fixed

- **Activity only flashes a transaction the user has never seen.** The highlight
  was decided from per-mount state, so opening Activity announced whatever was on
  top. Which entries have been shown is now recorded durably; a restored history
  seeds silently.

## [1.2.85] - 2026-08-06

### Fixed

- **Sends no longer stall on the hardened path.** Covenant genesis needs a
  BRC-150-verified tip, and that is now checked before the send fetches the
  origin BEEF or loads the covenant chunk. A hardened attempt that fails before
  anything is broadcast falls back to soft-latch instead of failing the transfer.
- **Sync no longer walks the whole wallet on every pass.** Transaction bodies are
  cached and de-duplicated across ladder steps, hardened induction only runs when
  the settle body is already at hand, indexer misses survive a restart, and one
  pass identifies a bounded number of unknown outputs.
- Bounded the storage provider calls used by sync, so a host that accepts the
  socket and never answers can no longer wedge receiving.

### Changed

- The covenant bridge chunk warms while the confirm screen is open, so a
  hardened send does not pay for loading it.

## [1.2.84] - 2026-08-06

### Added

- **Live hardened BRC-156 send** for identity-key peers: Commit (`noSend`) →
  Settle (`sendWith`) unlocks the clean-room alternating delayed-proof covenant
  against the wallet-built AtomicBEEF txs. Genesis from BRC-150 P2PKH tips and
  covenant re-spends both work. Soft-latch remains the fallback for bare addresses.

### Changed

- Covenant `assertCanonicalTx` allows up to 16 inputs so wallet funding fits.
- Settle hashOutputs includes the 0-sat OP_RETURN latch state.

## [1.2.83] - 2026-08-06

### Fixed

- **Renderer no longer pulls scrypt-ts / node:path.** Hardened receive helpers live
  in browser-safe `oneSatHardenedReceive.ts`; covenant script-exec stays Node-only.
  Unblocks Desktop packaging CI for v1.2.82+.

## [1.2.82] - 2026-08-06

### Added

- **Authenticity ladder** — collectables evaluate BRC-156 hardened → BRC-150 v2 →
  indexer (always `unproven`). Versioned proven cache + UI badge.
- **Complete BRC-150 receive path** — full tip→origin path, AtomicBEEF subject,
  `ord` envelope check; receive can rebuild from wallet BEEF before indexer.
- **Clean-room BRC-156 alternating delayed-proof covenant** (`scrypt-ts`) with
  Tx1→Tx6 script-exec tests and bounded receive verifier. Schema-2 latch state
  uses `proofOutpoint` (not a sliding grandparent window).

### Changed

- Soft-latch remains the **live send** path. Hardened wallet send stays gated
  (`isHardenedSendEnabled() === false`) until the createAction unlock bridge
  lands — no false O(1) hardened-send claim.
- Spec (`docs/bsva/brcs/tokens/0156.md`) documents alternating delayed proofs
  and rejects marker+CHECKSIG / sliding-window forgeries.

## [1.2.81] - 2026-08-06

### Changed

- **Latched 1Sat BRC number is 156** (upstream merge of PR #198), not 154.
  Protocol marker is `BRC156`. Spec: `docs/bsva/brcs/tokens/0156.md`.


## [1.2.80] - 2026-08-06

### Added

- **BRC-156 Phase 1b — on-chain latch state.** Soft-latch Settle now writes tip (1) +
  latch (2-sat P2PKH) + `OP_FALSE OP_RETURN "BRC156" {origin, tip, parentLatch, …}`.
  Receivers name latched items from the settle tx itself — no ordinal indexer and
  no ancestry walk. Spec: `docs/bsva/brcs/tokens/0156.md`.

### Fixed

- **Activity row no longer flashes on tab switch.** The fresh animation only runs
  when a new top entry actually arrives (same moment as payment-received toast).

- **Collectable details open from cache with a skeleton.** Clicking an item no
  longer stalls on a hung `listOutputs`; missing items use a styled empty state.

- **Pending latch tips no longer hammer indexers.** Proven tips retry on a 45s
  window (not every 8s poll), with a bounded input probe. Indexer walk is
  bootstrap-only for unlatched tips.

### Improved

- **Background receive hooks for mobile.** Wallet unlock/lock and receive events
  are dispatched so Android can keep sync alive and post local notifications.


## [1.2.79] - 2026-08-06

### Fixed

- **Sent direction badge fits its circle.** The overlaid send arrow is 75% of
  its previous size; the badge and receive icon remain unchanged.

## [1.2.78] - 2026-08-06

### Improved

- **Faster ordinal receive when an item is already known to have landed.** While
  latch-proven tips wait on the indexer, chain polls run every 8s instead of
  30s. Transient BEEF/import failures retry after 45s (was 5 minutes). Latch
  tips no longer write the 10-minute dust miss backoff.

- **Chat matches Aeon chrome.** Messages use flat tokenized surfaces, compact
  geometry, and Aeon-style tabs/composer instead of the old Nexus gradient skin.

- **New chat messages and activity rows stay in view.** Threads stick to the
  bottom when you are already there; the activity feed pins and briefly flashes
  newest rows when you are at the default top scroll.

- **Clearer status pill.** “Chain failed” is now **Sync failed** (balance may be
  stale; coins/keys are fine). Cloud history errors say **Backup failed**.

## [1.2.77] - 2026-08-06

### Fixed

- **Inbound tip/pay cards are claims, not confirmed receipts.** Messagebox
  tip cards no longer show as “Received”; they mark **Claimed · unverified**
  until chain verification exists. Attachment links must come from the
  messagebox host. Tip binding now stores `boundMessageId`, and delivery
  failures after an on-chain tip surface a hint.

## [1.2.76] - 2026-08-06

### Added

- **Chat file transfer.** Attach a file (up to 8 MB) in a thread; it uploads to
  the messagebox and lands as a downloadable card for the recipient. Shared
  files also appear under the Files tab.

### Improved

- **Chat bubbles and tip cards.** Sent and received bubbles are more distinct;
  tips use their own gold-accented card with sat and fiat amounts instead of a
  generic Pay label. Sub-cent tips no longer display as `$0.00`.

- **Activity icons.** BSV transfers use the same logo as the price panel. Send
  badges are directional blue (not error red); receive stays green.

## [1.2.75] - 2026-08-06

### Fixed

- **Activity icons now show the asset with direction as a subscript.** An NFT's
  image is the main icon and BSV transfers use the BSV logo. A small send or
  receive badge overlays the corner, so the icon identifies both what moved and
  which way without replacing the asset with a generic action glyph.

## [1.2.74] - 2026-08-06

### Fixed

- **Activity rows now lead with the asset, not the verb.** An NFT's image and
  name are the subject; BSV transfers use the BSV logo and `BSV`. `Send` or
  `Receive` is the smaller subtitle, so direction remains clear without
  competing with the thing that moved.

- **Collectables no longer depend on one explorer being reachable.** The toolbox
  registers a single provider for raw transaction lookups — WhatsOnChain — while
  every other lookup has two or three. Importing a tip needs those bytes for the
  transaction and each unproven ancestor, so on a device WhatsOnChain is
  throttling (the throttled reply carries no CORS headers, which the browser
  reports as `TypeError: Failed to fetch`) every collectable bounced with "The
  txid … must be valid transaction on chain main" — for transactions sitting on
  every other explorer. Bitails and JungleBus are now registered behind
  WhatsOnChain, so a busy primary costs a round trip instead of the import. The
  toolbox still hashes each returned body against the txid it asked for.

- **Opening Collect no longer waits on the network.** The ownership check
  introduced in 1.2.73 awaited an address scan before painting, and a throttled
  provider answers in tens of seconds — one open took 17s. The grid now paints
  from the basket immediately and reconciles when the scan lands. The address
  scan itself gives up after 7s and falls through to the toolbox services.

- **A stale scan can no longer hide a tip that just arrived.** Ownership is only
  applied to tips the scan was in a position to see; anything first seen after it
  ran stays on screen until a newer scan judges it.

## [1.2.73] - 2026-08-06

### Fixed

- **Collectables are now the tips this address still holds — nothing else.** The
  panel was painting from basket `1sat` plus a durable cache, and basket rows
  outlive a spend until something releases them. Sending an item (or spending it
  elsewhere) left a ghost card on screen; opening Collect before a refresh could
  show last session's tips even when the UTXOs were gone.

  The list is now basket tips ∩ live 1-sat outpoints on the receive address. Tips
  missing from that set are dropped and relinquished. Chain ingest feeds the
  same scan into the filter so a just-imported tip appears and a spent tip does
  not wait on the Collect panel timer. Details also re-check ownership before
  opening. A failed address scan keeps the prior basket list rather than wiping
  the grid.

### Changed

- **Activity detail prefers "Transaction", and item rows link into Collect.**
  The subcontext breadcrumb said "Payment" for every history row. It now says
  "Transaction" unless the row is an explicit app BSV payment. Collectable
  transfers open the item (thumbnail, media, and name) when the tip is still
  held — or, for a receive, by the recorded outpoint.

## [1.2.72] - 2026-08-06

### Fixed

- **Collectables bounced while payments went through, because internalizing an
  ordinal needs a block header the Chaintracks host has not stored yet.**
  Verifying a merkle root and recording which block a proof belongs to are two
  separate calls, and only the first one had failover. The second,
  `getHeaderForHeight`, reaches straight into `options.chaintracks` past every
  wrapper, so a host sitting below the tip returned nothing and the toolbox
  reported "The hash parameter must be valid height '961050' on mined chain
  main". A P2PKH sweep is a `createAction` and stops after the root check, which
  is why money arrived and every collectable failed.

  Header lookups now fall back to Bitails and WhatsOnChain, and a header from a
  public source is only accepted when it proves itself: its 80 bytes must hash
  to the hash the API reported, and that hash must clear the proof-of-work its
  own `bits` field encodes. Forging one would require mining it.
- **Cloud backup was failing permanently over a diagnostic breadcrumb.** BRC-38
  export refuses a document containing any JSON `null`, and the monitor writes
  them — a proof service that answers without a txid leaves `{"txid":null}` in a
  `provenTxReqs` history note. One note poisoned every subsequent backup, and
  the watchdog's failure counter then locked backups out for twelve hours.
  These notes carry no wallet state, so when the export is refused for a null
  member the wallet now strips the nulls out of the stored history and exports
  again.
- **A backup hold no longer outlives the build that earned it.** The watchdog
  had already pushed the next attempt twelve hours out, so shipping the fix
  above would have changed nothing until tomorrow. The streak now records which
  version failed and clears itself on upgrade.

## [1.2.71] - 2026-08-06

### Fixed

- **A chain tracker that was merely behind was rejecting real payments.**
  `Beef.verify` asks "is this the real merkle root at this height?" and the
  interface only permits `true` or `false` — so a tracker whose header store has
  not reached that height answers `false`, which the caller cannot tell apart
  from "this proof is forged". The Chaintracks host sat at block 961039 while the
  user's deposit was mined at 961052, so every recent payment was declared
  invalid and surfaced as `valid AtomicBEEF` or `valid Beef when factoring
  options.trustSelf` — wording that blames the data for what was really a stale
  index. It also drove the "Chain failed" pill.

  A `false` is now only believed from a source that demonstrably holds the height
  being asked about. An error, a timeout, a height past the source's tip, a 404,
  or a denial the primary cannot corroborate are all "unknown", and the question
  moves to the next source. `true` still requires a source to affirmatively
  confirm the root, so nothing is waved through unverified; when nothing can
  answer the tracker throws instead of denying, because a denial is permanent and
  discards the deposit while a throw is retried on the next sync.
- **Added Bitails as a header source, ahead of WhatsOnChain.** The toolbox's
  service rotation already leans on WhatsOnChain for raw transactions, UTXO scans
  and exchange rates, so by the time a merkle root needs checking the device is
  often rate-limited there — and a throttled response carries no CORS headers, so
  a WebView reports it as `TypeError: Failed to fetch`, indistinguishable from the
  host being down. Verified roots are also cached per height, since they cannot
  change, instead of being re-fetched for every BEEF.

## [1.2.70] - 2026-08-06

### Fixed

- **One bad deposit threw away every other deposit in the scan.** Legacy sweeps
  let `SetupClient.fundWalletFromP2PKHOutpoints` build its own input BEEF. That
  builder reads raw transactions from two hardcoded URLs and asks GorillaPool
  alone for merkle proofs; when a proof comes back empty it walks every parent
  input instead. So one silent proof miss fans out into a request per ancestor
  per level against the same two hosts it depends on — they rate-limit, the
  throttled response carries no CORS headers so the browser reports
  `TypeError: Failed to fetch`, and the resulting throw is raised *outside* the
  per-outpoint `try`. The whole batch died with it, which is why a P2P payment
  could simply never arrive. The wallet now builds the BEEF itself
  (`legacyBeef.ts`) through the toolbox's multi-provider service rotation,
  caches raw transactions and proofs (neither can change), spaces requests out,
  and contains a failure to the one outpoint it belongs to. Unprovable outpoints
  stay retryable instead of being marked done.
- **`Services.getHeight()` had no failover.** It reaches past `getChainTracker()`
  into `services.options.chaintracks`, so 1.2.69's fallback never saw the call
  and every height lookup still failed against the dead Chaintracks host. The
  monitor holds that same object, so patching it covers both callers.

### Removed

- **`ReviewProvenTxs` monitor task.** It is a lagged backup audit for reorgs that
  `TaskReorg` already handles from header events, and it resumes from the last
  height it recorded — a wallet that has never completed a run starts at block 0
  and issues 100 header lookups a minute, forever, about transactions that are
  not ours. That load was competing with deposit lookups on the same
  rate-limited providers.

## [1.2.69] - 2026-08-06

### Fixed

- **Nothing new synced: the chain tracker was down.** `mainnet-chaintracks.babbage.systems`
  answers HTTP 500 (`At least one bulk ingestor must implement getPresentHeight`).
  `Beef.verify` needs a chain tracker, and the toolbox points every incoming path
  at that one host — so internalizing an ordinal failed as "valid AtomicBEEF",
  legacy sweeps failed as "valid Beef when factoring options.trustSelf", and
  `ReviewProvenTxs` errored on every pass. All three read like corrupt data; all
  three were one dead host. Merkle-root checks now fail over to WhatsOnChain,
  which serves the exact blocks these BEEFs reference.
- **Incoming ordinals could never be internalized.** The BSV SDK validates
  `internalizeAction`'s `customInstructions` at a hard 1000 characters. We attached
  the BRC-150 v2 remittance, which is ~400k — our own budget was set to 400,000,
  i.e. 400x over a limit we never checked against. Every incoming item threw
  before anything was written. The remittance is built locally from chain data and
  is not sender-supplied, so the receive path now stores identity only and
  `verifyItemAuthenticity` rebuilds provenance on demand as it already did.

## [1.2.68] - 2026-08-06

### Fixed

- **Incoming PtP payments could be permanently written off.** The legacy sweep
  that credits every received payment goes through `fundWalletFromP2PKHOutpoints`,
  whose `createAction` passes only `{ trustSelf: 'known' }` — so it inherits the
  SDK's delayed broadcast. A reported `success: true` therefore means "queued
  locally", not "sent". We then durably marked the outpoint imported, and
  `legacyImportGuard` marks are permanent by design.
- v1.2.40 deleted the self-heal that covered exactly this case
  (`retryableStuckSweeps` / `forgetLegacyImported` / `txExistsOnChain`) because it
  was making sync crawl. After that there was no un-mark path left in the wallet
  at all: a sweep that never reached a miner left the coins unspent on the address
  behind a permanent blacklist, while the log claimed "balance should already
  include them".
- The heal is restored, and stricter than before. It only runs in the stuck state
  (nothing imported, marks present, coins still on the address), and it now
  requires a *recorded sweep txid that is provably absent* from the chain. The
  old version treated "no recorded txid" as retryable, which is what booked one
  deposit three times; absent proof, the mark stands.

## [1.2.67] - 2026-08-06

### Fixed

- Release build for 1.2.66 failed typecheck on a new test file's mock types.
  Same payment fixes as 1.2.66, shipped.

## [1.2.66] - 2026-08-06

### Fixed

- **BSV payments were never broadcast by the send itself.** `acceptDelayedBroadcast`
  defaults to **true** in the SDK, and `sendSatsToAddress` passed no options — so
  `createAction` only queued the transaction for the monitor's `TaskSendWaiting`
  loop. Worse, the toolbox skips `throwIfAnyUnsuccessfulCreateActions` in delayed
  mode, so a broadcast that never happened returned a txid and looked like a
  success. Payments now send undelayed and a failure is an error. Collectable
  sends already did this, which is why items went out and money did not.
- Pre-send "checking balance" was running the full chain ingest, including an
  indexer walk for every unidentified one-sat. A payment cannot spend an ordinal,
  so the spend heal now sweeps funding only — no tip lookups, no item or latch
  internalization on the path where the user is waiting.

## [1.2.65] - 2026-08-06

### Fixed

- Desktop sync felt slower than mobile for a silly reason: `yieldToUi` used
  `requestIdleCallback` with a 120ms timeout, and during ingest the main thread
  stays busy so every yield waited out the full timeout. Electron has ric;
  Android WebViews often do not — so mobile already fell through to
  `setTimeout(0)` and finished sooner. Yields now always use `setTimeout(0)`.
- First post-unlock chain poll and the toolbox monitor start immediately on
  desktop; phone shells keep the longer deferral that protects unlock taps.
- Peer BRC-153 transfers: a co-created 2-sat latch is local proof that OUTPUT:0
  is an ordinal tip. Latch-proven tips bypass the 10-minute miss backoff and
  surface as "Item arriving" instead of silently sitting in held dust.
- Top bar control heights aligned across Activity / Collectables / Friends.
- HandCash handles display as `$handle`; BRC-CLOUD claims require an HMAC claim
  ticket (or operator key).

## [1.2.64] - 2026-08-06

### Fixed

- Images stopped loading past the first few. The concurrent-decode cap added in
  v1.2.58 handed out a slot when a frame came near the viewport but only
  returned it on unmount, so the first three visible cards held all three slots
  for as long as they stayed on screen and every other image queued forever.
  The cap exists to limit simultaneous *decodes*, so the slot now goes back the
  moment an image settles; the `src` stays attached to keep the frame painted.
- Raised the cap from 3 to 6, and a request that never answers now gives up its
  slot after 10s so one dead host cannot hold the queue shut.
- Extracted the semaphore to `imageLoadSlots.ts` with tests, including a guard
  for the starvation case above.

## [1.2.63] - 2026-08-06

### Fixed

- The crash was the BRC-39 cloud backup, and it was a self-sustaining loop.
  Auto-sync runs on every unlock and encrypts the whole wallet with Argon2id at
  the canonical BRC-39 parameters — 7 passes over 128 MiB — on the UI thread.
  That is the ~3s block in every log, which is why the stall followed whichever
  tab happened to be tapped and why `[cloud-backup] auto-sync ok` never once
  appears: the WebView was killed mid-KDF, so the upload never recorded success,
  so the next launch tried again. New NFTs made it worse by enlarging the
  BRC-38 document that gets encrypted.
- Argon2id and AES-GCM now run in a dedicated worker, which is terminated after
  each backup so its 128 MiB WASM heap is returned instead of held for the
  session. The UI thread no longer blocks on a backup.
- Added a durable crash-loop breaker. An attempt is marked open before the
  export and reconciled at boot; an attempt that never closed counts as a
  failure and delays the retry (5m → 30m → 2h → 12h → 24h). A success clears
  the streak, and a manual "Back up now" ignores the hold.
- Automatic backups no longer re-derive the vault key. `createBrc39BackupBytes`
  was running a second 210k-iteration PBKDF2 to re-check a password the session
  had already proven at unlock.

## [1.2.62] - 2026-08-06

### Fixed

- True freeze was wallet-toolbox `TaskMonitorCallHistory`: on every unlock it
  JSON.stringifies the entire services call log and writes it to IndexedDB on the
  main thread. Every crash log showed that line right before a ~3s stall while
  tapping Friends/Apps/Identity/Settings — not Collect-specific. That task is
  removed, and the rest of the monitor loop starts only after idle.
- Activity NFT thumbnails restored (lazy DeferredImage).
- DeferredImage no longer force-loads every card 350ms after mount.

## [1.2.61] - 2026-08-06

### Fixed

- True freeze cause was wallet sync, not tabs. Latest log: soft-latch ingest mid-tap
  then a 2.8s main-thread stall. Latch dust stays on the address after basket
  insertion, so every Dashboard poll re-fetched BEEF and ran `internalizeAction`
  on the UI thread. Known latches are skipped, failed imports back off for 5
  minutes, BEEF work yields to the UI, the first post-unlock poll waits for idle,
  and background polls no longer run the spendable audit.

## [1.2.60] - 2026-08-06

### Fixed

- Latest log was Settings → Identity then a 3s stall on first QR open. Identity QR
  pre-warms at unlock and is cached per key. Light tabs stay mounted once visited;
  Collectables still unmounts when you leave it.
- Activity had the same remount cost. The feed snapshot is cached per limit, rows
  render in batches, and NFT activity lines use an icon in the list — full ordinal
  images only on the payment detail view, not 200 decodes at once.

## [1.2.59] - 2026-08-06

### Fixed

- Latest crash log was rapid Activity ↔ Identity tab taps. Identity regenerated its
  QR on every mount; it is now cached per identity key. Light tabs stay mounted
  once visited; Collectables still unmounts when you leave it.

## [1.2.58] - 2026-08-06

### Fixed

- Revert the keep-alive nav experiment. Mounting every visited tab at once stacked
  panel trees and ordinal images until Android killed the WebView — logs showed 3s
  main-thread stalls with heap still at 10MB, which is native memory pressure, not
  a JS OOM. Only the active section mounts again, like yesterday.
- Collect opens from cache immediately; network refresh waits for idle time.
  Cards render in small batches per frame instead of all at once.
- Ordinal images decode at most six at a time, and authenticity checks run when
  you open an item — not for the whole basket after every list.

## [1.2.57] - 2026-08-06

### Fixed

- Sections scroll again. Keeping panels mounted put a wrapper element between
  the stage and each panel, which broke the flex chain the panels size against:
  nothing could scroll, and the longest list — Settings — froze on open while
  the layout tried to resolve a percentage height against an unbounded parent.
  A slot is now `display: contents`, so a visible panel sits in the stage's flex
  chain exactly as it did before it stayed mounted.
- The stage picks its layout mode from the section on screen. With every visited
  section mounted, a background panel's empty state was reflowing the visible
  one.
- Opening a friend, an app or a setting no longer tears down every mounted
  section, so coming back does not remount them all at once.

## [1.2.56] - 2026-08-06

### Fixed

- Rapid nav-bar tapping no longer freezes the UI. Root section panels stay
  mounted and are shown/hidden instead of remounting whole trees on every tap.
  Soft SFX is rate-limited, and nav breadcrumbs are debounced so the log path
  itself cannot pile up during a burst of taps.

## [1.2.55] - 2026-08-06

### Added

- Freeze detection. A blocked main thread raises no error and stops all other
  logging, so a 500ms timer now reports how late it ran, long tasks over 800ms
  are attributed where the runtime supports it, and a 5s heartbeat marks exactly
  when the app stopped responding.
- Foreground/background transitions are logged, which separates an OS reclaim
  after backgrounding from a freeze the user was staring at.

### Fixed

- Image viewport observers are created once per frame instead of on every
  load/release flip, since re-observing re-fires the initial callback and an
  element resting on the boundary could oscillate.
- The log tail is only written when there are new lines, halving the
  synchronous storage writes the diagnostics themselves cost.

## [1.2.54] - 2026-08-06

### Fixed

- Ordinal images are released once they scroll well clear of the viewport.
  Decoded bitmaps live in native memory rather than the JS heap, and ordinals are
  served at full resolution, so a grid of them could get the WebView killed by
  the OS while the JS heap still looked idle.

### Added

- Logs can be uploaded from Mobile, not just Desktop, and a recovered crash log
  is sent automatically at boot when an upload URL is configured.
- Navigation breadcrumbs and a warning past 40 simultaneously decoded images, so
  a crash log shows which screen the app was on and how much it was holding.

## [1.2.53] - 2026-08-06

### Added

- Logs survive a crash. The tail is mirrored to durable storage (immediately on
  any error) and reloaded on the next start, so the log viewer opens with the
  previous session's final lines instead of only the fresh restart.
- The session banner records the running version, heap use and device, which is
  what pins a crash to a build.
- Heap pressure is sampled while visible and logged past 70% of the JS heap
  limit. An OOM kill raises no error, so this is the only footprint it leaves.

## [1.2.52] - 2026-08-06

### Changed

- An address holding only ordinals no longer logs a scary "no funding
  classified" warning. Only UTXOs that matched no class at all are reported.
- The all-basket spendable audit is attempted once per session. Storage builds
  that cannot filter on an undefined basket are remembered, so each sync goes
  straight to the default basket instead of throwing and retrying.

## [1.2.51] - 2026-08-06

### Fixed

- Opening Collect with many BRC-150 ordinals no longer OOMs the WebView. Listing
  no longer pulls every item's remittance BEEF (~400k chars each) or verifies it
  on the critical path. Authenticity still runs automatically after paint — one
  tip at a time, with UI yields — and verdicts are cached durably.

## [1.2.50] - 2026-08-06

### Fixed

- Audio unlock listeners no longer run on every tap for the life of the app —
  they unbind once the AudioContext is running. Tone nodes also tear down on a
  timer, because some Android WebViews never fire `onended` after `stop()`.
- Cap session receive-chime outpoints, prune inscription hit/miss maps, and
  expire stale permission-connect timestamps so a long unlock cannot grow
  unbounded Sets.

## [1.2.49] - 2026-08-05

### Fixed

- Collectables paint from a durable cache on open instead of waiting on
  `listOutputs`. Last session's inventory is shown immediately; the network
  refresh updates it in the background.
- Ordinal images load again. Android WebViews often never fire
  `IntersectionObserver` for elements already on screen; the frame is checked
  synchronously first, with a short fallback so a broken observer can never leave
  images on the skeleton forever.

### Changed

- GorillaPool is only consulted for ordinals remittance cannot verify. A P2P tip
  that already carries `origin:` (and optional BRC-150 provenance) is listed and
  detailed from local data — no indexer walk. Unverified tips on the receive
  address are still resolved once, then cached.

## [1.2.48] - 2026-08-05

### Fixed

- Tapping the nav bar no longer degrades the app click by click. Each sound left
  its oscillator and gain node wired to the destination, so the audio graph grew
  by a node per tap and was reprocessed every quantum. Nodes are now disconnected
  when the tone ends.
- Sending money no longer stalls on work it cannot use. The pre-send heal forced
  the spendable audit, which spends one UTXO-status request per output and, now
  that it never releases, only reports. Sends skip it.
- Classifying scanned UTXOs no longer re-walks the indexer for the same outpoint.
  Any 1-sat output that could not be resolved was walked again — up to ~100 serial
  requests each — on every background poll and before every send. Results come
  from `inscriptionCache` now, with a back-off for dust that never resolves.
- Flipping through the nav bar no longer stacks duplicate `listOutputs` queries;
  concurrent collectable listings join the in-flight read.

## [1.2.47] - 2026-08-05

### Fixed

- Collect page no longer freezes the phone. Listing items resolved every item
  through the indexer before painting, and each resolution walks the chain
  backwards up to 7 hops, spending a GorillaPool lookup plus a WhatsOnChain
  transaction fetch plus a lookup per input at each hop — hundreds of serial
  requests per open, repeated every 30s. The list now paints from the output's own
  tags and `customInstructions`, which is all it renders.
- Ordinal images are deferred until near the viewport again, so opening the grid
  no longer fetches every full-size image at once. Deferral is driven by an
  observer on the frame rather than `loading="lazy"`, which cannot work while the
  image is hidden.

### Added

- `inscriptionCache.ts` remembers resolved inscription metadata per outpoint, and
  keeps it across restarts. What an outpoint is inscribed with cannot change, so a
  resolved item is never walked again; misses back off for 10 minutes.

## [1.2.46] - 2026-08-05

### Fixed

- Change no longer disappears after a send. Sync called `reviewSpendableOutputs`
  with `release`, which writes `spendable: false` permanently based on
  `services.isUtxo` — and that returns `or.isUtxo === true`, so an indexer that
  has not yet seen our unconfirmed change, or a UTXO service that merely errored,
  both read as "spent". Sync now audits and reports only; it can no longer write
  off a single output.

### Changed

- Outputs are written off only on affirmative evidence: a spend the network
  rejected because an input was already spent (`staleOutputRelease.ts`). That
  still clears outputs spent on another device sharing the identity, which is
  what release was for, without the collateral damage.
- Removed `sendSettleGuard`. Its 10-minute window only delayed the write-off, so
  change from a transaction that took longer to confirm was destroyed anyway.

## [1.2.45] - 2026-08-05

### Fixed

- Ordinal images never loaded: `DeferredImage` hides the `<img>` until it loads, and a
  `display: none` image never satisfies lazy loading's intersection check, so it never
  fetched and sat on the skeleton forever. The component now always loads eagerly and
  ignores a caller's `loading` prop. Off-thread decoding (`decoding="async"`) is kept.

## [1.2.39] - 2026-08-05

### Changed

- Patch release (every push must ship a new version).

## [1.2.37] - 2026-08-05

### Fixed

- Pre-prompt spend heals no longer throw `runChainIngestDuringSpend requires an active spend session`. Chain refresh uses the top-level ingest path outside a spend lock, and nests only while send is already exclusive.
- Soften the BSV toast CRT texture — wider scanlines and a haze instead of a dense pixel grid.

## [1.2.36] - 2026-08-05

### Fixed

- Sending a collectable no longer fails with "Every signableTransaction input must have a sourceTransaction". The input BEEF now covers every outpoint the send spends, so a tip and a latch from different transactions are both provable.
- The proof latch is signed with its own satoshi value instead of the tip's 1 sat, so latched transfers produce valid signatures.
- A collectable whose tip still carries its inscription envelope is recognised as spendable instead of reporting "locked to a key this device cannot sign".

## [1.2.35] - 2026-08-05

### Added

- Activity history for collectables shows the item name and thumbnail instead of a 1-sat payment amount.
- BRC-99 `p 1sat <scope>` baskets for item permissions (`*`, `collection:`, `creator:`, `origin:`); plain `1sat` remains the coarse fallback. Unsupported `p` schemes are rejected.

## [1.2.34] - 2026-08-05

### Fixed

- Sending a collectable now releases the tip (and its prior latch) from the item basket immediately, so a sent item stops listing in the sending wallet and cannot appear in two wallets at once.
- The legacy-import grace window no longer blocks a forced spendable review. Outputs this device just spent are released on spend heal and explicit Refresh; the release is only held when the same pass swept legacy funding.

## [1.2.33] - 2026-08-05

### Fixed

- Misfiled funds recover again: the inscription probe no longer walks ancestor transactions, so funding outputs descended from an ordinal spend stopped being treated as collectables and left in the item basket.
- Refresh now reports what happened to item-basket money — recovered, held with an inscription, locked to another key, below the fee floor, or a sweep error — instead of only logging to the console.

## [1.2.32] - 2026-08-05

### Fixed

- Sound effects play on Android: one shared `AudioContext` that is resumed on the first gesture, instead of a fresh suspended context per beep.

## [1.2.31] - 2026-08-05

### Changed

- Remove backup gating from send, BRC-100 permissions, and the Dashboard nag — backup stays optional in Settings.
- Simplify key-slice backup UI (email-first, trustholder choice above slices).
- Mobile top bar / Settings version comes from the Mobile package, not Desktop’s semver.

## [1.2.30] - 2026-08-05

### Changed

- Dashboard **Scan** offers **Add as friend** (identity keys) or **Send**, instead of jumping straight to Send.
- Collectable send uses the same send-panel layout as BSV send so mobile stacking matches Desktop.
- Removed the “one-sat waiting on the index” note from Collectables / sync status.

## [1.2.29] - 2026-08-05

### Fixed

- **Authenticity is lossless again on collectable sends.** Soft-latch was attaching structural v3 remittance and marking items `proven` without tip→origin BEEF or on-chain induction. Sends now attach BRC-150 v2 remittance; the 2-sat latch companion UTXO still ships for the latch profile. Bare v3 no longer counts as proven.

## [1.2.28] - 2026-08-05

### Changed

- **BRC-153 soft-latch sends are live** again: collectable transfers create tip (1 sat) + latch (**exactly 2** sats, P2PKH), co-spend prior latch when present, attach v3 remittance with relative `OUTPUT:N` tip/latch refs.
- Soft-latch dust is a protocol constant (`LATCH_DUST_SATS = 2`): never listed as a collectable, never fund-swept, internalized to basket `1sat-latch`. Spec updated accordingly.

## [1.2.27] - 2026-08-05

### Fixed

- **Legacy balance could be filed into the collectables basket.** The migration trusted the cloud item list outright, so any outpoint it named was excluded from the funding sweep and internalized into basket `1sat` — regardless of how many satoshis it actually held. Basket `1sat` is not counted toward spendable balance, so that money disappeared from the wallet.
- Cloud-named items are now cross-checked against the live UTXO: anything that is not exactly 1 satoshi is swept as funding. Outpoint matching is case-insensitive.
- `internalizeAction` verifies output value from the fetched BEEF before filing to basket `1sat`, covering every import path.

### Added

- Recovery on refresh: item-basket outputs worth more than a satoshi are swept back into spendable change. Outputs that resolve as inscriptions, or that are locked to another key, are reported and left alone.

## [1.2.26] - 2026-08-05

### Fixed

- **Receiving a collectable no longer shows a duplicate item.** The BRC-153 soft-latch shipped the latch as a bare 1-sat P2PKH output, which is indistinguishable from an ordinal tip on chain — receivers imported it as a second collectable with the same origin.
- Collectables listing skips latch-tagged outputs and deduplicates basket `1sat` by origin, so wallets already holding a phantom item heal on refresh.

### Changed

- Latched sends are held (`isLatchedSendEnabled()` → `false`) until the latch carries an on-chain marker script and a non-1-satoshi value; sends fall back to BRC-150 v2 remittance. v3 verify stays live.
- BRC-153 spec records the requirement that latch outputs be identifiable from the transaction alone.

## [1.2.25] - 2026-08-05

### Fixed

- Soft-latch send TypeScript build (signable input map typing).

## [1.2.24] - 2026-08-05

### Changed

- **BRC-153 soft-latch sends are live** (no feature gate): collectable transfers create tip + `1sat-latch` latch, co-spend prior latch when present, attach v3 remittance with relative `OUTPUT:N` tip/latch refs.

## [1.2.23] - 2026-08-05

### Changed

- **BRC-153** latched 1Sat provenance (renumbered from draft 151 — official registry reserves 151 for opinions).
- Manifest `/health` advertise 1Sat BRC capabilities (`147`, `150`, `153`; v2/v3 verify; latched send gated).
- Collectable sends use `tryBuildProvenanceForSend` (v2 today; v3 when Commit/Settle ships).

## [1.2.22] - 2026-08-05

### Added

- **BRC-151** latched 1Sat provenance (draft spec + phase 1): v3 remittance parse/verify, `1sat-latch` basket profile, BOLT-inspired O(1) path for collectables.
- Tap **Synced** status pill to refresh wallet (chain ingest + optional history pull).

## [1.2.21] - 2026-08-05

### Fixed

- Receive page QR no longer clipped; breadcrumb headers match section header typography.

## [1.2.20] - 2026-08-05

### Fixed

- Legacy balance no longer vanishes after “Payment received” — import runs before spendable review.
- 2-minute grace window after legacy sweep so indexers can catch up before outputs are released.
- Heal path when outpoints were marked imported but funds still sit on the legacy address.
- Receive toast only fires when spendable balance actually rises (not on import attempt alone).

## [1.2.19] - 2026-08-05

### Changed

- Wallet-layer coordinator (`walletCoordinatorMachine`) — chain ingest, spend, history replica, and recompose cannot overlap illegally.
- Spend-path chain heal uses nested ingest (no deadlock with in-flight send); Dashboard Refresh waits for active spend.

## [1.2.18] - 2026-08-05

### Fixed

- Unify chain ingest under `chainIngest.ts` + `ingestLegacyAddress.ts` (Refresh and migrate share one pipeline).
- Legacy receive scan prefers WhatsOnChain; reclaim falsely blacklisted UTXOs still unspent on-chain.
- Migration runs spendable review before legacy import (same as Refresh).

### Changed

- Remove `syncFunds.ts` — use `refreshFromChain()` from `chainIngest.ts`.

## [1.2.17] - 2026-08-05

### Fixed

- Prevent double legacy/1sat imports via outpoint guards and a shared chain-ingest queue (migrate + Dashboard sync).
- Serialize BRC-39 history upload/restore; skip soft-pull while local history is dirty.
- Receive toasts use the selected display denomination; longer toast duration; CRT toast contrast.

### Changed

- Serialize `internalizeAction` with spends; block collectable-send / handle-claim re-entry; skip overlapping Dashboard poll ticks.
## [1.2.16] - 2026-08-05

### Fixed

- **Peer-to-peer collectable send.** Basket `1sat` transfers now declare `unlockingScriptLength` and complete signing with the device root key. A too-broad error map had been rewriting the BRC-100 validation failure as "Invalid recipient address or identity key."
- **Sticky panel labels.** Solid background extends through the scroll-stage top padding so list content no longer peeks above the box label.

### Added

- **Handle claim (separate from balance migration).** BRC-100 `claimCloudHandle` / `getClaimedCloudHandle` bind a cloud `$alias` to the Desktop identity key via BRC-CLOUD.
- **GrapheneOS note** in Settings → About when HandCash Mobile detects GrapheneOS (sideload updates, no Play Services, backup disabled).

## [1.2.15] - 2026-08-04

### Changed

- **Key slices backup UX.** Settings → Key slices is a flexible slice manager: per-slice destination cycling (←/→), bulk destination shift, rotate-all with a confirm prompt (new integrity set), and a single progress header. Removed the awkward “Save N more slice(s)” primary label — confirm is **Done — slices saved** once two distinct handoffs exist. Cloud deposit stays a separate entry for HandCash + Haste.

## [1.2.14] - 2026-08-04

### Added

- **Scan to link** for multi-device pairing. Pair settings has a primary **Scan to link** camera flow; Dashboard Scan routes device-link QRs to Use on another device. QR scanning falls back to `@zxing/browser` when `BarcodeDetector` is missing (Android WebView / Capacitor).

## [1.2.13] - 2026-08-04

### Added

- **Immutable on-device UTXO archive.** Every BRC-39 export (download, cloud upload, or post-spend snapshot) also writes a write-once file under `userData/brc39-archive/{identity}/`. Existing snapshots are never overwritten (`wx` exclusive create); identical content is deduped. History settings lists local snapshots and can merge-restore them. Survives cloud PUT overwrite and IndexedDB factory wipe.

## [1.2.12] - 2026-08-04

### Added

- **Add money** action on the dashboard — opens the Exolix swap at `handcash.io/wallet/swap`, which pays BSV back into this device over the BRC-100 bridge. Override the host with `VITE_MARKET_BASE_URL`.

### Removed

- Manual **Refresh** button. The dashboard already polls the chain every 12s (parity) or 30s, and now also merges strictly-newer BRC-39 history on a 60s cadence, so there is nothing left for the button to do. Spend paths still force a full spendability review before broadcasting.

## [1.2.11] - 2026-08-04

### Fixed

- macOS “HandCash is damaged and can’t be opened”. With `identity: null` electron-builder skipped signing entirely, so the bundle shipped with only the linker's default signature (`Identifier=Electron`, no sealed resources) and `codesign --verify` failed — Apple Silicon rejects that regardless of quarantine state. `scripts/afterPack.cjs` now ad-hoc signs each packaged `.app` before the DMG/zip is built.
- Mac release workflow now runs `codesign --verify --deep --strict` and asserts the signature is bound to `io.handcash.brc100`, so a broken signature fails CI instead of shipping.

### Notes

- Still not notarized, so first launch needs `xattr -cr /Applications/HandCash.app`. On macOS 15+ right-click → Open no longer bypasses Gatekeeper; the GUI route is **System Settings → Privacy & Security → Open Anyway**.
- To repair an install from 1.2.10 or earlier: `xattr -cr /Applications/HandCash.app && codesign --force --deep --sign - /Applications/HandCash.app`.

## [1.2.10] - 2026-08-04

### Fixed

- Pin `@bsv/wallet-toolbox-client` to `2.4.4` so the `listOutputsIdb` patch applies in CI (`npm ci` was resolving 2.5.0).

## [1.2.9] - 2026-08-04

### Fixed

- Vendor `aeon-ui-engine@1.3.9` in-repo (`file:vendor/aeon-ui-engine`) so unsigned Mac/Linux/Windows CI can build without npm publish or access to the private AeonUI repo.

### Notes

- **Unsigned Mac BETA (notarization later):** download DMG from GitHub Releases. If Gatekeeper says “damaged”, run `xattr -cr /Applications/HandCash.app`. Auto-update opens the DMG instead of ShipIt.

## [1.2.8] - 2026-08-04

### Fixed

- Attempted HTTPS git URL for `aeon-ui-engine` (superseded by vendored path in 1.2.9).

## [1.2.7] - 2026-08-04

### Fixed

- Pin `aeon-ui-engine` to GitHub `v1.3.9` so CI builds Messages/BRC-218 UI (npm 1.3.5 was missing Thread/Composer/Prompt parts).
- Mac release workflow YAML (unsigned DMG builds — notarization still later).

## [1.2.6] - 2026-08-04

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.2.5] - 2026-08-04

### Added

- Wallet layer model (`chainIngest`, `historyReplica`, `localState`) with `recomposeWallet` on unlock/restore/pair sync.
- BRC-150 provenance helpers; empty-local history guard; soft BRC-39 pull on Refresh.
- Aeon `KeySliceList` for BRC-140 slice backup (progress, per-row state, distinct-slice confirm).

### Changed

- Trustholder backup uses the same dynamic list UX as offline split key backup.

### Fixed

- Mac auto-update still skips ShipIt on unsigned builds — opens the arch-matched DMG instead so `/Applications/HandCash.app` is not left damaged.

## [1.2.4] - 2026-08-04

### Added

- Cloud key backup (BRC-232) Settings panel for HandCash + Haste trustholder deposits.
- Modular Settings helpers (History URL field, status rows).

### Changed

- Restore Friends list/grid root (search kept); Message stays on friend details.
- Status pill: hide soft sync / backup probes; chain health wins over cloud “pending”.
- Unlock auto cloud sync is push-only; refuse older/unknown remote history pulls.
- Scan QR always opens the camera (no backup-settings redirect).
- Clearer Keys backup copy (“copy/save slices”); leaner fixed panel label bars.

### Fixed

- Auth no longer blocks on chain/cloud sync before entering the wallet.

## [1.2.3] - 2026-08-04

### Added

- Messages tab (BRC-218 compose commands, in-thread `/pay` `/request` `/escrow` cards).
- BRC-CLOUD messagebox client (send/list/ack) with local-first store.
- In-wallet log viewer; cloud backup health in the status pill.

### Changed

- Friends → Message opens the Messages thread.
- Mobile inherits Messages (short tab label: Msgs).

## [1.2.2] - 2026-08-02

### Changed

- Add the finalized, approved BRC-147/150 1Sat Ordinals specifications to the Desktop standards package.

## [1.2.1] - 2026-08-02

### Changed

- Remove Twonk support; keep item permission hardening (view/send/receive separate from Pay).

## [1.2.0] - 2026-08-01

### Added

- Item permissions: view (optional collection/creator), send, and receive — separate from Pay.

### Changed

- Pay and Auto-pay never cover NFT / collectable spends.

## [1.1.16] - 2026-08-01

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.1.15] - 2026-07-31

### Changed

- BRC-125 PeerPay URIs on Receive (default QR) and Send (paste + optional sats).
- BRC-112 balance-basket fallback; BRC-114 time-label helpers for activity windows.

## [1.1.14] - 2026-07-31

### Changed

- BRC-140 key slices (2-of-3) for recovery; store slices in different places.
- BRC-38/39 wallet data backup (download/import wallet.brc39; optional custom URL — HandCash host left blank).
- Settings: open app logs folder for support.
- Restore via BRC-140 share paste on auth.

## [1.1.13] - 2026-07-31

### Changed

- Remove Chat (Lab chat, BRC-218 composer, in-thread pay cards, and related nav/settings).

## [1.1.12] - 2026-07-31

### Changed

- Surface sync / held 1-sat / migrate-style errors in the wallet UI (not console-only).
- Clarify identity key vs payment address on Identity, Receive, and Send.
- Require backup confirmation before first outbound send or app connect.
- Unlock nudge when the BRC-100 bridge is hit while the wallet is locked.
- Windows release CI workflow (`latest.yml` + installers on tag).
- Gate `encrypt` with other action methods; document migrate bridge hosts.

## [1.1.10] - 2026-07-31

### Changed

- Compact collectable details (side hero, scroll); Origin/Outpoint at bottom; traits via Aeon MetricStrip.
- Inventory Send affordance; Lab/About statecharts cleanup; settings chart id fix.
- Consume aeon-ui-engine ^1.3.5.

## [1.1.9] - 2026-07-31

### Changed

- In-chat pay/request confirm (no Send redirect); Lab Chat flag; quieter receive SFX on sync.
- Statecharts: stable fit/zoom, taller labels, click a linked state to open its chart.

## [1.1.8] - 2026-07-31

### Changed

- Chat (BRC-218 commands), opt-in wallet SFX, favicon retry, compact statecharts, desktop icon mark inset.

## [1.1.7] - 2026-07-31

### Changed

- Mac updates open the arch-matched GitHub DMG (ShipIt still blocked until Developer ID).
- Screenshot to clipboard (⌘⇧S) with version badge; About statecharts.

## [1.1.6] - 2026-07-31

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.1.5] - 2026-07-31

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.1.4] - 2026-07-31

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.1.3] - 2026-07-31

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.1.2] - 2026-07-30

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.1.1] - 2026-07-30

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

All notable changes to HandCash Desktop are documented here.

## [1.1.0] - 2026-07-30

### Added

- Cursor-style update mode (default / manual / none) with `appUpdate` statechart.
- Aeon 1.2.0 product shell: brand palette, StatusBanner, Prompt, `launch:mac`.
- Collectables send/detail flow; GitHub prerelease update feed wiring.

### Fixed

- Update Mode selectable without Electron bridge; durable prefs for mode.
- Missing `app-update.yml` on arm64 `dir` packages (feed URL + launch inject).

## [1.0.0] - 2026-07-30

### Added

- Initial BETA release — self-custodial BRC-100 Desktop wallet.
