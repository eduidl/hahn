//! A group's coordinate frame graph, merged from all of its transform topics.

use super::convert::{Message, has, is_string, is_struct, quaternion, vector};
use crate::{
    ApiError, AppState, blocking,
    message::parse_time,
    source::{Source, TimeRange},
};
use anyhow::ensure;
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
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

fn transform_list(data_type: &DataTypeDef) -> bool {
    let element = match data_type {
        DataTypeDef::List(element)
        | DataTypeDef::BoundedList(element, _)
        | DataTypeDef::Array(element, _) => element,
        _ => return false,
    };
    matches!(&element.data_type, DataTypeDef::Struct(defs) if transform_fields(&defs.fields))
}

fn accepts(schema_name: &str, defs: &FieldDefs) -> bool {
    match schema_name {
        "foxglove.FrameTransform" => transform_fields(defs),
        "foxglove.FrameTransforms" => has(defs, "transforms", transform_list),
        _ => false,
    }
}

/// The parent, child and transform of a message, if it holds a usable one.
fn sample<'a>(message: Message<'a>) -> anyhow::Result<(&'a str, &'a str, Transform)> {
    let (parent, child) = (
        message.string("parent_frame_id")?,
        message.string("child_frame_id")?,
    );
    ensure!(
        !parent.is_empty() && !child.is_empty(),
        "A transform must name both of its frames"
    );
    let transform = Transform {
        translation: vector(message.child("translation")?)?,
        rotation: quaternion(message.child("rotation")?)?,
    };
    Ok((parent, child, transform))
}

/// Topics of latched, time-independent transforms.
fn is_static_topic(topic: &str) -> bool {
    matches!(topic.rsplit('/').next(), Some("tf_static" | "tf-static"))
}

struct Sample {
    time: u64,
    parent: Arc<str>,
    transform: Transform,
}

/// The transforms from one frame to its parents, ordered by time.
#[derive(Default)]
struct Edge {
    samples: Vec<Sample>,
    from_static_topic: bool,
}

impl Edge {
    /// A lone sample is all there is to know about a frame, so it holds at all times.
    fn is_static(&self) -> bool {
        self.from_static_topic || self.samples.len() == 1
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

#[derive(Default)]
pub(crate) struct TfIndex {
    edges: HashMap<Arc<str>, Edge>,
    /// Every frame named, shared by the samples referring to it.
    names: HashSet<Arc<str>>,
}

impl TfIndex {
    /// Reads every transform topic of the recordings.
    pub(crate) fn build(
        sources: impl IntoIterator<Item = Arc<dyn Source>>,
    ) -> anyhow::Result<Self> {
        let mut index = Self::default();
        for source in sources {
            for meta in source.topics()? {
                let (Ok(defs), Some(schema_name)) = (&meta.fields, &meta.schema_name) else {
                    continue;
                };
                if !accepts(schema_name, defs) {
                    continue;
                }
                let from_static_topic = is_static_topic(&meta.topic);
                source.read(&meta.id, TimeRange::default(), &mut |times, value| {
                    // One bad sample must not take every frame of the run with it.
                    if let Ok(message) = Message::new(defs, &value) {
                        let messages = if schema_name == "foxglove.FrameTransforms" {
                            message.children("transforms").unwrap_or_default()
                        } else {
                            vec![message]
                        };
                        for message in messages {
                            if let Ok((parent, child, transform)) = sample(message) {
                                index.add(
                                    child,
                                    parent,
                                    times.log_time,
                                    transform,
                                    from_static_topic,
                                );
                            }
                        }
                    }
                    Ok(())
                })?;
            }
        }
        for edge in index.edges.values_mut() {
            // Stable, so that the last of equal times stays the last recorded.
            edge.samples.sort_by_key(|s| s.time);
        }
        Ok(index)
    }

    fn add(
        &mut self,
        child: &str,
        parent: &str,
        time: u64,
        transform: Transform,
        from_static_topic: bool,
    ) {
        let (child, parent) = (self.intern(child), self.intern(parent));
        let edge = self.edges.entry(child).or_default();
        edge.from_static_topic |= from_static_topic;
        edge.samples.push(Sample {
            time,
            parent,
            transform,
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

    fn frames(&self) -> Vec<FrameInfo<'_>> {
        let mut frames: Vec<_> = self
            .names
            .iter()
            .map(|id| {
                let edge = self.edges.get(id);
                FrameInfo {
                    id,
                    parent: edge.and_then(|e| e.samples.last()).map(|s| &*s.parent),
                }
            })
            .collect();
        frames.sort_by_key(|frame| frame.id);
        frames
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

#[derive(Serialize)]
struct FrameInfo<'a> {
    id: &'a str,
    parent: Option<&'a str>,
}

async fn run_index(state: &AppState, run: &str) -> Result<Arc<TfIndex>, ApiError> {
    state.run(run)?;
    let (runs, run) = (state.runs.clone(), run.to_owned());
    blocking(move || {
        runs.iter()
            .find(|r| r.id == run)
            .expect("checked above")
            .tf()
    })
    .await
}

#[derive(Serialize)]
struct FrameList<'a> {
    frames: Vec<FrameInfo<'a>>,
}

pub(crate) async fn frames(
    State(state): State<AppState>,
    Path(run): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    use axum::response::IntoResponse;
    let index = run_index(&state, &run).await?;
    Ok(Json(FrameList {
        frames: index.frames(),
    })
    .into_response())
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
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("Unknown frame: {}", query.target),
        ));
    }
    Ok(Json(Transforms {
        frames: index.resolve(&query.target, time),
        time_ns: query.time_ns,
        target: query.target,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moved(x: f64) -> Transform {
        Transform {
            translation: [x, 0., 0.],
            ..IDENTITY
        }
    }

    /// A quarter turn around z.
    fn turned() -> Transform {
        let half = std::f64::consts::FRAC_PI_4;
        Transform {
            translation: [0.; 3],
            rotation: [0., 0., half.sin(), half.cos()],
        }
    }

    fn close(a: [f64; 3], b: [f64; 3]) {
        for (a, b) in a.iter().zip(&b) {
            assert!((a - b).abs() < 1e-9, "{a} != {b}");
        }
    }

    #[test]
    fn composes_rotation_before_translation() {
        let moved_then_turned = moved(1.).then(turned());
        close(moved_then_turned.translation, [1., 0., 0.]);
        let turned_then_moved = turned().then(moved(1.));
        close(turned_then_moved.translation, [0., 1., 0.]);
        close(
            turned_then_moved
                .then(turned_then_moved.inverse())
                .translation,
            [0.; 3],
        );
    }

    #[test]
    fn interpolates_between_samples_and_never_extrapolates() {
        let mut index = TfIndex::default();
        index.add("base", "map", 100, moved(0.), false);
        index.add("base", "map", 200, moved(10.), false);
        let at = |time| index.resolve("map", time).get("base").copied();
        assert_eq!(at(99), None);
        assert_eq!(at(100), Some(moved(0.)));
        close(at(150).unwrap().translation, [5., 0., 0.]);
        assert_eq!(at(200), Some(moved(10.)));
        assert_eq!(at(201), None);
    }

    #[test]
    fn slerp_takes_the_short_way_round() {
        let half = std::f64::consts::FRAC_PI_8;
        let mid = slerp(
            [0., 0., 0., 1.],
            // The same quarter turn as `turned`, with its sign flipped.
            [0., 0., -turned().rotation[2], -turned().rotation[3]],
            0.5,
        );
        close([mid[2], mid[3], 0.], [half.sin(), half.cos(), 0.]);
    }

    #[test]
    fn chains_static_and_dynamic_edges_in_both_directions() {
        let mut index = TfIndex::default();
        index.add("base", "map", 100, moved(1.), false);
        index.add("base", "map", 200, moved(1.), false);
        index.add("lidar", "base", 1, moved(2.), true);
        let to_map = index.resolve("map", 150);
        close(to_map["lidar"].translation, [3., 0., 0.]);
        let to_lidar = index.resolve("lidar", 150);
        close(to_lidar["map"].translation, [-3., 0., 0.]);
        // Past the dynamic samples only the static edge remains.
        let later = index.resolve("lidar", 300);
        assert!(later.contains_key("base"));
        assert!(!later.contains_key("map"));
    }

    #[test]
    fn unconnected_frames_are_left_out() {
        let mut index = TfIndex::default();
        index.add("base", "map", 1, moved(1.), false);
        index.add("tag", "other", 1, moved(1.), false);
        let frames = index.resolve("map", 1);
        assert!(frames.contains_key("base"));
        assert!(!frames.contains_key("tag"));
    }

    #[test]
    fn a_frame_changing_parent_is_not_interpolated_across() {
        let mut index = TfIndex::default();
        index.add("base", "a", 100, moved(1.), false);
        index.add("base", "b", 200, moved(9.), false);
        assert_eq!(index.resolve("a", 150)["base"], moved(1.));
        assert!(!index.resolve("b", 150).contains_key("base"));
        assert_eq!(index.resolve("b", 200)["base"], moved(9.));
    }
}
