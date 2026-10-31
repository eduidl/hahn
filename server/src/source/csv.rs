//! CSV tables: one file is one topic, one row is one message.
//!
//! The first column is the log time. Its header suffix selects the unit
//! (`_ns`, `_us`, `_ms`, otherwise seconds); times are absolute, like MCAP log
//! times. Other columns become fields whose type is inferred from every cell,
//! and dotted headers (`pose.x`) become nested structs.

use super::{
    Format, MessageTimes, Source, SourceInfo, TimeRange, TopicMeta, Visit, check_field_names,
    has_extension, time_scale,
};
use anyhow::{Context, bail, ensure};
use mcapdecode::core::{DataTypeDef, FieldDef, FieldDefs, Value};
use std::{path::Path, sync::Arc};

pub(super) struct Csv;

impl Format for Csv {
    fn accepts(&self, path: &Path) -> bool {
        has_extension(path, "csv")
    }

    fn open(&self, path: &Path) -> anyhow::Result<Arc<dyn Source>> {
        let topic = format!(
            "/{}",
            path.file_stem()
                .context("CSV file has no name")?
                .to_string_lossy()
        );
        let mut reader = csv::Reader::from_path(path)?;
        let headers: Vec<String> = reader.headers()?.iter().map(str::to_owned).collect();
        let records = reader
            .records()
            .collect::<Result<Vec<_>, _>>()
            .context("Invalid CSV")?;
        Ok(Arc::new(CsvSource::parse(topic, &headers, &records)?))
    }
}

/// Fully parsed in memory, sorted by time.
struct CsvSource {
    topic: String,
    defs: FieldDefs,
    times: Vec<u64>,
    rows: Vec<Value>,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Int,
    Float,
    Bool,
    Text,
}

/// Field tree in header order; leaves are column indexes.
enum Node {
    Column(usize),
    Group(Vec<(String, Node)>),
}

impl CsvSource {
    fn parse(
        topic: String,
        headers: &[String],
        records: &[csv::StringRecord],
    ) -> anyhow::Result<Self> {
        let (time_header, columns) = headers.split_first().context("CSV has no columns")?;
        let scale = time_scale(time_header);
        let kinds: Vec<Kind> = (1..headers.len())
            .map(|column| infer(records.iter().filter_map(|r| r.get(column))))
            .collect();
        let tree = field_tree(columns)?;
        let defs = FieldDefs::new(field_defs(&tree, &kinds));
        check_field_names(&defs)?;

        let mut rows: Vec<(u64, Value)> = records
            .iter()
            .enumerate()
            .map(|(line, record)| {
                let cell = record.get(0).unwrap_or("");
                let time = parse_time(cell, scale)
                    .with_context(|| format!("Invalid time {cell:?} in data row {}", line + 1))?;
                Ok((time, row_value(&tree, &kinds, record)))
            })
            .collect::<anyhow::Result<_>>()?;
        rows.sort_by_key(|(time, _)| *time);
        let (times, rows) = rows.into_iter().unzip();
        Ok(Self {
            topic,
            defs,
            times,
            rows,
        })
    }

    fn check(&self, topic: &str) -> anyhow::Result<()> {
        ensure!(topic == self.topic, "Unknown topic: {topic}");
        Ok(())
    }
}

impl Source for CsvSource {
    fn info(&self) -> anyhow::Result<SourceInfo> {
        Ok(SourceInfo {
            start_ns: *self.times.first().context("No message time range")?,
            end_ns: *self.times.last().context("No message time range")?,
            message_count: Some(self.times.len() as u64),
        })
    }

    fn topics(&self) -> anyhow::Result<Vec<TopicMeta>> {
        Ok(vec![TopicMeta {
            id: self.topic.clone(),
            topic: self.topic.clone(),
            schema_name: None,
            schema_encoding: Some("csv".into()),
            message_count: Some(self.times.len() as u64),
            fields: Ok(self.defs.clone()),
        }])
    }

    fn field_defs(&self, topic: &str) -> anyhow::Result<FieldDefs> {
        self.check(topic)?;
        Ok(self.defs.clone())
    }

    fn read(&self, topic: &str, range: TimeRange, visit: &mut Visit) -> anyhow::Result<()> {
        self.check(topic)?;
        let from = range
            .start
            .map_or(0, |start| self.times.partition_point(|&t| t < start));
        let to = range.end.map_or(self.times.len(), |end| {
            self.times.partition_point(|&t| t < end)
        });
        for i in from..to.max(from) {
            visit(self.times[i].into(), self.rows[i].clone())?;
        }
        Ok(())
    }

    fn latest_at(&self, topic: &str, time: u64) -> anyhow::Result<Option<(MessageTimes, Value)>> {
        self.check(topic)?;
        let after = self.times.partition_point(|&t| t <= time);
        Ok(after
            .checked_sub(1)
            .map(|i| (self.times[i].into(), self.rows[i].clone())))
    }
}

fn parse_time(cell: &str, scale: u64) -> anyhow::Result<u64> {
    let cell = cell.trim();
    // Plain decimals stay exact; nanosecond epochs do not fit in an f64 mantissa.
    if let Some(ns) = parse_decimal(cell, scale) {
        return u64::try_from(ns).ok().context("Time out of range");
    }
    let value: f64 = cell.parse()?;
    let ns = value * scale as f64;
    ensure!(
        ns.is_finite() && ns >= 0.0 && ns < u64::MAX as f64,
        "Time out of range"
    );
    Ok(ns.round() as u64)
}

/// `digits[.digits]` times `scale`, truncated to whole nanoseconds.
fn parse_decimal(cell: &str, scale: u64) -> Option<u128> {
    let (whole, fraction) = cell.split_once('.').unwrap_or((cell, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || !digits(whole) || !digits(fraction) {
        return None;
    }
    let mut ns = whole.parse::<u128>().ok()?.checked_mul(scale.into())?;
    let mut unit = u128::from(scale);
    for digit in fraction.bytes() {
        unit /= 10;
        ns += u128::from(digit - b'0') * unit;
    }
    Some(ns)
}

fn infer<'a>(cells: impl Iterator<Item = &'a str>) -> Kind {
    let mut kind: Option<Kind> = None;
    for cell in cells.map(str::trim).filter(|c| !c.is_empty()) {
        let this = if cell.parse::<i64>().is_ok() {
            Kind::Int
        } else if cell.parse::<f64>().is_ok() {
            Kind::Float
        } else if parse_bool(cell).is_some() {
            Kind::Bool
        } else {
            return Kind::Text;
        };
        kind = Some(match (kind, this) {
            (None, k) => k,
            (Some(a), b) if a == b => a,
            (Some(Kind::Int | Kind::Float), Kind::Int | Kind::Float) => Kind::Float,
            _ => return Kind::Text,
        });
    }
    kind.unwrap_or(Kind::Text)
}

fn parse_bool(cell: &str) -> Option<bool> {
    match cell.to_ascii_lowercase().as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn cell_value(cell: Option<&str>, kind: Kind) -> Value {
    let Some(cell) = cell.map(str::trim).filter(|c| !c.is_empty()) else {
        return Value::Null;
    };
    let parsed = match kind {
        Kind::Int => cell.parse().ok().map(Value::I64),
        Kind::Float => cell.parse().ok().map(Value::F64),
        Kind::Bool => parse_bool(cell).map(Value::Bool),
        Kind::Text => Some(Value::String(cell.into())),
    };
    parsed.unwrap_or(Value::Null)
}

fn field_tree(columns: &[String]) -> anyhow::Result<Vec<(String, Node)>> {
    let mut root = Vec::new();
    for (index, header) in columns.iter().enumerate() {
        let segments: Vec<&str> = header.split('.').collect();
        ensure!(
            segments.iter().all(|s| !s.is_empty()),
            "Invalid column name {header:?}"
        );
        let (leaf, groups) = segments.split_last().expect("split yields a segment");
        let mut level = &mut root;
        for group in groups {
            let position = match level.iter().position(|(name, _)| name == group) {
                Some(position) => position,
                None => {
                    level.push((group.to_string(), Node::Group(Vec::new())));
                    level.len() - 1
                }
            };
            let Node::Group(children) = &mut level[position].1 else {
                bail!("Column {header:?} conflicts with column {group:?}");
            };
            level = children;
        }
        if level.iter().any(|(name, _)| name == leaf) {
            bail!("Duplicate column {header:?}");
        }
        // Columns are numbered from the first field, after the time column.
        level.push((leaf.to_string(), Node::Column(index)));
    }
    Ok(root)
}

fn field_defs(nodes: &[(String, Node)], kinds: &[Kind]) -> Vec<FieldDef> {
    nodes
        .iter()
        .map(|(name, node)| {
            let data_type = match node {
                Node::Column(index) => match kinds[*index] {
                    Kind::Int => DataTypeDef::I64,
                    Kind::Float => DataTypeDef::F64,
                    Kind::Bool => DataTypeDef::Bool,
                    Kind::Text => DataTypeDef::String,
                },
                Node::Group(children) => {
                    DataTypeDef::Struct(FieldDefs::new(field_defs(children, kinds)).into())
                }
            };
            FieldDef::new(name, data_type, true)
        })
        .collect()
}

fn row_value(nodes: &[(String, Node)], kinds: &[Kind], record: &csv::StringRecord) -> Value {
    Value::Struct(
        nodes
            .iter()
            .map(|(_, node)| match node {
                Node::Column(index) => cell_value(record.get(index + 1), kinds[*index]),
                Node::Group(children) => row_value(children, kinds, record),
            })
            .collect(),
    )
}
