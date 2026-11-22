// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Read-only SQLite WAL query operations for `ToolboxDb`.
//! All reads execute concurrently on the WAL `ReadPool` without touching the writer lock,
//! unless bound to an explicit caller `trxId` (in which case they read from the writer
//! connection to preserve ACID read-your-own-writes semantics).

use crate::toolbox_db::blobs::{encode_b64, get_cold_blob, get_cold_blob_slice};
use crate::toolbox_db::schema::parse_optional_iso;
use rusqlite::{params, types::Value as SqlVal, Connection, OptionalExtension, Row};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub type OpResult = Result<Value, String>;

fn db_err(ctx: &str, err: rusqlite::Error) -> String {
    format!("{ctx}: {err}")
}

/// Parameterized WHERE clause builder (strictly bound parameters, never string interpolation).
#[derive(Default)]
pub struct SqlFilter {
    pub clauses: Vec<String>,
    pub args: Vec<SqlVal>,
}

impl SqlFilter {
    pub fn push_raw(&mut self, clause: impl Into<String>) {
        self.clauses.push(clause.into());
    }

    pub fn push_param(&mut self, clause_with_q: impl Into<String>, val: SqlVal) {
        self.clauses.push(clause_with_q.into());
        self.args.push(val);
    }

    pub fn push_eq_i64(&mut self, col: &str, obj: &Map<String, Value>, key: &str) {
        let Some(v) = obj.get(key) else { return };
        if v.is_null() {
            self.clauses.push(format!("{col} IS NULL"));
        } else if let Some(n) = v.as_i64() {
            self.clauses.push(format!("{col} = ?"));
            self.args.push(SqlVal::Integer(n));
        }
    }

    pub fn push_eq_pk(&mut self, col: &str, obj: &Map<String, Value>, key: &str) {
        let Some(v) = obj.get(key) else { return };
        if v.is_null() {
            return;
        }
        if let Some(n) = v.as_i64() {
            if n != 0 {
                self.clauses.push(format!("{col} = ?"));
                self.args.push(SqlVal::Integer(n));
            }
        }
    }

    pub fn push_eq_str(&mut self, col: &str, obj: &Map<String, Value>, key: &str) {
        let Some(v) = obj.get(key) else { return };
        if v.is_null() {
            self.clauses.push(format!("{col} IS NULL"));
        } else if let Some(s) = v.as_str() {
            self.clauses.push(format!("{col} = ?"));
            self.args.push(SqlVal::Text(s.to_string()));
        }
    }

    pub fn push_eq_bool(&mut self, col: &str, obj: &Map<String, Value>, key: &str) {
        let Some(v) = obj.get(key) else { return };
        if v.is_null() {
            return;
        }
        if let Some(b) = val_to_bool(v) {
            self.clauses.push(format!("{col} = ?"));
            self.args.push(SqlVal::Integer(if b { 1 } else { 0 }));
        }
    }

    pub fn push_eq_date(&mut self, col: &str, obj: &Map<String, Value>, key: &str) {
        let Some(v) = obj.get(key) else { return };
        if v.is_null() {
            self.clauses.push(format!("{col} IS NULL"));
        } else if let Some(iso) = parse_optional_iso(Some(v)) {
            self.clauses.push(format!("{col} = ?"));
            self.args.push(SqlVal::Text(iso));
        }
    }

    pub fn push_since(&mut self, col: &str, params_obj: &Value) {
        if let Some(iso) = parse_optional_iso(params_obj.get("since")) {
            self.clauses.push(format!("{col} >= ?"));
            self.args.push(SqlVal::Text(iso));
        }
    }

    pub fn push_in_strings(&mut self, col: &str, vals: &[String]) {
        if vals.is_empty() {
            return;
        }
        let placeholders = vec!["?"; vals.len()].join(",");
        self.clauses.push(format!("{col} IN ({placeholders})"));
        for s in vals {
            self.args.push(SqlVal::Text(s.clone()));
        }
    }

    pub fn push_in_i64s(&mut self, col: &str, vals: &[i64]) {
        if vals.is_empty() {
            return;
        }
        let placeholders = vec!["?"; vals.len()].join(",");
        self.clauses.push(format!("{col} IN ({placeholders})"));
        for n in vals {
            self.args.push(SqlVal::Integer(*n));
        }
    }

    pub fn where_sql(&self) -> String {
        if self.clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", self.clauses.join(" AND "))
        }
    }

    pub fn append_paging(&mut self, params_obj: &Value, ignore_offset: bool) -> String {
        let Some(paged) = params_obj.get("paged").and_then(|v| v.as_object()) else {
            return String::new();
        };
        let limit = paged.get("limit").and_then(|v| v.as_i64()).unwrap_or(0);
        let offset = if ignore_offset {
            0
        } else {
            paged.get("offset").and_then(|v| v.as_i64()).unwrap_or(0)
        };
        if limit > 0 {
            self.args.push(SqlVal::Integer(limit));
            if offset > 0 {
                self.args.push(SqlVal::Integer(offset));
                " LIMIT ? OFFSET ?".to_string()
            } else {
                " LIMIT ?".to_string()
            }
        } else if offset > 0 {
            self.args.push(SqlVal::Integer(offset));
            " LIMIT -1 OFFSET ?".to_string()
        } else {
            String::new()
        }
    }
}

pub fn val_to_bool(v: &Value) -> Option<bool> {
    if let Some(b) = v.as_bool() {
        return Some(b);
    }
    if let Some(n) = v.as_i64() {
        return Some(n != 0);
    }
    None
}

fn partial_map(params_obj: &Value) -> Map<String, Value> {
    params_obj
        .get("partial")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

fn string_list(params_obj: &Value, key: &str) -> Option<Vec<String>> {
    let arr = params_obj.get(key)?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|v| v.as_str().map(ToString::to_string))
            .collect(),
    )
}

fn i64_list(params_obj: &Value, key: &str) -> Option<Vec<i64>> {
    let arr = params_obj.get(key)?.as_array()?;
    Some(arr.iter().filter_map(|v| v.as_i64()).collect())
}

fn opt_insert_str(map: &mut Map<String, Value>, key: &str, val: Option<String>) {
    if let Some(s) = val {
        map.insert(key.into(), Value::String(s));
    }
}

fn opt_insert_i64(map: &mut Map<String, Value>, key: &str, val: Option<i64>) {
    if let Some(n) = val {
        map.insert(key.into(), json!(n));
    }
}

fn opt_insert_bool(map: &mut Map<String, Value>, key: &str, val: Option<i64>) {
    if let Some(n) = val {
        map.insert(key.into(), Value::Bool(n != 0));
    }
}

// ─── Settings & Meta & Identity Summary ───────────────────────────────────────

pub fn read_settings(conn: &Connection) -> OpResult {
    let row = conn
        .query_row(
            "SELECT storage_identity_key, created_at, updated_at, storage_name, chain, dbtype, max_output_script
             FROM settings LIMIT 1",
            [],
            |r| {
                Ok(json!({
                    "storageIdentityKey": r.get::<_, String>(0)?,
                    "created_at": r.get::<_, String>(1)?,
                    "updated_at": r.get::<_, String>(2)?,
                    "storageName": r.get::<_, String>(3)?,
                    "chain": r.get::<_, String>(4)?,
                    "dbtype": r.get::<_, String>(5)?,
                    "maxOutputScript": r.get::<_, i64>(6)?,
                }))
            },
        )
        .optional()
        .map_err(|e| db_err("readSettings", e))?;
    Ok(row.unwrap_or(Value::Null))
}

pub fn get_meta(conn: &Connection, params_obj: &Value) -> OpResult {
    let key = params_obj
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("missing key")?;
    let val: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| db_err("getMeta", e))?;
    Ok(val.map(Value::String).unwrap_or(Value::Null))
}

pub fn identity_summary(conn: &Connection, params_obj: &Value) -> OpResult {
    let identity_key = params_obj
        .get("identityKey")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let user_id: Option<i64> = conn
        .query_row(
            "SELECT user_id FROM users WHERE identity_key = ?1",
            params![identity_key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| db_err("identitySummary user", e))?;
    let Some(uid) = user_id else {
        return Ok(json!({ "stored": false, "txCount": Value::Null }));
    };
    let tx_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE user_id = ?1",
            params![uid],
            |r| r.get(0),
        )
        .map_err(|e| db_err("identitySummary count", e))?;
    Ok(json!({ "stored": true, "userId": uid, "txCount": tx_count }))
}

// ─── Users ────────────────────────────────────────────────────────────────────

fn build_users_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_pk("user_id", &p, "userId");
    f.push_eq_date("created_at", &p, "created_at");
    f.push_eq_date("updated_at", &p, "updated_at");
    if let Some(s) = p.get("identityKey").and_then(|v| v.as_str()) {
        if !s.is_empty() {
            f.push_param("identity_key = ?", SqlVal::Text(s.to_string()));
        }
    }
    if let Some(s) = p.get("activeStorage").and_then(|v| v.as_str()) {
        if !s.is_empty() {
            f.push_param("active_storage = ?", SqlVal::Text(s.to_string()));
        }
    }
    f.push_since("updated_at", params_obj);
    f
}

pub fn find_users(conn: &Connection, params_obj: &Value) -> OpResult {
    let mut f = build_users_filter(params_obj);
    let paging = f.append_paging(params_obj, false);
    let sql = format!(
        "SELECT user_id, created_at, updated_at, identity_key, active_storage FROM users{} ORDER BY user_id ASC{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| db_err("findUsers", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), |r| {
            Ok(json!({
                "userId": r.get::<_, i64>(0)?,
                "created_at": r.get::<_, String>(1)?,
                "updated_at": r.get::<_, String>(2)?,
                "identityKey": r.get::<_, String>(3)?,
                "activeStorage": r.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| db_err("findUsers query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| db_err("findUsers row", e))?);
    }
    Ok(Value::Array(out))
}

pub fn count_users(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_users_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM users{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countUsers", e))?;
    Ok(json!(n))
}

// ─── Output Baskets ───────────────────────────────────────────────────────────

fn build_output_baskets_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_pk("basket_id", &p, "basketId");
    f.push_eq_i64("user_id", &p, "userId");
    f.push_eq_date("created_at", &p, "created_at");
    f.push_eq_date("updated_at", &p, "updated_at");
    f.push_eq_str("name", &p, "name");
    f.push_eq_i64("number_of_desired_utxos", &p, "numberOfDesiredUTXOs");
    f.push_eq_i64("minimum_desired_utxo_value", &p, "minimumDesiredUTXOValue");
    f.push_eq_bool("is_deleted", &p, "isDeleted");
    f.push_since("updated_at", params_obj);
    f
}

pub fn find_output_baskets(conn: &Connection, params_obj: &Value) -> OpResult {
    let mut f = build_output_baskets_filter(params_obj);
    let paging = f.append_paging(params_obj, false);
    let sql = format!(
        "SELECT basket_id, created_at, updated_at, user_id, name, number_of_desired_utxos, minimum_desired_utxo_value, is_deleted
         FROM output_baskets{} ORDER BY basket_id ASC{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err("findOutputBaskets", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), |r| {
            Ok(json!({
                "basketId": r.get::<_, i64>(0)?,
                "created_at": r.get::<_, String>(1)?,
                "updated_at": r.get::<_, String>(2)?,
                "userId": r.get::<_, i64>(3)?,
                "name": r.get::<_, String>(4)?,
                "numberOfDesiredUTXOs": r.get::<_, i64>(5)?,
                "minimumDesiredUTXOValue": r.get::<_, i64>(6)?,
                "isDeleted": r.get::<_, i64>(7)? != 0,
            }))
        })
        .map_err(|e| db_err("findOutputBaskets query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| db_err("findOutputBaskets row", e))?);
    }
    Ok(Value::Array(out))
}

pub fn count_output_baskets(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_output_baskets_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM output_baskets{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countOutputBaskets", e))?;
    Ok(json!(n))
}

// ─── Output Tags & Maps ───────────────────────────────────────────────────────

fn build_output_tags_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_pk("output_tag_id", &p, "outputTagId");
    f.push_eq_i64("user_id", &p, "userId");
    f.push_eq_date("created_at", &p, "created_at");
    f.push_eq_date("updated_at", &p, "updated_at");
    f.push_eq_str("tag", &p, "tag");
    f.push_eq_bool("is_deleted", &p, "isDeleted");
    f.push_since("updated_at", params_obj);
    f
}

pub fn find_output_tags(conn: &Connection, params_obj: &Value) -> OpResult {
    let mut f = build_output_tags_filter(params_obj);
    let paging = f.append_paging(params_obj, false);
    let sql = format!(
        "SELECT output_tag_id, created_at, updated_at, user_id, tag, is_deleted
         FROM output_tags{} ORDER BY output_tag_id ASC{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| db_err("findOutputTags", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), |r| {
            Ok(json!({
                "outputTagId": r.get::<_, i64>(0)?,
                "created_at": r.get::<_, String>(1)?,
                "updated_at": r.get::<_, String>(2)?,
                "userId": r.get::<_, i64>(3)?,
                "tag": r.get::<_, String>(4)?,
                "isDeleted": r.get::<_, i64>(5)? != 0,
            }))
        })
        .map_err(|e| db_err("findOutputTags query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| db_err("findOutputTags row", e))?);
    }
    Ok(Value::Array(out))
}

pub fn count_output_tags(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_output_tags_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM output_tags{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countOutputTags", e))?;
    Ok(json!(n))
}

fn build_output_tag_maps_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_i64("m.output_tag_id", &p, "outputTagId");
    f.push_eq_i64("m.output_id", &p, "outputId");
    f.push_eq_date("m.created_at", &p, "created_at");
    f.push_eq_date("m.updated_at", &p, "updated_at");
    f.push_eq_bool("m.is_deleted", &p, "isDeleted");
    if let Some(tag_ids) = i64_list(params_obj, "tagIds") {
        if tag_ids.is_empty() {
            f.push_raw("1 = 0");
        } else {
            f.push_in_i64s("m.output_tag_id", &tag_ids);
        }
    }
    if let Some(uid) = params_obj.get("userId").and_then(|v| v.as_i64()) {
        f.push_param(
            "EXISTS (SELECT 1 FROM output_tags t WHERE t.output_tag_id = m.output_tag_id AND t.user_id = ?)",
            SqlVal::Integer(uid),
        );
    }
    f.push_since("m.updated_at", params_obj);
    f
}

pub fn find_output_tag_maps(conn: &Connection, params_obj: &Value) -> OpResult {
    let mut f = build_output_tag_maps_filter(params_obj);
    let paging = f.append_paging(params_obj, false);
    let sql = format!(
        "SELECT m.output_tag_id, m.output_id, m.created_at, m.updated_at, m.is_deleted
         FROM output_tags_map m{} ORDER BY m.output_tag_id ASC, m.output_id ASC{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err("findOutputTagMaps", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), |r| {
            Ok(json!({
                "outputTagId": r.get::<_, i64>(0)?,
                "outputId": r.get::<_, i64>(1)?,
                "created_at": r.get::<_, String>(2)?,
                "updated_at": r.get::<_, String>(3)?,
                "isDeleted": r.get::<_, i64>(4)? != 0,
            }))
        })
        .map_err(|e| db_err("findOutputTagMaps query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| db_err("findOutputTagMaps row", e))?);
    }
    Ok(Value::Array(out))
}

pub fn count_output_tag_maps(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_output_tag_maps_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM output_tags_map m{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countOutputTagMaps", e))?;
    Ok(json!(n))
}

pub fn get_tags_for_output_id(conn: &Connection, params_obj: &Value) -> OpResult {
    let output_id = params_obj
        .get("outputId")
        .and_then(|v| v.as_i64())
        .ok_or("missing outputId")?;
    let mut stmt = conn
        .prepare(
            "SELECT t.output_tag_id, t.created_at, t.updated_at, t.user_id, t.tag, t.is_deleted
             FROM output_tags_map m
             INNER JOIN output_tags t ON t.output_tag_id = m.output_tag_id
             WHERE m.output_id = ?1 AND m.is_deleted = 0 AND t.is_deleted = 0
             ORDER BY m.output_tag_id ASC",
        )
        .map_err(|e| db_err("getTagsForOutputId", e))?;
    let rows = stmt
        .query_map(params![output_id], |r| {
            Ok(json!({
                "outputTagId": r.get::<_, i64>(0)?,
                "created_at": r.get::<_, String>(1)?,
                "updated_at": r.get::<_, String>(2)?,
                "userId": r.get::<_, i64>(3)?,
                "tag": r.get::<_, String>(4)?,
                "isDeleted": r.get::<_, i64>(5)? != 0,
            }))
        })
        .map_err(|e| db_err("getTagsForOutputId query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| db_err("getTagsForOutputId row", e))?);
    }
    Ok(Value::Array(out))
}

// ─── Tx Labels & Maps ─────────────────────────────────────────────────────────

fn build_tx_labels_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_pk("tx_label_id", &p, "txLabelId");
    f.push_eq_i64("user_id", &p, "userId");
    f.push_eq_date("created_at", &p, "created_at");
    f.push_eq_date("updated_at", &p, "updated_at");
    f.push_eq_str("label", &p, "label");
    f.push_eq_bool("is_deleted", &p, "isDeleted");
    f.push_since("updated_at", params_obj);
    f
}

pub fn find_tx_labels(conn: &Connection, params_obj: &Value) -> OpResult {
    let mut f = build_tx_labels_filter(params_obj);
    let paging = f.append_paging(params_obj, false);
    let sql = format!(
        "SELECT tx_label_id, created_at, updated_at, user_id, label, is_deleted
         FROM tx_labels{} ORDER BY tx_label_id ASC{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| db_err("findTxLabels", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), |r| {
            Ok(json!({
                "txLabelId": r.get::<_, i64>(0)?,
                "created_at": r.get::<_, String>(1)?,
                "updated_at": r.get::<_, String>(2)?,
                "userId": r.get::<_, i64>(3)?,
                "label": r.get::<_, String>(4)?,
                "isDeleted": r.get::<_, i64>(5)? != 0,
            }))
        })
        .map_err(|e| db_err("findTxLabels query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| db_err("findTxLabels row", e))?);
    }
    Ok(Value::Array(out))
}

pub fn count_tx_labels(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_tx_labels_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM tx_labels{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countTxLabels", e))?;
    Ok(json!(n))
}

fn build_tx_label_maps_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_i64("m.tx_label_id", &p, "txLabelId");
    f.push_eq_i64("m.transaction_id", &p, "transactionId");
    f.push_eq_date("m.created_at", &p, "created_at");
    f.push_eq_date("m.updated_at", &p, "updated_at");
    f.push_eq_bool("m.is_deleted", &p, "isDeleted");
    if let Some(uid) = params_obj.get("userId").and_then(|v| v.as_i64()) {
        f.push_param(
            "EXISTS (SELECT 1 FROM tx_labels l WHERE l.tx_label_id = m.tx_label_id AND l.user_id = ?)",
            SqlVal::Integer(uid),
        );
    }
    f.push_since("m.updated_at", params_obj);
    f
}

pub fn find_tx_label_maps(conn: &Connection, params_obj: &Value) -> OpResult {
    let mut f = build_tx_label_maps_filter(params_obj);
    let paging = f.append_paging(params_obj, false);
    let sql = format!(
        "SELECT m.tx_label_id, m.transaction_id, m.created_at, m.updated_at, m.is_deleted
         FROM tx_labels_map m{} ORDER BY m.tx_label_id ASC, m.transaction_id ASC{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err("findTxLabelMaps", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), |r| {
            Ok(json!({
                "txLabelId": r.get::<_, i64>(0)?,
                "transactionId": r.get::<_, i64>(1)?,
                "created_at": r.get::<_, String>(2)?,
                "updated_at": r.get::<_, String>(3)?,
                "isDeleted": r.get::<_, i64>(4)? != 0,
            }))
        })
        .map_err(|e| db_err("findTxLabelMaps query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| db_err("findTxLabelMaps row", e))?);
    }
    Ok(Value::Array(out))
}

pub fn count_tx_label_maps(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_tx_label_maps_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM tx_labels_map m{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countTxLabelMaps", e))?;
    Ok(json!(n))
}

pub fn get_labels_for_transaction_id(conn: &Connection, params_obj: &Value) -> OpResult {
    let Some(transaction_id) = params_obj.get("transactionId").and_then(|v| v.as_i64()) else {
        return Ok(Value::Array(Vec::new()));
    };
    let mut stmt = conn
        .prepare(
            "SELECT l.tx_label_id, l.created_at, l.updated_at, l.user_id, l.label, l.is_deleted
             FROM tx_labels_map m
             INNER JOIN tx_labels l ON l.tx_label_id = m.tx_label_id
             WHERE m.transaction_id = ?1 AND m.is_deleted = 0 AND l.is_deleted = 0
             ORDER BY m.tx_label_id ASC",
        )
        .map_err(|e| db_err("getLabelsForTransactionId", e))?;
    let rows = stmt
        .query_map(params![transaction_id], |r| {
            Ok(json!({
                "txLabelId": r.get::<_, i64>(0)?,
                "created_at": r.get::<_, String>(1)?,
                "updated_at": r.get::<_, String>(2)?,
                "userId": r.get::<_, i64>(3)?,
                "label": r.get::<_, String>(4)?,
                "isDeleted": r.get::<_, i64>(5)? != 0,
            }))
        })
        .map_err(|e| db_err("getLabelsForTransactionId query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| db_err("getLabelsForTransactionId row", e))?);
    }
    Ok(Value::Array(out))
}

// ─── Certificates & Fields ────────────────────────────────────────────────────

fn build_certificate_fields_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_i64("user_id", &p, "userId");
    f.push_eq_i64("certificate_id", &p, "certificateId");
    f.push_eq_date("created_at", &p, "created_at");
    f.push_eq_date("updated_at", &p, "updated_at");
    f.push_eq_str("field_name", &p, "fieldName");
    f.push_eq_str("field_value", &p, "fieldValue");
    f.push_eq_str("master_key", &p, "masterKey");
    f.push_since("updated_at", params_obj);
    f
}

pub fn find_certificate_fields(conn: &Connection, params_obj: &Value) -> OpResult {
    let mut f = build_certificate_fields_filter(params_obj);
    let paging = f.append_paging(params_obj, false);
    let sql = format!(
        "SELECT certificate_id, field_name, created_at, updated_at, user_id, field_value, master_key
         FROM certificate_fields{} ORDER BY certificate_id ASC, field_name ASC{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err("findCertificateFields", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), |r| {
            Ok(json!({
                "certificateId": r.get::<_, i64>(0)?,
                "fieldName": r.get::<_, String>(1)?,
                "created_at": r.get::<_, String>(2)?,
                "updated_at": r.get::<_, String>(3)?,
                "userId": r.get::<_, i64>(4)?,
                "fieldValue": r.get::<_, String>(5)?,
                "masterKey": r.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| db_err("findCertificateFields query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| db_err("findCertificateFields row", e))?);
    }
    Ok(Value::Array(out))
}

pub fn count_certificate_fields(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_certificate_fields_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM certificate_fields{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countCertificateFields", e))?;
    Ok(json!(n))
}

fn build_certificates_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_pk("certificate_id", &p, "certificateId");
    f.push_eq_i64("user_id", &p, "userId");
    f.push_eq_date("created_at", &p, "created_at");
    f.push_eq_date("updated_at", &p, "updated_at");
    f.push_eq_str("type", &p, "type");
    f.push_eq_str("serial_number", &p, "serialNumber");
    f.push_eq_str("certifier", &p, "certifier");
    f.push_eq_str("subject", &p, "subject");
    f.push_eq_str("verifier", &p, "verifier");
    f.push_eq_str("revocation_outpoint", &p, "revocationOutpoint");
    f.push_eq_str("signature", &p, "signature");
    f.push_eq_bool("is_deleted", &p, "isDeleted");
    if let Some(certs) = string_list(params_obj, "certifiers") {
        if certs.is_empty() {
            f.push_raw("1 = 0");
        } else {
            f.push_in_strings("certifier", &certs);
        }
    }
    if let Some(types) = string_list(params_obj, "types") {
        if types.is_empty() {
            f.push_raw("1 = 0");
        } else {
            f.push_in_strings("type", &types);
        }
    }
    f.push_since("updated_at", params_obj);
    f
}

pub fn find_certificates(conn: &Connection, params_obj: &Value) -> OpResult {
    let include_fields = params_obj
        .get("includeFields")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut f = build_certificates_filter(params_obj);
    let paging = f.append_paging(params_obj, false);
    let sql = format!(
        "SELECT certificate_id, created_at, updated_at, user_id, type, serial_number, certifier, subject, verifier, revocation_outpoint, signature, is_deleted
         FROM certificates{} ORDER BY certificate_id ASC{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err("findCertificates", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), |r| {
            let mut m = Map::new();
            m.insert("certificateId".into(), json!(r.get::<_, i64>(0)?));
            m.insert("created_at".into(), json!(r.get::<_, String>(1)?));
            m.insert("updated_at".into(), json!(r.get::<_, String>(2)?));
            m.insert("userId".into(), json!(r.get::<_, i64>(3)?));
            m.insert("type".into(), json!(r.get::<_, String>(4)?));
            m.insert("serialNumber".into(), json!(r.get::<_, String>(5)?));
            m.insert("certifier".into(), json!(r.get::<_, String>(6)?));
            m.insert("subject".into(), json!(r.get::<_, String>(7)?));
            opt_insert_str(&mut m, "verifier", r.get::<_, Option<String>>(8)?);
            m.insert("revocationOutpoint".into(), json!(r.get::<_, String>(9)?));
            m.insert("signature".into(), json!(r.get::<_, String>(10)?));
            m.insert("isDeleted".into(), json!(r.get::<_, i64>(11)? != 0));
            Ok(Value::Object(m))
        })
        .map_err(|e| db_err("findCertificates query", e))?;
    let mut out = Vec::new();
    for r in rows {
        let mut cert = r.map_err(|e| db_err("findCertificates row", e))?;
        if include_fields {
            let cert_id = cert["certificateId"].as_i64().unwrap_or(0);
            let fields = find_certificate_fields(
                conn,
                &json!({ "partial": { "certificateId": cert_id } }),
            )?;
            if let Some(obj) = cert.as_object_mut() {
                obj.insert("fields".into(), fields);
            }
        }
        out.push(cert);
    }
    Ok(Value::Array(out))
}

pub fn count_certificates(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_certificates_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM certificates{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countCertificates", e))?;
    Ok(json!(n))
}

// ─── Commissions ──────────────────────────────────────────────────────────────

fn build_commissions_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_pk("commission_id", &p, "commissionId");
    f.push_eq_i64("transaction_id", &p, "transactionId");
    f.push_eq_i64("user_id", &p, "userId");
    f.push_eq_date("created_at", &p, "created_at");
    f.push_eq_date("updated_at", &p, "updated_at");
    f.push_eq_i64("satoshis", &p, "satoshis");
    f.push_eq_str("key_offset", &p, "keyOffset");
    f.push_eq_bool("is_redeemed", &p, "isRedeemed");
    f.push_since("updated_at", params_obj);
    f
}

pub fn find_commissions(conn: &Connection, params_obj: &Value) -> OpResult {
    let mut f = build_commissions_filter(params_obj);
    let paging = f.append_paging(params_obj, false);
    let sql = format!(
        "SELECT commission_id, created_at, updated_at, user_id, transaction_id, satoshis, key_offset, is_redeemed, locking_script_hash
         FROM commissions{} ORDER BY commission_id ASC{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err("findCommissions", e))?;
    let raw_rows: Vec<(Map<String, Value>, String)> = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), |r| {
            let mut m = Map::new();
            m.insert("commissionId".into(), json!(r.get::<_, i64>(0)?));
            m.insert("created_at".into(), json!(r.get::<_, String>(1)?));
            m.insert("updated_at".into(), json!(r.get::<_, String>(2)?));
            m.insert("userId".into(), json!(r.get::<_, i64>(3)?));
            m.insert("transactionId".into(), json!(r.get::<_, i64>(4)?));
            m.insert("satoshis".into(), json!(r.get::<_, i64>(5)?));
            m.insert("keyOffset".into(), json!(r.get::<_, String>(6)?));
            m.insert("isRedeemed".into(), json!(r.get::<_, i64>(7)? != 0));
            Ok((m, r.get::<_, String>(8)?))
        })
        .map_err(|e| db_err("findCommissions query", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| db_err("findCommissions row", e))?;
    let mut out = Vec::with_capacity(raw_rows.len());
    for (mut m, hash) in raw_rows {
        let bytes = get_cold_blob(conn, &hash)
            .map_err(|e| db_err("findCommissions blob", e))?
            .unwrap_or_default();
        m.insert("lockingScriptB64".into(), Value::String(encode_b64(&bytes)));
        out.push(Value::Object(m));
    }
    Ok(Value::Array(out))
}

pub fn count_commissions(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_commissions_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM commissions{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countCommissions", e))?;
    Ok(json!(n))
}

// ─── Monitor Events ───────────────────────────────────────────────────────────

fn build_monitor_events_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_pk("id", &p, "id");
    f.push_eq_date("created_at", &p, "created_at");
    f.push_eq_date("updated_at", &p, "updated_at");
    f.push_eq_str("event", &p, "event");
    f.push_eq_str("details", &p, "details");
    f.push_since("updated_at", params_obj);
    f
}

pub fn find_monitor_events(conn: &Connection, params_obj: &Value) -> OpResult {
    let mut f = build_monitor_events_filter(params_obj);
    let paging = f.append_paging(params_obj, false);
    let sql = format!(
        "SELECT id, created_at, updated_at, event, details FROM monitor_events{} ORDER BY id ASC{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err("findMonitorEvents", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), |r| {
            let mut m = Map::new();
            m.insert("id".into(), json!(r.get::<_, i64>(0)?));
            m.insert("created_at".into(), json!(r.get::<_, String>(1)?));
            m.insert("updated_at".into(), json!(r.get::<_, String>(2)?));
            m.insert("event".into(), json!(r.get::<_, String>(3)?));
            opt_insert_str(&mut m, "details", r.get::<_, Option<String>>(4)?);
            Ok(Value::Object(m))
        })
        .map_err(|e| db_err("findMonitorEvents query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| db_err("findMonitorEvents row", e))?);
    }
    Ok(Value::Array(out))
}

pub fn count_monitor_events(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_monitor_events_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM monitor_events{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countMonitorEvents", e))?;
    Ok(json!(n))
}

// ─── Sync States ──────────────────────────────────────────────────────────────

fn build_sync_states_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_pk("sync_state_id", &p, "syncStateId");
    f.push_eq_i64("user_id", &p, "userId");
    f.push_eq_date("created_at", &p, "created_at");
    f.push_eq_date("updated_at", &p, "updated_at");
    f.push_eq_str("storage_identity_key", &p, "storageIdentityKey");
    f.push_eq_str("storage_name", &p, "storageName");
    f.push_eq_str("status", &p, "status");
    f.push_eq_bool("init", &p, "init");
    f.push_eq_str("ref_num", &p, "refNum");
    f.push_eq_date("when_at", &p, "when");
    f.push_eq_i64("satoshis", &p, "satoshis");
    f.push_eq_str("error_local", &p, "errorLocal");
    f.push_eq_str("error_other", &p, "errorOther");
    f.push_since("updated_at", params_obj);
    f
}

pub fn find_sync_states(conn: &Connection, params_obj: &Value) -> OpResult {
    let mut f = build_sync_states_filter(params_obj);
    let paging = f.append_paging(params_obj, false);
    let sql = format!(
        "SELECT sync_state_id, created_at, updated_at, user_id, storage_identity_key, storage_name, status, init, ref_num, sync_map, when_at, satoshis, error_local, error_other
         FROM sync_states{} ORDER BY sync_state_id ASC{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err("findSyncStates", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), |r| {
            let mut m = Map::new();
            m.insert("syncStateId".into(), json!(r.get::<_, i64>(0)?));
            m.insert("created_at".into(), json!(r.get::<_, String>(1)?));
            m.insert("updated_at".into(), json!(r.get::<_, String>(2)?));
            m.insert("userId".into(), json!(r.get::<_, i64>(3)?));
            m.insert("storageIdentityKey".into(), json!(r.get::<_, String>(4)?));
            m.insert("storageName".into(), json!(r.get::<_, String>(5)?));
            m.insert("status".into(), json!(r.get::<_, String>(6)?));
            m.insert("init".into(), json!(r.get::<_, i64>(7)? != 0));
            m.insert("refNum".into(), json!(r.get::<_, String>(8)?));
            m.insert("syncMap".into(), json!(r.get::<_, String>(9)?));
            opt_insert_str(&mut m, "when", r.get::<_, Option<String>>(10)?);
            opt_insert_i64(&mut m, "satoshis", r.get::<_, Option<i64>>(11)?);
            opt_insert_str(&mut m, "errorLocal", r.get::<_, Option<String>>(12)?);
            opt_insert_str(&mut m, "errorOther", r.get::<_, Option<String>>(13)?);
            Ok(Value::Object(m))
        })
        .map_err(|e| db_err("findSyncStates query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| db_err("findSyncStates row", e))?);
    }
    Ok(Value::Array(out))
}

pub fn count_sync_states(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_sync_states_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM sync_states{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countSyncStates", e))?;
    Ok(json!(n))
}

// ─── Proven Txs ───────────────────────────────────────────────────────────────

fn build_proven_txs_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_pk("p.proven_tx_id", &p, "provenTxId");
    f.push_eq_date("p.created_at", &p, "created_at");
    f.push_eq_date("p.updated_at", &p, "updated_at");
    f.push_eq_str("p.txid", &p, "txid");
    f.push_eq_i64("p.height", &p, "height");
    f.push_eq_i64("p.tx_index", &p, "index");
    f.push_eq_str("p.block_hash", &p, "blockHash");
    f.push_eq_str("p.merkle_root", &p, "merkleRoot");
    if let Some(txids) = string_list(params_obj, "txids") {
        if !txids.is_empty() {
            f.push_in_strings("p.txid", &txids);
        }
    }
    if let Some(uid) = params_obj.get("userId").and_then(|v| v.as_i64()) {
        f.push_param(
            "EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = ? AND t.proven_tx_id = p.proven_tx_id)",
            SqlVal::Integer(uid),
        );
    }
    f.push_since("p.updated_at", params_obj);
    f
}

struct ProvenTxRowRaw {
    json: Map<String, Value>,
    merkle_path_hash: String,
    raw_tx_hash: String,
}

fn read_proven_tx_row(r: &Row<'_>) -> rusqlite::Result<ProvenTxRowRaw> {
    let mut m = Map::new();
    m.insert("provenTxId".into(), json!(r.get::<_, i64>(0)?));
    m.insert("created_at".into(), json!(r.get::<_, String>(1)?));
    m.insert("updated_at".into(), json!(r.get::<_, String>(2)?));
    m.insert("txid".into(), json!(r.get::<_, String>(3)?));
    m.insert("height".into(), json!(r.get::<_, i64>(4)?));
    m.insert("index".into(), json!(r.get::<_, i64>(5)?));
    m.insert("blockHash".into(), json!(r.get::<_, String>(8)?));
    m.insert("merkleRoot".into(), json!(r.get::<_, String>(9)?));
    Ok(ProvenTxRowRaw {
        json: m,
        merkle_path_hash: r.get(6)?,
        raw_tx_hash: r.get(7)?,
    })
}

pub fn find_proven_txs(conn: &Connection, params_obj: &Value) -> OpResult {
    let mut f = build_proven_txs_filter(params_obj);
    let desc = params_obj
        .get("orderDescending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let paging = f.append_paging(params_obj, false);
    let dir = if desc { "DESC" } else { "ASC" };
    let sql = format!(
        "SELECT p.proven_tx_id, p.created_at, p.updated_at, p.txid, p.height, p.tx_index, p.merkle_path_hash, p.raw_tx_hash, p.block_hash, p.merkle_root
         FROM proven_txs p{} ORDER BY p.proven_tx_id {dir}{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| db_err("findProvenTxs", e))?;
    let raw_rows: Vec<ProvenTxRowRaw> = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), read_proven_tx_row)
        .map_err(|e| db_err("findProvenTxs query", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| db_err("findProvenTxs row", e))?;
    let mut out = Vec::with_capacity(raw_rows.len());
    for mut item in raw_rows {
        let mp = get_cold_blob(conn, &item.merkle_path_hash)
            .map_err(|e| db_err("proven_tx merklePath blob", e))?
            .unwrap_or_default();
        let rt = get_cold_blob(conn, &item.raw_tx_hash)
            .map_err(|e| db_err("proven_tx rawTx blob", e))?
            .unwrap_or_default();
        item.json
            .insert("merklePathB64".into(), Value::String(encode_b64(&mp)));
        item.json
            .insert("rawTxB64".into(), Value::String(encode_b64(&rt)));
        out.push(Value::Object(item.json));
    }
    Ok(Value::Array(out))
}

pub fn count_proven_txs(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_proven_txs_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM proven_txs p{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countProvenTxs", e))?;
    Ok(json!(n))
}

// ─── Proven Tx Reqs ───────────────────────────────────────────────────────────

fn build_proven_tx_reqs_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_pk("r.proven_tx_req_id", &p, "provenTxReqId");
    f.push_eq_i64("r.proven_tx_id", &p, "provenTxId");
    f.push_eq_date("r.created_at", &p, "created_at");
    f.push_eq_date("r.updated_at", &p, "updated_at");
    f.push_eq_str("r.status", &p, "status");
    f.push_eq_i64("r.attempts", &p, "attempts");
    f.push_eq_bool("r.notified", &p, "notified");
    f.push_eq_str("r.txid", &p, "txid");
    f.push_eq_str("r.batch", &p, "batch");
    f.push_eq_str("r.history", &p, "history");
    f.push_eq_str("r.notify", &p, "notify");
    f.push_eq_bool("r.was_broadcast", &p, "wasBroadcast");
    f.push_eq_i64("r.rebroadcast_attempts", &p, "rebroadcastAttempts");
    if let Some(statuses) = string_list(params_obj, "status") {
        if !statuses.is_empty() {
            f.push_in_strings("r.status", &statuses);
        }
    }
    if let Some(txids) = string_list(params_obj, "txids") {
        if !txids.is_empty() {
            f.push_in_strings("r.txid", &txids);
        }
    }
    if let Some(uid) = params_obj.get("userId").and_then(|v| v.as_i64()) {
        f.push_param(
            "EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = ? AND t.txid = r.txid)",
            SqlVal::Integer(uid),
        );
    }
    f.push_since("r.updated_at", params_obj);
    f
}

struct ProvenTxReqRowRaw {
    json: Map<String, Value>,
    raw_tx_hash: String,
    input_beef_hash: Option<String>,
}

fn read_proven_tx_req_row(r: &Row<'_>) -> rusqlite::Result<ProvenTxReqRowRaw> {
    let mut m = Map::new();
    m.insert("provenTxReqId".into(), json!(r.get::<_, i64>(0)?));
    m.insert("created_at".into(), json!(r.get::<_, String>(1)?));
    m.insert("updated_at".into(), json!(r.get::<_, String>(2)?));
    opt_insert_i64(&mut m, "provenTxId", r.get::<_, Option<i64>>(3)?);
    m.insert("status".into(), json!(r.get::<_, String>(4)?));
    m.insert("attempts".into(), json!(r.get::<_, i64>(5)?));
    m.insert("notified".into(), json!(r.get::<_, i64>(6)? != 0));
    m.insert("txid".into(), json!(r.get::<_, String>(7)?));
    opt_insert_str(&mut m, "batch", r.get::<_, Option<String>>(8)?);
    m.insert("history".into(), json!(r.get::<_, String>(9)?));
    m.insert("notify".into(), json!(r.get::<_, String>(10)?));
    opt_insert_bool(&mut m, "wasBroadcast", r.get::<_, Option<i64>>(13)?);
    opt_insert_i64(&mut m, "rebroadcastAttempts", r.get::<_, Option<i64>>(14)?);
    Ok(ProvenTxReqRowRaw {
        json: m,
        raw_tx_hash: r.get(11)?,
        input_beef_hash: r.get(12)?,
    })
}

pub fn find_proven_tx_reqs(conn: &Connection, params_obj: &Value) -> OpResult {
    let mut f = build_proven_tx_reqs_filter(params_obj);
    let desc = params_obj
        .get("orderDescending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let no_raw = params_obj
        .get("noRawTx")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let paging = f.append_paging(params_obj, false);
    let dir = if desc { "DESC" } else { "ASC" };
    let sql = format!(
        "SELECT r.proven_tx_req_id, r.created_at, r.updated_at, r.proven_tx_id, r.status, r.attempts, r.notified,
                r.txid, r.batch, r.history, r.notify, r.raw_tx_hash, r.input_beef_hash, r.was_broadcast, r.rebroadcast_attempts
         FROM proven_tx_reqs r{} ORDER BY r.proven_tx_req_id {dir}{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err("findProvenTxReqs", e))?;
    let raw_rows: Vec<ProvenTxReqRowRaw> = stmt
        .query_map(
            rusqlite::params_from_iter(f.args.iter()),
            read_proven_tx_req_row,
        )
        .map_err(|e| db_err("findProvenTxReqs query", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| db_err("findProvenTxReqs row", e))?;
    let mut out = Vec::with_capacity(raw_rows.len());
    for mut item in raw_rows {
        if !no_raw {
            let rt = get_cold_blob(conn, &item.raw_tx_hash)
                .map_err(|e| db_err("proven_tx_req rawTx blob", e))?
                .unwrap_or_default();
            item.json
                .insert("rawTxB64".into(), Value::String(encode_b64(&rt)));
            if let Some(ref h) = item.input_beef_hash {
                if let Some(beef) =
                    get_cold_blob(conn, h).map_err(|e| db_err("proven_tx_req inputBEEF blob", e))?
                {
                    item.json
                        .insert("inputBEEFB64".into(), Value::String(encode_b64(&beef)));
                }
            }
        }
        out.push(Value::Object(item.json));
    }
    Ok(Value::Array(out))
}

pub fn count_proven_tx_reqs(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_proven_tx_reqs_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM proven_tx_reqs r{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countProvenTxReqs", e))?;
    Ok(json!(n))
}

// ─── Raw Tx & Proof Batch Resolution ──────────────────────────────────────────

const USABLE_FULL_REQ_STATUSES: &[&str] = &[
    "unsent",
    "unmined",
    "unconfirmed",
    "sending",
    "nosend",
    "completed",
];

const USABLE_SLICE_REQ_STATUSES: &[&str] = &[
    "unsent",
    "nosend",
    "sending",
    "unmined",
    "completed",
    "unfail",
];

/// Look up the cold blob hash of a valid rawTx for `txid` (proven first, else req).
pub fn lookup_raw_tx_hash(
    conn: &Connection,
    txid: &str,
    for_slice: bool,
) -> rusqlite::Result<Option<String>> {
    if let Some(hash) = conn
        .query_row(
            "SELECT raw_tx_hash FROM proven_txs WHERE txid = ?1",
            params![txid],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(Some(hash));
    }
    let req: Option<(String, String)> = conn
        .query_row(
            "SELECT status, raw_tx_hash FROM proven_tx_reqs WHERE txid = ?1",
            params![txid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let valid = if for_slice {
        USABLE_SLICE_REQ_STATUSES
    } else {
        USABLE_FULL_REQ_STATUSES
    };
    if let Some((status, hash)) = req {
        if valid.contains(&status.as_str()) {
            return Ok(Some(hash));
        }
    }
    Ok(None)
}

pub fn get_proven_or_raw_txs(conn: &Connection, params_obj: &Value) -> OpResult {
    let txids = string_list(params_obj, "txids").unwrap_or_default();
    let mut out = Map::new();
    let mut seen = HashSet::new();
    for txid in txids {
        if !seen.insert(txid.clone()) {
            continue;
        }
        let proven: Option<ProvenTxRowRaw> = conn
            .query_row(
                "SELECT proven_tx_id, created_at, updated_at, txid, height, tx_index, merkle_path_hash, raw_tx_hash, block_hash, merkle_root
                 FROM proven_txs WHERE txid = ?1",
                params![&txid],
                read_proven_tx_row,
            )
            .optional()
            .map_err(|e| db_err("getProvenOrRawTxs proven", e))?;
        if let Some(mut p) = proven {
            let mp = get_cold_blob(conn, &p.merkle_path_hash)
                .map_err(|e| db_err("getProvenOrRawTxs mp", e))?
                .unwrap_or_default();
            let rt = get_cold_blob(conn, &p.raw_tx_hash)
                .map_err(|e| db_err("getProvenOrRawTxs rt", e))?
                .unwrap_or_default();
            p.json
                .insert("merklePathB64".into(), Value::String(encode_b64(&mp)));
            p.json
                .insert("rawTxB64".into(), Value::String(encode_b64(&rt)));
            out.insert(txid, json!({ "proven": Value::Object(p.json) }));
            continue;
        }
        let req: Option<(String, String, Option<String>)> = conn
            .query_row(
                "SELECT status, raw_tx_hash, input_beef_hash FROM proven_tx_reqs WHERE txid = ?1",
                params![&txid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| db_err("getProvenOrRawTxs req", e))?;
        if let Some((status, raw_hash, beef_hash)) = req {
            if USABLE_FULL_REQ_STATUSES.contains(&status.as_str()) {
                let mut entry = Map::new();
                if let Some(rt) = get_cold_blob(conn, &raw_hash)
                    .map_err(|e| db_err("getProvenOrRawTxs req rt", e))?
                {
                    entry.insert("rawTxB64".into(), Value::String(encode_b64(&rt)));
                }
                if let Some(bh) = beef_hash {
                    if let Some(bf) = get_cold_blob(conn, &bh)
                        .map_err(|e| db_err("getProvenOrRawTxs req beef", e))?
                    {
                        entry.insert("inputBEEFB64".into(), Value::String(encode_b64(&bf)));
                    }
                }
                out.insert(txid, Value::Object(entry));
                continue;
            }
        }
        out.insert(txid, json!({}));
    }
    Ok(Value::Object(out))
}

pub fn get_raw_tx_of_known_valid_transaction(conn: &Connection, params_obj: &Value) -> OpResult {
    let txid = params_obj
        .get("txid")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if txid.is_empty() {
        return Ok(Value::Null);
    }
    let offset = params_obj.get("offset").and_then(|v| v.as_u64());
    let length = params_obj.get("length").and_then(|v| v.as_u64());
    let slice_requested = offset.is_some() && length.is_some();

    let Some(hash) = lookup_raw_tx_hash(conn, txid, slice_requested)
        .map_err(|e| db_err("getRawTx hash", e))?
    else {
        return Ok(Value::Null);
    };
    let bytes = if let (Some(off), Some(len)) = (offset, length) {
        get_cold_blob_slice(conn, &hash, off as usize, len as usize)
            .map_err(|e| db_err("getRawTx slice", e))?
    } else {
        get_cold_blob(conn, &hash).map_err(|e| db_err("getRawTx blob", e))?
    };
    Ok(bytes
        .map(|b| Value::String(encode_b64(&b)))
        .unwrap_or(Value::Null))
}

pub fn get_raw_txs_for_script_slices(conn: &Connection, params_obj: &Value) -> OpResult {
    let txids = string_list(params_obj, "txids").unwrap_or_default();
    let mut out = Map::new();
    let mut seen = HashSet::new();
    for txid in txids {
        if txid.is_empty() || !seen.insert(txid.clone()) {
            continue;
        }
        if let Some(hash) =
            lookup_raw_tx_hash(conn, &txid, true).map_err(|e| db_err("scriptSlices hash", e))?
        {
            if let Some(bytes) =
                get_cold_blob(conn, &hash).map_err(|e| db_err("scriptSlices blob", e))?
            {
                out.insert(txid, Value::String(encode_b64(&bytes)));
            }
        }
    }
    Ok(Value::Object(out))
}

// ─── Transactions ─────────────────────────────────────────────────────────────

fn build_transactions_filter(params_obj: &Value) -> SqlFilter {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_pk("t.transaction_id", &p, "transactionId");
    f.push_eq_i64("t.user_id", &p, "userId");
    f.push_eq_date("t.created_at", &p, "created_at");
    f.push_eq_date("t.updated_at", &p, "updated_at");
    f.push_eq_i64("t.proven_tx_id", &p, "provenTxId");
    f.push_eq_str("t.status", &p, "status");
    f.push_eq_str("t.reference", &p, "reference");
    f.push_eq_bool("t.is_outgoing", &p, "isOutgoing");
    f.push_eq_i64("t.satoshis", &p, "satoshis");
    f.push_eq_str("t.description", &p, "description");
    f.push_eq_i64("t.version", &p, "version");
    f.push_eq_i64("t.lock_time", &p, "lockTime");
    f.push_eq_str("t.txid", &p, "txid");
    f.push_eq_str("t.no_send_expiry_mode", &p, "noSendExpiryMode");
    f.push_eq_i64("t.no_send_expiry_value", &p, "noSendExpiryValue");
    f.push_eq_i64("t.no_send_expiry_deadline", &p, "noSendExpiryDeadline");
    f.push_eq_str("t.no_send_expiry_state", &p, "noSendExpiryState");
    f.push_eq_str("t.no_send_expiry_anchor_txid", &p, "noSendExpiryAnchorTxid");
    f.push_eq_i64("t.no_send_expiry_anchor_vout", &p, "noSendExpiryAnchorVout");
    f.push_eq_i64("t.no_send_expiry_released_at", &p, "noSendExpiryReleasedAt");
    f.push_eq_i64("t.no_send_expiry_observed_at", &p, "noSendExpiryObservedAt");
    f.push_eq_str(
        "t.no_send_expiry_reclaim_txid",
        &p,
        "noSendExpiryReclaimTxid",
    );
    f.push_eq_str(
        "t.no_send_expiry_reclaim_derivation_prefix",
        &p,
        "noSendExpiryReclaimDerivationPrefix",
    );
    f.push_eq_str(
        "t.no_send_expiry_reclaim_derivation_suffix",
        &p,
        "noSendExpiryReclaimDerivationSuffix",
    );
    f.push_eq_i64(
        "t.no_send_expiry_reclaim_satoshis",
        &p,
        "noSendExpiryReclaimSatoshis",
    );

    if let Some(statuses) = string_list(params_obj, "status") {
        if statuses.is_empty() {
            f.push_raw("1 = 0");
        } else {
            f.push_in_strings("t.status", &statuses);
        }
    }
    if let Some(from) = parse_optional_iso(params_obj.get("from")) {
        f.push_param("t.created_at >= ?", SqlVal::Text(from));
    }
    if let Some(to) = parse_optional_iso(params_obj.get("to")) {
        f.push_param("t.created_at < ?", SqlVal::Text(to));
    }
    if let Some(label_ids) = i64_list(params_obj, "labelIds") {
        if !label_ids.is_empty() {
            let unique: Vec<i64> = {
                let mut seen = HashSet::new();
                label_ids.into_iter().filter(|id| seen.insert(*id)).collect()
            };
            let is_all = params_obj
                .get("isQueryModeAll")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let ph = vec!["?"; unique.len()].join(",");
            if is_all {
                f.clauses.push(format!(
                    "(SELECT COUNT(DISTINCT lm.tx_label_id) FROM tx_labels_map lm WHERE lm.transaction_id = t.transaction_id AND lm.is_deleted = 0 AND lm.tx_label_id IN ({ph})) = ?"
                ));
                for id in &unique {
                    f.args.push(SqlVal::Integer(*id));
                }
                f.args.push(SqlVal::Integer(unique.len() as i64));
            } else {
                f.clauses.push(format!(
                    "EXISTS (SELECT 1 FROM tx_labels_map lm WHERE lm.transaction_id = t.transaction_id AND lm.is_deleted = 0 AND lm.tx_label_id IN ({ph}))"
                ));
                for id in &unique {
                    f.args.push(SqlVal::Integer(*id));
                }
            }
        }
    }
    let desc = params_obj
        .get("orderDescending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if let Some(after_id) = params_obj.get("afterTransactionId").and_then(|v| v.as_i64()) {
        if desc {
            f.push_param("t.transaction_id < ?", SqlVal::Integer(after_id));
        } else {
            f.push_param("t.transaction_id > ?", SqlVal::Integer(after_id));
        }
    }
    f.push_since("t.updated_at", params_obj);
    f
}

struct TxRowRaw {
    json: Map<String, Value>,
    txid: Option<String>,
    input_beef_hash: Option<String>,
    raw_tx_hash: Option<String>,
    reclaim_raw_tx_hash: Option<String>,
}

fn read_tx_row(r: &Row<'_>) -> rusqlite::Result<TxRowRaw> {
    let mut m = Map::new();
    m.insert("transactionId".into(), json!(r.get::<_, i64>(0)?));
    m.insert("created_at".into(), json!(r.get::<_, String>(1)?));
    m.insert("updated_at".into(), json!(r.get::<_, String>(2)?));
    m.insert("userId".into(), json!(r.get::<_, i64>(3)?));
    opt_insert_i64(&mut m, "provenTxId", r.get::<_, Option<i64>>(4)?);
    m.insert("status".into(), json!(r.get::<_, String>(5)?));
    m.insert("reference".into(), json!(r.get::<_, String>(6)?));
    m.insert("isOutgoing".into(), json!(r.get::<_, i64>(7)? != 0));
    m.insert("satoshis".into(), json!(r.get::<_, i64>(8)?));
    m.insert("description".into(), json!(r.get::<_, String>(9)?));
    opt_insert_i64(&mut m, "version", r.get::<_, Option<i64>>(10)?);
    opt_insert_i64(&mut m, "lockTime", r.get::<_, Option<i64>>(11)?);
    let txid: Option<String> = r.get(12)?;
    opt_insert_str(&mut m, "txid", txid.clone());
    let input_beef_hash: Option<String> = r.get(13)?;
    let raw_tx_hash: Option<String> = r.get(14)?;
    opt_insert_str(&mut m, "noSendExpiryMode", r.get(15)?);
    opt_insert_i64(&mut m, "noSendExpiryValue", r.get(16)?);
    opt_insert_i64(&mut m, "noSendExpiryDeadline", r.get(17)?);
    opt_insert_str(&mut m, "noSendExpiryState", r.get(18)?);
    opt_insert_str(&mut m, "noSendExpiryAnchorTxid", r.get(19)?);
    opt_insert_i64(&mut m, "noSendExpiryAnchorVout", r.get(20)?);
    opt_insert_i64(&mut m, "noSendExpiryReleasedAt", r.get(21)?);
    opt_insert_i64(&mut m, "noSendExpiryObservedAt", r.get(22)?);
    opt_insert_str(&mut m, "noSendExpiryReclaimTxid", r.get(23)?);
    let reclaim_raw_tx_hash: Option<String> = r.get(24)?;
    opt_insert_str(&mut m, "noSendExpiryReclaimDerivationPrefix", r.get(25)?);
    opt_insert_str(&mut m, "noSendExpiryReclaimDerivationSuffix", r.get(26)?);
    opt_insert_i64(&mut m, "noSendExpiryReclaimSatoshis", r.get(27)?);
    Ok(TxRowRaw {
        json: m,
        txid,
        input_beef_hash,
        raw_tx_hash,
        reclaim_raw_tx_hash,
    })
}

pub fn find_transactions(conn: &Connection, params_obj: &Value) -> OpResult {
    let no_raw_tx = params_obj
        .get("noRawTx")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let has_after = params_obj
        .get("afterTransactionId")
        .and_then(|v| v.as_i64())
        .is_some();
    let desc = params_obj
        .get("orderDescending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut f = build_transactions_filter(params_obj);
    let paging = f.append_paging(params_obj, has_after);
    let dir = if desc { "DESC" } else { "ASC" };
    let sql = format!(
        "SELECT t.transaction_id, t.created_at, t.updated_at, t.user_id, t.proven_tx_id, t.status, t.reference,
                t.is_outgoing, t.satoshis, t.description, t.version, t.lock_time, t.txid,
                t.input_beef_hash, t.raw_tx_hash,
                t.no_send_expiry_mode, t.no_send_expiry_value, t.no_send_expiry_deadline, t.no_send_expiry_state,
                t.no_send_expiry_anchor_txid, t.no_send_expiry_anchor_vout, t.no_send_expiry_released_at,
                t.no_send_expiry_observed_at, t.no_send_expiry_reclaim_txid, t.no_send_expiry_reclaim_raw_tx_hash,
                t.no_send_expiry_reclaim_derivation_prefix, t.no_send_expiry_reclaim_derivation_suffix,
                t.no_send_expiry_reclaim_satoshis
         FROM transactions t{} ORDER BY t.transaction_id {dir}{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err("findTransactions", e))?;
    let raw_rows: Vec<TxRowRaw> = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), read_tx_row)
        .map_err(|e| db_err("findTransactions query", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| db_err("findTransactions row", e))?;
    let mut out = Vec::with_capacity(raw_rows.len());
    for mut item in raw_rows {
        if !no_raw_tx {
            if let Some(ref h) = item.input_beef_hash {
                if let Some(b) =
                    get_cold_blob(conn, h).map_err(|e| db_err("tx inputBEEF blob", e))?
                {
                    item.json
                        .insert("inputBEEFB64".into(), Value::String(encode_b64(&b)));
                }
            }
            let mut raw_hash = item.raw_tx_hash.clone();
            if raw_hash.is_none() {
                if let Some(ref txid) = item.txid {
                    if !txid.is_empty() {
                        raw_hash = lookup_raw_tx_hash(conn, txid, false)
                            .map_err(|e| db_err("tx fallback rawTx", e))?;
                    }
                }
            }
            if let Some(ref h) = raw_hash {
                if let Some(b) = get_cold_blob(conn, h).map_err(|e| db_err("tx rawTx blob", e))? {
                    item.json
                        .insert("rawTxB64".into(), Value::String(encode_b64(&b)));
                }
            }
            if let Some(ref h) = item.reclaim_raw_tx_hash {
                if let Some(b) =
                    get_cold_blob(conn, h).map_err(|e| db_err("tx reclaimRawTx blob", e))?
                {
                    item.json.insert(
                        "noSendExpiryReclaimRawTxB64".into(),
                        Value::String(encode_b64(&b)),
                    );
                }
            }
        }
        out.push(Value::Object(item.json));
    }
    Ok(Value::Array(out))
}

pub fn count_transactions(conn: &Connection, params_obj: &Value) -> OpResult {
    let f = build_transactions_filter(params_obj);
    let sql = format!("SELECT COUNT(*) FROM transactions t{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countTransactions", e))?;
    Ok(json!(n))
}

pub fn find_transaction_statuses_by_ids(conn: &Connection, params_obj: &Value) -> OpResult {
    let user_id = params_obj
        .get("userId")
        .and_then(|v| v.as_i64())
        .ok_or("missing userId")?;
    let ids = i64_list(params_obj, "transactionIds").unwrap_or_default();
    if ids.is_empty() {
        return Ok(json!({}));
    }
    let unique: Vec<i64> = {
        let mut seen = HashSet::new();
        ids.into_iter().filter(|id| seen.insert(*id)).collect()
    };
    let mut out = Map::new();
    for chunk in unique.chunks(500) {
        let ph = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT transaction_id, status FROM transactions WHERE user_id = ? AND transaction_id IN ({ph})"
        );
        let mut args = Vec::with_capacity(chunk.len() + 1);
        args.push(SqlVal::Integer(user_id));
        for id in chunk {
            args.push(SqlVal::Integer(*id));
        }
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| db_err("findTransactionStatusesByIds", e))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| db_err("findTransactionStatusesByIds query", e))?;
        for r in rows {
            let (id, st) = r.map_err(|e| db_err("findTransactionStatusesByIds row", e))?;
            out.insert(id.to_string(), Value::String(st));
        }
    }
    Ok(Value::Object(out))
}

// ─── Outputs ──────────────────────────────────────────────────────────────────

/// Exact SQL predicate equivalent to `isAutoSpendableChangeOutput` in `managedChange.ts`.
pub const MANAGED_AUTO_SPENDABLE_SQL: &str = "o.type = 'P2PKH' AND o.change_flag = 1 AND o.provided_by = 'storage' AND o.purpose = 'change' AND o.derivation_prefix IS NOT NULL AND length(o.derivation_prefix) > 0 AND o.derivation_suffix IS NOT NULL AND length(o.derivation_suffix) > 0 AND o.spendable = 1 AND o.spent_by IS NULL";

fn build_outputs_filter(params_obj: &Value) -> (SqlFilter, bool) {
    let p = partial_map(params_obj);
    let mut f = SqlFilter::default();
    f.push_eq_pk("o.output_id", &p, "outputId");
    f.push_eq_i64("o.user_id", &p, "userId");
    f.push_eq_i64("o.transaction_id", &p, "transactionId");
    f.push_eq_i64("o.basket_id", &p, "basketId");
    f.push_eq_date("o.created_at", &p, "created_at");
    f.push_eq_date("o.updated_at", &p, "updated_at");
    f.push_eq_bool("o.spendable", &p, "spendable");
    f.push_eq_bool("o.change_flag", &p, "change");
    f.push_eq_i64("o.vout", &p, "vout");
    f.push_eq_i64("o.satoshis", &p, "satoshis");
    f.push_eq_i64("o.sequence_number", &p, "sequenceNumber");
    f.push_eq_i64("o.script_length", &p, "scriptLength");
    f.push_eq_i64("o.script_offset", &p, "scriptOffset");
    f.push_eq_str("o.output_description", &p, "outputDescription");
    f.push_eq_str("o.provided_by", &p, "providedBy");
    f.push_eq_str("o.purpose", &p, "purpose");
    f.push_eq_str("o.type", &p, "type");
    f.push_eq_str("o.txid", &p, "txid");
    f.push_eq_str("o.sender_identity_key", &p, "senderIdentityKey");
    f.push_eq_str("o.derivation_prefix", &p, "derivationPrefix");
    f.push_eq_str("o.derivation_suffix", &p, "derivationSuffix");
    f.push_eq_str("o.custom_instructions", &p, "customInstructions");
    f.push_eq_str("o.spending_description", &p, "spendingDescription");
    f.push_eq_i64("o.spent_by", &p, "spentBy");

    if params_obj
        .get("managedOnly")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        f.push_raw(MANAGED_AUTO_SPENDABLE_SQL);
    }

    let mut join_tx = false;
    if let Some(tx_statuses) = string_list(params_obj, "txStatus") {
        join_tx = true;
        if tx_statuses.is_empty() {
            f.push_raw("1 = 0");
        } else {
            f.push_in_strings("t.status", &tx_statuses);
            if let Some(uid) = p.get("userId").and_then(|v| v.as_i64()) {
                f.push_param("t.user_id = ?", SqlVal::Integer(uid));
            }
        }
    }

    if let Some(tag_ids) = i64_list(params_obj, "tagIds") {
        if !tag_ids.is_empty() {
            let unique: Vec<i64> = {
                let mut seen = HashSet::new();
                tag_ids.into_iter().filter(|id| seen.insert(*id)).collect()
            };
            let is_all = params_obj
                .get("isQueryModeAll")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let ph = vec!["?"; unique.len()].join(",");
            if is_all {
                f.clauses.push(format!(
                    "(SELECT COUNT(DISTINCT otm.output_tag_id) FROM output_tags_map otm WHERE otm.output_id = o.output_id AND otm.is_deleted = 0 AND otm.output_tag_id IN ({ph})) = ?"
                ));
                for id in &unique {
                    f.args.push(SqlVal::Integer(*id));
                }
                f.args.push(SqlVal::Integer(unique.len() as i64));
            } else {
                f.clauses.push(format!(
                    "EXISTS (SELECT 1 FROM output_tags_map otm WHERE otm.output_id = o.output_id AND otm.is_deleted = 0 AND otm.output_tag_id IN ({ph}))"
                ));
                for id in &unique {
                    f.args.push(SqlVal::Integer(*id));
                }
            }
        }
    }

    let desc = params_obj
        .get("orderDescending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if let Some(after_id) = params_obj.get("afterOutputId").and_then(|v| v.as_i64()) {
        if desc {
            f.push_param("o.output_id < ?", SqlVal::Integer(after_id));
        } else {
            f.push_param("o.output_id > ?", SqlVal::Integer(after_id));
        }
    }

    f.push_since("o.updated_at", params_obj);
    (f, join_tx)
}

pub struct OutputRowRaw {
    pub json: Map<String, Value>,
    pub output_id: i64,
    pub transaction_id: i64,
    pub satoshis: i64,
    pub txid: Option<String>,
    pub script_length: Option<i64>,
    pub script_offset: Option<i64>,
    pub locking_script_hash: Option<String>,
}

pub const OUTPUT_SELECT_COLS: &str = "o.output_id, o.created_at, o.updated_at, o.user_id, o.transaction_id, o.basket_id,
    o.spendable, o.change_flag, o.output_description, o.vout, o.satoshis, o.provided_by, o.purpose, o.type,
    o.txid, o.sender_identity_key, o.derivation_prefix, o.derivation_suffix, o.custom_instructions,
    o.spent_by, o.sequence_number, o.spending_description, o.script_length, o.script_offset, o.locking_script_hash";

pub fn read_output_row(r: &Row<'_>) -> rusqlite::Result<OutputRowRaw> {
    let output_id: i64 = r.get(0)?;
    let transaction_id: i64 = r.get(4)?;
    let satoshis: i64 = r.get(10)?;
    let txid: Option<String> = r.get(14)?;
    let script_length: Option<i64> = r.get(22)?;
    let script_offset: Option<i64> = r.get(23)?;
    let locking_script_hash: Option<String> = r.get(24)?;

    let mut m = Map::new();
    m.insert("outputId".into(), json!(output_id));
    m.insert("created_at".into(), json!(r.get::<_, String>(1)?));
    m.insert("updated_at".into(), json!(r.get::<_, String>(2)?));
    m.insert("userId".into(), json!(r.get::<_, i64>(3)?));
    m.insert("transactionId".into(), json!(transaction_id));
    opt_insert_i64(&mut m, "basketId", r.get::<_, Option<i64>>(5)?);
    m.insert("spendable".into(), json!(r.get::<_, i64>(6)? != 0));
    m.insert("change".into(), json!(r.get::<_, i64>(7)? != 0));
    m.insert("outputDescription".into(), json!(r.get::<_, String>(8)?));
    m.insert("vout".into(), json!(r.get::<_, i64>(9)?));
    m.insert("satoshis".into(), json!(satoshis));
    m.insert("providedBy".into(), json!(r.get::<_, String>(11)?));
    m.insert("purpose".into(), json!(r.get::<_, String>(12)?));
    m.insert("type".into(), json!(r.get::<_, String>(13)?));
    opt_insert_str(&mut m, "txid", txid.clone());
    opt_insert_str(&mut m, "senderIdentityKey", r.get(15)?);
    opt_insert_str(&mut m, "derivationPrefix", r.get(16)?);
    opt_insert_str(&mut m, "derivationSuffix", r.get(17)?);
    opt_insert_str(&mut m, "customInstructions", r.get(18)?);
    opt_insert_i64(&mut m, "spentBy", r.get(19)?);
    opt_insert_i64(&mut m, "sequenceNumber", r.get(20)?);
    opt_insert_str(&mut m, "spendingDescription", r.get(21)?);
    opt_insert_i64(&mut m, "scriptLength", script_length);
    opt_insert_i64(&mut m, "scriptOffset", script_offset);

    Ok(OutputRowRaw {
        json: m,
        output_id,
        transaction_id,
        satoshis,
        txid,
        script_length,
        script_offset,
        locking_script_hash,
    })
}

/// Resolve an output's locking script from `cold_blobs` or via SQLite `substr()` slice
/// of the parent transaction's `rawTx` without copying multi-MB transactions!
pub fn hydrate_output_script(
    conn: &Connection,
    item: &OutputRowRaw,
    tx_raw_hash_cache: &mut HashMap<String, Option<String>>,
) -> Result<Option<Vec<u8>>, String> {
    let expected_len = item.script_length.filter(|&n| n > 0).map(|n| n as usize);
    let mut inline_bytes: Option<Vec<u8>> = None;
    if let Some(ref h) = item.locking_script_hash {
        inline_bytes =
            get_cold_blob(conn, h).map_err(|e| db_err("output lockingScript blob", e))?;
        if let Some(ref b) = inline_bytes {
            match expected_len {
                None => return Ok(inline_bytes),
                Some(len) if b.len() == len => return Ok(inline_bytes),
                Some(_) => {}
            }
        }
    }
    if let (Some(len), Some(off), Some(ref txid)) = (
        expected_len,
        item.script_offset.filter(|&n| n > 0).map(|n| n as usize),
        &item.txid,
    ) {
        if !txid.is_empty() {
            let hash_opt = if let Some(cached) = tx_raw_hash_cache.get(txid) {
                cached.clone()
            } else {
                let h = lookup_raw_tx_hash(conn, txid, true)
                    .map_err(|e| db_err("output script slice lookup", e))?;
                tx_raw_hash_cache.insert(txid.clone(), h.clone());
                h
            };
            if let Some(raw_hash) = hash_opt {
                if let Some(slice) = get_cold_blob_slice(conn, &raw_hash, off, len)
                    .map_err(|e| db_err("output script substr", e))?
                {
                    return Ok(Some(slice));
                }
            }
        }
    }
    Ok(inline_bytes)
}

pub fn find_outputs(conn: &Connection, params_obj: &Value) -> OpResult {
    let no_script = params_obj
        .get("noScript")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let has_after = params_obj
        .get("afterOutputId")
        .and_then(|v| v.as_i64())
        .is_some();
    let desc = params_obj
        .get("orderDescending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let (mut f, join_tx) = build_outputs_filter(params_obj);
    let paging = f.append_paging(params_obj, has_after);
    let join_sql = if join_tx {
        " INNER JOIN transactions t ON t.transaction_id = o.transaction_id"
    } else {
        ""
    };
    let dir = if desc { "DESC" } else { "ASC" };
    let sql = format!(
        "SELECT {OUTPUT_SELECT_COLS} FROM outputs o{join_sql}{} ORDER BY o.output_id {dir}{}",
        f.where_sql(),
        paging
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| db_err("findOutputs", e))?;
    let raw_rows: Vec<OutputRowRaw> = stmt
        .query_map(rusqlite::params_from_iter(f.args.iter()), read_output_row)
        .map_err(|e| db_err("findOutputs query", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| db_err("findOutputs row", e))?;

    let mut out = Vec::with_capacity(raw_rows.len());
    let mut tx_raw_cache = HashMap::new();
    for mut item in raw_rows {
        if !no_script {
            if let Some(bytes) = hydrate_output_script(conn, &item, &mut tx_raw_cache)? {
                item.json
                    .insert("lockingScriptB64".into(), Value::String(encode_b64(&bytes)));
            }
        }
        out.push(Value::Object(item.json));
    }
    Ok(Value::Array(out))
}

pub fn count_outputs(conn: &Connection, params_obj: &Value) -> OpResult {
    let (f, join_tx) = build_outputs_filter(params_obj);
    let join_sql = if join_tx {
        " INNER JOIN transactions t ON t.transaction_id = o.transaction_id"
    } else {
        ""
    };
    let sql = format!("SELECT COUNT(*) FROM outputs o{join_sql}{}", f.where_sql());
    let n: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("countOutputs", e))?;
    Ok(json!(n))
}

pub fn find_outputs_by_ids(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = i64_list(params_obj, "outputIds").unwrap_or_default();
    let no_script = params_obj
        .get("noScript")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if ids.is_empty() {
        return Ok(json!({}));
    }
    let unique: Vec<i64> = {
        let mut seen = HashSet::new();
        ids.into_iter().filter(|id| seen.insert(*id)).collect()
    };
    let mut out = Map::new();
    let mut tx_raw_cache = HashMap::new();
    for chunk in unique.chunks(500) {
        let ph = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT {OUTPUT_SELECT_COLS} FROM outputs o WHERE o.output_id IN ({ph})");
        let args: Vec<SqlVal> = chunk.iter().map(|id| SqlVal::Integer(*id)).collect();
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| db_err("findOutputsByIds", e))?;
        let raw_rows: Vec<OutputRowRaw> = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), read_output_row)
            .map_err(|e| db_err("findOutputsByIds query", e))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| db_err("findOutputsByIds row", e))?;
        for mut item in raw_rows {
            if !no_script {
                if let Some(bytes) = hydrate_output_script(conn, &item, &mut tx_raw_cache)? {
                    item.json
                        .insert("lockingScriptB64".into(), Value::String(encode_b64(&bytes)));
                }
            }
            out.insert(item.output_id.to_string(), Value::Object(item.json));
        }
    }
    Ok(Value::Object(out))
}

pub fn find_outputs_by_outpoints(conn: &Connection, params_obj: &Value) -> OpResult {
    let user_id = params_obj
        .get("userId")
        .and_then(|v| v.as_i64())
        .ok_or("missing userId")?;
    let no_script = params_obj
        .get("noScript")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let outpoints = params_obj
        .get("outpoints")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if outpoints.is_empty() {
        return Ok(json!({}));
    }
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {OUTPUT_SELECT_COLS} FROM outputs o WHERE o.txid = ?1 AND o.vout = ?2 AND o.user_id = ?3 LIMIT 1"
        ))
        .map_err(|e| db_err("findOutputsByOutpoints", e))?;
    let mut out = Map::new();
    let mut seen = HashSet::new();
    let mut tx_raw_cache = HashMap::new();
    for op in outpoints {
        let Some(txid) = op.get("txid").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(vout) = op.get("vout").and_then(|v| v.as_i64()) else {
            continue;
        };
        let key = format!("{txid}.{vout}");
        if !seen.insert(key.clone()) {
            continue;
        }
        let row = stmt
            .query_row(params![txid, vout, user_id], read_output_row)
            .optional()
            .map_err(|e| db_err("findOutputsByOutpoints row", e))?;
        if let Some(mut item) = row {
            if !no_script {
                if let Some(bytes) = hydrate_output_script(conn, &item, &mut tx_raw_cache)? {
                    item.json
                        .insert("lockingScriptB64".into(), Value::String(encode_b64(&bytes)));
                }
            }
            out.insert(key, Value::Object(item.json));
        }
    }
    Ok(Value::Object(out))
}

// ─── Ultra-Fast Hot-Path Operations ───────────────────────────────────────────

/// Complete non-specOp `listOutputs` in a single concurrent SQLite WAL read call:
/// basket resolution + tag resolution + indexed JOIN `outputs`/`transactions` +
/// keyset resume + total count (only when needed) + batch tag/label/script hydration.
pub fn list_outputs_fast(conn: &Connection, params_obj: &Value) -> OpResult {
    let user_id = params_obj
        .get("userId")
        .and_then(|v| v.as_i64())
        .ok_or("missing userId")?;
    let limit = params_obj
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(10)
        .max(0);
    let raw_offset = params_obj
        .get("offset")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let (offset, order_desc) = if raw_offset < 0 {
        (-raw_offset - 1, true)
    } else {
        (raw_offset, false)
    };
    let basket_name = params_obj
        .get("basket")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let tags = string_list(params_obj, "tags").unwrap_or_default();
    let query_mode_all = params_obj
        .get("tagQueryMode")
        .and_then(|v| v.as_str())
        .map(|s| s == "all")
        .unwrap_or(false);
    let managed_only = params_obj
        .get("managedOnly")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_tags = params_obj
        .get("includeTags")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_labels = params_obj
        .get("includeLabels")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_scripts = params_obj
        .get("includeLockingScripts")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_custom = params_obj
        .get("includeCustomInstructions")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let skip_total = params_obj
        .get("skipTotal")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let resume_after = params_obj
        .get("resumeAfterOutputId")
        .and_then(|v| v.as_i64());

    // 1. Resolve basket
    let basket_id: Option<i64> = if let Some(bname) = basket_name {
        let bid: Option<i64> = conn
            .query_row(
                "SELECT basket_id FROM output_baskets WHERE user_id = ?1 AND name = ?2",
                params![user_id, bname],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| db_err("listOutputsFast basket", e))?;
        let Some(id) = bid else {
            return Ok(json!({ "totalOutputs": 0, "outputs": [] }));
        };
        Some(id)
    } else {
        None
    };

    // 2. Resolve tags
    let mut tag_ids = Vec::new();
    if !tags.is_empty() {
        let ph = vec!["?"; tags.len()].join(",");
        let sql = format!(
            "SELECT output_tag_id FROM output_tags WHERE user_id = ? AND is_deleted = 0 AND tag IN ({ph})"
        );
        let mut args = Vec::with_capacity(tags.len() + 1);
        args.push(SqlVal::Integer(user_id));
        for t in &tags {
            args.push(SqlVal::Text(t.clone()));
        }
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| db_err("listOutputsFast tags", e))?;
        let found: Vec<i64> = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), |r| r.get(0))
            .map_err(|e| db_err("listOutputsFast tags query", e))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| db_err("listOutputsFast tags row", e))?;
        tag_ids = found;
        let impossible = if query_mode_all {
            tag_ids.len() < tags.len()
        } else {
            tag_ids.is_empty()
        };
        if impossible {
            return Ok(json!({ "totalOutputs": 0, "outputs": [] }));
        }
    }

    // 3. Build base filter (reused for count if needed)
    let build_base = |with_resume: bool| -> SqlFilter {
        let mut f = SqlFilter::default();
        f.push_param("o.user_id = ?", SqlVal::Integer(user_id));
        if let Some(bid) = basket_id {
            f.push_param("o.basket_id = ?", SqlVal::Integer(bid));
        }
        f.push_raw("o.spendable = 1");
        f.push_param("t.user_id = ?", SqlVal::Integer(user_id));
        f.push_raw("t.status IN ('completed','unproven','nosend','sending')");
        if managed_only {
            f.push_raw(MANAGED_AUTO_SPENDABLE_SQL);
        }
        if !tag_ids.is_empty() {
            let ph = vec!["?"; tag_ids.len()].join(",");
            if query_mode_all {
                f.clauses.push(format!(
                    "(SELECT COUNT(DISTINCT otm.output_tag_id) FROM output_tags_map otm WHERE otm.output_id = o.output_id AND otm.is_deleted = 0 AND otm.output_tag_id IN ({ph})) = ?"
                ));
                for id in &tag_ids {
                    f.args.push(SqlVal::Integer(*id));
                }
                f.args.push(SqlVal::Integer(tag_ids.len() as i64));
            } else {
                f.clauses.push(format!(
                    "EXISTS (SELECT 1 FROM output_tags_map otm WHERE otm.output_id = o.output_id AND otm.is_deleted = 0 AND otm.output_tag_id IN ({ph}))"
                ));
                for id in &tag_ids {
                    f.args.push(SqlVal::Integer(*id));
                }
            }
        }
        if with_resume {
            if let Some(after) = resume_after {
                if order_desc {
                    f.push_param("o.output_id < ?", SqlVal::Integer(after));
                } else {
                    f.push_param("o.output_id > ?", SqlVal::Integer(after));
                }
            }
        }
        f
    };

    let mut page_filter = build_base(true);
    let dir = if order_desc { "DESC" } else { "ASC" };
    let effective_offset = if resume_after.is_some() { 0 } else { offset };
    let paging_sql = if limit > 0 {
        page_filter.args.push(SqlVal::Integer(limit));
        if effective_offset > 0 {
            page_filter.args.push(SqlVal::Integer(effective_offset));
            " LIMIT ? OFFSET ?"
        } else {
            " LIMIT ?"
        }
    } else {
        " LIMIT 0"
    };

    let sql = format!(
        "SELECT {OUTPUT_SELECT_COLS}
         FROM outputs o
         INNER JOIN transactions t ON t.transaction_id = o.transaction_id{}
         ORDER BY o.output_id {dir}{paging_sql}",
        page_filter.where_sql()
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err("listOutputsFast select", e))?;
    let rows: Vec<OutputRowRaw> = stmt
        .query_map(
            rusqlite::params_from_iter(page_filter.args.iter()),
            read_output_row,
        )
        .map_err(|e| db_err("listOutputsFast query", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| db_err("listOutputsFast row", e))?;

    // 4. Total outputs (exact semantics matching listOutputsIdb)
    let returned_len = rows.len() as i64;
    let total_outputs: i64 =
        if (returned_len != limit && (returned_len > 0 || offset == 0))
            || (skip_total && returned_len > 0)
        {
            offset + returned_len
        } else {
        let count_filter = build_base(false);
        let csql = format!(
            "SELECT COUNT(*) FROM outputs o INNER JOIN transactions t ON t.transaction_id = o.transaction_id{}",
            count_filter.where_sql()
        );
        conn.query_row(
            &csql,
            rusqlite::params_from_iter(count_filter.args.iter()),
            |r| r.get(0),
        )
        .map_err(|e| db_err("listOutputsFast count", e))?
    };

    let last_output_id = rows.last().map(|r| r.output_id);

    // 5. Batch-fetch tags for all returned outputs in ONE query!
    let mut tags_by_output: HashMap<i64, Vec<String>> = HashMap::new();
    if include_tags && !rows.is_empty() {
        let ids: Vec<i64> = rows.iter().map(|r| r.output_id).collect();
        for chunk in ids.chunks(500) {
            let ph = vec!["?"; chunk.len()].join(",");
            let tsql = format!(
                "SELECT m.output_id, t.tag
                 FROM output_tags_map m
                 INNER JOIN output_tags t ON t.output_tag_id = m.output_tag_id
                 WHERE m.output_id IN ({ph}) AND m.is_deleted = 0 AND t.is_deleted = 0
                 ORDER BY m.output_id ASC, m.output_tag_id ASC"
            );
            let args: Vec<SqlVal> = chunk.iter().map(|id| SqlVal::Integer(*id)).collect();
            let mut tstmt = conn
                .prepare(&tsql)
                .map_err(|e| db_err("listOutputsFast batch tags", e))?;
            let trows = tstmt
                .query_map(rusqlite::params_from_iter(args.iter()), |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| db_err("listOutputsFast batch tags query", e))?;
            for tr in trows {
                let (oid, tag) = tr.map_err(|e| db_err("listOutputsFast batch tags row", e))?;
                tags_by_output.entry(oid).or_default().push(tag);
            }
        }
    }

    // 6. Batch-fetch labels for all distinct transactionIds in ONE query!
    let mut labels_by_tx: HashMap<i64, Vec<String>> = HashMap::new();
    if include_labels && !rows.is_empty() {
        let tx_ids: Vec<i64> = {
            let mut seen = HashSet::new();
            rows.iter()
                .map(|r| r.transaction_id)
                .filter(|id| seen.insert(*id))
                .collect()
        };
        for chunk in tx_ids.chunks(500) {
            let ph = vec!["?"; chunk.len()].join(",");
            let lsql = format!(
                "SELECT m.transaction_id, l.label
                 FROM tx_labels_map m
                 INNER JOIN tx_labels l ON l.tx_label_id = m.tx_label_id
                 WHERE m.transaction_id IN ({ph}) AND m.is_deleted = 0 AND l.is_deleted = 0
                 ORDER BY m.transaction_id ASC, m.tx_label_id ASC"
            );
            let args: Vec<SqlVal> = chunk.iter().map(|id| SqlVal::Integer(*id)).collect();
            let mut lstmt = conn
                .prepare(&lsql)
                .map_err(|e| db_err("listOutputsFast batch labels", e))?;
            let lrows = lstmt
                .query_map(rusqlite::params_from_iter(args.iter()), |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| db_err("listOutputsFast batch labels query", e))?;
            for lr in lrows {
                let (tid, label) = lr.map_err(|e| db_err("listOutputsFast batch labels row", e))?;
                labels_by_tx.entry(tid).or_default().push(label);
            }
        }
    }

    // 7. Assemble WalletOutput objects directly (with optional lockingScript hex!)
    let mut tx_raw_cache = HashMap::new();
    let mut wallet_outputs = Vec::with_capacity(rows.len());
    for item in &rows {
        let txid_str = item.txid.as_deref().unwrap_or("");
        let vout = item.json["vout"].as_i64().unwrap_or(0);
        let mut wo = Map::new();
        wo.insert("satoshis".into(), json!(item.satoshis));
        wo.insert(
            "spendable".into(),
            item.json
                .get("spendable")
                .cloned()
                .unwrap_or(Value::Bool(true)),
        );
        wo.insert("outpoint".into(), Value::String(format!("{txid_str}.{vout}")));
        if include_custom {
            if let Some(ci) = item
                .json
                .get("customInstructions")
                .and_then(|v| v.as_str())
            {
                if !ci.is_empty() {
                    wo.insert("customInstructions".into(), Value::String(ci.to_string()));
                }
            }
        }
        if include_labels && !txid_str.is_empty() {
            let labels = labels_by_tx
                .get(&item.transaction_id)
                .cloned()
                .unwrap_or_default();
            wo.insert("labels".into(), json!(labels));
        }
        if include_tags {
            let t = tags_by_output
                .get(&item.output_id)
                .cloned()
                .unwrap_or_default();
            wo.insert("tags".into(), json!(t));
        }
        if include_scripts {
            if let Some(bytes) = hydrate_output_script(conn, item, &mut tx_raw_cache)? {
                wo.insert("lockingScript".into(), Value::String(hex::encode(bytes)));
            }
        }
        wallet_outputs.push(Value::Object(wo));
    }

    let mut res = Map::new();
    res.insert("totalOutputs".into(), json!(total_outputs));
    res.insert("outputs".into(), Value::Array(wallet_outputs));
    if let Some(lid) = last_output_id {
        res.insert("lastOutputId".into(), json!(lid));
    }
    Ok(Value::Object(res))
}

/// Fast SQL SUM for `specOpWalletBalance` (0.1ms instead of materializing all outputs).
pub fn sum_spendable_outputs(conn: &Connection, params_obj: &Value) -> OpResult {
    let user_id = params_obj
        .get("userId")
        .and_then(|v| v.as_i64())
        .ok_or("missing userId")?;
    let basket_name = params_obj
        .get("basket")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let managed_only = params_obj
        .get("managedOnly")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let tags = string_list(params_obj, "tags").unwrap_or_default();
    let query_mode_all = params_obj
        .get("tagQueryMode")
        .and_then(|v| v.as_str())
        .map(|s| s == "all")
        .unwrap_or(false);

    let basket_id: Option<i64> = if let Some(bname) = basket_name {
        let bid: Option<i64> = conn
            .query_row(
                "SELECT basket_id FROM output_baskets WHERE user_id = ?1 AND name = ?2",
                params![user_id, bname],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| db_err("sumSpendableOutputs basket", e))?;
        let Some(id) = bid else {
            return Ok(json!(0));
        };
        Some(id)
    } else {
        None
    };

    let mut f = SqlFilter::default();
    f.push_param("o.user_id = ?", SqlVal::Integer(user_id));
    if let Some(bid) = basket_id {
        f.push_param("o.basket_id = ?", SqlVal::Integer(bid));
    }
    f.push_raw("o.spendable = 1");
    f.push_param("t.user_id = ?", SqlVal::Integer(user_id));
    f.push_raw("t.status IN ('completed','unproven','nosend','sending')");
    if managed_only {
        f.push_raw(MANAGED_AUTO_SPENDABLE_SQL);
    }

    if !tags.is_empty() {
        let ph = vec!["?"; tags.len()].join(",");
        let tsql = format!(
            "SELECT output_tag_id FROM output_tags WHERE user_id = ? AND is_deleted = 0 AND tag IN ({ph})"
        );
        let mut targs = Vec::with_capacity(tags.len() + 1);
        targs.push(SqlVal::Integer(user_id));
        for t in &tags {
            targs.push(SqlVal::Text(t.clone()));
        }
        let mut stmt = conn
            .prepare(&tsql)
            .map_err(|e| db_err("sumSpendableOutputs tags", e))?;
        let tag_ids: Vec<i64> = stmt
            .query_map(rusqlite::params_from_iter(targs.iter()), |r| r.get(0))
            .map_err(|e| db_err("sumSpendableOutputs tags query", e))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| db_err("sumSpendableOutputs tags row", e))?;
        if (query_mode_all && tag_ids.len() < tags.len()) || tag_ids.is_empty() {
            return Ok(json!(0));
        }
        let iph = vec!["?"; tag_ids.len()].join(",");
        if query_mode_all {
            f.clauses.push(format!(
                "(SELECT COUNT(DISTINCT otm.output_tag_id) FROM output_tags_map otm WHERE otm.output_id = o.output_id AND otm.is_deleted = 0 AND otm.output_tag_id IN ({iph})) = ?"
            ));
            for id in &tag_ids {
                f.args.push(SqlVal::Integer(*id));
            }
            f.args.push(SqlVal::Integer(tag_ids.len() as i64));
        } else {
            f.clauses.push(format!(
                "EXISTS (SELECT 1 FROM output_tags_map otm WHERE otm.output_id = o.output_id AND otm.is_deleted = 0 AND otm.output_tag_id IN ({iph}))"
            ));
            for id in &tag_ids {
                f.args.push(SqlVal::Integer(*id));
            }
        }
    }

    let sql = format!(
        "SELECT COALESCE(SUM(o.satoshis), 0)
         FROM outputs o
         INNER JOIN transactions t ON t.transaction_id = o.transaction_id{}",
        f.where_sql()
    );
    let total: i64 = conn
        .query_row(&sql, rusqlite::params_from_iter(f.args.iter()), |r| r.get(0))
        .map_err(|e| db_err("sumSpendableOutputs sum", e))?;
    Ok(json!(total))
}

/// Complete cash summary in ONE single indexed SQL query (`next: null`).
pub fn read_cash_summary(conn: &Connection, params_obj: &Value) -> OpResult {
    let identity_key = params_obj
        .get("identityKey")
        .and_then(|v| v.as_str())
        .ok_or("missing identityKey")?;
    let user_id: Option<i64> = conn
        .query_row(
            "SELECT user_id FROM users WHERE identity_key = ?1",
            params![identity_key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| db_err("readCashSummary user", e))?;
    let Some(uid) = user_id else {
        return Err("Summary owner is unavailable".into());
    };
    let row_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM outputs WHERE user_id = ?1",
            params![uid],
            |r| r.get(0),
        )
        .map_err(|e| db_err("readCashSummary rowCount", e))?;
    let basket_id: Option<i64> = conn
        .query_row(
            "SELECT basket_id FROM output_baskets WHERE name = 'default' AND user_id = ?1",
            params![uid],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| db_err("readCashSummary basket", e))?;
    let Some(bid) = basket_id else {
        return Ok(json!({
            "sats": 0,
            "outputCount": 0,
            "rowCount": row_count,
            "next": Value::Null,
        }));
    };
    let sql = format!(
        "SELECT COALESCE(SUM(o.satoshis), 0), COUNT(*)
         FROM outputs o
         INNER JOIN transactions t ON t.transaction_id = o.transaction_id
         WHERE o.user_id = ?1
           AND o.basket_id = ?2
           AND {MANAGED_AUTO_SPENDABLE_SQL}
           AND t.user_id = ?1
           AND t.status IN ('completed','unproven','nosend','sending')"
    );
    let (sats, output_count): (i64, i64) = conn
        .query_row(&sql, params![uid, bid], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| db_err("readCashSummary sum", e))?;
    Ok(json!({
        "sats": sats,
        "outputCount": output_count,
        "rowCount": row_count,
        "next": Value::Null,
    }))
}

pub fn read_pending_change_page(conn: &Connection, params_obj: &Value) -> OpResult {
    let identity_key = params_obj
        .get("identityKey")
        .and_then(|v| v.as_str())
        .ok_or("missing identityKey")?;
    let after = params_obj
        .get("after")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let user_id: Option<i64> = conn
        .query_row(
            "SELECT user_id FROM users WHERE identity_key = ?1",
            params![identity_key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| db_err("readPendingChangePage user", e))?;
    let Some(uid) = user_id else {
        return Err("Pending-change owner is unavailable".into());
    };
    let limit = 500_i64;
    let sql = format!(
        "SELECT {OUTPUT_SELECT_COLS}
         FROM outputs o
         WHERE o.user_id = ?1 AND o.change_flag = 1 AND o.spendable = 0 AND o.output_id > ?2
         ORDER BY o.output_id ASC
         LIMIT ?3"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err("readPendingChangePage", e))?;
    let rows: Vec<OutputRowRaw> = stmt
        .query_map(params![uid, after, limit], read_output_row)
        .map_err(|e| db_err("readPendingChangePage query", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| db_err("readPendingChangePage row", e))?;
    let next = if rows.len() as i64 == limit {
        rows.last().map(|r| json!(r.output_id)).unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let outputs: Vec<Value> = rows.into_iter().map(|r| Value::Object(r.json)).collect();
    Ok(json!({ "outputs": outputs, "next": next }))
}

pub fn count_change_inputs(conn: &Connection, params_obj: &Value) -> OpResult {
    let user_id = params_obj
        .get("userId")
        .and_then(|v| v.as_i64())
        .ok_or("missing userId")?;
    let basket_id = params_obj
        .get("basketId")
        .and_then(|v| v.as_i64())
        .ok_or("missing basketId")?;
    let exclude_sending = params_obj
        .get("excludeSending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let now = crate::toolbox_db::schema::now_iso();
    let status_clause = if exclude_sending {
        "t.status IN ('completed','unproven')"
    } else {
        "t.status IN ('completed','unproven','sending')"
    };
    let sql = format!(
        "SELECT COUNT(*)
         FROM outputs o
         INNER JOIN transactions t ON t.transaction_id = o.transaction_id
         WHERE o.user_id = ?1
           AND o.basket_id = ?2
           AND {MANAGED_AUTO_SPENDABLE_SQL}
           AND t.user_id = ?1
           AND {status_clause}
           AND NOT EXISTS (
               SELECT 1 FROM action_batch_outputs abo
               INNER JOIN action_batches ab ON ab.action_batch_id = abo.action_batch_id
               WHERE abo.output_id = o.output_id
                 AND ab.status IN ('active', 'prepared')
                 AND ab.expires_at > ?3
                 AND ab.hard_expires_at > ?3
           )"
    );
    let n: i64 = conn
        .query_row(&sql, params![user_id, basket_id, now], |r| r.get(0))
        .map_err(|e| db_err("countChangeInputs", e))?;
    Ok(json!(n))
}

// ─── Action Batches Reads ─────────────────────────────────────────────────────

fn read_action_batch_row(r: &Row<'_>) -> rusqlite::Result<Value> {
    let mut m = Map::new();
    m.insert("actionBatchId".into(), json!(r.get::<_, i64>(0)?));
    m.insert("created_at".into(), json!(r.get::<_, String>(1)?));
    m.insert("updated_at".into(), json!(r.get::<_, String>(2)?));
    m.insert("userId".into(), json!(r.get::<_, i64>(3)?));
    m.insert("batchId".into(), json!(r.get::<_, String>(4)?));
    m.insert("status".into(), json!(r.get::<_, String>(5)?));
    m.insert("expiresAt".into(), json!(r.get::<_, String>(6)?));
    m.insert("hardExpiresAt".into(), json!(r.get::<_, String>(7)?));
    opt_insert_str(&mut m, "manifestDigest", r.get(8)?);
    opt_insert_str(&mut m, "manifest", r.get(9)?);
    opt_insert_str(&mut m, "uploadDigests", r.get(10)?);
    opt_insert_str(&mut m, "result", r.get(11)?);
    Ok(Value::Object(m))
}

pub fn find_action_batch(conn: &Connection, params_obj: &Value) -> OpResult {
    let user_id = params_obj
        .get("userId")
        .and_then(|v| v.as_i64())
        .ok_or("missing userId")?;
    let batch_id = params_obj
        .get("batchId")
        .and_then(|v| v.as_str())
        .ok_or("missing batchId")?;
    let row = conn
        .query_row(
            "SELECT action_batch_id, created_at, updated_at, user_id, batch_id, status, expires_at, hard_expires_at,
                    manifest_digest, manifest, upload_digests, result
             FROM action_batches WHERE user_id = ?1 AND batch_id = ?2",
            params![user_id, batch_id],
            read_action_batch_row,
        )
        .optional()
        .map_err(|e| db_err("findActionBatch", e))?;
    Ok(row.unwrap_or(Value::Null))
}

pub fn find_expired_action_batches(conn: &Connection, params_obj: &Value) -> OpResult {
    let now_iso = parse_optional_iso(params_obj.get("now"))
        .unwrap_or_else(crate::toolbox_db::schema::now_iso);
    let mut stmt = conn
        .prepare(
            "SELECT action_batch_id, created_at, updated_at, user_id, batch_id, status, expires_at, hard_expires_at,
                    manifest_digest, manifest, upload_digests, result
             FROM action_batches
             WHERE status IN ('active', 'prepared')
               AND (expires_at <= ?1 OR hard_expires_at <= ?1)
             ORDER BY action_batch_id ASC",
        )
        .map_err(|e| db_err("findExpiredActionBatches", e))?;
    let rows = stmt
        .query_map(params![now_iso], read_action_batch_row)
        .map_err(|e| db_err("findExpiredActionBatches query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| db_err("findExpiredActionBatches row", e))?);
    }
    Ok(Value::Array(out))
}

pub fn find_action_batch_output_ids(conn: &Connection, params_obj: &Value) -> OpResult {
    let batch_id = params_obj
        .get("actionBatchId")
        .and_then(|v| v.as_i64())
        .ok_or("missing actionBatchId")?;
    let mut stmt = conn
        .prepare("SELECT output_id FROM action_batch_outputs WHERE action_batch_id = ?1")
        .map_err(|e| db_err("findActionBatchOutputIds", e))?;
    let rows = stmt
        .query_map(params![batch_id], |r| r.get::<_, i64>(0))
        .map_err(|e| db_err("findActionBatchOutputIds query", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(json!(
            r.map_err(|e| db_err("findActionBatchOutputIds row", e))?
        ));
    }
    Ok(Value::Array(out))
}

pub fn find_reserved_action_batch_output_ids(conn: &Connection, params_obj: &Value) -> OpResult {
    let output_ids = i64_list(params_obj, "outputIds").unwrap_or_default();
    if output_ids.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    let now = crate::toolbox_db::schema::now_iso();
    let mut reserved = Vec::new();
    for chunk in output_ids.chunks(500) {
        let ph = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT abo.output_id
             FROM action_batch_outputs abo
             INNER JOIN action_batches ab ON ab.action_batch_id = abo.action_batch_id
             WHERE abo.output_id IN ({ph})
               AND ab.status IN ('active', 'prepared')
               AND ab.expires_at > ?
               AND ab.hard_expires_at > ?"
        );
        let mut args: Vec<SqlVal> = chunk.iter().map(|id| SqlVal::Integer(*id)).collect();
        args.push(SqlVal::Text(now.clone()));
        args.push(SqlVal::Text(now.clone()));
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| db_err("findReservedActionBatchOutputIds", e))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|e| db_err("findReservedActionBatchOutputIds query", e))?;
        for r in rows {
            reserved.push(json!(r.map_err(|e| db_err(
                "findReservedActionBatchOutputIds row",
                e
            ))?));
        }
    }
    Ok(Value::Array(reserved))
}

pub fn find_action_batch_blob_records(conn: &Connection, params_obj: &Value) -> OpResult {
    let action_batch_id = params_obj
        .get("actionBatchId")
        .and_then(|v| v.as_i64())
        .ok_or("missing actionBatchId")?;
    let digests = string_list(params_obj, "digests").unwrap_or_default();
    if digests.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    let mut stmt = conn
        .prepare(
            "SELECT action_batch_blob_id, action_batch_id, digest, created_at, updated_at, bytes_hash
             FROM action_batch_blobs WHERE action_batch_id = ?1 AND digest = ?2",
        )
        .map_err(|e| db_err("findActionBatchBlobRecords", e))?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for digest in digests {
        if !seen.insert(digest.clone()) {
            continue;
        }
        let row: Option<(i64, i64, String, String, String, String)> = stmt
            .query_row(params![action_batch_id, &digest], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })
            .optional()
            .map_err(|e| db_err("findActionBatchBlobRecords row", e))?;
        if let Some((blob_id, ab_id, dg, ca, ua, bhash)) = row {
            let bytes = get_cold_blob(conn, &bhash)
                .map_err(|e| db_err("actionBatchBlob cold_blob", e))?
                .unwrap_or_default();
            out.push(json!({
                "actionBatchBlobId": blob_id,
                "actionBatchId": ab_id,
                "digest": dg,
                "created_at": ca,
                "updated_at": ua,
                "bytesB64": encode_b64(&bytes),
            }));
        }
    }
    Ok(Value::Array(out))
}

pub fn table_counts(conn: &Connection) -> OpResult {
    let tables = [
        "users",
        "output_baskets",
        "transactions",
        "proven_txs",
        "proven_tx_reqs",
        "outputs",
        "output_tags",
        "output_tags_map",
        "tx_labels",
        "tx_labels_map",
        "commissions",
        "certificates",
        "certificate_fields",
        "sync_states",
        "monitor_events",
        "action_batches",
        "action_batch_outputs",
        "action_batch_blobs",
    ];
    let mut map = Map::new();
    for t in tables {
        let n: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
            .map_err(|e| db_err("tableCounts", e))?;
        map.insert(t.into(), json!(n));
    }
    Ok(Value::Object(map))
}
