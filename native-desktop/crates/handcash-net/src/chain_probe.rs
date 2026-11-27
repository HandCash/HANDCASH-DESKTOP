// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Chain spent-status probe classifiers.
//! 1:1 port of `src/wallet/chainProbe/classify.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutpointSpentStatus {
    Spent,
    Unspent,
    Unknown,
}

/// Arcade `/tx` is source-tx presence. Always `None` so spent probes skip it.
pub fn spent_status_from_arcade_tx_lookup(_tx_status: Option<&str>) -> Option<OutpointSpentStatus> {
    None
}

/// Bitails `/tx/{txid}/output/{n}/status`. `unknown` means spent *or* never
/// seen — that is not proof the coins moved, so the caller must fail closed.
pub fn classify_bitails_utxo_status(
    status: Option<&str>,
    spent: Option<bool>,
) -> OutpointSpentStatus {
    if let Some(s) = status {
        let lower = s.to_ascii_lowercase();
        if lower == "unknown" || lower == "not found" {
            return OutpointSpentStatus::Unknown;
        }
    }
    match spent {
        Some(true) => OutpointSpentStatus::Spent,
        Some(false) => OutpointSpentStatus::Unspent,
        None => OutpointSpentStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arcade_tx_lookup_never_claims_spent_status() {
        assert_eq!(spent_status_from_arcade_tx_lookup(Some("MINED")), None);
        assert_eq!(spent_status_from_arcade_tx_lookup(None), None);
    }

    #[test]
    fn bitails_classifier_fails_closed_on_unknown_or_missing() {
        assert_eq!(
            classify_bitails_utxo_status(Some("unknown"), Some(true)),
            OutpointSpentStatus::Unknown
        );
        assert_eq!(
            classify_bitails_utxo_status(Some("Not Found"), Some(false)),
            OutpointSpentStatus::Unknown
        );
        assert_eq!(
            classify_bitails_utxo_status(Some("ok"), Some(true)),
            OutpointSpentStatus::Spent
        );
        assert_eq!(
            classify_bitails_utxo_status(None, Some(false)),
            OutpointSpentStatus::Unspent
        );
        assert_eq!(
            classify_bitails_utxo_status(None, None),
            OutpointSpentStatus::Unknown
        );
    }
}
