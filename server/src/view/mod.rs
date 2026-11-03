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

pub(crate) use tf::{TfIndex, dynamic_transforms, frames, readers, static_transforms};
pub use tf::{TransformReader, TransformSample};

use crate::{
    AppState, blocking,
    error::{ApiError, Code, coded},
    message::{parse_range, parse_time},
    source::{MessageTimes, Source},
    stream::disconnected,
};
use axum::{
    Json,
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
    Annotation, AnnotationsView, Box3, BoxesView, CameraCalibrationView, GeoFeature,
    GeoLocationView, GeoView, ImageView, Kind, NumericType, PackedField, PathView, PointCloudView,
    PointField, Pose, PoseView, PosesView, PositionView, RawImageView, Shape, View,
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
    /// For an image: the calibration that topic names suggest for it (ADR 0004).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) calibration: Option<ViewRef>,
    /// For an image: whether its pixels are rectified, when topic names say so.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rectified: Option<bool>,
}

/// A view of another topic of the same group.
#[derive(Clone, Serialize)]
pub(crate) struct ViewRef {
    pub(crate) topic: String,
    pub(crate) view: &'static str,
}

impl ViewInfo {
    pub(crate) fn of(converter: &dyn ViewConverter) -> Self {
        Self {
            id: converter.id(),
            kind: converter.kind().as_str(),
            name: converter.name(),
            calibration: None,
            rectified: None,
        }
    }
}

/// Where a camera's topics live, from one of its image topics, by the conventions of
/// ROS and Foxglove recordings: `/cam/image_raw`, `/cam/image_rect/compressed` and
/// `/cam` all name the camera `/cam`. Also whether the name says the pixels are
/// rectified (`rect`) or raw (`raw`).
fn camera_of(image_topic: &str) -> (&str, Option<bool>) {
    let mut camera = image_topic.trim_end_matches('/');
    let mut rectified = None;
    while let Some((parent, last)) = camera.rsplit_once('/') {
        if last != "compressed" && !last.starts_with("image") {
            break;
        }
        if last.contains("rect") {
            rectified = Some(true);
        } else if last.contains("raw") && rectified.is_none() {
            rectified = Some(false);
        }
        camera = parent;
    }
    (camera, rectified)
}

/// Fills in, for each image view, the calibration of the same camera when exactly one
/// calibration topic of the group lives directly under it, and whether its pixels
/// are rectified. Neither is certain: the client lets the user choose otherwise.
pub(crate) fn suggest_calibrations(topics: &mut [(String, String, Vec<ViewInfo>)]) {
    let calibrations: Vec<(String, String, &'static str)> = topics
        .iter()
        .flat_map(|(id, name, views)| {
            views
                .iter()
                .filter(|view| view.kind == Kind::CameraCalibration.as_str())
                .map(|view| (id.clone(), name.clone(), view.id))
        })
        .collect();
    for (_, name, views) in topics.iter_mut() {
        let (camera, rectified) = camera_of(name);
        let matches: Vec<_> = calibrations
            .iter()
            .filter(|(_, calibration, _)| {
                calibration.rsplit_once('/').map(|(parent, _)| parent) == Some(camera)
            })
            .collect();
        for view in views
            .iter_mut()
            .filter(|view| view.kind == Kind::Image.as_str())
        {
            view.rectified = rectified;
            if let [(id, _, calibration)] = matches[..] {
                view.calibration = Some(ViewRef {
                    topic: id.clone(),
                    view: calibration,
                });
            }
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
        #[serde(skip_serializing_if = "Option::is_none")]
        stream: Option<usize>,
        time_ns: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Unchanged,
    Complete {
        #[serde(skip_serializing_if = "Option::is_none")]
        stream: Option<usize>,
        scanned_messages: usize,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        stream: Option<usize>,
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
    stream: Option<usize>,
) -> anyhow::Result<Vec<Bytes>> {
    let mut payload = Payload::default();
    let converted = Message::new(defs, value).and_then(|message| {
        let view = converter.convert(&message)?;
        anyhow::ensure!(
            view.kind() == converter.kind(),
            "Converter {} returned {} instead of {}",
            converter.id(),
            view.kind().as_str(),
            converter.kind().as_str()
        );
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
                stream,
                time_ns,
                value: Some(value),
                error: None,
            },
            payload,
        ),
        Err(error) => control(&Header::Frame {
            stream,
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
        group.require_topic(&topic)?;
        let (defs, converter) = group.views(&state.converters)?.get(&topic, &view)?;
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
            send(frame(&*converter, &defs, times, &value, None)?)?;
            Ok(())
        });
        if tx.is_closed() {
            return;
        }
        let end = match result {
            Ok(()) => Header::Complete {
                stream: None,
                scanned_messages: scanned,
            },
            Err(error) => Header::Error {
                stream: None,
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
pub(crate) struct BatchViewsQuery {
    start_ns: Option<String>,
    end_ns: Option<String>,
    views: Vec<BatchView>,
}

#[derive(Deserialize)]
struct BatchView {
    topic: String,
    view: String,
}

pub(crate) async fn batch_views(
    State(state): State<AppState>,
    Path((run, group)): Path<(String, String)>,
    Json(query): Json<BatchViewsQuery>,
) -> Result<Response, ApiError> {
    if query.views.is_empty() || query.views.len() > 32 {
        return Err(ApiError::new(
            Code::InvalidRequest,
            "Choose between 1 and 32 views",
        ));
    }
    let range = parse_range(&query.start_ns, &query.end_ns)?;
    let group = state.group(&run, &group)?;
    let (source, prepared) = blocking(move || {
        let source = group.source()?;
        let views = group.views(&state.converters)?;
        let prepared = query
            .views
            .into_iter()
            .map(|item| {
                group.require_topic(&item.topic)?;
                let (defs, converter) = views.get(&item.topic, &item.view)?;
                Ok((item.topic, defs, converter))
            })
            .collect::<Vec<anyhow::Result<_>>>();
        Ok((source, prepared))
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
        let mut topics = Vec::<String>::new();
        let mut members = Vec::<Vec<usize>>::new();
        for (i, entry) in prepared.iter().enumerate() {
            match entry {
                Ok((topic, _, _)) => {
                    let index = topics
                        .iter()
                        .position(|name| name == topic)
                        .unwrap_or_else(|| {
                            topics.push(topic.clone());
                            members.push(Vec::new());
                            topics.len() - 1
                        });
                    members[index].push(i);
                }
                Err(error) => {
                    if control(&Header::Error {
                        stream: Some(i),
                        code: Code::of(error).as_str(),
                        message: error.to_string(),
                    })
                    .and_then(|chunks| Ok(send(chunks)?))
                    .is_err()
                    {
                        return;
                    }
                }
            }
        }
        let mut counts = vec![0; prepared.len()];
        let result = source.read_batch(&topics, range, &mut |topic, times, value| {
            for &i in &members[topic] {
                let (_, defs, converter) = prepared[i].as_ref().unwrap();
                send(frame(&**converter, defs, times, &value, Some(i))?)?;
                counts[i] += 1;
            }
            Ok(())
        });
        if tx.is_closed() {
            return;
        }
        match result {
            Ok(results) => {
                for (topic, result) in results.into_iter().enumerate() {
                    for &i in &members[topic] {
                        let header = match &result {
                            Ok(()) => Header::Complete {
                                stream: Some(i),
                                scanned_messages: counts[i],
                            },
                            Err(error) => Header::Error {
                                stream: Some(i),
                                code: Code::of(error).as_str(),
                                message: error.to_string(),
                            },
                        };
                        if control(&header)
                            .and_then(|chunks| Ok(send(chunks)?))
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
            Err(error) => {
                for (i, entry) in prepared.iter().enumerate() {
                    if entry.is_ok() {
                        let header = Header::Error {
                            stream: Some(i),
                            code: Code::of(&error).as_str(),
                            message: error.to_string(),
                        };
                        if control(&header)
                            .and_then(|chunks| Ok(send(chunks)?))
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
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
            stream: None,
            scanned_messages: latest.iter().len(),
        })?);
        Ok(chunks)
    })
    .await?;
    let chunks = tokio_stream::iter(chunks.into_iter().map(Ok::<_, Infallible>));
    Ok(frames_response(Body::from_stream(chunks)))
}
