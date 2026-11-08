//! Indexed, chunked MCAP recordings decoded by `mcapdecode`.

use super::{
    BatchVisit, Format, MessageTimes, Source, SourceInfo, TimeRange, TopicMeta, Visit,
    has_extension,
};
use anyhow::bail;
use mcapdecode::{
    FieldDefs, McapReader, McapReaderError, MessageEncoding, Read, SchemaEncoding, Value,
};
use std::{
    ops::{Bound, ControlFlow},
    path::Path,
    sync::Arc,
};

pub(super) struct Mcap;

impl Format for Mcap {
    fn accepts(&self, path: &Path) -> bool {
        has_extension(path, "mcap")
    }

    fn open(&self, path: &Path) -> anyhow::Result<Arc<dyn Source>> {
        let file = match McapReader::builder().with_parallel(false).open(path) {
            Err(McapReaderError::SummaryNotAvailable) => {
                bail!("MCAP has no Summary; indexed recordings are required")
            }
            file => file?,
        };
        Ok(Arc::new(McapSource {
            info: indexed_info(&file)?,
            file,
        }))
    }
}

/// The caller must keep recordings immutable while the server is running.
struct McapSource {
    info: SourceInfo,
    file: McapReader,
}

impl Source for McapSource {
    fn read_batch(
        &self,
        topics: &[String],
        range: TimeRange,
        visit: &mut BatchVisit,
    ) -> anyhow::Result<Vec<anyhow::Result<()>>> {
        let mut counts = vec![0usize; topics.len()];
        let mut stopped = None;
        if topics.len() > 1 && topics.iter().all(|topic| !topic.starts_with("@mcap:")) {
            let result = self
                .file
                .read()
                .topics(topics)
                .time_range(bounds(range))
                .decoded()
                .try_for_each(|channel, message| {
                    let i = topics.iter().position(|t| *t == channel.topic).unwrap();
                    let times = MessageTimes {
                        log_time: message.log_time,
                        publish_time: Some(message.publish_time),
                    };
                    if let Err(error) = visit(i, times, message.value) {
                        stopped = Some(error);
                        return ControlFlow::Break(());
                    }
                    counts[i] += 1;
                    ControlFlow::Continue(())
                });
            if let Some(error) = stopped {
                return Err(error);
            }
            if result.is_ok() {
                return Ok(topics.iter().map(|_| Ok(())).collect());
            }
        }
        let mut results = Vec::with_capacity(topics.len());
        for (i, topic) in topics.iter().enumerate() {
            let mut skipped = 0;
            let result = self.read(topic, range, &mut |times, value| {
                if skipped < counts[i] {
                    skipped += 1;
                    return Ok(());
                }
                visit(i, times, value).map_err(|error| {
                    stopped = Some(error);
                    anyhow::anyhow!("Batch visitor stopped")
                })
            });
            if let Some(error) = stopped.take() {
                return Err(error);
            }
            results.push(result);
        }
        Ok(results)
    }

    fn info(&self) -> anyhow::Result<SourceInfo> {
        Ok(self.info.clone())
    }

    fn topics(&self) -> anyhow::Result<Vec<TopicMeta>> {
        let channels = self.file.channels();
        let summary = self.file.summary();
        let mut counts = std::collections::HashMap::new();
        let mut schemas = std::collections::HashMap::new();
        for channel in &channels {
            *counts.entry(channel.topic.clone()).or_insert(0usize) += 1;
        }
        channels
            .into_iter()
            .map(|channel| {
                let key = summary.channels.get(&channel.id).and_then(|channel| {
                    channel
                        .schema
                        .as_ref()
                        .map(|schema| (schema.id, channel.message_encoding.clone()))
                });
                let fields = match key {
                    Some(key) => schemas
                        .entry(key)
                        .or_insert_with(|| {
                            channel_field_defs(self.file.read().channel(channel.id))
                                .map_err(|e| e.to_string())
                        })
                        .clone(),
                    None => channel_field_defs(self.file.read().channel(channel.id))
                        .map_err(|e| e.to_string()),
                };
                Ok(TopicMeta {
                    id: if counts[&channel.topic] == 1 && !channel.topic.starts_with("@mcap:") {
                        channel.topic.clone()
                    } else {
                        format!("@mcap:{}", channel.id)
                    },
                    topic: channel.topic,
                    // A channel without a schema has always been reported with an empty encoding.
                    schema_encoding: Some(
                        channel
                            .schema
                            .as_ref()
                            .map_or("", |schema| schema.encoding.as_str())
                            .to_owned(),
                    ),
                    schema_name: channel.schema.map(|schema| schema.name),
                    message_count: channel.message_count,
                    fields,
                })
            })
            .collect()
    }

    fn field_defs(&self, topic: &str) -> anyhow::Result<FieldDefs> {
        channel_field_defs(self.select(topic)?)
    }

    fn is_json_text(&self, topic: &str) -> anyhow::Result<bool> {
        let id: Option<u16> = topic.strip_prefix("@mcap:").map(str::parse).transpose()?;
        Ok(self.file.channels().iter().any(|channel| {
            id.map_or(channel.topic == topic, |id| channel.id == id)
                && channel
                    .schema
                    .as_ref()
                    .is_some_and(|schema| schema.encoding == SchemaEncoding::JsonSchema)
                && channel.message_encoding == MessageEncoding::Json
        }))
    }

    /// Located through the message indexes, so only the chunk holding the message is read.
    fn latest_at(&self, topic: &str, time: u64) -> anyhow::Result<Option<(MessageTimes, Value)>> {
        // Without messages there are no chunk indexes to search.
        if self.info.time_range.is_none() {
            return Ok(None);
        }
        let latest = self.select(topic)?.time_range(..=time).decoded().latest()?;
        Ok(latest.into_iter().next().map(|(_, message)| {
            let times = MessageTimes {
                log_time: message.log_time,
                publish_time: Some(message.publish_time),
            };
            (times, message.value)
        }))
    }

    fn meta_fields(&self) -> &'static [&'static str] {
        &["log_time", "publish_time"]
    }

    fn read(&self, topic: &str, range: TimeRange, visit: &mut Visit) -> anyhow::Result<()> {
        let read = self.select(topic)?;
        // Carry the visitor's own error out unchanged rather than as a decoder error.
        let mut stopped = None;
        let result = read
            .time_range(bounds(range))
            .decoded()
            .try_for_each(|_, message| {
                let times = MessageTimes {
                    log_time: message.log_time,
                    publish_time: Some(message.publish_time),
                };
                match visit(times, message.value) {
                    Ok(()) => ControlFlow::Continue(()),
                    Err(e) => {
                        stopped = Some(e);
                        ControlFlow::Break(())
                    }
                }
            });
        match stopped {
            Some(e) => Err(e),
            None => Ok(result?),
        }
    }
}

impl McapSource {
    /// The channel a topic id names: `@mcap:<channel id>`, or a topic with one channel.
    fn select(&self, topic: &str) -> anyhow::Result<Read<'_>> {
        Ok(match topic.strip_prefix("@mcap:") {
            Some(id) => self.file.read().channel(id.parse()?),
            None => self.file.read().topic(topic),
        })
    }
}

/// The schema of the one channel `read` selects.
fn channel_field_defs(read: Read<'_>) -> anyhow::Result<FieldDefs> {
    let mut defs = read.field_defs()?;
    if defs.len() != 1 {
        bail!("Expected one channel, found {}", defs.len());
    }
    Ok(defs.remove(0).1)
}

/// Inclusive start, exclusive end.
fn bounds(range: TimeRange) -> (Bound<u64>, Bound<u64>) {
    (
        range.start.map_or(Bound::Unbounded, Bound::Included),
        range.end.map_or(Bound::Unbounded, Bound::Excluded),
    )
}

/// What the summary says about the messages. Rejects recordings without chunk and
/// message indexes, which cannot be read fast enough.
fn indexed_info(file: &McapReader) -> anyhow::Result<SourceInfo> {
    let summary = file.summary();
    let time_range = file.message_time_range().map(|range| range.into_inner());
    let message_count = summary.stats.as_ref().map(|stats| stats.message_count);
    // Statistics or chunk indexes that show no messages need no message index.
    if time_range.is_none() && (message_count.is_some() || !summary.chunk_indexes.is_empty()) {
        return Ok(SourceInfo {
            time_range: None,
            message_count: Some(0),
        });
    }
    if summary.chunk_indexes.is_empty() {
        bail!("MCAP has no ChunkIndex; indexed, chunked recordings are required");
    }
    if summary
        .chunk_indexes
        .iter()
        .any(|c| c.message_index_offsets.is_empty())
    {
        bail!(
            "MCAP chunks without message indexes are not supported by the current decoder reader"
        );
    }
    Ok(SourceInfo {
        time_range,
        message_count,
    })
}
