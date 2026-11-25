// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Executable catalog of HandCash statecharts mirroring `src/machines/machineManifest.ts`.

use crate::HandCashChart;

/// All 62 manifest IDs from `src/machines/machineManifest.ts`.
pub const TS_MANIFEST_IDS: [&str; 62] = [
    "settingsPreferences",
    "actionLifecycle",
    "asyncAction",
    "publicIdentities",
    "app",
    "send",
    "unlock",
    "offer",
    "bnt",
    "coin",
    "swap",
    "swapOffers",
    "swapSettle",
    "marketPurchase",
    "marketSellerSettlement",
    "appBrowser",
    "appBrowserPage",
    "assetBurnUi",
    "deviceBackup",
    "bntHoldings",
    "historyRecovery",
    "modelViewer",
    "permissionDecision",
    "qrReveal",
    "qrScanner",
    "update",
    "walletAccountMenu",
    "devKeysPanel",
    "ticker",
    "wipe",
    "assetSend",
    "legacyImport",
    "importItemBrowser",
    "importQueue",
    "walletJob",
    "chartApps",
    "notes",
    "appLauncher",
    "walletStatus",
    "collectableSend",
    "collectableSendRun",
    "authenticity",
    "itemSend",
    "brc29Send",
    "bsvSend",
    "burn",
    "serverWalletRecover",
    "txLifecycle",
    "walletCoordinator",
    "accountMove",
    "emailRecovery",
    "relaySignin",
    "pairingCode",
    "onboardEmail",
    "call",
    "callView",
    "grantExpiry",
    "entryMesh",
    "recordingPlayer",
    "fiatCurrencyMenu",
    "importWriteGrant",
    "iptAcceptRequest",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChartEntry {
    pub manifest_id: &'static str,
    pub machine_id: &'static str,
    pub top_level_states: &'static [&'static str],
}

const fn entry<M: HandCashChart>() -> ChartEntry {
    ChartEntry {
        manifest_id: M::MANIFEST_ID,
        machine_id: M::ID,
        top_level_states: M::TOP_LEVEL_STATES,
    }
}

/// All statecharts migrated into `handcash-machines` so far.
/// Every wave appends here until all 62 entries of [`TS_MANIFEST_IDS`] are present.
pub fn migrated_charts() -> Vec<ChartEntry> {
    vec![
        // Wave 1 (15 / 15)
        entry::<crate::settings_preferences::SettingsPreferencesMachine>(),
        entry::<crate::action_lifecycle::ActionLifecycleMachine>(),
        entry::<crate::async_action::AsyncActionMachine>(),
        entry::<crate::public_identities::PublicIdentitiesMachine>(),
        entry::<crate::app::AppMachine>(),
        entry::<crate::send::SendMachine>(),
        entry::<crate::unlock::UnlockMachine>(),
        entry::<crate::wallet_account_menu::WalletAccountMenuMachine>(),
        entry::<crate::wipe::WipeMachine>(),
        entry::<crate::wallet_status::WalletStatusMachine>(),
        entry::<crate::authenticity::AuthenticityMachine>(),
        entry::<crate::tx_lifecycle::TxLifecycleMachine>(),
        entry::<crate::wallet_coordinator::WalletCoordinatorMachine>(),
        entry::<crate::account_move::AccountMoveMachine>(),
        entry::<crate::fiat_currency_menu::FiatCurrencyMenuMachine>(),
        // Wave 2 (13 / 13)
        entry::<crate::bsv_send::BsvSendMachine>(),
        entry::<crate::brc29_send::Brc29SendMachine>(),
        entry::<crate::item_send::ItemSendMachine>(),
        entry::<crate::collectable_send::CollectableSendMachine>(),
        entry::<crate::collectable_send_run::CollectableSendRunMachine>(),
        entry::<crate::burn::BurnMachine>(),
        entry::<crate::asset_burn_ui::AssetBurnUiMachine>(),
        entry::<crate::asset_send::AssetSendMachine>(),
        entry::<crate::server_wallet_recover::ServerWalletRecoverMachine>(),
        entry::<crate::history_recovery::HistoryRecoveryMachine>(),
        entry::<crate::device_backup::DeviceBackupMachine>(),
        entry::<crate::wallet_job::WalletJobMachine>(),
        entry::<crate::model_viewer::ModelViewerMachine>(),
        // Wave 3 (12 / 12)
        entry::<crate::entry_mesh::EntryMeshMachine>(),
        entry::<crate::onboard_email::OnboardEmailMachine>(),
        entry::<crate::email_recovery::EmailRecoveryMachine>(),
        entry::<crate::relay_signin::RelaySigninMachine>(),
        entry::<crate::pairing_code::PairingCodeMachine>(),
        entry::<crate::qr_reveal::QrRevealMachine>(),
        entry::<crate::qr_scanner::QrScannerMachine>(),
        entry::<crate::permission_decision::PermissionDecisionMachine>(),
        entry::<crate::grant_expiry::GrantExpiryMachine>(),
        entry::<crate::update::UpdateMachine>(),
        entry::<crate::dev_keys_panel::DevKeysPanelMachine>(),
        entry::<crate::notes::NotesMachine>(),
        // Wave 4 (11 / 11)
        entry::<crate::legacy_import::LegacyImportMachine>(),
        entry::<crate::import_item_browser::ImportItemBrowserMachine>(),
        entry::<crate::import_queue::ImportQueueMachine>(),
        entry::<crate::import_write_grant::ImportWriteGrantMachine>(),
        entry::<crate::app_browser::AppBrowserMachine>(),
        entry::<crate::app_browser_page::AppBrowserPageMachine>(),
        entry::<crate::app_launcher::AppLauncherMachine>(),
        entry::<crate::chart_apps::ChartAppsMachine>(),
        entry::<crate::call::CallMachine>(),
        entry::<crate::call_view::CallViewMachine>(),
        entry::<crate::recording_player::RecordingPlayerMachine>(),
        // Wave 5 (11 / 11)
        entry::<crate::offer::OfferMachine>(),
        entry::<crate::market_purchase::MarketPurchaseMachine>(),
        entry::<crate::market_seller_settlement::MarketSellerSettlementMachine>(),
        entry::<crate::bnt::BntMachine>(),
        entry::<crate::bnt_holdings::BntHoldingsMachine>(),
        entry::<crate::ipt_accept_request::IptAcceptRequestMachine>(),
        entry::<crate::coin::CoinMachine>(),
        entry::<crate::swap::SwapMachine>(),
        entry::<crate::swap_offers::SwapOffersMachine>(),
        entry::<crate::swap_settle::SwapSettleMachine>(),
        entry::<crate::ticker::TickerMachine>(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn ts_manifest_has_62_unique_ids() {
        let unique: BTreeSet<&str> = TS_MANIFEST_IDS.iter().copied().collect();
        assert_eq!(unique.len(), 62);
    }

    #[test]
    fn every_migrated_chart_matches_ts_manifest_and_all_62_are_present() {
        let allowed: BTreeSet<&str> = TS_MANIFEST_IDS.iter().copied().collect();
        let mut seen = BTreeSet::new();
        for chart in migrated_charts() {
            assert!(
                allowed.contains(chart.manifest_id),
                "unknown manifest id: {}",
                chart.manifest_id
            );
            assert!(
                seen.insert(chart.manifest_id),
                "duplicate manifest id: {}",
                chart.manifest_id
            );
            assert!(!chart.machine_id.is_empty());
            assert!(!chart.top_level_states.is_empty());
        }
        assert_eq!(
            seen,
            allowed,
            "all 62 TS statecharts must be registered in handcash-machines"
        );
    }

    #[test]
    fn ts_manifest_file_matches_const_catalog() {
        let manifest_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../src/machines/machineManifest.ts");
        let raw = std::fs::read_to_string(&manifest_path)
            .expect("src/machines/machineManifest.ts should exist");
        let start = raw
            .find("export const machineManifest = Object.freeze({")
            .expect("machineManifest export");
        let body = &raw[start..];
        let end = body.find("})").expect("machineManifest closing");
        let mut parsed = BTreeSet::new();
        for line in body[..end].lines().skip(1) {
            let trimmed = line.trim();
            if let Some((key, _)) = trimmed.split_once(':') {
                let k = key.trim();
                if !k.is_empty() && !k.starts_with('/') {
                    parsed.insert(k.to_string());
                }
            }
        }
        let expected: BTreeSet<String> = TS_MANIFEST_IDS.iter().map(|s| s.to_string()).collect();
        assert_eq!(parsed, expected, "Rust TS_MANIFEST_IDS drifted from machineManifest.ts");
    }
}
