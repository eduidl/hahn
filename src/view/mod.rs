//! Views: messages converted to the protocol's fixed kinds, and the frame graph
//! their coordinates refer to.
//!
//! Only the server knows recorded message types. Clients see the kinds and share
//! one parser for all of them, so adding a kind or a converter adds no operation.

mod convert;
mod frame;
mod tf;

pub(crate) use tf::{TfIndex, frames, transforms};

use crate::{
    ApiError, AppState, blocking,
    message::{parse_range, parse_time},
    source::{MessageTimes, Source},
    stream::disconnected,
};
use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
};
use convert::{CONVERTERS, Converter, Message};
pub(crate) use frame::CONTENT_TYPE;
use frame::{Payload, encode};
use mcapdecode::core::{FieldDefs, Value};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, convert::Infallible, sync::Arc};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

#[derive(Clone, Serialize)]
pub(crate) struct ViewInfo {
    id: &'static str,
    kind: &'static str,
    name: &'static str,
}

/// The views a topic of this schema offers.
pub(crate) fn declared(schema_name: Option<&str>, defs: &FieldDefs) -> Vec<ViewInfo> {
    accepted(schema_name, defs)
        .map(|converter| ViewInfo {
            id: converter.id(),
            kind: converter.kind(),
            name: converter.name(),
        })
        .collect()
}

fn accepted<'a>(
    schema_name: Option<&'a str>,
    defs: &'a FieldDefs,
) -> impl Iterator<Item = &'static dyn Converter> + 'a {
    CONVERTERS.iter().copied().filter(move |converter| {
        schema_name.is_some_and(|schema_name| converter.accepts(schema_name, defs))
    })
}

struct TopicViews {
    defs: Arc<FieldDefs>,
    converters: Vec<&'static dyn Converter>,
}

/// Which converters apply to which topic. Kept per group, since it is looked up on
/// every request during playback and listing topics reads the recording's summary.
pub(crate) struct ViewIndex {
    topics: HashMap<String, TopicViews>,
}

impl ViewIndex {
    pub(crate) fn build(source: &dyn Source) -> anyhow::Result<Self> {
        let mut topics = HashMap::new();
        for meta in source.topics()? {
            let Ok(defs) = meta.fields else { continue };
            let converters: Vec<_> = accepted(meta.schema_name.as_deref(), &defs).collect();
            if !converters.is_empty() {
                let defs = Arc::new(defs);
                topics.insert(meta.topic, TopicViews { defs, converters });
            }
        }
        Ok(Self { topics })
    }

    fn get(
        &self,
        topic: &str,
        view: &str,
    ) -> anyhow::Result<(Arc<FieldDefs>, &'static dyn Converter)> {
        self.topics
            .get(topic)
            .and_then(|views| {
                let converter = views.converters.iter().find(|c| c.id() == view)?;
                Some((views.defs.clone(), *converter))
            })
            .ok_or_else(|| anyhow::anyhow!("Unknown view {view:?} of topic {topic:?}"))
    }
}

/// The JSON header of a frame.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Header {
    Frame {
        time_ns: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Unchanged,
    Complete {
        scanned_messages: usize,
    },
    Error {
        message: String,
    },
}

fn control(header: &Header) -> anyhow::Result<Vec<Bytes>> {
    encode(header, Payload::default())
}

/// One message as a frame. A message that cannot be converted fails on its own: the
/// schema cannot rule that out, and the messages around it may be fine.
fn frame(
    converter: &dyn Converter,
    defs: &FieldDefs,
    times: MessageTimes,
    value: &Value,
) -> anyhow::Result<Vec<Bytes>> {
    let mut payload = Payload::default();
    let converted = Message::new(defs, value).and_then(|message| {
        let value = converter.convert(&message, &mut payload)?;
        anyhow::ensure!(payload.fits(), "The message is too large for a frame");
        Ok(value)
    });
    let time_ns = times.log_time.to_string();
    match converted {
        Ok(value) => encode(
            &Header::Frame {
                time_ns,
                value: Some(value),
                error: None,
            },
            payload,
        ),
        Err(error) => control(&Header::Frame {
            time_ns,
            value: None,
            error: Some(format!("{error:#}")),
        }),
    }
}

fn frames_response(body: Body) -> Response {
    (
        [
            (header::CONTENT_TYPE, CONTENT_TYPE),
            (header::CACHE_CONTROL, "no-store"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        body,
    )
        .into_response()
}

#[derive(Deserialize)]
pub(crate) struct ViewsQuery {
    topic: String,
    view: String,
    start_ns: Option<String>,
    /// Exclusive upper bound. Omit to include the last timestamp of a recording.
    end_ns: Option<String>,
}

/// Converted messages in a time range, one frame per message.
pub(crate) async fn views(
    State(state): State<AppState>,
    Path((run, group)): Path<(String, String)>,
    Query(query): Query<ViewsQuery>,
) -> Result<Response, ApiError> {
    let group = state.group(&run, &group)?;
    let range = parse_range(&query.start_ns, &query.end_ns)?;
    let (topic, view) = (query.topic, query.view);
    let (source, topic, defs, converter) = blocking(move || {
        let source = group.source()?;
        let (defs, converter) = group.views()?.get(&topic, &view)?;
        Ok((source, topic, defs, converter))
    })
    .await?;
    let (tx, rx) = mpsc::channel(4);
    tokio::task::spawn_blocking(move || {
        let send = |chunks: Vec<Bytes>| -> std::io::Result<()> {
            for chunk in chunks {
                tx.blocking_send(Ok::<_, Infallible>(chunk))
                    .map_err(|_| disconnected())?;
            }
            Ok(())
        };
        let mut scanned = 0;
        let result = source.read(&topic, range, &mut |times, value| {
            if tx.is_closed() {
                return Err(disconnected().into());
            }
            scanned += 1;
            send(frame(converter, &defs, times, &value)?)?;
            Ok(())
        });
        if tx.is_closed() {
            return;
        }
        let end = match result {
            Ok(()) => Header::Complete {
                scanned_messages: scanned,
            },
            Err(error) => Header::Error {
                message: error.to_string(),
            },
        };
        if let Ok(chunks) = control(&end) {
            let _ = send(chunks);
        }
    });
    Ok(frames_response(Body::from_stream(ReceiverStream::new(rx))))
}

#[derive(Deserialize)]
pub(crate) struct LatestQuery {
    topic: String,
    view: String,
    time_ns: String,
    /// The time of the frame the client already holds.
    known_time_ns: Option<String>,
}

/// The converted message current at `time_ns`, unless the client holds it already.
pub(crate) async fn latest(
    State(state): State<AppState>,
    Path((run, group)): Path<(String, String)>,
    Query(query): Query<LatestQuery>,
) -> Result<Response, ApiError> {
    let group = state.group(&run, &group)?;
    let time = parse_time(&query.time_ns)?;
    let known = query.known_time_ns.as_deref().map(parse_time).transpose()?;
    let chunks = blocking(move || {
        let source = group.source()?;
        let (defs, converter) = group.views()?.get(&query.topic, &query.view)?;
        let mut chunks = Vec::new();
        let latest = source.latest_at(&query.topic, time)?;
        if let Some((times, value)) = &latest {
            if known == Some(times.log_time) {
                chunks.extend(control(&Header::Unchanged)?);
            } else {
                chunks.extend(frame(converter, &defs, *times, value)?);
            }
        }
        chunks.extend(control(&Header::Complete {
            scanned_messages: latest.iter().len(),
        })?);
        Ok(chunks)
    })
    .await?;
    let chunks = tokio_stream::iter(chunks.into_iter().map(Ok::<_, Infallible>));
    Ok(frames_response(Body::from_stream(chunks)))
}
