//! A recording split across files, with independent topics for each segment.

use super::{Format, Source, SourceInfo, TimeRange, TopicMeta, Visit};
use mcapdecode::core::FieldDefs;
use std::{path::Path, sync::Arc};

struct Segmented {
    segments: Vec<Arc<dyn Source>>,
    info: SourceInfo,
    topics: Vec<(TopicMeta, usize, String)>,
}

pub fn open_segments(
    format: &dyn Format,
    paths: &[impl AsRef<Path>],
) -> anyhow::Result<Arc<dyn Source>> {
    let mut sources = paths
        .iter()
        .map(|path| {
            let source = format.open(path.as_ref())?;
            Ok((source.info()?, source))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    sources.sort_by_key(|(info, _)| info.start_ns);
    anyhow::ensure!(!sources.is_empty(), "No segments");
    for pair in sources.windows(2) {
        anyhow::ensure!(
            pair[0].0.end_ns <= pair[1].0.start_ns,
            "Segments overlap in time"
        );
    }
    let info = SourceInfo {
        start_ns: sources[0].0.start_ns,
        end_ns: sources
            .iter()
            .map(|(info, _)| info.end_ns)
            .max()
            .unwrap_or(0),
        message_count: sources.iter().map(|(info, _)| info.message_count).sum(),
    };
    let mut topics = Vec::new();
    for (i, (_, source)) in sources.iter().enumerate() {
        for mut meta in source.topics()? {
            let original = meta.id.clone();
            meta.id = format!("@segment:{i}:{original}");
            topics.push((meta, i, original));
        }
    }
    Ok(Arc::new(Segmented {
        segments: sources.into_iter().map(|(_, source)| source).collect(),
        info,
        topics,
    }))
}

impl Segmented {
    fn topic(&self, id: &str) -> anyhow::Result<&(TopicMeta, usize, String)> {
        self.topics
            .iter()
            .find(|(meta, _, _)| meta.id == id)
            .ok_or_else(|| anyhow::anyhow!("topic not found"))
    }
}

impl Source for Segmented {
    fn meta_fields(&self) -> &'static [&'static str] {
        self.segments[0].meta_fields()
    }
    fn info(&self) -> anyhow::Result<SourceInfo> {
        Ok(self.info.clone())
    }
    fn topics(&self) -> anyhow::Result<Vec<TopicMeta>> {
        Ok(self
            .topics
            .iter()
            .map(|(meta, _, _)| meta.clone())
            .collect())
    }
    fn field_defs(&self, topic: &str) -> anyhow::Result<FieldDefs> {
        let (meta, _, _) = self.topic(topic)?;
        meta.fields.clone().map_err(anyhow::Error::msg)
    }
    fn is_json_text(&self, topic: &str) -> anyhow::Result<bool> {
        let (_, segment, original) = self.topic(topic)?;
        self.segments[*segment].is_json_text(original)
    }
    fn read(&self, topic: &str, range: TimeRange, visit: &mut Visit) -> anyhow::Result<()> {
        let (_, index, original) = self.topic(topic)?;
        self.segments[*index].read(original, range, visit)
    }
}
