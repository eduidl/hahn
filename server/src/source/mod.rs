//! The format-independent protocol every recording source implements.
//!
//! Handlers only see [`Source`]; each file format provides a [`Format`] that
//! recognises its files and opens them. Schemas and values use the
//! format-agnostic `mcapdecode_core` IR.

mod mcap;
mod segmented;

pub use segmented::open_segments;

use mcapdecode::core::{FieldDefs, Value};
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
    pub id: String,
    pub topic: String,
    pub schema_name: Option<String>,
    /// Lets the client name types in the schema's own language (ROS 2, protobuf, ...).
    pub schema_encoding: Option<String>,
    pub message_count: Option<u64>,
    pub fields: Result<FieldDefs, String>,
}

/// When a message was recorded, as far as the format knows.
#[derive(Debug, Clone, Copy)]
pub struct MessageTimes {
    /// The primary time.
    pub log_time: u64,
    pub publish_time: Option<u64>,
}

impl From<u64> for MessageTimes {
    fn from(log_time: u64) -> Self {
        Self {
            log_time,
            publish_time: None,
        }
    }
}

/// Visitor for [`Source::read`]; returning `Err` stops the read with that error.
pub type Visit<'a> = dyn FnMut(MessageTimes, Value) -> anyhow::Result<()> + 'a;

/// An opened, immutable recording. Calls block, so run them off the async runtime.
///
/// Topics are named by [`TopicMeta::id`]. Every message of a topic is a
/// [`Value::Struct`] of the topic's [`FieldDefs`], in the same order.
pub trait Source: Send + Sync {
    /// Names of the values in [`MessageTimes`] this format records.
    fn meta_fields(&self) -> &'static [&'static str] {
        &[]
    }
    /// The time range of all messages. Fails for a recording without messages.
    fn info(&self) -> anyhow::Result<SourceInfo>;
    fn topics(&self) -> anyhow::Result<Vec<TopicMeta>>;
    fn field_defs(&self, topic: &str) -> anyhow::Result<FieldDefs>;
    /// Whether messages of `topic` are one string field of unparsed JSON text.
    fn is_json_text(&self, _topic: &str) -> anyhow::Result<bool> {
        Ok(false)
    }
    /// Messages of `topic` within `range`, in the recording's order: not always by time.
    fn read(&self, topic: &str, range: TimeRange, visit: &mut Visit) -> anyhow::Result<()>;

    /// The latest message at or before `time`, searched backwards in growing windows.
    fn latest_at(&self, topic: &str, time: u64) -> anyhow::Result<Option<(MessageTimes, Value)>> {
        let start = self.info()?.start_ns;
        let end = time.saturating_add(1);
        let mut window = FIRST_WINDOW_NS;
        loop {
            let from = end.saturating_sub(window).max(start);
            let mut latest: Option<(MessageTimes, Value)> = None;
            let range = TimeRange {
                start: Some(from),
                end: Some(end),
            };
            self.read(topic, range, &mut |times, value| {
                if latest
                    .as_ref()
                    .is_none_or(|(t, _)| times.log_time >= t.log_time)
                {
                    latest = Some((times, value));
                }
                Ok(())
            })?;
            if latest.is_some() || from <= start {
                return Ok(latest);
            }
            window = window.saturating_mul(2);
        }
    }
}

/// A file format: recognises its files and opens them as a [`Source`].
///
/// An application adds its own with [`Builder::format`](crate::Builder::format).
pub trait Format: Send + Sync {
    /// Decided from the path alone, such as by its extension: the server asks about
    /// every file when it starts.
    fn accepts(&self, path: &Path) -> bool;
    /// Opens a file this format accepted, on first use of its group. An error is
    /// reported for that group only, each time it is used.
    fn open(&self, path: &Path) -> anyhow::Result<Arc<dyn Source>>;
}

/// `extra` followed by the built-in formats, tried in that order.
pub(crate) fn formats(extra: Vec<Arc<dyn Format>>) -> Vec<Arc<dyn Format>> {
    let mut formats = extra;
    formats.push(Arc::new(mcap::Mcap));
    formats
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(extension))
}
