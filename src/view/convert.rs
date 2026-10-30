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

pub(crate) const CONVERTERS: &[&dyn Converter] = &[&Image, &PointCloud, &Geo];

/// Reads a decoded struct by field name.
#[derive(Clone, Copy)]
pub(crate) struct Message<'a> {
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

    pub(crate) fn string(&self, name: &str) -> anyhow::Result<&'a str> {
        match self.present(name)? {
            Some(Value::String(value)) => Ok(value),
            None => Ok(""),
            Some(_) => bail!("Field {name} is not a string"),
        }
    }

    pub(crate) fn number(&self, name: &str) -> anyhow::Result<f64> {
        let value = self
            .present(name)?
            .with_context(|| format!("Field {name} has no value"))?;
        number(value).with_context(|| format!("Field {name} is not a number"))
    }

    pub(crate) fn numbers(&self, name: &str) -> anyhow::Result<Vec<f64>> {
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

    fn bytes(&self, name: &str) -> anyhow::Result<Arc<[u8]>> {
        match self.present(name)? {
            Some(Value::Bytes(value) | Value::Uint8List(value)) => Ok(value.clone()),
            None => Ok(Arc::from([])),
            Some(_) => bail!("Field {name} is not bytes"),
        }
    }

    /// A nested struct, or `None` when the message leaves it out.
    pub(crate) fn child(&self, name: &str) -> anyhow::Result<Option<Message<'a>>> {
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

    fn children(&self, name: &str) -> anyhow::Result<Vec<Message<'a>>> {
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

fn is_list(data_type: &DataTypeDef) -> bool {
    matches!(
        data_type,
        DataTypeDef::List(_) | DataTypeDef::BoundedList(..) | DataTypeDef::Array(..)
    )
}

fn is_bytes(data_type: &DataTypeDef) -> bool {
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

fn is_number(data_type: &DataTypeDef) -> bool {
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
fn frame_id(message: &Message) -> anyhow::Result<serde_json::Value> {
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

/// `foxglove.CompressedImage`.
struct Image;

impl Converter for Image {
    fn id(&self) -> &'static str {
        "image"
    }
    fn kind(&self) -> &'static str {
        "image"
    }
    fn name(&self) -> &'static str {
        "Image"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "foxglove.CompressedImage"
            && has(defs, "data", is_bytes)
            && has(defs, "format", is_string)
            && has(defs, "frame_id", is_string)
    }
    fn convert(
        &self,
        message: &Message,
        payload: &mut Payload,
    ) -> anyhow::Result<serde_json::Value> {
        let format = message.string("format")?.to_ascii_lowercase();
        ensure!(
            matches!(format.as_str(), "jpeg" | "jpg" | "png" | "webp" | "avif"),
            "Unsupported image format: {format:?}"
        );
        let format = if format == "jpg" { "jpeg" } else { &format };
        Ok(json!({
            "kind": "image",
            "frame_id": frame_id(message)?,
            "format": format,
            "role": "color",
            "data": payload.add(message.bytes("data")?),
        }))
    }
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
        schema_name == "foxglove.PointCloud"
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
        let points = data.len() / stride;
        let mut positions = Vec::with_capacity(points * 12);
        let mut bytes: Vec<Vec<u8>> = columns
            .iter()
            .map(|(_, _, numeric)| Vec::with_capacity(points * numeric.size))
            .collect();
        let mut count = 0;
        for point in data.chunks_exact(stride) {
            let position = axes.map(|axis| {
                axis.map_or(0., |(_, offset, numeric)| numeric.read(&point[*offset..]))
            });
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
        let pose = message.child("pose")?;
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
            "frame_id": frame_id(message)?,
            "count": count,
            "pose": { "position": position, "orientation": orientation },
            "positions": payload.add(positions.into()),
            "fields": fields,
        }))
    }
}

/// A `foxglove.NumericType`: its name in the protocol, and how to read it.
#[derive(Clone, Copy)]
struct Numeric {
    name: &'static str,
    size: usize,
    read: fn(&[u8]) -> f64,
}

/// The type of a `foxglove.PackedElementField`.
fn numeric_type(field: &Message) -> anyhow::Result<Numeric> {
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
    Ok(match name.as_str() {
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
        schema_name == "foxglove.LocationFix"
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
        let latitude = message.number("latitude")?;
        let longitude = message.number("longitude")?;
        let altitude = message.number("altitude")?;
        ensure!(
            (-90. ..=90.).contains(&latitude) && (-180. ..=180.).contains(&longitude),
            "Invalid location: {latitude}, {longitude}"
        );
        let mut properties = serde_json::Map::new();
        if let Ok(heading) = message.number("heading")
            && heading.is_finite()
        {
            properties.insert("heading".into(), heading.into());
        }
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
            "frame_id": frame_id(message)?,
            "features": [{
                "type": "Feature",
                "geometry": { "type": "Point", "coordinates": coordinates },
                "properties": properties,
            }],
        }))
    }
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
    fn image_format_is_normalized_and_checked() {
        let defs = image_defs();
        let convert = |format: &str| {
            let value = Value::Struct(vec![
                Value::string(""),
                Value::Bytes(Arc::from([1u8].as_slice())),
                Value::string(format),
            ]);
            let message = Message::new(&defs, &value).unwrap();
            Image.convert(&message, &mut Payload::default())
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
