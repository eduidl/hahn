//! Indexed, chunked MCAP recordings decoded by `mcapdecode`.

use super::{Format, Source, SourceInfo, TimeRange, TopicMeta, Visit, has_extension};
use anyhow::{Context, bail};
use mcapdecode::{McapReader, ReadOptions, core::FieldDefs};
use std::{
    collections::HashMap,
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};

pub(super) struct Mcap;

impl Format for Mcap {
    fn name(&self) -> &'static str {
        "mcap"
    }

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
        let summary = recording_summary(&self.path)?;
        let mut schemas = HashMap::new();
        self.reader
            .list_topics(&self.path)?
            .into_iter()
            .map(|info| {
                let channels: Vec<_> = summary
                    .channels
                    .values()
                    .filter(|c| c.topic == info.topic)
                    .collect();
                let cache_key = if channels.len() == 1 {
                    channels[0]
                        .schema
                        .as_ref()
                        .map(|s| (s.id, channels[0].message_encoding.clone()))
                } else {
                    None
                };
                let defs = || {
                    self.reader
                        .topic_field_defs(&self.path, &info.topic)
                        .map_err(|e| e.to_string())
                };
                let fields = match cache_key {
                    Some(key) => schemas.entry(key).or_insert_with(defs).clone(),
                    None => defs(),
                };
                let schema = channels.iter().find_map(|channel| channel.schema.as_ref());
                Ok(TopicMeta {
                    topic: info.topic,
                    schema_name: info.schema_name,
                    schema_encoding: schema.map(|schema| schema.encoding.clone()),
                    message_count: info.message_count,
                    fields,
                })
            })
            .collect()
    }

    fn field_defs(&self, topic: &str) -> anyhow::Result<FieldDefs> {
        Ok(self.reader.topic_field_defs(&self.path, topic)?)
    }

    fn read(
        &self,
        topic: &str,
        range: TimeRange,
        limit: Option<usize>,
        visit: &mut Visit,
    ) -> anyhow::Result<()> {
        let options = ReadOptions {
            time_range: Some(mcapdecode::TimeRange {
                start: range.start,
                end: range.end,
            }),
            limit,
            parallel: Some(false),
            ..Default::default()
        };
        // Carry the visitor's own error out unchanged rather than as a decoder error.
        let mut stopped = None;
        let result = self.reader.for_each_decoded_message_with_options(
            &self.path,
            topic,
            &options,
            |message| {
                visit(message.log_time, message.value).map_err(|e| {
                    stopped = Some(e);
                    std::io::Error::other("Read stopped").into()
                })
            },
        );
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
