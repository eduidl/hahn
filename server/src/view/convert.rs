//! Converters from recorded message types to the protocol's fixed kinds.

use super::frame::Payload;
use anyhow::{Context, bail, ensure};
use mcapdecode::core::{DataTypeDef, FieldDefs, Value};
use serde_json::json;
use std::sync::Arc;

/// Turns messages of the types it accepts into one fixed kind.
pub(crate) trait Converter: Send + Sync {
    /// Unique among the converters; a topic's views are named after them.
    fn id(&self) -> &'static str;
    fn kind(&self) -> &'static str;
    fn name(&self) -> &'static str;
    /// Decided from the schema alone. Both the name and the shape must match, so
    /// that an unrelated type of the same name does not fail on every message.
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool;
    fn convert(
        &self,
        message: &Message,
        payload: &mut Payload,
    ) -> anyhow::Result<serde_json::Value>;
}

pub(crate) fn converters() -> Vec<Arc<dyn Converter>> {
    let mut converters: Vec<Arc<dyn Converter>> = vec![
        Arc::new(ImageAdapter(Arc::new(Image))),
        Arc::new(RawImage),
        Arc::new(CameraCalibration),
        Arc::new(PointCloud),
        Arc::new(Odometry),
        Arc::new(Geo),
    ];
    converters.extend(super::ros2::converters());
    converters
}

/// An encoded image in Hahn's image view.
pub struct ImageView {
    pub frame_id: Option<String>,
    pub format: String,
    pub data: Arc<[u8]>,
}

/// Converts a decoded message into a Hahn image view.
pub trait ImageConverter: Send + Sync {
    /// Unique among all view converters registered with a server.
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool;
    fn convert(&self, message: &Message<'_>) -> anyhow::Result<ImageView>;
}

pub(crate) struct ImageAdapter(pub Arc<dyn ImageConverter>);

impl Converter for ImageAdapter {
    fn id(&self) -> &'static str {
        self.0.id()
    }
    fn kind(&self) -> &'static str {
        "image"
    }
    fn name(&self) -> &'static str {
        self.0.name()
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        self.0.accepts(schema_name, defs)
    }
    fn convert(
        &self,
        message: &Message,
        payload: &mut Payload,
    ) -> anyhow::Result<serde_json::Value> {
        let image = self.0.convert(message)?;
        let format = image.format.to_ascii_lowercase();
        ensure!(
            matches!(format.as_str(), "jpeg" | "jpg" | "png" | "webp" | "avif"),
            "Unsupported image format: {format:?}"
        );
        let format = if format == "jpg" { "jpeg" } else { &format };
        Ok(
            json!({"kind": "image", "frame_id": image.frame_id, "format": format, "role": "color", "data": payload.add(image.data)}),
        )
    }
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
    pub(crate) fn new(defs: &'a FieldDefs, value: &'a Value) -> anyhow::Result<Self> {
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
        number(value).with_context(|| format!("Field {name} is not a number"))
    }

    pub fn numbers(&self, name: &str) -> anyhow::Result<Vec<f64>> {
        match self.present(name)? {
            Some(Value::List(values) | Value::Array(values)) => values
                .iter()
                .map(|value| {
                    number(value).with_context(|| format!("Field {name} has a non-number"))
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
            Some(value) => {
                Ok(number(value).with_context(|| format!("Field {name} is not a flag"))? != 0.)
            }
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

    pub(crate) fn children(&self, name: &str) -> anyhow::Result<Vec<Message<'a>>> {
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
}

fn number(value: &Value) -> Option<f64> {
    Some(match value {
        Value::F64(v) => *v,
        Value::F32(v) => *v as f64,
        Value::I8(v) => *v as f64,
        Value::I16(v) => *v as f64,
        Value::I32(v) => *v as f64,
        Value::I64(v) => *v as f64,
        Value::U8(v) => *v as f64,
        Value::U16(v) => *v as f64,
        Value::U32(v) => *v as f64,
        Value::U64(v) => *v as f64,
        _ => return None,
    })
}

/// Whether `defs` has a field `name` whose type passes `check`.
pub(crate) fn has(defs: &FieldDefs, name: &str, check: fn(&DataTypeDef) -> bool) -> bool {
    defs.iter()
        .any(|field| field.name == name && check(&field.element.data_type))
}

pub(crate) fn is_struct(data_type: &DataTypeDef) -> bool {
    matches!(data_type, DataTypeDef::Struct(_))
}

pub(super) fn is_list(data_type: &DataTypeDef) -> bool {
    matches!(
        data_type,
        DataTypeDef::List(_) | DataTypeDef::BoundedList(..) | DataTypeDef::Array(..)
    )
}

pub(super) fn is_bytes(data_type: &DataTypeDef) -> bool {
    matches!(
        data_type,
        DataTypeDef::Bytes | DataTypeDef::Uint8List | DataTypeDef::BoundedUint8List(_)
    )
}

pub(crate) fn is_string(data_type: &DataTypeDef) -> bool {
    matches!(
        data_type,
        DataTypeDef::String | DataTypeDef::BoundedString(_)
    )
}

pub(super) fn is_number(data_type: &DataTypeDef) -> bool {
    matches!(
        data_type,
        DataTypeDef::I8
            | DataTypeDef::I16
            | DataTypeDef::I32
            | DataTypeDef::I64
            | DataTypeDef::U8
            | DataTypeDef::U16
            | DataTypeDef::U32
            | DataTypeDef::U64
            | DataTypeDef::F32
            | DataTypeDef::F64
    )
}

/// An empty frame name means the message does not say.
pub(super) fn frame_id(message: &Message) -> anyhow::Result<serde_json::Value> {
    Ok(match message.string("frame_id")? {
        "" => serde_json::Value::Null,
        id => id.into(),
    })
}

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

impl Converter for CameraCalibration {
    fn id(&self) -> &'static str {
        "camera_calibration"
    }
    fn kind(&self) -> &'static str {
        "camera_calibration"
    }
    fn name(&self) -> &'static str {
        "Camera calibration"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "CameraCalibration")
            && has(defs, "frame_id", is_string)
            && has(defs, "width", is_number)
            && has(defs, "height", is_number)
            // Protobuf capitalizes these, and `foxglove_msgs` does not.
            && (has(defs, "K", is_list) && has(defs, "D", is_list)
                || has(defs, "k", is_list) && has(defs, "d", is_list))
            && has(defs, "distortion_model", is_string)
    }
    fn convert(&self, message: &Message, _: &mut Payload) -> anyhow::Result<serde_json::Value> {
        let (matrix, distortion) = if message.field("K").is_ok() {
            ("K", "D")
        } else {
            ("k", "d")
        };
        calibration_value(message, frame_id(message)?, matrix, distortion)
    }
}

/// A calibration from a message's `width`, `height` and `distortion_model`, and the
/// camera matrix and distortion in the named fields.
pub(super) fn calibration_value(
    message: &Message,
    frame: serde_json::Value,
    matrix: &str,
    distortion: &str,
) -> anyhow::Result<serde_json::Value> {
    let width = message.number("width")?;
    let height = message.number("height")?;
    let k = message.numbers(matrix)?;
    let d = message.numbers(distortion)?;
    ensure!(
        width.is_finite() && width > 0. && height.is_finite() && height > 0.,
        "Invalid camera dimensions"
    );
    ensure!(
        k.len() == 9 && k.iter().all(|v| v.is_finite()) && k[0] > 0. && k[4] > 0.,
        "Invalid camera matrix"
    );
    ensure!(
        d.iter().all(|v| v.is_finite()),
        "Invalid distortion coefficients"
    );
    Ok(
        json!({"kind":"camera_calibration", "frame_id":frame, "width":width, "height":height, "intrinsics":k, "distortion":d, "distortion_model":message.string("distortion_model")?}),
    )
}

/// `foxglove.CompressedImage`.
struct Image;

impl ImageConverter for Image {
    fn id(&self) -> &'static str {
        "image"
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
    fn convert(&self, message: &Message) -> anyhow::Result<ImageView> {
        let frame = message.string("frame_id")?;
        Ok(ImageView {
            frame_id: (!frame.is_empty()).then(|| frame.to_owned()),
            format: message.string("format")?.to_owned(),
            data: message.bytes("data")?,
        })
    }
}

/// `foxglove.RawImage`, retaining the recorded pixel bytes and row stride.
struct RawImage;

impl Converter for RawImage {
    fn id(&self) -> &'static str {
        "raw_image"
    }
    fn kind(&self) -> &'static str {
        "image"
    }
    fn name(&self) -> &'static str {
        "Raw image"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "RawImage")
            && has(defs, "frame_id", is_string)
            && has(defs, "width", is_number)
            && has(defs, "height", is_number)
            && has(defs, "step", is_number)
            && has(defs, "encoding", is_string)
            && has(defs, "data", is_bytes)
    }
    fn convert(
        &self,
        message: &Message,
        payload: &mut Payload,
    ) -> anyhow::Result<serde_json::Value> {
        raw_image_value(message, frame_id(message)?, payload)
    }
}

/// A raw image from a message's `width`, `height`, `step`, `encoding` and `data`.
pub(super) fn raw_image_value(
    message: &Message,
    frame: serde_json::Value,
    payload: &mut Payload,
) -> anyhow::Result<serde_json::Value> {
    let dimension = |name| -> anyhow::Result<usize> {
        let n = message.number(name)?;
        ensure!(
            n.is_finite() && n > 0. && n.fract() == 0. && n <= u32::MAX as f64,
            "Invalid image {name}"
        );
        Ok(n as usize)
    };
    let width = dimension("width")?;
    let height = dimension("height")?;
    let step = dimension("step")?;
    let encoding = message.string("encoding")?;
    let bytes_per_pixel = match encoding {
        "mono8" | "8UC1" | "nv12" | "bayer_rggb8" | "bayer_bggr8" | "bayer_gbrg8"
        | "bayer_grbg8" => 1usize,
        "mono16" | "16UC1" | "yuv422" | "uyvy" | "yuv422_yuy2" | "yuyv" => 2,
        "rgb8" | "bgr8" | "8UC3" => 3,
        "rgba8" | "bgra8" | "32FC1" => 4,
        _ => bail!("Unsupported raw image encoding: {encoding:?}"),
    };
    if matches!(
        encoding,
        "yuv422" | "uyvy" | "yuv422_yuy2" | "yuyv" | "nv12"
    ) {
        ensure!(
            width.is_multiple_of(2),
            "Raw image width must be even for {encoding}"
        );
    }
    if encoding == "nv12" {
        ensure!(
            height.is_multiple_of(2),
            "Raw image height must be even for nv12"
        );
    }
    ensure!(
        step >= width
            .checked_mul(bytes_per_pixel)
            .context("Image row is too large")?,
        "Raw image step is too small"
    );
    let rows = height
        .checked_add(if encoding == "nv12" { height / 2 } else { 0 })
        .context("Image height is too large")?;
    let size = step.checked_mul(rows).context("Image data is too large")?;
    let data = message.bytes("data")?;
    ensure!(
        data.len() == size,
        "Raw image data length does not match step and height"
    );
    Ok(
        json!({"kind":"image", "frame_id":frame, "format":"raw", "width":width, "height":height, "step":step, "encoding":encoding, "data":payload.add(data)}),
    )
}

/// The current body pose from `foxglove.Odometry`.
struct Odometry;

impl Converter for Odometry {
    fn id(&self) -> &'static str {
        "pose"
    }
    fn kind(&self) -> &'static str {
        "pose"
    }
    fn name(&self) -> &'static str {
        "Pose"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "Odometry")
            && has(defs, "frame_id", is_string)
            && has(defs, "pose", is_struct)
    }
    fn convert(&self, message: &Message, _: &mut Payload) -> anyhow::Result<serde_json::Value> {
        let pose = message.child("pose")?.context("Odometry has no pose")?;
        pose_value(&pose, frame_id(message)?)
    }
}

/// A pose from a message of `position` and `orientation`.
pub(super) fn pose_value(
    pose: &Message,
    frame: serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    let position = vector(pose.child("position")?)?;
    let orientation = quaternion(pose.child("orientation")?)?;
    Ok(
        json!({"kind":"pose", "frame_id":frame, "pose":{"position":position, "orientation":orientation}}),
    )
}

/// `foxglove.PointCloud`.
struct PointCloud;

impl Converter for PointCloud {
    fn id(&self) -> &'static str {
        "pointcloud"
    }
    fn kind(&self) -> &'static str {
        "pointcloud"
    }
    fn name(&self) -> &'static str {
        "Point cloud"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "PointCloud")
            && has(defs, "data", is_bytes)
            && has(defs, "fields", is_list)
            && has(defs, "point_stride", is_number)
            && has(defs, "pose", is_struct)
            && has(defs, "frame_id", is_string)
    }
    fn convert(
        &self,
        message: &Message,
        payload: &mut Payload,
    ) -> anyhow::Result<serde_json::Value> {
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
                let numeric = numeric_type(field)?;
                ensure!(
                    offset + numeric.size <= stride,
                    "Point field {name} does not fit in a stride of {stride} bytes"
                );
                Ok((name, offset, numeric))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let pose = message.child("pose")?;
        pointcloud_value(
            &fields,
            data.chunks_exact(stride),
            data.len() / stride,
            pose,
            frame_id(message)?,
            payload,
        )
    }
}

/// A named value inside a packed point: its name, byte offset and type.
pub(super) type PackedField<'a> = (&'a str, usize, Numeric);

/// A point cloud from packed points, split into positions and one column per field.
pub(super) fn pointcloud_value<'a>(
    fields: &[PackedField],
    packed: impl Iterator<Item = &'a [u8]>,
    points: usize,
    pose: Option<Message>,
    frame: serde_json::Value,
    payload: &mut Payload,
) -> anyhow::Result<serde_json::Value> {
    let axis = |name: &str| fields.iter().find(|(n, ..)| *n == name);
    let axes = [axis("x"), axis("y"), axis("z")];
    ensure!(
        axes.iter().flatten().count() >= 2,
        "A point cloud needs at least two of the fields x, y and z"
    );
    let columns: Vec<_> = fields
        .iter()
        .filter(|(name, ..)| !matches!(*name, "x" | "y" | "z"))
        .collect();
    let mut positions = Vec::with_capacity(points * 12);
    let mut bytes: Vec<Vec<u8>> = columns
        .iter()
        .map(|(_, _, numeric)| Vec::with_capacity(points * numeric.size))
        .collect();
    let mut count = 0;
    for point in packed {
        let position = axes
            .map(|axis| axis.map_or(0., |(_, offset, numeric)| numeric.read(&point[*offset..])));
        // A point with no return has no position to draw.
        if !position.iter().all(|v| v.is_finite()) {
            continue;
        }
        count += 1;
        for v in position {
            positions.extend_from_slice(&(v as f32).to_le_bytes());
        }
        for ((_, offset, numeric), column) in columns.iter().zip(&mut bytes) {
            column.extend_from_slice(&point[*offset..*offset + numeric.size]);
        }
    }
    let position = vector(pose.map(|p| p.child("position")).transpose()?.flatten())?;
    let orientation = quaternion(pose.map(|p| p.child("orientation")).transpose()?.flatten())?;
    let fields: Vec<_> = columns
        .iter()
        .zip(bytes)
        .map(|((name, _, numeric), column)| {
            json!({ "name": name, "type": numeric.name, "data": payload.add(column.into()) })
        })
        .collect();
    Ok(json!({
        "kind": "pointcloud",
        "frame_id": frame,
        "count": count,
        "pose": { "position": position, "orientation": orientation },
        "positions": payload.add(positions.into()),
        "fields": fields,
    }))
}

/// A `foxglove.NumericType`: its name in the protocol, and how to read it.
#[derive(Clone, Copy)]
pub(super) struct Numeric {
    name: &'static str,
    pub(super) size: usize,
    read: fn(&[u8]) -> f64,
}

impl Numeric {
    /// Reads from the start of `bytes`, little endian as the schema defines.
    fn read(&self, bytes: &[u8]) -> f64 {
        (self.read)(bytes)
    }
}

/// The type of a `foxglove.PackedElementField`.
fn numeric_type(field: &Message) -> anyhow::Result<Numeric> {
    let (_, value) = field.field("type")?;
    let name = match value {
        Value::String(name) => name.to_string(),
        value => match number(value).map(|v| v as i64) {
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
pub(super) fn numeric_named(name: &str) -> anyhow::Result<Numeric> {
    macro_rules! numeric {
        ($name:literal, $type:ty) => {
            Numeric {
                name: $name,
                size: size_of::<$type>(),
                read: |b| {
                    <$type>::from_le_bytes(b[..size_of::<$type>()].try_into().unwrap()) as f64
                },
            }
        };
    }
    Ok(match name {
        "UINT8" => numeric!("u8", u8),
        "INT8" => numeric!("i8", i8),
        "UINT16" => numeric!("u16", u16),
        "INT16" => numeric!("i16", i16),
        "UINT32" => numeric!("u32", u32),
        "INT32" => numeric!("i32", i32),
        "FLOAT32" => numeric!("f32", f32),
        "FLOAT64" => numeric!("f64", f64),
        _ => bail!("Unknown numeric type: {name}"),
    })
}

/// `foxglove.LocationFix`.
struct Geo;

impl Converter for Geo {
    fn id(&self) -> &'static str {
        "geo"
    }
    fn kind(&self) -> &'static str {
        "geo"
    }
    fn name(&self) -> &'static str {
        "Location"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        is_foxglove(schema_name, "LocationFix")
            && has(defs, "latitude", is_number)
            && has(defs, "longitude", is_number)
            && has(defs, "altitude", is_number)
            && has(defs, "frame_id", is_string)
    }
    fn convert(
        &self,
        message: &Message,
        _payload: &mut Payload,
    ) -> anyhow::Result<serde_json::Value> {
        let mut properties = serde_json::Map::new();
        if let Ok(heading) = message.number("heading")
            && heading.is_finite()
        {
            properties.insert("heading".into(), heading.into());
        }
        location_value(message, frame_id(message)?, properties)
    }
}

/// A location from a message's `latitude`, `longitude`, `altitude` and, when usable,
/// `position_covariance`.
pub(super) fn location_value(
    message: &Message,
    frame: serde_json::Value,
    mut properties: serde_json::Map<String, serde_json::Value>,
) -> anyhow::Result<serde_json::Value> {
    let latitude = message.number("latitude")?;
    let longitude = message.number("longitude")?;
    let altitude = message.number("altitude")?;
    ensure!(
        (-90. ..=90.).contains(&latitude) && (-180. ..=180.).contains(&longitude),
        "Invalid location: {latitude}, {longitude}"
    );
    // The diagonal of the ENU covariance in row-major order: east and north.
    if let Ok(covariance) = message.numbers("position_covariance")
        && let [east, _, _, _, north, ..] = covariance[..]
        && east.max(north) > 0.
    {
        properties.insert("accuracy_m".into(), east.max(north).sqrt().into());
    }
    let mut coordinates = vec![longitude, latitude];
    if altitude.is_finite() {
        coordinates.push(altitude);
    }
    Ok(json!({
        "kind": "geo",
        "frame_id": frame,
        "features": [{
            "type": "Feature",
            "geometry": { "type": "Point", "coordinates": coordinates },
            "properties": properties,
        }],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mcapdecode::core::FieldDef;

    fn defs(fields: Vec<(&str, DataTypeDef)>) -> FieldDefs {
        FieldDefs::new(
            fields
                .into_iter()
                .map(|(name, data_type)| FieldDef::new(name, data_type, false))
                .collect(),
        )
    }

    fn image_defs() -> FieldDefs {
        defs(vec![
            ("frame_id", DataTypeDef::String),
            ("data", DataTypeDef::Bytes),
            ("format", DataTypeDef::String),
        ])
    }

    #[test]
    fn a_type_of_the_right_name_but_wrong_shape_is_not_accepted() {
        assert!(Image.accepts("foxglove.CompressedImage", &image_defs()));
        assert!(!Image.accepts("other.CompressedImage", &image_defs()));
        let wrong = defs(vec![("data", DataTypeDef::String)]);
        assert!(!Image.accepts("foxglove.CompressedImage", &wrong));
    }

    #[test]
    fn foxglove_calibration_is_read_under_either_spelling() {
        let calibration = |matrix: &'static str, distortion: &'static str| {
            let list = || {
                DataTypeDef::List(Box::new(mcapdecode::core::ElementDef::new(
                    DataTypeDef::F64,
                    false,
                )))
            };
            defs(vec![
                ("frame_id", DataTypeDef::String),
                ("width", DataTypeDef::U32),
                ("height", DataTypeDef::U32),
                ("distortion_model", DataTypeDef::String),
                (matrix, list()),
                (distortion, list()),
            ])
        };
        let (protobuf, ros) = (calibration("K", "D"), calibration("k", "d"));
        assert!(CameraCalibration.accepts("foxglove.CameraCalibration", &protobuf));
        assert!(CameraCalibration.accepts("foxglove_msgs/msg/CameraCalibration", &ros));
        let k = [400., 0., 320., 0., 400., 240., 0., 0., 1.]
            .map(Value::F64)
            .to_vec();
        let value = Value::Struct(vec![
            Value::string("camera"),
            Value::U32(640),
            Value::U32(480),
            Value::string("plumb_bob"),
            Value::List(k),
            Value::List(vec![]),
        ]);
        let message = Message::new(&ros, &value).unwrap();
        let converted = CameraCalibration
            .convert(&message, &mut Payload::default())
            .unwrap();
        assert_eq!(converted["intrinsics"][0], 400.);
    }

    #[test]
    fn image_format_is_normalized_and_checked() {
        let defs = image_defs();
        let convert = |format: &str| {
            let value = Value::Struct(vec![
                Value::string(""),
                Value::Bytes(Arc::from([1u8].as_slice())),
                Value::string(format),
            ]);
            let message = Message::new(&defs, &value).unwrap();
            ImageAdapter(Arc::new(Image)).convert(&message, &mut Payload::default())
        };
        let value = convert("JPG").unwrap();
        assert_eq!(value["format"], "jpeg");
        assert_eq!(value["frame_id"], serde_json::Value::Null);
        assert!(convert("bmp").is_err());
    }

    #[test]
    fn unset_rotations_are_identity_and_others_are_normalized() {
        assert_eq!(quaternion(None).unwrap(), [0., 0., 0., 1.]);
        let defs = defs(vec![
            ("x", DataTypeDef::F64),
            ("y", DataTypeDef::F64),
            ("z", DataTypeDef::F64),
            ("w", DataTypeDef::F64),
        ]);
        let at = |w| {
            Value::Struct(vec![
                Value::F64(0.),
                Value::F64(0.),
                Value::F64(0.),
                Value::F64(w),
            ])
        };
        let (zero, two) = (at(0.), at(2.));
        let read = |value| quaternion(Some(Message::new(&defs, value).unwrap())).unwrap();
        assert_eq!(read(&zero), [0., 0., 0., 1.]);
        assert_eq!(read(&two), [0., 0., 0., 1.]);
    }
}
