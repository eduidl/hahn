//! Recordings held in memory, served through the public [`hahn::Format`], so a test
//! can give the server any schema and value without writing a file format for it.

use hahn::{
    DataTypeDef, ElementDef, FieldDef, FieldDefs, Format, MessageTimes, Source, SourceInfo,
    TimeRange, TopicMeta, Value, Visit,
};
use std::{path::Path, sync::Arc};

/// One topic: its schema and its messages by recording time.
#[derive(Clone)]
pub(crate) struct Topic {
    pub(crate) name: &'static str,
    pub(crate) schema_name: &'static str,
    pub(crate) schema_encoding: &'static str,
    /// Messages are one string field of JSON text.
    pub(crate) json_text: bool,
    pub(crate) defs: FieldDefs,
    pub(crate) messages: Vec<(u64, Value)>,
}

impl Topic {
    pub(crate) fn new(
        name: &'static str,
        schema_name: &'static str,
        fields: Vec<(&str, DataTypeDef)>,
    ) -> Self {
        Self {
            name,
            schema_name,
            schema_encoding: "memory",
            json_text: false,
            defs: defs(fields),
            messages: Vec::new(),
        }
    }

    /// Adds a message of the field values in schema order.
    pub(crate) fn at(mut self, time: u64, values: Vec<Value>) -> Self {
        self.messages.push((time, Value::Struct(values)));
        self
    }
}

pub(crate) fn defs(fields: Vec<(&str, DataTypeDef)>) -> FieldDefs {
    FieldDefs::new(
        fields
            .into_iter()
            .map(|(name, data_type)| FieldDef::new(name, data_type, false))
            .collect(),
    )
}

pub(crate) fn structure(fields: Vec<(&str, DataTypeDef)>) -> DataTypeDef {
    DataTypeDef::Struct(defs(fields).into())
}

pub(crate) fn list(element: DataTypeDef) -> DataTypeDef {
    DataTypeDef::List(Box::new(ElementDef::new(element, false)))
}

/// Serves `topics` as the one run of a server set up by `configure`.
pub(crate) fn app(
    topics: Vec<Topic>,
    configure: impl FnOnce(hahn::Builder) -> hahn::Builder,
) -> (tempfile::TempDir, axum::Router) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("memory.mem"), "").unwrap();
    let builder = hahn::Builder::new(dir.path()).format(Memory(Arc::new(topics)));
    (dir, configure(builder).router().unwrap())
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

struct MemorySource(Arc<Vec<Topic>>);

impl MemorySource {
    fn topic(&self, name: &str) -> anyhow::Result<&Topic> {
        self.0
            .iter()
            .find(|topic| topic.name == name)
            .ok_or_else(|| anyhow::anyhow!("Unknown topic: {name}"))
    }
}

impl Source for MemorySource {
    fn info(&self) -> anyhow::Result<SourceInfo> {
        let times = self
            .0
            .iter()
            .flat_map(|topic| topic.messages.iter().map(|(time, _)| *time));
        Ok(SourceInfo {
            time_range: times.clone().min().zip(times.max()),
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
