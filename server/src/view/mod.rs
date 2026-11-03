//! Views: messages converted to the protocol's fixed kinds, and the frame graph
//! their coordinates refer to.
//!
//! Only the server knows recorded message types. Clients see the kinds and share
//! one parser for all of them, so adding a kind or a converter adds no operation.

mod convert;
mod frame;
mod ros2;
mod tf;
mod value;

pub(crate) use tf::{TfIndex, dynamic_transforms, frames, readers, static_transforms, transforms};
pub use tf::{TransformReader, TransformSample};

use crate::{
    AppState, blocking,
    error::{ApiError, Code, coded},
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
pub use convert::{Message, ViewConverter, schema};
pub(crate) use frame::CONTENT_TYPE;
use frame::{Payload, encode};
use mcapdecode::core::{FieldDefs, Value};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, convert::Infallible, sync::Arc};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
pub use value::{
    CameraCalibrationView, GeoFeature, GeoView, ImageView, Kind, NumericType, PackedField,
    PointCloudView, PointField, Pose, PoseView, RawImageView, View,
};

/// The built-in converters followed by `extra`, whose IDs must be new.
pub(crate) fn converters(
    extra: Vec<Arc<dyn ViewConverter>>,
) -> anyhow::Result<Vec<Arc<dyn ViewConverter>>> {
    let mut converters = convert::converters();
    for converter in extra {
        anyhow::ensure!(!converter.id().is_empty(), "Converter ID must not be empty");
        anyhow::ensure!(
            converters
                .iter()
                .all(|existing| existing.id() != converter.id()),
            "Duplicate converter ID: {}",
            converter.id()
        );
        converters.push(converter);
    }
    Ok(converters)
}

#[derive(Clone, Serialize)]
pub(crate) struct ViewInfo {
    pub(crate) id: &'static str,
    pub(crate) kind: &'static str,
    pub(crate) name: &'static str,
}

impl ViewInfo {
    pub(crate) fn of(converter: &dyn ViewConverter) -> Self {
        Self {
            id: converter.id(),
            kind: converter.kind().as_str(),
            name: converter.name(),
        }
    }
}

/// The views a topic of this schema offers.
pub(crate) fn declared(
    schema_name: Option<&str>,
    defs: &FieldDefs,
    converters: &[Arc<dyn ViewConverter>],
) -> Vec<ViewInfo> {
    accepted(schema_name, defs, converters)
        .map(|converter| ViewInfo::of(&**converter))
        .collect()
}

fn accepted<'a>(
    schema_name: Option<&'a str>,
    defs: &'a FieldDefs,
    converters: &'a [Arc<dyn ViewConverter>],
) -> impl Iterator<Item = &'a Arc<dyn ViewConverter>> + 'a {
    converters.iter().filter(move |converter| {
        schema_name.is_some_and(|schema_name| converter.accepts(schema_name, defs))
    })
}

struct TopicViews {
    defs: Arc<FieldDefs>,
    converters: Vec<Arc<dyn ViewConverter>>,
}

/// Which converters apply to which topic. Kept per group, since it is looked up on
/// every request during playback and listing topics reads the recording's summary.
pub(crate) struct ViewIndex {
    topics: HashMap<String, TopicViews>,
}

impl ViewIndex {
    pub(crate) fn build(
        source: &dyn Source,
        registry: &[Arc<dyn ViewConverter>],
    ) -> anyhow::Result<Self> {
        let mut topics = HashMap::new();
        for meta in source.topics()? {
            let Ok(defs) = meta.fields else { continue };
            let converters: Vec<_> = accepted(meta.schema_name.as_deref(), &defs, registry)
                .cloned()
                .collect();
            if !converters.is_empty() {
                let defs = Arc::new(defs);
                topics.insert(meta.id, TopicViews { defs, converters });
            }
        }
        Ok(Self { topics })
    }

    fn get(
        &self,
        topic: &str,
        view: &str,
    ) -> anyhow::Result<(Arc<FieldDefs>, Arc<dyn ViewConverter>)> {
        self.topics
            .get(topic)
            .and_then(|views| {
                let converter = views.converters.iter().find(|c| c.id() == view)?;
                Some((views.defs.clone(), converter.clone()))
            })
            .ok_or_else(|| {
                coded(
                    Code::UnknownView,
                    format!("Unknown view {view:?} of topic {topic:?}"),
                )
            })
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
        code: &'static str,
        message: String,
    },
}

fn control(header: &Header) -> anyhow::Result<Vec<Bytes>> {
    encode(header, Payload::default())
}

/// One message as a frame. A message that cannot be converted fails on its own: the
/// schema cannot rule that out, and the messages around it may be fine.
fn frame(
    converter: &dyn ViewConverter,
    defs: &FieldDefs,
    times: MessageTimes,
    value: &Value,
    target: Option<(&str, &TfIndex)>,
) -> anyhow::Result<Vec<Bytes>> {
    let mut payload = Payload::default();
    let converted = Message::new(defs, value).and_then(|message| {
        let mut view = converter.convert(&message)?;
        anyhow::ensure!(
            view.kind() == converter.kind(),
            "Converter {} returned {} instead of {}",
            converter.id(),
            view.kind().as_str(),
            converter.kind().as_str()
        );
        if let Some((target, tf)) = target {
            let View::Pose(pose) = &mut view else {
                anyhow::bail!("Target frame is only supported for pose views");
            };
            pose.pose = value::checked(pose.pose)?;
            let source = pose
                .frame_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Pose has no frame ID"))?;
            let (position, orientation) = tf
                .pose_in_target(
                    target,
                    source,
                    times.log_time,
                    pose.pose.position,
                    pose.pose.orientation,
                )
                .ok_or_else(|| {
                    anyhow::anyhow!("No transform from {source} to {target} at this time")
                })?;
            pose.frame_id = Some(target.to_owned());
            pose.pose = Pose {
                position,
                orientation,
            };
        }
        let stamp = converter.stamp(&message)?;
        let mut value = value::encode(view, &mut payload)?;
        if let (Some(stamp), Some(object)) = (stamp, value.as_object_mut()) {
            object.insert("stamp_ns".into(), stamp.to_string().into());
        }
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
    target_frame: Option<String>,
}

/// Converted messages in a time range, one frame per message.
pub(crate) async fn views(
    State(state): State<AppState>,
    Path((run, group)): Path<(String, String)>,
    Query(query): Query<ViewsQuery>,
) -> Result<Response, ApiError> {
    let group = state.group(&run, &group)?;
    let range = parse_range(&query.start_ns, &query.end_ns)?;
    let (topic, view, target) = (query.topic, query.view, query.target_frame);
    let (source, topic, defs, converter, target) = blocking(move || {
        let source = group.source()?;
        group.require_topic(&topic)?;
        let (defs, converter) = group.views(&state.converters)?.get(&topic, &view)?;
        if target.is_some() && converter.kind() != Kind::Pose {
            return Err(coded(
                Code::InvalidRequest,
                "Target frame is only supported for pose views",
            ));
        }
        let target = target
            .map(|target| {
                if target.is_empty() {
                    return Err(coded(
                        Code::InvalidRequest,
                        "Target frame must not be empty",
                    ));
                }
                let run = state
                    .runs
                    .iter()
                    .find(|item| item.id == run)
                    .expect("run checked by group");
                Ok::<_, anyhow::Error>((target, run.tf(&state.transforms)?))
            })
            .transpose()?;
        Ok((source, topic, defs, converter, target))
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
            send(frame(
                &*converter,
                &defs,
                times,
                &value,
                target
                    .as_ref()
                    .map(|(name, tf)| (name.as_str(), tf.as_ref())),
            )?)?;
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
                code: Code::of(&error).as_str(),
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
        group.require_topic(&query.topic)?;
        let (defs, converter) = group
            .views(&state.converters)?
            .get(&query.topic, &query.view)?;
        let mut chunks = Vec::new();
        let latest = source.latest_at(&query.topic, time)?;
        if let Some((times, value)) = &latest {
            if known == Some(times.log_time) {
                chunks.extend(control(&Header::Unchanged)?);
            } else {
                chunks.extend(frame(&*converter, &defs, *times, value, None)?);
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
