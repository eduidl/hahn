//! A group's coordinate frame graph, merged from all of its transform topics.

use super::convert::{Message, has, is_foxglove, is_string, is_struct, quaternion, vector};
use crate::{
    AppState, blocking,
    error::{ApiError, Code},
    message::{parse_range, parse_time},
    source::{Source, TimeRange},
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use mcapdecode::core::{DataTypeDef, FieldDefs};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::Arc,
};

/// A rigid transform: `p_out = rotation * p_in + translation`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
struct Transform {
    translation: [f64; 3],
    /// `[x, y, z, w]`
    rotation: [f64; 4],
}

const IDENTITY: Transform = Transform {
    translation: [0.; 3],
    rotation: [0., 0., 0., 1.],
};

fn multiply(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let [ax, ay, az, aw] = a;
    let [bx, by, bz, bw] = b;
    [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]
}

fn rotate(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let [x, y, z, w] = q;
    let [vx, vy, vz] = v;
    // v + 2w(u × v) + 2u × (u × v), with t = 2(u × v).
    let t = [
        2. * (y * vz - z * vy),
        2. * (z * vx - x * vz),
        2. * (x * vy - y * vx),
    ];
    [
        vx + w * t[0] + y * t[2] - z * t[1],
        vy + w * t[1] + z * t[0] - x * t[2],
        vz + w * t[2] + x * t[1] - y * t[0],
    ]
}

impl Transform {
    /// The transform applying `other` first and then `self`.
    fn then(self, other: Transform) -> Transform {
        let moved = rotate(self.rotation, other.translation);
        Transform {
            translation: [
                self.translation[0] + moved[0],
                self.translation[1] + moved[1],
                self.translation[2] + moved[2],
            ],
            rotation: multiply(self.rotation, other.rotation),
        }
    }

    fn inverse(self) -> Transform {
        let [x, y, z, w] = self.rotation;
        let rotation = [-x, -y, -z, w];
        let [tx, ty, tz] = rotate(rotation, self.translation);
        Transform {
            translation: [-tx, -ty, -tz],
            rotation,
        }
    }

    fn interpolate(self, other: Transform, ratio: f64) -> Transform {
        let mut translation = [0.; 3];
        for (i, value) in translation.iter_mut().enumerate() {
            *value = self.translation[i] + (other.translation[i] - self.translation[i]) * ratio;
        }
        Transform {
            translation,
            rotation: slerp(self.rotation, other.rotation, ratio),
        }
    }
}

fn slerp(a: [f64; 4], b: [f64; 4], ratio: f64) -> [f64; 4] {
    let mut dot: f64 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
    // Take the short way round: q and -q are the same rotation.
    let sign = if dot < 0. { -1. } else { 1. };
    dot *= sign;
    let (from, to) = if dot > 0.9995 {
        // Nearly parallel: the sine below would lose precision.
        (1. - ratio, ratio)
    } else {
        let angle = dot.acos();
        (
            ((1. - ratio) * angle).sin() / angle.sin(),
            (ratio * angle).sin() / angle.sin(),
        )
    };
    let mut q = [0.; 4];
    for (i, value) in q.iter_mut().enumerate() {
        *value = from * a[i] + to * sign * b[i];
    }
    let length = q.iter().map(|v| v * v).sum::<f64>().sqrt();
    q.map(|v| v / length)
}

/// Types read as transforms, chosen like the converters of views.
fn transform_fields(defs: &FieldDefs) -> bool {
    has(defs, "parent_frame_id", is_string)
        && has(defs, "child_frame_id", is_string)
        && has(defs, "translation", is_struct)
        && has(defs, "rotation", is_struct)
}

fn list_of(data_type: &DataTypeDef, check: fn(&FieldDefs) -> bool) -> bool {
    let element = match data_type {
        DataTypeDef::List(element)
        | DataTypeDef::BoundedList(element, _)
        | DataTypeDef::Array(element, _) => element,
        _ => return false,
    };
    matches!(&element.data_type, DataTypeDef::Struct(defs) if check(&defs.fields))
}

fn transform_list(data_type: &DataTypeDef) -> bool {
    list_of(data_type, transform_fields)
}

/// The fields of `geometry_msgs/msg/TransformStamped`.
fn stamped_fields(defs: &FieldDefs) -> bool {
    has(defs, "header", is_struct)
        && has(defs, "child_frame_id", is_string)
        && has(defs, "transform", is_struct)
}

fn stamped_list(data_type: &DataTypeDef) -> bool {
    list_of(data_type, stamped_fields)
}

/// Reads the transforms that messages of the types it accepts hold.
///
/// Built-in readers implement this too. An application adds its own with
/// [`Builder::transforms`](crate::Builder::transforms). Every transform of a run
/// joins one graph of frames, whichever group or topic it came from.
pub trait TransformReader: Send + Sync {
    /// Decided from the schema alone, like [`ViewConverter::accepts`](super::ViewConverter::accepts).
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool;
    /// The transforms one message holds. An error leaves out this message only. Hahn
    /// leaves out a sample without both frame names or with a number that is not
    /// finite, and normalizes rotations.
    fn read(&self, message: &Message) -> anyhow::Result<Vec<TransformSample>>;
    /// Whether the transforms of `topic` hold at all times. By default, those on a
    /// topic whose last path segment is `tf_static` or `tf-static`. A frame with only
    /// one sample holds at all times anyway.
    fn is_static(&self, topic: &str) -> bool {
        is_static_topic(topic)
    }
}

/// A transform from `child` to `parent`: `p_parent = rotation * p_child + translation`,
/// recorded with its message.
#[derive(Clone, Debug, PartialEq)]
pub struct TransformSample {
    pub parent: String,
    pub child: String,
    /// Meters.
    pub translation: [f64; 3],
    /// `[x, y, z, w]`.
    pub rotation: [f64; 4],
    /// When the transform was measured, on the recording's measurement clock, such as
    /// its `header.stamp`. `None` when the message does not say; never the recording
    /// time, which Hahn keeps beside it.
    pub stamp_ns: Option<u64>,
}

pub(crate) fn readers(extra: Vec<Arc<dyn TransformReader>>) -> Vec<Arc<dyn TransformReader>> {
    let mut readers: Vec<Arc<dyn TransformReader>> = vec![
        Arc::new(FrameTransform),
        Arc::new(FrameTransforms),
        Arc::new(TfMessage),
    ];
    readers.extend(extra);
    readers
}

/// `foxglove.FrameTransform`.
struct FrameTransform;

impl TransformReader for FrameTransform {
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "FrameTransform") && transform_fields(defs)
    }
    fn read(&self, message: &Message) -> anyhow::Result<Vec<TransformSample>> {
        Ok(vec![sample(*message)?])
    }
}

/// `foxglove.FrameTransforms`. A bad transform leaves out only itself.
struct FrameTransforms;

impl TransformReader for FrameTransforms {
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "FrameTransforms") && has(defs, "transforms", transform_list)
    }
    fn read(&self, message: &Message) -> anyhow::Result<Vec<TransformSample>> {
        Ok(message
            .children("transforms")?
            .into_iter()
            .filter_map(|message| sample(message).ok())
            .collect())
    }
}

/// `tf2_msgs/msg/TFMessage`. A bad transform leaves out only itself.
struct TfMessage;

impl TransformReader for TfMessage {
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "tf2_msgs/msg/TFMessage" && has(defs, "transforms", stamped_list)
    }
    fn read(&self, message: &Message) -> anyhow::Result<Vec<TransformSample>> {
        Ok(message
            .children("transforms")?
            .into_iter()
            .filter_map(|message| stamped_sample(message).ok())
            .collect())
    }
}

/// The transform of a `foxglove.FrameTransform`.
fn sample(message: Message) -> anyhow::Result<TransformSample> {
    Ok(TransformSample {
        parent: message.string("parent_frame_id")?.to_owned(),
        child: message.string("child_frame_id")?.to_owned(),
        translation: vector(message.child("translation")?)?,
        rotation: quaternion(message.child("rotation")?)?,
        stamp_ns: message.time("timestamp")?,
    })
}

/// The same from a `geometry_msgs/msg/TransformStamped`.
fn stamped_sample(message: Message) -> anyhow::Result<TransformSample> {
    let header = message.child("header")?;
    let parent = header.map_or(Ok(""), |header| header.string("frame_id"))?;
    let transform = message.child("transform")?;
    let part = |name| {
        transform
            .map(|t| t.child(name))
            .transpose()
            .map(Option::flatten)
    };
    Ok(TransformSample {
        parent: parent.to_owned(),
        child: message.string("child_frame_id")?.to_owned(),
        translation: vector(part("translation")?)?,
        rotation: quaternion(part("rotation")?)?,
        stamp_ns: match header {
            Some(header) => header.time("stamp")?,
            None => None,
        },
    })
}

/// A sample as Hahn uses it, or `None` if it must be left out.
fn usable(sample: TransformSample) -> Option<(String, String, Transform, Option<u64>)> {
    let TransformSample {
        parent,
        child,
        translation,
        rotation,
        stamp_ns,
    } = sample;
    if parent.is_empty() || child.is_empty() {
        return None;
    }
    if !translation.iter().chain(&rotation).all(|v| v.is_finite()) {
        return None;
    }
    let length = rotation.iter().map(|v| v * v).sum::<f64>().sqrt();
    let rotation = if length == 0. {
        [0., 0., 0., 1.]
    } else {
        rotation.map(|v| v / length)
    };
    Some((
        parent,
        child,
        Transform {
            translation,
            rotation,
        },
        stamp_ns,
    ))
}

/// Topics of latched, time-independent transforms.
fn is_static_topic(topic: &str) -> bool {
    matches!(topic.rsplit('/').next(), Some("tf_static" | "tf-static"))
}

struct Sample {
    /// Recording time.
    time: u64,
    /// Where the sample was read: run group, then topic, then message order.
    order: u64,
    stamp: Option<u64>,
    parent: Arc<str>,
    transform: Transform,
}

/// The transforms from one frame to its parents, ordered by time.
#[derive(Default)]
struct Edge {
    samples: Vec<Sample>,
    on_static_topic: bool,
    on_dynamic_topic: bool,
    /// Samples of this frame left out because they hold no usable transform.
    dropped: u64,
}

impl Edge {
    /// Static when only static topics hold the frame: one that also appears on a
    /// dynamic topic may change. A lone sample is all there is to know about a frame,
    /// so it holds at all times.
    fn is_static(&self) -> bool {
        (self.on_static_topic && !self.on_dynamic_topic) || self.samples.len() == 1
    }

    /// The parent and transform at `time`. Never extrapolates a dynamic edge.
    fn at(&self, time: u64) -> Option<(&Arc<str>, Transform)> {
        if self.is_static() {
            let last = self.samples.last()?;
            return Some((&last.parent, last.transform));
        }
        let after = self.samples.partition_point(|s| s.time <= time);
        let before = self.samples.get(after.checked_sub(1)?)?;
        if before.time == time {
            return Some((&before.parent, before.transform));
        }
        let next = self.samples.get(after)?;
        // A change of parent cannot be interpolated across.
        if next.parent != before.parent {
            return Some((&before.parent, before.transform));
        }
        let ratio = (time - before.time) as f64 / (next.time - before.time) as f64;
        Some((
            &before.parent,
            before.transform.interpolate(next.transform, ratio),
        ))
    }
}

/// A sample read from a group, kept apart until the whole group has been read.
struct Read {
    child: String,
    parent: String,
    time: u64,
    stamp: Option<u64>,
    transform: Transform,
    static_topic: bool,
}

#[derive(Default)]
pub(crate) struct TfIndex {
    edges: HashMap<Arc<str>, Edge>,
    /// Every frame named, shared by the samples referring to it.
    names: HashSet<Arc<str>>,
    /// Groups left out because they could not be read.
    unreadable: Vec<String>,
    /// The order of the next sample added.
    next: u64,
}

impl TfIndex {
    /// Reads every transform topic of the run's groups, in run order. A group that
    /// cannot be opened or read is left out as a whole and listed, so that it does
    /// not take the other groups' frames with it.
    pub(crate) fn build(
        groups: impl IntoIterator<Item = (String, anyhow::Result<Arc<dyn Source>>)>,
        readers: &[Arc<dyn TransformReader>],
    ) -> Self {
        let mut index = Self::default();
        for (id, source) in groups {
            let mut dropped = Vec::new();
            match source.and_then(|source| read_group(&*source, readers, &mut dropped)) {
                Ok(samples) => {
                    for sample in samples {
                        index.add(sample);
                    }
                    for child in dropped {
                        let child = index.intern(&child);
                        index.edges.entry(child).or_default().dropped += 1;
                    }
                }
                Err(_) => index.unreadable.push(id),
            }
        }
        for edge in index.edges.values_mut() {
            // Stable, so that the last of equal times stays the last recorded.
            edge.samples.sort_by_key(|s| s.time);
        }
        index
    }

    fn add(&mut self, read: Read) {
        let (child, parent) = (self.intern(&read.child), self.intern(&read.parent));
        let order = self.next;
        self.next += 1;
        let edge = self.edges.entry(child).or_default();
        edge.on_static_topic |= read.static_topic;
        edge.on_dynamic_topic |= !read.static_topic;
        edge.samples.push(Sample {
            time: read.time,
            order,
            stamp: read.stamp,
            parent,
            transform: read.transform,
        });
    }

    fn intern(&mut self, name: &str) -> Arc<str> {
        if let Some(name) = self.names.get(name) {
            return name.clone();
        }
        let name: Arc<str> = name.into();
        self.names.insert(name.clone());
        name
    }

    /// Resolve one pose at its recording time, without changing the pose's local frame.
    pub(super) fn pose_in_target(
        &self,
        target: &str,
        source: &str,
        time: u64,
        position: [f64; 3],
        orientation: [f64; 4],
    ) -> Option<([f64; 3], [f64; 4])> {
        let placement = if source == target {
            IDENTITY
        } else {
            *self.resolve(target, time).get(source)?
        };
        let pose = placement.then(Transform {
            translation: position,
            rotation: orientation,
        });
        Some((pose.translation, pose.rotation))
    }

    fn frames(&self) -> Vec<FrameInfo<'_>> {
        let mut frames: Vec<_> = self
            .names
            .iter()
            .map(|id| {
                let edge = self.edges.get(id).filter(|edge| !edge.samples.is_empty());
                let mut parents: Vec<&str> = Vec::new();
                for sample in edge.iter().flat_map(|edge| &edge.samples) {
                    if !parents.contains(&&*sample.parent) {
                        parents.push(&sample.parent);
                    }
                }
                FrameInfo {
                    id,
                    parent: edge.and_then(|e| e.samples.last()).map(|s| &*s.parent),
                    kind: edge.map(|edge| {
                        if edge.is_static() {
                            "static"
                        } else {
                            "dynamic"
                        }
                    }),
                    parents,
                    dropped_samples: self.edges.get(id).map_or(0, |edge| edge.dropped),
                }
            })
            .collect();
        frames.sort_by_key(|frame| frame.id);
        frames
    }

    /// The transform of each static frame: its last sample.
    fn static_transforms(&self) -> Vec<TransformRow<'_>> {
        let mut rows: Vec<_> = self
            .edges
            .iter()
            .filter(|(_, edge)| edge.is_static())
            .filter_map(|(child, edge)| {
                let last = edge.samples.last()?;
                Some(TransformRow::of(child, last, false))
            })
            .collect();
        rows.sort_by_key(|row| row.child);
        rows
    }

    /// The samples of dynamic frames recorded in `[start, end)`, in recording order.
    fn dynamic_samples(&self, start: u64, end: u64) -> Vec<TransformRow<'_>> {
        let mut found: Vec<(&Arc<str>, &Sample)> = Vec::new();
        for (child, edge) in &self.edges {
            if edge.is_static() {
                continue;
            }
            let from = edge.samples.partition_point(|s| s.time < start);
            let to = edge.samples.partition_point(|s| s.time < end);
            found.extend(edge.samples[from..to.max(from)].iter().map(|s| (child, s)));
        }
        found.sort_by_key(|(_, sample)| (sample.time, sample.order));
        found
            .into_iter()
            .map(|(child, sample)| TransformRow::of(child, sample, true))
            .collect()
    }

    /// Every frame connected to `target` at `time`, with the transform into `target`.
    fn resolve(&self, target: &str, time: u64) -> BTreeMap<Arc<str>, Transform> {
        // Each frame's edge as it stands at `time`, walkable in both directions.
        let mut neighbours: HashMap<&str, Vec<(&Arc<str>, Transform)>> = HashMap::new();
        for (child, edge) in &self.edges {
            if let Some((parent, transform)) = edge.at(time) {
                // parent <- child, and child <- parent.
                neighbours
                    .entry(parent)
                    .or_default()
                    .push((child, transform));
                neighbours
                    .entry(child)
                    .or_default()
                    .push((parent, transform.inverse()));
            }
        }
        let target: Arc<str> = target.into();
        let mut resolved = BTreeMap::from([(target.clone(), IDENTITY)]);
        let mut queue = VecDeque::from([target]);
        while let Some(frame) = queue.pop_front() {
            let to_target = resolved[&frame];
            for (next, transform) in neighbours.get(&*frame).into_iter().flatten() {
                if !resolved.contains_key(*next) {
                    resolved.insert((*next).clone(), to_target.then(*transform));
                    queue.push_back((*next).clone());
                }
            }
        }
        resolved
    }
}

/// Reads one group's transforms, collecting the children of samples left out.
fn read_group(
    source: &dyn Source,
    readers: &[Arc<dyn TransformReader>],
    dropped: &mut Vec<String>,
) -> anyhow::Result<Vec<Read>> {
    let mut samples = Vec::new();
    for meta in source.topics()? {
        let (Ok(defs), Some(schema_name)) = (&meta.fields, &meta.schema_name) else {
            continue;
        };
        let Some(reader) = readers.iter().find(|r| r.accepts(schema_name, defs)) else {
            continue;
        };
        let static_topic = reader.is_static(&meta.topic);
        source.read(&meta.id, TimeRange::default(), &mut |times, value| {
            // One bad sample must not take every frame of the run with it.
            let read = Message::new(defs, &value)
                .and_then(|message| reader.read(&message))
                .unwrap_or_default();
            for sample in read {
                let child = sample.child.clone();
                match usable(sample) {
                    Some((parent, child, transform, stamp)) => samples.push(Read {
                        child,
                        parent,
                        time: times.log_time,
                        stamp,
                        transform,
                        static_topic,
                    }),
                    None if !child.is_empty() => dropped.push(child),
                    None => {}
                }
            }
            Ok(())
        })?;
    }
    Ok(samples)
}

#[derive(Serialize)]
struct FrameInfo<'a> {
    id: &'a str,
    /// The last parent recorded. Superseded by `parents`.
    parent: Option<&'a str>,
    /// `None` for a frame that is only ever a parent.
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
    parents: Vec<&'a str>,
    dropped_samples: u64,
}

/// A transform as sent: static ones without times, dynamic samples with them.
#[derive(Serialize)]
struct TransformRow<'a> {
    child: &'a str,
    parent: &'a str,
    translation: [f64; 3],
    rotation: [f64; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    time_ns: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stamp_ns: Option<String>,
}

impl<'a> TransformRow<'a> {
    fn of(child: &'a str, sample: &'a Sample, timed: bool) -> Self {
        Self {
            child,
            parent: &sample.parent,
            translation: sample.transform.translation,
            rotation: sample.transform.rotation,
            time_ns: timed.then(|| sample.time.to_string()),
            stamp_ns: sample
                .stamp
                .filter(|_| timed)
                .map(|stamp| stamp.to_string()),
        }
    }
}

async fn run_index(state: &AppState, run: &str) -> Result<Arc<TfIndex>, ApiError> {
    state.run(run)?;
    let (state, run) = (state.clone(), run.to_owned());
    blocking(move || {
        state
            .runs
            .iter()
            .find(|r| r.id == run)
            .expect("checked above")
            .tf(&state.transforms)
    })
    .await
}

#[derive(Serialize)]
struct FrameList<'a> {
    frames: Vec<FrameInfo<'a>>,
    /// Groups whose transforms are missing because they could not be read.
    unreadable_groups: &'a [String],
}

pub(crate) async fn frames(
    State(state): State<AppState>,
    Path(run): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    use axum::response::IntoResponse;
    let index = run_index(&state, &run).await?;
    Ok(Json(FrameList {
        frames: index.frames(),
        unreadable_groups: &index.unreadable,
    })
    .into_response())
}

pub(crate) async fn static_transforms(
    State(state): State<AppState>,
    Path(run): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    use axum::response::IntoResponse;
    let index = run_index(&state, &run).await?;
    Ok(Json(serde_json::json!({ "transforms": index.static_transforms() })).into_response())
}

#[derive(Deserialize)]
pub(crate) struct DynamicQuery {
    start_ns: String,
    end_ns: String,
}

pub(crate) async fn dynamic_transforms(
    State(state): State<AppState>,
    Path(run): Path<String>,
    Query(query): Query<DynamicQuery>,
) -> Result<axum::response::Response, ApiError> {
    use axum::response::IntoResponse;
    let range = parse_range(&Some(query.start_ns), &Some(query.end_ns))?;
    let (start, end) = (range.start.unwrap_or(0), range.end.unwrap_or(u64::MAX));
    let index = run_index(&state, &run).await?;
    Ok(Json(serde_json::json!({ "samples": index.dynamic_samples(start, end) })).into_response())
}

#[derive(Deserialize)]
pub(crate) struct TransformsQuery {
    target: String,
    time_ns: String,
}

#[derive(Serialize)]
pub(crate) struct Transforms {
    time_ns: String,
    target: String,
    frames: BTreeMap<Arc<str>, Transform>,
}

pub(crate) async fn transforms(
    State(state): State<AppState>,
    Path(run): Path<String>,
    Query(query): Query<TransformsQuery>,
) -> Result<Json<Transforms>, ApiError> {
    let time = parse_time(&query.time_ns)?;
    let index = run_index(&state, &run).await?;
    if !index.names.contains(query.target.as_str()) {
        return Err(ApiError::new(
            Code::UnknownFrame,
            format!("Unknown frame: {}", query.target),
        ));
    }
    Ok(Json(Transforms {
        frames: index.resolve(&query.target, time),
        time_ns: query.time_ns,
        target: query.target,
    }))
}
