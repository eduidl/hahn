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
pub trait Source: Send + Sync {
    /// Names of the values in [`MessageTimes`] this format records.
    fn meta_fields(&self) -> &'static [&'static str] {
        &[]
    }
    fn info(&self) -> anyhow::Result<SourceInfo>;
    fn topics(&self) -> anyhow::Result<Vec<TopicMeta>>;
    fn field_defs(&self, topic: &str) -> anyhow::Result<FieldDefs>;
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
pub trait Format: Send + Sync {
    fn accepts(&self, path: &Path) -> bool;
    fn open(&self, path: &Path) -> anyhow::Result<Arc<dyn Source>>;
}

/// Every supported format, tried in order.
pub fn formats() -> &'static [&'static dyn Format] {
    &[&mcap::Mcap, &csv::Csv, &parquet::Parquet]
}

/// Names starting with `$` are reserved for markers in message values.
pub(super) fn check_field_names(defs: &FieldDefs) -> anyhow::Result<()> {
    fn check_type(data_type: &DataTypeDef) -> anyhow::Result<()> {
        match data_type {
            DataTypeDef::Struct(children) => check_field_names(&children.fields),
            DataTypeDef::List(element)
            | DataTypeDef::BoundedList(element, _)
            | DataTypeDef::Array(element, _) => check_type(&element.data_type),
            DataTypeDef::Map { key, value } => {
                check_type(&key.data_type)?;
                check_type(&value.data_type)
            }
            _ => Ok(()),
        }
    }
    for field in defs.iter() {
        anyhow::ensure!(
            !field.name.starts_with('$'),
            "Field name {:?} is reserved: names must not start with $",
            field.name
        );
        check_type(&field.element.data_type)?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use mcapdecode::core::{ElementDef, FieldDef};

    fn named(name: &str) -> DataTypeDef {
        DataTypeDef::Struct(vec![FieldDef::new(name, DataTypeDef::F64, false)].into())
    }

    fn check(data_type: DataTypeDef) -> anyhow::Result<()> {
        check_field_names(&FieldDefs::new(vec![FieldDef::new("a", data_type, false)]))
    }

    #[test]
    fn reserved_names_are_found_at_any_depth() {
        assert!(check(named("x")).is_ok());
        assert!(check(named("$x")).is_err());
        let element = |name| Box::new(ElementDef::new(named(name), false));
        assert!(check(DataTypeDef::List(element("$x"))).is_err());
        assert!(check(DataTypeDef::Array(element("$x"), 2)).is_err());
        assert!(
            check(DataTypeDef::Map {
                key: Box::new(ElementDef::new(DataTypeDef::String, false)),
                value: element("$x"),
            })
            .is_err()
        );
    }
}
