# Manual checklist — identity + multi-device (BRC-39 URL)

**Restore** = **BRC-75** / **BRC-140** → same identity → **one BSV pot**.

**Link devices** = both must set the **same History backup base URL** (**BRC-39**). Pair QR embeds that URL; mismatch is rejected. Sync = pull/push `wallet.brc39` + `friends.json` at that host. Same unlock password on both devices (encrypts BRC-39).

## Identity on a second device

1. Phrase/shares → restore on the other install.
2. Confirm identity key matches.
3. Set **identical** History backup URL on both (History or Use on another device).
4. Link via QR / paste.
5. **Sync via backup URL** (password) on each side as needed.
6. Refresh to reconcile spends vs chain.

## Spend heal

1. Send from A → Sync and/or Refresh on B.
2. Expect local history/friends from the shared URL; UTXO truth still verified on-chain.

## Boundaries

- No link without a shared backup URL.
- **No offline payments** — spends require network (hard rule with or without parity). Stale local outs + another device = double-spend risk.
- **Spend path** — force chain heal + balance check before Send (Review/Confirm), auto-pay/`createAction`, and collectable sends; spends are serialized locally.
- **Cross-device spend lease** — when a backup URL is set, `spend-lease.json` on that host gives one device a short exclusive send window (cloud-style reservation). Other device sees “X is sending…”.
- **Unlock / online** — force spendable review so other-device spends drop immediately.
- BRC-232 share vaults are key recovery only — not this sync path.
- LAN peer (port 3340) is optional live peek; parity is the backup URL.
