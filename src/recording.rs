use anyhow::{Context, bail};
use serde::Serialize;
use std::{fs::File, path::Path};

#[derive(Debug, Serialize)]
pub struct RecordingInfo {
    pub start_ns: String,
    /// Last message timestamp, inclusive.
    pub end_ns: String,
    pub message_count: Option<u64>,
}

/// Inspect the summary without scanning message payloads.
/// The caller must keep recordings immutable while the server is running.
pub fn recording_info(path: &Path) -> anyhow::Result<RecordingInfo> {
    let summary = recording_summary(path)?;
    info_from_summary(summary)
}

pub(crate) fn recording_summary(path: &Path) -> anyhow::Result<mcap::read::Summary> {
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

fn info_from_summary(summary: mcap::read::Summary) -> anyhow::Result<RecordingInfo> {
    let (start, end, count) = if let Some(stats) = summary.stats {
        (
            stats.message_start_time,
            stats.message_end_time,
            Some(stats.message_count),
        )
    } else {
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
        (start, end, None)
    };
    Ok(RecordingInfo {
        start_ns: start.to_string(),
        end_ns: end.to_string(),
        message_count: count,
    })
}
