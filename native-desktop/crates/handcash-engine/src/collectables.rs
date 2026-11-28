// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Read-only Collect projection. No custody, proof bytes, network I/O or spend authority.
//! Reference: collectableGroups.ts, collectableSearch.ts, collectableSelection.ts.
//! Attribution is an already-verified resolver outcome, never an indexer name.

use icu_collator::{
    options::{CollatorOptions, Strength},
    Collator, CollatorBorrowed,
};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

/// TS localeCompare under the reference recorder's English/root locale.
/// Primary strength implements sensitivity: 'base'; suggestions use tertiary.
pub fn compare_labels(a: &str, b: &str) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            let mut options = CollatorOptions::default();
            options.strength = Some(Strength::Primary);
            Collator::try_new(Default::default(), options).expect("compiled root collation data")
        })
        .compare(a, b)
}

fn compare_suggestions(a: &str, b: &str) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            Collator::try_new(Default::default(), Default::default())
                .expect("compiled root collation data")
        })
        .compare(a, b)
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    pub outpoint: String,
    pub origin: String,
    pub name: String,
    pub image_url: String,
    pub collection_id: String,
    pub app: String,
    pub signer: String,
    pub issuer: String,
    pub issuer_attested: bool,
    pub bap_id: String,
    pub content: String,
    pub item_type: String,
    pub sub_type: String,
    pub mime_type: String,
    pub traits: Vec<Trait>,
    pub extras: Vec<Trait>,
    pub proven: bool,
    pub attribution: Option<Attribution>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Trait {
    pub name: String,
    pub value: String,
}

/// Only the identity service may supply this verified display outcome.
/// A BAP stamp alone can supply only Unconfirmed, never a profile name/image.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Attribution {
    Verified {
        identity_key: String,
        profile_id: String,
        bap_id: Option<String>,
        label: String,
        image_url: Option<String>,
        listed: bool,
    },
    Unconfirmed {
        bap_id: String,
    },
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CompactAsset {
    pub asset_id: String,
    pub deploy: String,
    pub kind: String,
    pub sym: String,
    pub name: String,
    pub image_url: String,
    pub issuers: Vec<String>,
    pub attribution: Option<Attribution>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issuer {
    pub key: String,
    pub label: String,
    pub identity_key: Option<String>,
    pub profile_id: Option<String>,
    pub image_url: Option<String>,
    pub rank: u8,
}

pub fn normalize_issuer(raw: &str) -> Option<String> {
    let lower = raw.trim().to_lowercase();
    let key = lower.strip_prefix("0x").unwrap_or(&lower);
    (key.len() == 66
        && (key.starts_with("02") || key.starts_with("03"))
        && key.bytes().all(|b| b.is_ascii_hexdigit()))
    .then(|| key.to_string())
}

pub fn short_profile_id(id: &str) -> String {
    let chars: Vec<_> = id.chars().collect();
    if chars.len() > 10 {
        format!(
            "{}…{}",
            chars[..6].iter().collect::<String>(),
            chars[chars.len() - 4..].iter().collect::<String>()
        )
    } else {
        id.to_string()
    }
}

fn short_key(key: &str) -> String {
    format!("{}…{}", &key[..8], &key[key.len() - 6..])
}

pub fn issuer_view(item: &Item) -> Option<Issuer> {
    let key = normalize_issuer(&item.issuer)?;
    let mut view = Issuer {
        key: format!("issuer:pubkey:{key}"),
        label: short_key(&key),
        identity_key: Some(key.clone()),
        profile_id: None,
        image_url: None,
        rank: 3,
    };
    if !item.issuer_attested {
        view.key = format!("issuer:claim:{key}");
        view.label = format!("Issuer claim {}", short_key(&key));
        view.rank = 5;
        return Some(view);
    }
    match &item.attribution {
        Some(Attribution::Verified {
            identity_key,
            profile_id,
            bap_id,
            label,
            image_url,
            listed,
        }) if item.bap_id.is_empty() || bap_id.as_deref() == Some(item.bap_id.as_str()) => {
            // Do not allow a malformed resolver key to manufacture a shelf.
            if let Some(identity) = normalize_issuer(identity_key) {
                view.key = format!("issuer:pubkey:{identity}");
                view.identity_key = Some(identity);
                view.profile_id = Some(profile_id.clone());
                view.label = label.clone();
                view.image_url = image_url.clone();
                view.rank = if *listed { 0 } else { 1 };
            }
        }
        Some(Attribution::Unconfirmed { bap_id }) if bap_id == &item.bap_id => {
            view.key = format!("issuer:bap-unconfirmed:{bap_id}");
            view.label = format!("Unconfirmed profile {}", short_profile_id(bap_id));
            view.profile_id = Some(bap_id.clone());
            view.rank = 4;
        }
        _ => {}
    }
    Some(view)
}

fn shelf_for(item: &Item) -> Option<Issuer> {
    if let Some(view) = issuer_view(item) {
        return Some(view);
    }
    let app = item.app.trim();
    let (key, label) = if !item.signer.is_empty() {
        (
            format!("issuer:signer:{}", item.signer),
            if app.is_empty() {
                "Signed items".into()
            } else {
                app.into()
            },
        )
    } else if !app.is_empty() {
        (format!("issuer:app:{}", app.to_lowercase()), app.into())
    } else if !item.collection_id.trim().is_empty() {
        (
            format!("issuer:collection:{}", item.collection_id.to_lowercase()),
            series_label(&[item])
                .unwrap_or_else(|| format!("Collection {}", short_profile_id(&item.collection_id))),
        )
    } else {
        return None;
    };
    Some(Issuer {
        key,
        label,
        identity_key: None,
        profile_id: None,
        image_url: None,
        rank: 2,
    })
}

fn series_stem(name: &str) -> String {
    if let Some((prefix, suffix)) = name.rsplit_once('#') {
        let digits = suffix.trim_end();
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return prefix.trim().to_string();
        }
    }
    name.trim().to_string()
}

pub fn series_label(items: &[&Item]) -> Option<String> {
    let stems: Vec<_> = items
        .iter()
        .map(|i| series_stem(&i.name))
        .filter(|s| !s.is_empty())
        .collect();
    let first = stems.first()?;
    stems
        .iter()
        .all(|s| s.to_lowercase() == first.to_lowercase())
        .then(|| first.clone())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Face {
    pub outpoint: String,
    pub image_url: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub key: String,
    pub label: String,
    pub items: Vec<String>,
    pub faces: Vec<Face>,
    pub overflow: usize,
    pub quantity: usize,
    pub proven_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub issuer: Issuer,
    pub items: Vec<String>,
    pub bnt: Vec<String>,
    pub collections: Vec<Collection>,
    pub loose: Vec<String>,
    pub faces: Vec<Face>,
    pub overflow: usize,
    pub quantity: usize,
    pub proven_count: usize,
    pub quantity_label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grouped {
    pub issuers: Vec<Shelf>,
    pub ungrouped: Vec<String>,
    pub ungrouped_bnt: Vec<String>,
}

fn item_faces(items: &[&Item]) -> Vec<Face> {
    let mut seen = BTreeSet::new();
    items
        .iter()
        .filter(|i| !i.image_url.is_empty() && seen.insert(i.image_url.as_str()))
        .take(4)
        .map(|i| Face {
            outpoint: i.outpoint.clone(),
            image_url: i.image_url.clone(),
            name: i.name.clone(),
        })
        .collect()
}

fn numbered(n: usize) -> String {
    let s = n.to_string();
    s.chars()
        .enumerate()
        .fold(String::new(), |mut out, (i, c)| {
            if i > 0 && (s.len() - i).is_multiple_of(3) {
                out.push(',');
            }
            out.push(c);
            out
        })
}

pub fn quantity_label(
    quantity: usize,
    proven: usize,
    token_count: usize,
    bnt_items: usize,
) -> String {
    let mut parts = Vec::new();
    if token_count > 0 {
        parts.push(format!(
            "{} {}",
            numbered(token_count),
            if token_count == 1 { "token" } else { "tokens" }
        ));
    }
    let count = quantity + bnt_items;
    if count > 0 || token_count == 0 {
        parts.push(format!(
            "{} {}",
            numbered(count),
            if count == 1 { "item" } else { "items" }
        ));
    }
    let verified = proven + bnt_items;
    if verified > 0 {
        parts.push(format!("{} verified", numbered(verified)));
    }
    parts.join(" · ")
}

pub fn group(items: &[Item], assets: &[CompactAsset]) -> Grouped {
    // Vec preserves TS Map insertion order, including stable ties after sorting.
    let mut buckets: Vec<(Issuer, Vec<&Item>, Vec<&CompactAsset>)> = Vec::new();
    let mut bucket_indices = BTreeMap::new();
    let mut out = Grouped {
        issuers: Vec::new(),
        ungrouped: Vec::new(),
        ungrouped_bnt: Vec::new(),
    };
    for item in items {
        if let Some(meta) = shelf_for(item) {
            let index = *bucket_indices.entry(meta.key.clone()).or_insert_with(|| {
                let index = buckets.len();
                buckets.push((meta, vec![], vec![]));
                index
            });
            buckets[index].1.push(item);
        } else {
            out.ungrouped.push(item.outpoint.clone());
        }
    }
    for asset in assets {
        let item = Item {
            issuer: asset.issuers.first().cloned().unwrap_or_default(),
            issuer_attested: true,
            attribution: asset.attribution.clone(),
            ..Item::default()
        };
        if let Some(meta) = issuer_view(&item) {
            let index = *bucket_indices.entry(meta.key.clone()).or_insert_with(|| {
                let index = buckets.len();
                buckets.push((meta, vec![], vec![]));
                index
            });
            buckets[index].2.push(asset);
        } else {
            out.ungrouped_bnt.push(asset.asset_id.clone());
        }
    }
    for (issuer, members, mut bnt) in buckets {
        let mut by_collection: Vec<(String, Vec<&Item>)> = Vec::new();
        let mut loose = Vec::new();
        for item in &members {
            let id = item.collection_id.trim().to_lowercase();
            if id.is_empty() {
                loose.push(item.outpoint.clone());
            } else if let Some(b) = by_collection.iter_mut().find(|b| b.0 == id) {
                b.1.push(item);
            } else {
                by_collection.push((id, vec![item]));
            }
        }
        let mut collections: Vec<_> = by_collection
            .into_iter()
            .map(|(id, list)| {
                let faces = item_faces(&list);
                Collection {
                    key: format!("{}|collection:{id}", issuer.key),
                    label: series_label(&list).unwrap_or_else(|| {
                        format!("Collection {}", short_profile_id(&list[0].collection_id))
                    }),
                    items: list.iter().map(|i| i.outpoint.clone()).collect(),
                    overflow: list.len().saturating_sub(faces.len()),
                    faces,
                    quantity: list.len(),
                    proven_count: list.iter().filter(|i| i.proven).count(),
                }
            })
            .collect();
        collections.sort_by(|a, b| compare_labels(&a.label, &b.label));
        let mut faces = item_faces(&members);
        let mut seen: BTreeSet<_> = members.iter().map(|i| i.image_url.as_str()).collect();
        for a in &bnt {
            if faces.len() == 4 {
                break;
            }
            if !a.image_url.is_empty() && seen.insert(&a.image_url) {
                faces.push(Face {
                    outpoint: a.deploy.clone(),
                    image_url: a.image_url.clone(),
                    name: asset_label(a).into(),
                });
            }
        }
        bnt.sort_by(|a, b| compare_labels(asset_label(a), asset_label(b)));
        let proven_count = members.iter().filter(|i| i.proven).count();
        let bnt_items = bnt.iter().filter(|a| a.kind == "item").count();
        out.issuers.push(Shelf {
            quantity_label: quantity_label(
                members.len(),
                proven_count,
                bnt.len() - bnt_items,
                bnt_items,
            ),
            overflow: (members.len() + bnt.len()).saturating_sub(faces.len()),
            faces,
            quantity: members.len(),
            proven_count,
            issuer,
            items: members.iter().map(|i| i.outpoint.clone()).collect(),
            bnt: bnt.iter().map(|a| a.asset_id.clone()).collect(),
            collections,
            loose,
        });
    }
    out.issuers.sort_by(|a, b| {
        a.issuer
            .rank
            .cmp(&b.issuer.rank)
            .then_with(|| compare_labels(&a.issuer.label, &b.issuer.label))
    });
    out
}

fn asset_label(a: &CompactAsset) -> &str {
    if !a.sym.is_empty() {
        &a.sym
    } else if !a.name.is_empty() {
        &a.name
    } else {
        &a.asset_id
    }
}

pub fn search_blob(item: &Item) -> String {
    let mut parts = vec![
        item.name.as_str(),
        &item.origin,
        &item.outpoint,
        &item.collection_id,
        &item.app,
        &item.content,
        &item.item_type,
        &item.sub_type,
        &item.mime_type,
    ];
    let traits: Vec<_> = [&item.traits, &item.extras]
        .into_iter()
        .map(|list| {
            list.iter()
                .map(|t| format!("{} {}", t.name, t.value).trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    parts.extend(traits.iter().map(String::as_str));
    parts
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn matches(item: &Item, query: &str) -> bool {
    let blob = search_blob(item);
    query
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .all(|term| blob.contains(&term))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Suggestion {
    pub term: String,
    pub label: String,
    pub kind: String,
    pub count: usize,
}

fn name_stem(name: &str) -> String {
    let trimmed = name.trim_end();
    let stem = trimmed.trim_end_matches(|c: char| c.is_ascii_digit());
    if stem.len() == trimmed.len() {
        return name.trim().into();
    }
    stem.trim_end().trim_end_matches('#').trim_end().into()
}

pub fn suggestions(draft: &str, terms: &[String], items: &[Item], limit: usize) -> Vec<Suggestion> {
    let needle = draft.trim().to_lowercase();
    let applied: BTreeSet<_> = terms.iter().map(|s| s.trim().to_lowercase()).collect();
    let base: Vec<_> = items
        .iter()
        .filter(|i| matches(i, &terms.join(",")))
        .collect();
    let mut found = Vec::<Suggestion>::new();
    let mut seen = BTreeSet::new();
    let mut offer = |term: String, label: String, kind: String| {
        let key = term.trim().to_lowercase();
        if key.is_empty()
            || applied.contains(&key)
            || seen.contains(&key)
            || (!needle.is_empty()
                && !label.to_lowercase().contains(&needle)
                && !key.contains(&needle))
        {
            return;
        }
        seen.insert(key);
        found.push(Suggestion {
            term: term.trim().into(),
            label: label.trim().into(),
            kind,
            count: 0,
        });
    };
    for item in &base {
        for t in item.traits.iter().chain(&item.extras) {
            if !t.name.is_empty() && !t.value.is_empty() {
                offer(
                    format!("{} {}", t.name, t.value),
                    t.value.clone(),
                    t.name.clone(),
                );
            }
        }
        let stem = name_stem(&item.name);
        if !stem.is_empty() {
            offer(stem.clone(), stem.clone(), "Name".into());
        }
        if !needle.is_empty() && !item.name.is_empty() && item.name != stem {
            offer(item.name.clone(), item.name.clone(), "Name".into());
        }
        if !item.app.is_empty() {
            offer(item.app.clone(), item.app.clone(), "App".into());
        }
    }
    let blobs: Vec<_> = base.iter().map(|i| search_blob(i)).collect();
    for s in &mut found {
        let key = s.term.to_lowercase();
        s.count = blobs.iter().filter(|b| b.contains(&key)).count();
    }
    found.retain(|s| s.count > 0 && (!needle.is_empty() || s.count != base.len()));
    let starts = |s: &Suggestion| !needle.is_empty() && s.label.to_lowercase().starts_with(&needle);
    found.sort_by(|a, b| {
        starts(b)
            .cmp(&starts(a))
            .then_with(|| b.count.cmp(&a.count))
            .then_with(|| {
                a.label
                    .encode_utf16()
                    .count()
                    .cmp(&b.label.encode_utf16().count())
            })
            .then_with(|| compare_suggestions(&a.label, &b.label))
    });
    found.truncate(limit);
    found
}

pub fn reconcile(selected: &BTreeSet<String>, items: &[Item]) -> BTreeSet<String> {
    let held: BTreeSet<_> = items.iter().map(|i| &i.outpoint).collect();
    selected
        .iter()
        .filter(|op| held.contains(op))
        .cloned()
        .collect()
}

pub fn selectable<'a>(items: &'a [Item], busy: &BTreeSet<String>) -> Vec<&'a Item> {
    items
        .iter()
        .filter(|i| !busy.contains(&i.outpoint))
        .collect()
}

pub fn selection_state(selected: &BTreeSet<String>, items: &[&Item]) -> &'static str {
    let count = items
        .iter()
        .filter(|i| selected.contains(&i.outpoint))
        .count();
    if count == 0 {
        "none"
    } else if count == items.len() {
        "all"
    } else {
        "some"
    }
}

pub fn toggle(selected: &BTreeSet<String>, items: &[&Item], checked: bool) -> BTreeSet<String> {
    let mut next = selected.clone();
    for item in items {
        if checked {
            next.insert(item.outpoint.clone());
        } else {
            next.remove(&item.outpoint);
        }
    }
    next
}
