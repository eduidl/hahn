//! Indexed, chunked MCAP recordings decoded by `mcapdecode`.

use super::{Format, MessageTimes, Source, SourceInfo, TimeRange, TopicMeta, Visit, has_extension};
use anyhow::{Context, bail, ensure};
use mcapdecode::{McapReader, ReadOptions, core::FieldDefs};
use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};

pub(super) struct Mcap;

impl Format for Mcap {
    fn accepts(&self, path: &Path) -> bool {
        has_extension(path, "mcap")
    }

    fn open(&self, path: &Path) -> anyhow::Result<Arc<dyn Source>> {
        let info = info_from_summary(recording_summary(path)?)?;
        Ok(Arc::new(McapSource {
            path: path.to_owned(),
            info,
            reader: McapReader::builder()
                .with_default_decoders()
                .with_parallel(false)
                .build(),
        }))
    }
}

/// The caller must keep recordings immutable while the server is running.
struct McapSource {
    path: PathBuf,
    info: SourceInfo,
    reader: McapReader,
}

impl Source for McapSource {
    fn info(&self) -> anyhow::Result<SourceInfo> {
        Ok(self.info.clone())
    }

    fn topics(&self) -> anyhow::Result<Vec<TopicMeta>> {
        let channels = self.reader.list_channels(&self.path)?;
        let summary = recording_summary(&self.path)?;
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
                            self.reader
                                .field_defs_by_channel_id(&self.path, channel.id)
                                .map_err(|e| e.to_string())
                        })
                        .clone(),
                    None => self
                        .reader
                        .field_defs_by_channel_id(&self.path, channel.id)
                        .map_err(|e| e.to_string()),
                };
                Ok(TopicMeta {
                    id: if counts[&channel.topic] == 1 && !channel.topic.starts_with("@mcap:") {
                        channel.topic.clone()
                    } else {
                        format!("@mcap:{}", channel.id)
                    },
                    topic: channel.topic,
                    schema_name: channel.schema_name,
                    schema_encoding: Some(channel.schema_encoding),
                    message_count: channel.message_count,
                    fields,
                })
            })
            .collect()
    }

    fn field_defs(&self, topic: &str) -> anyhow::Result<FieldDefs> {
        if let Some(id) = topic.strip_prefix("@mcap:") {
            Ok(self
                .reader
                .field_defs_by_channel_id(&self.path, id.parse()?)?)
        } else {
            Ok(self.reader.topic_field_defs(&self.path, topic)?)
        }
    }

    fn meta_fields(&self) -> &'static [&'static str] {
        &["log_time", "publish_time"]
    }

    fn read(&self, topic: &str, range: TimeRange, visit: &mut Visit) -> anyhow::Result<()> {
        let options = ReadOptions {
            time_range: Some(mcapdecode::TimeRange {
                start: range.start,
                end: range.end,
            }),
            parallel: Some(false),
            ..Default::default()
        };
        // Carry the visitor's own error out unchanged rather than as a decoder error.
        let mut stopped = None;
        let mut callback = |message: mcapdecode::core::DecodedMessage| {
            let times = MessageTimes {
                log_time: message.log_time,
                publish_time: Some(message.publish_time),
            };
            visit(times, message.value).map_err(|e| {
                stopped = Some(e);
                std::io::Error::other("Read stopped").into()
            })
        };
        let result = if let Some(id) = topic.strip_prefix("@mcap:") {
            self.reader
                .for_each_decoded_message_by_channel_id_with_options(
                    &self.path,
                    id.parse()?,
                    &options,
                    &mut callback,
                )
        } else {
            self.reader.for_each_decoded_message_with_options(
                &self.path,
                topic,
                &options,
                &mut callback,
            )
        };
        match stopped {
            Some(e) => Err(e),
            None => Ok(result?),
        }
    }
}

fn recording_summary(path: &Path) -> anyhow::Result<mcap::read::Summary> {
    let file = File::open(path)?;
    // SAFETY: recordings are immutable inputs (also required by McapReader).
    // The mapping remains owned by this function for the duration of parsing.
    let mapping = unsafe { memmap2::Mmap::map(&file)? };
    let summary = mcap::read::Summary::read(&mapping)?
        .context("MCAP has no Summary; indexed recordings are required")?;
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
    Ok(summary)
}

fn info_from_summary(summary: mcap::read::Summary) -> anyhow::Result<SourceInfo> {
    if let Some(stats) = summary.stats {
        ensure!(stats.message_count > 0, "No message time range");
        return Ok(SourceInfo {
            start_ns: stats.message_start_time,
            end_ns: stats.message_end_time,
            message_count: Some(stats.message_count),
        });
    }
    let start = summary
        .chunk_indexes
        .iter()
        .map(|c| c.message_start_time)
        .min()
        .context("No message time range")?;
    let end = summary
        .chunk_indexes
        .iter()
        .map(|c| c.message_end_time)
        .max()
        .context("No message time range")?;
    Ok(SourceInfo {
        start_ns: start,
        end_ns: end,
        message_count: None,
    })
}
