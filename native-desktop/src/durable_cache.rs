//! Bounded copies of durable values; files remain the source of truth.
use std::collections::{HashMap, VecDeque};

// Large journals are already cached by the renderer. Do not retain another
// unbounded plaintext copy in the shell after serializing its response.
const MAX_VALUE_BYTES: usize = 256 * 1024;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 128;

#[derive(Default)]
pub(crate) struct DurableCache {
    values: HashMap<String, Option<String>>,
    order: VecDeque<String>,
    bytes: usize,
}

impl DurableCache {
    pub(crate) fn get(&self, key: &str) -> Option<&Option<String>> {
        self.values.get(key)
    }

    pub(crate) fn insert(&mut self, key: String, value: Option<String>) {
        // Always invalidate the old copy, even when its replacement is too large.
        self.remove(&key);
        let size = key.len() + value.as_ref().map_or(0, String::len);
        if size > MAX_VALUE_BYTES {
            return;
        }
        while self.values.len() >= MAX_ENTRIES || self.bytes + size > MAX_BYTES {
            let Some(oldest) = self.order.front().cloned() else {
                break;
            };
            self.remove(&oldest);
        }
        self.bytes += size;
        self.order.push_back(key.clone());
        self.values.insert(key, value);
    }

    fn remove(&mut self, key: &str) {
        if let Some(value) = self.values.remove(key) {
            self.bytes -= key.len() + value.as_ref().map_or(0, String::len);
            self.order.retain(|held| held != key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_value_replaces_cached_copy_without_retaining_it() {
        let mut cache = DurableCache::default();
        cache.insert("journal".into(), Some("old".into()));
        cache.insert("journal".into(), Some("x".repeat(MAX_VALUE_BYTES)));
        assert_eq!(cache.get("journal"), None);
        assert_eq!(cache.bytes, 0);
        assert!(cache.order.is_empty());
    }

    #[test]
    fn retained_bytes_stay_bounded_during_large_scan() {
        let mut cache = DurableCache::default();
        for i in 0..1000 {
            cache.insert(format!("segment-{i}"), Some("x".repeat(200 * 1024)));
            assert!(cache.bytes <= MAX_BYTES);
            assert!(cache.values.len() <= MAX_ENTRIES);
        }
        assert_eq!(cache.get("segment-0"), None);
        assert!(cache.get("segment-999").is_some());
        assert_eq!(
            cache.bytes,
            cache
                .values
                .iter()
                .map(|(k, v)| k.len() + v.as_ref().map_or(0, String::len))
                .sum::<usize>()
        );
        let baseline: usize = (0..1000)
            .map(|i| format!("segment-{i}").len() + 200 * 1024)
            .sum();
        println!(
            "synthetic retained payload: unbounded={baseline}, bounded={}",
            cache.bytes
        );
    }

    #[test]
    fn missing_values_and_keys_are_bounded_too() {
        let mut cache = DurableCache::default();
        for i in 0..1000 {
            cache.insert(format!("missing-{i}"), None);
        }
        assert_eq!(cache.values.len(), MAX_ENTRIES);
        assert_eq!(cache.order.len(), MAX_ENTRIES);
        assert_eq!(cache.get("missing-0"), None);
        assert_eq!(cache.get("missing-999"), Some(&None));
        cache.insert("k".repeat(MAX_VALUE_BYTES + 1), None);
        assert_eq!(cache.values.len(), MAX_ENTRIES);
    }

    #[test]
    fn replacements_account_for_utf8_bytes_without_growing_queue() {
        let mut cache = DurableCache::default();
        for _ in 0..1000 {
            cache.insert("key".into(), Some("é".repeat(10)));
        }
        assert_eq!(cache.bytes, 23);
        assert_eq!(cache.order.len(), 1);
        cache.insert("key".into(), None);
        assert_eq!(cache.bytes, 3);
        assert_eq!(cache.get("key"), Some(&None));
    }
}
