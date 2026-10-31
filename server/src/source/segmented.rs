//! One recording split across files, such as a rosbag2 bag's numbered segments.

use super::{Format, Source, SourceInfo, TimeRange, TopicMeta, Visit};
use mcapdecode::core::FieldDefs;
use std::{collections::HashSet, path::Path, sync::Arc};

struct Segment {
    source: Arc<dyn Source>,
    topics: HashSet<String>,
}

struct Segmented {
    segments: Vec<Segment>,
    info: SourceInfo,
    topics: Vec<TopicMeta>,
}

/// Opens `paths` as one recording. Their time ranges must not overlap, which keeps
/// the segments in time order when read in turn.
pub fn open_segments(
    format: &dyn Format,
    paths: &[impl AsRef<Path>],
) -> anyhow::Result<Arc<dyn Source>> {
    let sources = paths
        .iter()
        .map(|path| format.open(path.as_ref()))
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(Arc::new(Segmented::new(sources)?))
}

impl Segmented {
    fn new(sources: Vec<Arc<dyn Source>>) -> anyhow::Result<Self> {
        let mut ordered = sources
            .into_iter()
            .map(|source| Ok((source.info()?, source)))
            .collect::<anyhow::Result<Vec<_>>>()?;
        ordered.sort_by_key(|(info, _)| info.start_ns);
        anyhow::ensure!(!ordered.is_empty(), "No segments");
        for pair in ordered.windows(2) {
            anyhow::ensure!(
                pair[0].0.end_ns <= pair[1].0.start_ns,
                "Segments overlap in time"
            );
        }
        let info = SourceInfo {
            start_ns: ordered[0].0.start_ns,
            end_ns: ordered
                .iter()
                .map(|(info, _)| info.end_ns)
                .max()
                .unwrap_or(0),
            message_count: ordered.iter().map(|(info, _)| info.message_count).sum(),
        };
        let mut topics: Vec<TopicMeta> = Vec::new();
        let mut segments = Vec::with_capacity(ordered.len());
        for (_, source) in ordered {
            let mut names = HashSet::new();
            for meta in source.topics()? {
                names.insert(meta.topic.clone());
                match topics.iter_mut().find(|t| t.topic == meta.topic) {
                    Some(merged) => merge(merged, meta),
                    None => topics.push(meta),
                }
            }
            segments.push(Segment {
                source,
                topics: names,
            });
        }
        Ok(Self {
            segments,
            info,
            topics,
        })
    }
}

fn merge(merged: &mut TopicMeta, next: TopicMeta) {
    merged.message_count = [merged.message_count, next.message_count].into_iter().sum();
    let same = match (&merged.fields, &next.fields) {
        (Ok(a), Ok(b)) => a == b,
        _ => true,
    };
    if !same {
        merged.fields = Err("Schema differs between segments".into());
    } else if let Err(error) = next.fields {
        merged.fields = Err(error);
    }
}

impl Source for Segmented {
    fn meta_fields(&self) -> &'static [&'static str] {
        self.segments[0].source.meta_fields()
    }

    fn info(&self) -> anyhow::Result<SourceInfo> {
        Ok(self.info.clone())
    }

    fn topics(&self) -> anyhow::Result<Vec<TopicMeta>> {
        Ok(self.topics.clone())
    }

    fn field_defs(&self, topic: &str) -> anyhow::Result<FieldDefs> {
        let meta = self
            .topics
            .iter()
            .find(|t| t.topic == topic)
            .ok_or_else(|| anyhow::anyhow!("topic not found"))?;
        meta.fields.clone().map_err(anyhow::Error::msg)
    }

    fn read(&self, topic: &str, range: TimeRange, visit: &mut Visit) -> anyhow::Result<()> {
        self.field_defs(topic)?;
        for segment in self.segments.iter().filter(|s| s.topics.contains(topic)) {
            segment.source.read(topic, range, visit)?;
        }
        Ok(())
    }
}
