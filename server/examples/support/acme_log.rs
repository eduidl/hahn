//! A file format of an application's own, unknown to Hahn: one message per line,
//! `<time_ns> <topic> <value>`, with a number as the value. Lines starting with `#`
//! and empty lines are left out.
#![allow(dead_code)]

use hahn::{
    DataTypeDef, FieldDef, FieldDefs, Format, MessageTimes, Source, SourceInfo, TimeRange,
    TopicMeta, Value, Visit,
};
use std::{path::Path, sync::Arc};

/// Files ending in `.acmelog`.
pub struct AcmeLog;

impl Format for AcmeLog {
    fn accepts(&self, path: &Path) -> bool {
        path.extension().is_some_and(|e| e == "acmelog")
    }
    fn open(&self, path: &Path) -> anyhow::Result<Arc<dyn Source>> {
        Ok(Arc::new(AcmeLogSource::parse(&std::fs::read_to_string(
            path,
        )?)?))
    }
}

/// The whole file, read when it is opened. A real format would index it instead.
struct AcmeLogSource {
    /// Time, topic and value of each message, in file order.
    messages: Vec<(u64, usize, f64)>,
    topics: Vec<String>,
    defs: FieldDefs,
}

impl AcmeLogSource {
    fn parse(text: &str) -> anyhow::Result<Self> {
        let mut source = Self {
            messages: Vec::new(),
            topics: Vec::new(),
            defs: FieldDefs::new(vec![FieldDef::new("value", DataTypeDef::F64, false)]),
        };
        for (number, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let parts: Vec<_> = line.split_whitespace().collect();
            let [time, topic, value] = parts[..] else {
                anyhow::bail!("Line {}: expected time, topic and value", number + 1);
            };
            let topic = match source.topics.iter().position(|t| t == topic) {
                Some(index) => index,
                None => {
                    source.topics.push(topic.to_owned());
                    source.topics.len() - 1
                }
            };
            source.messages.push((time.parse()?, topic, value.parse()?));
        }
        Ok(source)
    }

    fn topic(&self, topic: &str) -> anyhow::Result<usize> {
        self.topics
            .iter()
            .position(|t| t == topic)
            .ok_or_else(|| anyhow::anyhow!("Unknown topic: {topic}"))
    }
}

impl Source for AcmeLogSource {
    fn info(&self) -> anyhow::Result<SourceInfo> {
        let times = self.messages.iter().map(|(time, ..)| *time);
        Ok(SourceInfo {
            time_range: times.clone().min().zip(times.max()),
            message_count: Some(self.messages.len() as u64),
        })
    }

    fn topics(&self) -> anyhow::Result<Vec<TopicMeta>> {
        Ok(self
            .topics
            .iter()
            .enumerate()
            .map(|(index, topic)| TopicMeta {
                id: topic.clone(),
                topic: topic.clone(),
                schema_name: Some("acme_log/Scalar".into()),
                schema_encoding: Some("acme_log".into()),
                message_count: Some(
                    self.messages.iter().filter(|(_, t, _)| *t == index).count() as u64
                ),
                fields: Ok(self.defs.clone()),
            })
            .collect())
    }

    fn field_defs(&self, topic: &str) -> anyhow::Result<FieldDefs> {
        self.topic(topic)?;
        Ok(self.defs.clone())
    }

    fn read(&self, topic: &str, range: TimeRange, visit: &mut Visit) -> anyhow::Result<()> {
        let topic = self.topic(topic)?;
        for &(time, t, value) in &self.messages {
            let after_start = range.start.is_none_or(|start| time >= start);
            let before_end = range.end.is_none_or(|end| time < end);
            if t == topic && after_start && before_end {
                visit(
                    MessageTimes::from(time),
                    Value::Struct(vec![Value::F64(value)]),
                )?;
            }
        }
        Ok(())
    }
}

/// `/speed` rising by 1 every 100 ms and `/battery` falling, over 4 seconds.
pub fn write_acme_log(path: &Path) -> anyhow::Result<()> {
    let mut text = String::from("# time_ns topic value\n");
    for i in 0..40u64 {
        let time = i * 100_000_000;
        text.push_str(&format!("{time} /speed {}\n", i as f64));
        if i % 4 == 0 {
            text.push_str(&format!("{time} /battery {}\n", 100. - i as f64 / 2.));
        }
    }
    std::fs::write(path, text)?;
    Ok(())
}
