use hahn::{
    DataTypeDef, ElementDef, FieldDef, FieldDefs, Format, MessageTimes, Source, SourceInfo,
    TimeRange, TopicMeta, Value, Visit,
};
use std::{path::Path, sync::Arc};

pub(crate) fn defs(fields: Vec<(&str, DataTypeDef)>) -> FieldDefs {
    FieldDefs::new(
        fields
            .into_iter()
            .map(|(name, data_type)| FieldDef::new(name, data_type, false))
            .collect(),
    )
}

struct Memory(Arc<Vec<Topic>>);

impl Format for Memory {
    fn accepts(&self, path: &Path) -> bool {
        path.extension().is_some_and(|e| e == "mem")
    }
    fn open(&self, _: &Path) -> anyhow::Result<Arc<dyn Source>> {
        Ok(Arc::new(MemorySource(self.0.clone())))
    }
}

impl Source for MemorySource {
    fn info(&self) -> anyhow::Result<SourceInfo> {
        let times = self
            .0
            .iter()
            .flat_map(|topic| topic.messages.iter().map(|(time, _)| *time));
        let (Some(start_ns), Some(end_ns)) = (times.clone().min(), times.max()) else {
            anyhow::bail!("The recording has no messages");
        };
        Ok(SourceInfo {
            start_ns,
            end_ns,
            message_count: None,
        })
    }

    fn topics(&self) -> anyhow::Result<Vec<TopicMeta>> {
        Ok(self
            .0
            .iter()
            .map(|topic| TopicMeta {
                id: topic.name.into(),
                topic: topic.name.into(),
                schema_name: Some(topic.schema_name.into()),
                schema_encoding: Some(topic.schema_encoding.into()),
                message_count: Some(topic.messages.len() as u64),
                fields: Ok(topic.defs.clone()),
            })
            .collect())
    }

    fn field_defs(&self, topic: &str) -> anyhow::Result<FieldDefs> {
        Ok(self.topic(topic)?.defs.clone())
    }

    fn is_json_text(&self, topic: &str) -> anyhow::Result<bool> {
        Ok(self.topic(topic)?.json_text)
    }

    fn read(&self, topic: &str, range: TimeRange, visit: &mut Visit) -> anyhow::Result<()> {
        for (time, value) in &self.topic(topic)?.messages {
            if range.start.is_none_or(|start| *time >= start)
                && range.end.is_none_or(|end| *time < end)
            {
                visit(MessageTimes::from(*time), value.clone())?;
            }
        }
        Ok(())
    }
}
