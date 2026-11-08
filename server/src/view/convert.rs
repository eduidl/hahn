//! Converters from recorded message types to the protocol's fixed kinds.

use super::value::{
    Annotation, AnnotationsView, CameraCalibrationView, GeoFeature, GeoLocationView, GeoView,
    ImageView, Kind, NumericType, PackedField, PathView, PointCloudView, Pose, PoseView,
    RawImageView, Shape, View,
};
use anyhow::{Context, bail, ensure};
use mcapdecode::{DataTypeDef, FieldDefs, Value};
use std::sync::Arc;

/// Turns messages of the types it accepts into one fixed kind.
///
/// Built-in converters implement this too. An application adds its own with
/// [`Builder::view`](crate::Builder::view).
pub trait ViewConverter: Send + Sync {
    /// Unique among the converters of a server; a topic's views are named after them.
    fn id(&self) -> &'static str;
    /// Every value [`convert`](Self::convert) returns must be of this kind.
    fn kind(&self) -> Kind;
    /// For display, such as `Pose`.
    fn name(&self) -> &'static str;
    /// Decided from the schema alone. Check the shape as well as the name, so that an
    /// unrelated type of the same name does not fail on every message. The helpers in
    /// [`crate::schema`] check field types.
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool;
    /// Converts one message. An error fails only this message, which the client shows
    /// in place of the value.
    fn convert(&self, message: &Message) -> anyhow::Result<View>;
    /// When the value was measured, in nanoseconds on the recording's measurement
    /// clock, or `None` when the message does not say. The default reads the
    /// `header.stamp` of ROS messages or the `timestamp` of Foxglove schemas; override
    /// it for a type that keeps its stamp elsewhere. Never substitute the recording
    /// time: clients place values in space by this stamp.
    fn stamp(&self, message: &Message) -> anyhow::Result<Option<u64>> {
        if message.has("header")
            && let Some(header) = message.child("header")?
        {
            return header.time("stamp");
        }
        message.time("timestamp")
    }
}

pub(crate) fn converters() -> Vec<Arc<dyn ViewConverter>> {
    let mut converters: Vec<Arc<dyn ViewConverter>> = vec![
        Arc::new(Image),
        Arc::new(RawImage),
        Arc::new(CameraCalibration),
        Arc::new(PointCloud),
        Arc::new(Odometry),
        Arc::new(PoseInFrame),
        Arc::new(PosesInFrame),
        Arc::new(Geo),
        Arc::new(GeoJson),
        Arc::new(ImageAnnotations),
    ];
    converters.extend(super::ros2::converters());
    converters
}

/// Whether `schema_name` is the Foxglove schema `name`, as Protobuf or as the
/// `foxglove_msgs` ROS 2 package, which share their field names.
pub(super) fn is_foxglove(schema_name: &str, name: &str) -> bool {
    schema_name
        .strip_prefix("foxglove.")
        .or_else(|| schema_name.strip_prefix("foxglove_msgs/msg/"))
        == Some(name)
}

/// Reads a decoded struct by field name.
#[derive(Clone, Copy)]
pub struct Message<'a> {
    defs: &'a FieldDefs,
    values: &'a [Value],
}

impl<'a> Message<'a> {
    /// A decoded message of the schema `defs`, which must be a struct.
    pub fn new(defs: &'a FieldDefs, value: &'a Value) -> anyhow::Result<Self> {
        match value {
            Value::Struct(values) => Ok(Self { defs, values }),
            _ => bail!("Expected a struct"),
        }
    }

    fn field(&self, name: &str) -> anyhow::Result<(&'a DataTypeDef, &'a Value)> {
        let index = self
            .defs
            .iter()
            .position(|field| field.name == name)
            .with_context(|| format!("Missing field: {name}"))?;
        let value = self
            .values
            .get(index)
            .with_context(|| format!("Missing value: {name}"))?;
        Ok((&self.defs[index].element.data_type, value))
    }

    fn present(&self, name: &str) -> anyhow::Result<Option<&'a Value>> {
        Ok(match self.field(name)?.1 {
            Value::Null => None,
            value => Some(value),
        })
    }

    /// Whether the schema has a field `name`, whatever its value.
    pub fn has(&self, name: &str) -> bool {
        self.field(name).is_ok()
    }

    /// The raw decoded value of a field.
    pub fn value(&self, name: &str) -> anyhow::Result<&'a Value> {
        Ok(self.field(name)?.1)
    }

    /// A string, or an empty one when the message leaves it out.
    pub fn string(&self, name: &str) -> anyhow::Result<&'a str> {
        match self.present(name)? {
            Some(Value::String(value)) => Ok(value),
            None => Ok(""),
            Some(_) => bail!("Field {name} is not a string"),
        }
    }

    pub fn number(&self, name: &str) -> anyhow::Result<f64> {
        let value = self
            .present(name)?
            .with_context(|| format!("Field {name} has no value"))?;
        value
            .try_lossy_f64()
            .ok()
            .with_context(|| format!("Field {name} is not a number"))
    }

    pub fn numbers(&self, name: &str) -> anyhow::Result<Vec<f64>> {
        match self.present(name)? {
            Some(Value::List(values) | Value::Array(values)) => values
                .iter()
                .map(|value| {
                    value
                        .try_lossy_f64()
                        .ok()
                        .with_context(|| format!("Field {name} has a non-number"))
                })
                .collect(),
            None => Ok(Vec::new()),
            Some(_) => bail!("Field {name} is not a list"),
        }
    }

    /// A true or false value, which some types hold as a number.
    pub fn flag(&self, name: &str) -> anyhow::Result<bool> {
        match self.present(name)? {
            Some(Value::Bool(value)) => Ok(*value),
            None => Ok(false),
            Some(value) => Ok(value
                .try_lossy_f64()
                .ok()
                .with_context(|| format!("Field {name} is not a flag"))?
                != 0.),
        }
    }

    pub fn bytes(&self, name: &str) -> anyhow::Result<Arc<[u8]>> {
        match self.present(name)? {
            Some(Value::Bytes(value) | Value::Uint8List(value)) => Ok(value.clone()),
            None => Ok(Arc::from([])),
            Some(_) => bail!("Field {name} is not bytes"),
        }
    }

    /// A nested struct, or `None` when the message leaves it out.
    pub fn child(&self, name: &str) -> anyhow::Result<Option<Message<'a>>> {
        let (data_type, value) = self.field(name)?;
        match (data_type, value) {
            (_, Value::Null) => Ok(None),
            (DataTypeDef::Struct(children), Value::Struct(values)) => Ok(Some(Message {
                defs: &children.fields,
                values,
            })),
            _ => bail!("Field {name} is not a struct"),
        }
    }

    /// A list of structs.
    pub fn children(&self, name: &str) -> anyhow::Result<Vec<Message<'a>>> {
        let (data_type, value) = self.field(name)?;
        let element = match data_type {
            DataTypeDef::List(element)
            | DataTypeDef::BoundedList(element, _)
            | DataTypeDef::Array(element, _) => &element.data_type,
            _ => bail!("Field {name} is not a list"),
        };
        let DataTypeDef::Struct(children) = element else {
            bail!("Field {name} does not hold structs");
        };
        match value {
            Value::Null => Ok(Vec::new()),
            Value::List(values) | Value::Array(values) => values
                .iter()
                .map(|value| Message::new(&children.fields, value))
                .collect(),
            _ => bail!("Field {name} is not a list"),
        }
    }

    /// The frame named in the field `frame_id`. An empty name means the message does
    /// not say.
    pub fn frame_id(&self) -> anyhow::Result<Option<String>> {
        Ok(match self.string("frame_id")? {
            "" => None,
            id => Some(id.to_owned()),
        })
    }

    /// Nanoseconds from a nested time of `sec` and `nanosec` (ROS) or `nsec`
    /// (Foxglove). `None` when it is left out, zero (what recorders write for "not
    /// stamped") or not a valid time: a bad stamp must not cost the value itself.
    pub fn time(&self, name: &str) -> anyhow::Result<Option<u64>> {
        let Some(time) = self.child(name).ok().flatten() else {
            return Ok(None);
        };
        let nanos = if time.has("nanosec") {
            "nanosec"
        } else {
            "nsec"
        };
        let (Ok(sec), Ok(nanos)) = (time.number("sec"), time.number(nanos)) else {
            return Ok(None);
        };
        if !(sec >= 0. && sec.fract() == 0. && nanos.fract() == 0. && (0. ..1e9).contains(&nanos)) {
            return Ok(None);
        }
        let ns = (sec as u64)
            .checked_mul(1_000_000_000)
            .and_then(|ns| ns.checked_add(nanos as u64));
        Ok(ns.filter(|&ns| ns > 0))
    }

    /// `[x, y, z]` from a nested struct, all zero when it is left out.
    pub fn vector(&self, name: &str) -> anyhow::Result<[f64; 3]> {
        vector(self.child(name)?)
    }

    /// `[x, y, z, w]` from a nested struct, normalized. A rotation of zero length,
    /// which is what an unset quaternion decodes to, means none.
    pub fn quaternion(&self, name: &str) -> anyhow::Result<[f64; 4]> {
        quaternion(self.child(name)?)
    }

    /// A pose from a nested struct of `position` and `orientation`, identity when it
    /// is left out.
    pub fn pose(&self, name: &str) -> anyhow::Result<Pose> {
        let Some(pose) = self.child(name)? else {
            return Ok(Pose::default());
        };
        Ok(Pose {
            position: pose.vector("position")?,
            orientation: pose.quaternion("orientation")?,
        })
    }
}

/// Checks on a schema, for [`ViewConverter::accepts`].
pub mod schema {
    use mcapdecode::{DataTypeDef, FieldDefs};

    /// Whether `defs` has a field `name` whose type passes `check`, such as
    /// `has(defs, "x", DataTypeDef::is_numeric)`.
    pub fn has(defs: &FieldDefs, name: &str, check: fn(&DataTypeDef) -> bool) -> bool {
        defs.iter()
            .any(|field| field.name == name && check(&field.element.data_type))
    }

    pub fn is_struct(data_type: &DataTypeDef) -> bool {
        matches!(data_type, DataTypeDef::Struct(_))
    }

    pub fn is_list(data_type: &DataTypeDef) -> bool {
        matches!(
            data_type,
            DataTypeDef::List(_) | DataTypeDef::BoundedList(..) | DataTypeDef::Array(..)
        )
    }

    pub fn is_bytes(data_type: &DataTypeDef) -> bool {
        matches!(
            data_type,
            DataTypeDef::Bytes | DataTypeDef::Uint8List | DataTypeDef::BoundedUint8List(_)
        )
    }

    pub fn is_string(data_type: &DataTypeDef) -> bool {
        matches!(
            data_type,
            DataTypeDef::String | DataTypeDef::BoundedString(_)
        )
    }
}

pub(crate) use schema::{has, is_bytes, is_list, is_string, is_struct};

/// `[x, y, z, w]`, normalized. A rotation of zero length, which is what an unset
/// quaternion decodes to, means none.
pub(crate) fn quaternion(message: Option<Message>) -> anyhow::Result<[f64; 4]> {
    let Some(message) = message else {
        return Ok([0., 0., 0., 1.]);
    };
    let q = [
        message.number("x")?,
        message.number("y")?,
        message.number("z")?,
        message.number("w")?,
    ];
    ensure!(q.iter().all(|v| v.is_finite()), "Non-finite rotation");
    let length = q.iter().map(|v| v * v).sum::<f64>().sqrt();
    if length == 0. {
        return Ok([0., 0., 0., 1.]);
    }
    Ok(q.map(|v| v / length))
}

pub(crate) fn vector(message: Option<Message>) -> anyhow::Result<[f64; 3]> {
    let Some(message) = message else {
        return Ok([0.; 3]);
    };
    let v = [
        message.number("x")?,
        message.number("y")?,
        message.number("z")?,
    ];
    ensure!(v.iter().all(|v| v.is_finite()), "Non-finite vector");
    Ok(v)
}

/// `foxglove.CameraCalibration`.
struct CameraCalibration;

impl ViewConverter for CameraCalibration {
    fn id(&self) -> &'static str {
        "camera_calibration"
    }
    fn kind(&self) -> Kind {
        Kind::CameraCalibration
    }
    fn name(&self) -> &'static str {
        "Camera calibration"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "CameraCalibration")
            && has(defs, "frame_id", is_string)
            && has(defs, "width", DataTypeDef::is_numeric)
            && has(defs, "height", DataTypeDef::is_numeric)
            // Protobuf capitalizes these, and `foxglove_msgs` does not.
            && (has(defs, "K", is_list) && has(defs, "D", is_list)
                || has(defs, "k", is_list) && has(defs, "d", is_list))
            && has(defs, "distortion_model", is_string)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        let (matrix, distortion) = if message.has("K") {
            ("K", "D")
        } else {
            ("k", "d")
        };
        calibration(message, message.frame_id()?, matrix, distortion)
    }
}

/// A calibration from a message's `width`, `height` and `distortion_model`, and the
/// camera matrix and distortion in the named fields.
pub(super) fn calibration(
    message: &Message,
    frame_id: Option<String>,
    matrix: &str,
    distortion: &str,
) -> anyhow::Result<View> {
    let intrinsics = message
        .numbers(matrix)?
        .try_into()
        .ok()
        .context("Invalid camera matrix")?;
    // Protobuf capitalizes it, ROS 2 and `foxglove_msgs` do not.
    let projection = ["P", "p"]
        .into_iter()
        .find(|name| message.has(name))
        .and_then(|name| message.numbers(name).ok()?.try_into().ok());
    Ok(CameraCalibrationView {
        frame_id,
        width: message.number("width")?,
        height: message.number("height")?,
        intrinsics,
        distortion: message.numbers(distortion)?,
        distortion_model: message.string("distortion_model")?.to_owned(),
        projection,
    }
    .into())
}

/// `foxglove.CompressedImage`.
struct Image;

impl ViewConverter for Image {
    fn id(&self) -> &'static str {
        "image"
    }
    fn kind(&self) -> Kind {
        Kind::Image
    }
    fn name(&self) -> &'static str {
        "Image"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "CompressedImage")
            && has(defs, "data", is_bytes)
            && has(defs, "format", is_string)
            && has(defs, "frame_id", is_string)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        Ok(ImageView {
            frame_id: message.frame_id()?,
            format: message.string("format")?.to_owned(),
            data: message.bytes("data")?,
        }
        .into())
    }
}

/// `foxglove.RawImage`, retaining the recorded pixel bytes and row stride.
struct RawImage;

impl ViewConverter for RawImage {
    fn id(&self) -> &'static str {
        "raw_image"
    }
    fn kind(&self) -> Kind {
        Kind::Image
    }
    fn name(&self) -> &'static str {
        "Raw image"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "RawImage")
            && has(defs, "frame_id", is_string)
            && has(defs, "width", DataTypeDef::is_numeric)
            && has(defs, "height", DataTypeDef::is_numeric)
            && has(defs, "step", DataTypeDef::is_numeric)
            && has(defs, "encoding", is_string)
            && has(defs, "data", is_bytes)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        raw_image(message, message.frame_id()?)
    }
}

/// A raw image from a message's `width`, `height`, `step`, `encoding` and `data`.
pub(super) fn raw_image(message: &Message, frame_id: Option<String>) -> anyhow::Result<View> {
    let dimension = |name| -> anyhow::Result<u32> {
        let n = message.number(name)?;
        ensure!(
            n.is_finite() && n > 0. && n.fract() == 0. && n <= u32::MAX as f64,
            "Invalid image {name}"
        );
        Ok(n as u32)
    };
    Ok(RawImageView {
        frame_id,
        width: dimension("width")?,
        height: dimension("height")?,
        step: dimension("step")?,
        encoding: message.string("encoding")?.to_owned(),
        data: message.bytes("data")?,
    }
    .into())
}

/// The current body pose from `foxglove.Odometry`.
struct Odometry;

impl ViewConverter for Odometry {
    fn id(&self) -> &'static str {
        "pose"
    }
    fn kind(&self) -> Kind {
        Kind::Pose
    }
    fn name(&self) -> &'static str {
        "Pose"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "Odometry")
            && has(defs, "frame_id", is_string)
            && has(defs, "pose", is_struct)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        let pose = message.child("pose")?.context("Odometry has no pose")?;
        pose_view(&pose, message.frame_id()?)
    }
}

/// `foxglove.PoseInFrame`.
struct PoseInFrame;

impl ViewConverter for PoseInFrame {
    fn id(&self) -> &'static str {
        "pose_in_frame"
    }
    fn kind(&self) -> Kind {
        Kind::Pose
    }
    fn name(&self) -> &'static str {
        "Pose"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "PoseInFrame")
            && has(defs, "frame_id", is_string)
            && has(defs, "pose", is_struct)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        let pose = message.child("pose")?.context("PoseInFrame has no pose")?;
        pose_view(&pose, message.frame_id()?)
    }
}

/// `foxglove.PosesInFrame`. It serves for routes as well as for unordered poses, and
/// which it is cannot be told from the recording; routes are more common (ADR 0005).
struct PosesInFrame;

impl ViewConverter for PosesInFrame {
    fn id(&self) -> &'static str {
        "path"
    }
    fn kind(&self) -> Kind {
        Kind::Path
    }
    fn name(&self) -> &'static str {
        "Path"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "PosesInFrame")
            && has(defs, "frame_id", is_string)
            && has(defs, "poses", is_list)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        let poses = message
            .children("poses")?
            .iter()
            .map(|pose| {
                Ok(Pose {
                    position: pose.vector("position")?,
                    orientation: pose.quaternion("orientation")?,
                })
            })
            .collect::<anyhow::Result<_>>()?;
        Ok(PathView {
            frame_id: message.frame_id()?,
            poses,
        }
        .into())
    }
}

/// A pose from a message of `position` and `orientation`.
pub(super) fn pose_view(pose: &Message, frame_id: Option<String>) -> anyhow::Result<View> {
    Ok(PoseView {
        frame_id,
        pose: Pose {
            position: pose.vector("position")?,
            orientation: pose.quaternion("orientation")?,
        },
    }
    .into())
}

/// `foxglove.PointCloud`.
struct PointCloud;

impl ViewConverter for PointCloud {
    fn id(&self) -> &'static str {
        "pointcloud"
    }
    fn kind(&self) -> Kind {
        Kind::PointCloud
    }
    fn name(&self) -> &'static str {
        "Point cloud"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "PointCloud")
            && has(defs, "data", is_bytes)
            && has(defs, "fields", is_list)
            && has(defs, "point_stride", DataTypeDef::is_numeric)
            && has(defs, "pose", is_struct)
            && has(defs, "frame_id", is_string)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        let stride = message.number("point_stride")? as usize;
        let data = message.bytes("data")?;
        ensure!(stride > 0, "Point stride must not be zero");
        ensure!(
            data.len().is_multiple_of(stride),
            "Point data of {} bytes does not divide into points of {stride} bytes",
            data.len()
        );
        let fields = message
            .children("fields")?
            .iter()
            .map(|field| {
                let name = field.string("name")?;
                let offset = field.number("offset")? as usize;
                let numeric_type = numeric_type(field)?;
                ensure!(
                    offset + numeric_type.size() <= stride,
                    "Point field {name} does not fit in a stride of {stride} bytes"
                );
                Ok(PackedField {
                    name: name.to_owned(),
                    offset,
                    numeric_type,
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let mut cloud =
            PointCloudView::from_packed(message.frame_id()?, &fields, data.chunks_exact(stride))?;
        cloud.pose = message.pose("pose")?;
        Ok(cloud.into())
    }
}

/// The type of a `foxglove.PackedElementField`.
fn numeric_type(field: &Message) -> anyhow::Result<NumericType> {
    let name = match field.value("type")? {
        Value::String(name) => name.to_string(),
        value => match value.try_lossy_f64().ok().map(|v| v as i64) {
            Some(1) => "UINT8".into(),
            Some(2) => "INT8".into(),
            Some(3) => "UINT16".into(),
            Some(4) => "INT16".into(),
            Some(5) => "UINT32".into(),
            Some(6) => "INT32".into(),
            Some(7) => "FLOAT32".into(),
            Some(8) => "FLOAT64".into(),
            other => bail!("Unknown numeric type: {other:?}"),
        },
    };
    numeric_named(&name)
}

/// The numeric type of a packed field, by its upper-case name.
fn numeric_named(name: &str) -> anyhow::Result<NumericType> {
    Ok(match name {
        "UINT8" => NumericType::U8,
        "INT8" => NumericType::I8,
        "UINT16" => NumericType::U16,
        "INT16" => NumericType::I16,
        "UINT32" => NumericType::U32,
        "INT32" => NumericType::I32,
        "FLOAT32" => NumericType::F32,
        "FLOAT64" => NumericType::F64,
        _ => bail!("Unknown numeric type: {name}"),
    })
}

/// `foxglove.LocationFix`.
struct Geo;

impl ViewConverter for Geo {
    fn id(&self) -> &'static str {
        "geo"
    }
    fn kind(&self) -> Kind {
        Kind::GeoLocation
    }
    fn name(&self) -> &'static str {
        "Location"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "LocationFix")
            && has(defs, "latitude", DataTypeDef::is_numeric)
            && has(defs, "longitude", DataTypeDef::is_numeric)
            && has(defs, "altitude", DataTypeDef::is_numeric)
            && has(defs, "frame_id", is_string)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        let mut location = location(message, true)?;
        location.heading = message.number("heading").ok();
        Ok(location.into())
    }
}

/// A location from a message's `latitude`, `longitude`, `altitude` and, when
/// `covariance` is usable, `position_covariance`.
pub(super) fn location(message: &Message, covariance: bool) -> anyhow::Result<GeoLocationView> {
    let mut location = GeoLocationView {
        latitude: message.number("latitude")?,
        longitude: message.number("longitude")?,
        altitude: message.number("altitude").ok(),
        ..Default::default()
    };
    // The diagonal of the ENU covariance in row-major order: east and north.
    if covariance
        && let Ok(covariance) = message.numbers("position_covariance")
        && let [east, _, _, _, north, ..] = covariance[..]
        && east.max(north) > 0.
    {
        location.accuracy_m = Some(east.max(north).sqrt());
    }
    Ok(location)
}

/// `foxglove.GeoJSON`: shapes on a map, held as GeoJSON text. A feature collection,
/// a feature or a bare geometry are all read as features.
struct GeoJson;

impl ViewConverter for GeoJson {
    fn id(&self) -> &'static str {
        "geojson"
    }
    fn kind(&self) -> Kind {
        Kind::Geo
    }
    fn name(&self) -> &'static str {
        "Shapes"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "GeoJSON") && has(defs, "geojson", is_string)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        let document: serde_json::Value = serde_json::from_str(message.string("geojson")?)
            .context("The GeoJSON is not valid JSON")?;
        let feature = |value: &serde_json::Value| -> Option<GeoFeature> {
            Some(GeoFeature {
                geometry: value.get("geometry")?.clone(),
                properties: value
                    .get("properties")
                    .and_then(|p| p.as_object())
                    .cloned()
                    .unwrap_or_default(),
            })
        };
        let features = match document.get("type").and_then(|t| t.as_str()) {
            Some("FeatureCollection") => document
                .get("features")
                .and_then(|f| f.as_array())
                .context("A FeatureCollection needs features")?
                .iter()
                .map(|value| {
                    // One without a geometry fails on its own when checked.
                    feature(value).unwrap_or(GeoFeature {
                        geometry: serde_json::Value::Null,
                        properties: Default::default(),
                    })
                })
                .collect(),
            Some("Feature") => vec![feature(&document).context("A Feature needs a geometry")?],
            Some(_) => vec![GeoFeature {
                geometry: document,
                properties: Default::default(),
            }],
            None => bail!("GeoJSON needs a type"),
        };
        Ok(GeoView {
            frame_id: None,
            features,
        }
        .into())
    }
}

/// An annotation that could not be read, so that it is left out and counted.
pub(super) fn unreadable_annotation() -> Annotation {
    Shape::Points(vec![[f64::NAN; 2]]).into()
}

/// `[x, y]` of a nested point, or not-a-number when it cannot be read.
pub(super) fn point2(message: &Message, name: &str) -> [f64; 2] {
    let read = || -> anyhow::Result<[f64; 2]> {
        let point = message.child(name)?.context("No point")?;
        Ok([point.number("x")?, point.number("y")?])
    };
    read().unwrap_or([f64::NAN; 2])
}

/// `foxglove.ImageAnnotations`: circles, points and lines, and texts over an image.
struct ImageAnnotations;

impl ImageAnnotations {
    const LISTS: [&str; 3] = ["circles", "points", "texts"];
}

impl ViewConverter for ImageAnnotations {
    fn id(&self) -> &'static str {
        "annotations"
    }
    fn kind(&self) -> Kind {
        Kind::ImageAnnotations
    }
    fn name(&self) -> &'static str {
        "Annotations"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "ImageAnnotations")
            && Self::LISTS.iter().any(|name| has(defs, name, is_list))
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        let mut annotations = Vec::new();
        let list = |name: &str| -> anyhow::Result<Vec<Message>> {
            Ok(if message.has(name) {
                message.children(name)?
            } else {
                Vec::new()
            })
        };
        for circle in list("circles")? {
            annotations.push(match circle.number("diameter") {
                Ok(diameter) => Shape::Circle {
                    center: point2(&circle, "position"),
                    diameter,
                }
                .into(),
                Err(_) => unreadable_annotation(),
            });
        }
        for points in list("points")? {
            let read = || -> anyhow::Result<Annotation> {
                let at: Vec<[f64; 2]> = points
                    .children("points")?
                    .iter()
                    .map(|p| {
                        [
                            p.number("x").unwrap_or(f64::NAN),
                            p.number("y").unwrap_or(f64::NAN),
                        ]
                    })
                    .collect();
                // The type is an enum: named in Protobuf, numbered in ROS 2.
                let kind = match points.value("type")? {
                    Value::String(name) => match &**name {
                        "POINTS" => 1,
                        "LINE_LOOP" => 2,
                        "LINE_STRIP" => 3,
                        "LINE_LIST" => 4,
                        _ => 0,
                    },
                    other => other.try_lossy_f64().ok().unwrap_or(0.) as i64,
                };
                Ok(match kind {
                    1 => Shape::Points(at),
                    2 => Shape::LineLoop(at),
                    3 => Shape::LineStrip(at),
                    4 => Shape::LineList(at),
                    _ => bail!("Unknown points annotation type"),
                }
                .into())
            };
            annotations.push(read().unwrap_or_else(|_| unreadable_annotation()));
        }
        for text in list("texts")? {
            annotations.push(match text.string("text") {
                Ok(content) => Shape::Text {
                    position: point2(&text, "position"),
                    text: content.to_owned(),
                }
                .into(),
                Err(_) => unreadable_annotation(),
            });
        }
        Ok(AnnotationsView {
            frame_id: None,
            annotations,
        }
        .into())
    }
    /// The message has no time of its own; its annotations each have one, the time
    /// of the image they mark.
    fn stamp(&self, message: &Message) -> anyhow::Result<Option<u64>> {
        for name in Self::LISTS {
            if message.has(name)
                && let Some(first) = message.children(name)?.first()
            {
                return first.time("timestamp");
            }
        }
        Ok(None)
    }
}
