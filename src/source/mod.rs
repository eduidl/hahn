//! The format-independent protocol every recording source implements.
//!
//! Handlers only see [`Source`]; each file format provides a [`Format`] that
//! recognises its files and opens them. Schemas and values use the
//! format-agnostic `mcapdecode_core` IR.

mod csv;
mod mcap;
mod parquet;
mod segmented;

pub use segmented::open_segments;

use mcapdecode::core::{DataTypeDef, FieldDefs, Value};
use std::{path::Path, sync::Arc};

/// First backwards search window of the default [`Source::latest_at`]; it
/// doubles until the recording start. Kept short so frequent large messages
/// (point clouds) are not decoded in bulk.
const FIRST_WINDOW_NS: u64 = 100_000_000;

/// Log-time range in nanoseconds: inclusive `start`, exclusive `end`.
#[derive(Debug, Clone, Copy, Default)]
pub struct TimeRange {
    pub start: Option<u64>,
    pub end: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct SourceInfo {
    pub start_ns: u64,
    /// Last message timestamp, inclusive.
    pub end_ns: u64,
    pub message_count: Option<u64>,
}

#[derive(Clone)]
pub struct TopicMeta {
    pub topic: String,
    pub schema_name: Option<String>,
    /// Lets the client name types in the schema's own language (ROS 2, protobuf, ...).
    pub schema_encoding: Option<String>,
    pub message_count: Option<u64>,
    pub fields: Result<FieldDefs, String>,
}

/// Visitor for [`Source::read`]; returning `Err` stops the read with that error.
pub type Visit<'a> = dyn FnMut(u64, Value) -> anyhow::Result<()> + 'a;

/// An opened, immutable recording. Calls block, so run them off the async runtime.
pub trait Source: Send + Sync {
    fn info(&self) -> anyhow::Result<SourceInfo>;
    fn topics(&self) -> anyhow::Result<Vec<TopicMeta>>;
    fn field_defs(&self, topic: &str) -> anyhow::Result<FieldDefs>;
    /// Messages of `topic` within `range` in log-time order, at most `limit`.
    fn read(
        &self,
        topic: &str,
        range: TimeRange,
        limit: Option<usize>,
        visit: &mut Visit,
    ) -> anyhow::Result<()>;

    /// The latest message at or before `time`, searched backwards in growing windows.
    fn latest_at(&self, topic: &str, time: u64) -> anyhow::Result<Option<(u64, Value)>> {
        let start = self.info()?.start_ns;
        let end = time.saturating_add(1);
        let mut window = FIRST_WINDOW_NS;
        loop {
            let from = end.saturating_sub(window).max(start);
            let mut latest: Option<(u64, Value)> = None;
            let range = TimeRange {
                start: Some(from),
                end: Some(end),
            };
            self.read(topic, range, None, &mut |log_time, value| {
                if latest.as_ref().is_none_or(|(t, _)| log_time >= *t) {
                    latest = Some((log_time, value));
                }
                Ok(())
            })?;
            if latest.is_some() || from <= start {
                return Ok(latest);
            }
            window = window.saturating_mul(2);
        }
    }

    /// The first message at or after `time`.
    fn first_after(&self, topic: &str, time: u64) -> anyhow::Result<Option<(u64, Value)>> {
        let mut first = None;
        let range = TimeRange {
            start: Some(time),
            end: None,
        };
        self.read(topic, range, Some(1), &mut |log_time, value| {
            first = Some((log_time, value));
            Ok(())
        })?;
        Ok(first)
    }
}

/// A file format: recognises its files and opens them as a [`Source`].
pub trait Format: Send + Sync {
    fn name(&self) -> &'static str;
    fn accepts(&self, path: &Path) -> bool;
    fn open(&self, path: &Path) -> anyhow::Result<Arc<dyn Source>>;
}

/// Every supported format, tried in order.
pub fn formats() -> &'static [&'static dyn Format] {
    &[&mcap::Mcap, &csv::Csv, &parquet::Parquet]
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(extension))
}

/// Nanoseconds per unit of the time column, chosen by its name suffix
/// (`_ns`, `_us`, `_ms`, otherwise seconds).
pub(super) fn time_scale(header: &str) -> u64 {
    let header = header.to_ascii_lowercase();
    if header.ends_with("_ns") {
        1
    } else if header.ends_with("_us") {
        1_000
    } else if header.ends_with("_ms") {
        1_000_000
    } else {
        1_000_000_000
    }
}
