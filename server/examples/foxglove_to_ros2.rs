//! Rewrites the standard Foxglove topics of an MCAP as ROS 2 CDR messages.
//!
//! This gives realistic images, points and paths for checking the ROS 2 views by eye.
//! The bytes come from this program's reading of the ROS definitions, so the result
//! does not show how a real ROS 2 driver fills its messages.
//!
//!     foxglove_to_ros2 <input.mcap> <output.mcap> [seconds from the start]

mod support;

use anyhow::{Context, bail};
use mcapdecode::{
    McapReader, ReadOptions, TimeRange,
    core::{DataTypeDef, FieldDefs, Value},
};
use std::{fs::File, path::Path};
use support::ros2::{self, Cdr, Cloud, RosWriter};

/// A decoded struct, read by field name.
#[derive(Clone, Copy)]
struct Fields<'a>(&'a FieldDefs, &'a [Value]);

impl<'a> Fields<'a> {
    fn of(defs: &'a FieldDefs, value: &'a Value) -> anyhow::Result<Self> {
        match value {
            Value::Struct(values) => Ok(Self(defs, values)),
            _ => bail!("Expected a struct"),
        }
    }
    fn get(&self, name: &str) -> Option<(&'a DataTypeDef, &'a Value)> {
        let index = self.0.iter().position(|field| field.name == name)?;
        Some((&self.0[index].element.data_type, self.1.get(index)?))
    }
    fn string(&self, name: &str) -> &'a str {
        match self.get(name) {
            Some((_, Value::String(value))) => value,
            _ => "",
        }
    }
    fn number(&self, name: &str) -> f64 {
        self.get(name)
            .and_then(|(_, value)| number(value))
            .unwrap_or(0.)
    }
    fn numbers(&self, name: &str) -> Vec<f64> {
        match self.get(name) {
            Some((_, Value::List(values) | Value::Array(values))) => {
                values.iter().filter_map(number).collect()
            }
            _ => Vec::new(),
        }
    }
    fn bytes(&self, name: &str) -> &'a [u8] {
        match self.get(name) {
            Some((_, Value::Bytes(value) | Value::Uint8List(value))) => value,
            _ => &[],
        }
    }
    fn child(&self, name: &str) -> Option<Fields<'a>> {
        match self.get(name)? {
            (DataTypeDef::Struct(defs), Value::Struct(values)) => Some(Self(&defs.fields, values)),
            _ => None,
        }
    }
    fn children(&self, name: &str) -> Vec<Fields<'a>> {
        let Some((data_type, Value::List(values) | Value::Array(values))) = self.get(name) else {
            return Vec::new();
        };
        let (DataTypeDef::List(element)
        | DataTypeDef::BoundedList(element, _)
        | DataTypeDef::Array(element, _)) = data_type
        else {
            return Vec::new();
        };
        let DataTypeDef::Struct(defs) = &element.data_type else {
            return Vec::new();
        };
        values
            .iter()
            .filter_map(|value| Self::of(&defs.fields, value).ok())
            .collect()
    }
    fn vector(&self, name: &str) -> [f64; 3] {
        self.child(name)
            .map_or([0.; 3], |v| [v.number("x"), v.number("y"), v.number("z")])
    }
    fn rotation(&self, name: &str) -> [f64; 4] {
        self.child(name).map_or([0., 0., 0., 1.], |v| {
            [v.number("x"), v.number("y"), v.number("z"), v.number("w")]
        })
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

fn ninth(values: Vec<f64>) -> anyhow::Result<[f64; 9]> {
    values
        .try_into()
        .map_err(|values: Vec<f64>| anyhow::anyhow!("Expected 9 values, got {}", values.len()))
}

/// `sensor_msgs/msg/PointField.datatype` of a `foxglove.PackedElementField`.
fn point_datatype(field: &Fields) -> anyhow::Result<u8> {
    let name = match field.get("type") {
        Some((_, Value::String(name))) => name.to_string(),
        Some((_, value)) => match number(value).map(|v| v as i64) {
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
        None => bail!("A point field has no type"),
    };
    Ok(match name.as_str() {
        "INT8" => 1,
        "UINT8" => 2,
        "INT16" => 3,
        "UINT16" => 4,
        "INT32" => 5,
        "UINT32" => 6,
        "FLOAT32" => 7,
        "FLOAT64" => 8,
        other => bail!("Unknown numeric type: {other}"),
    })
}

fn covariance_type(message: &Fields) -> u8 {
    match message.get("position_covariance_type") {
        Some((_, Value::String(name))) => match name.as_ref() {
            "APPROXIMATED" => 1,
            "DIAGONAL_KNOWN" => 2,
            "KNOWN" => 3,
            _ => 0,
        },
        Some((_, value)) => number(value).unwrap_or(0.) as u8,
        None => 0,
    }
}

/// The ROS 2 form of a message, or `None` for a type this does not rewrite.
fn rewrite(schema: &str, m: Fields, time: u64) -> anyhow::Result<Option<(ros2::RosType, Cdr)>> {
    let frame = m.string("frame_id");
    Ok(Some(match schema {
        "foxglove.CompressedImage" => {
            let format = m.string("format");
            // Written the way image_transport does, which is the form to parse.
            let format = match format {
                "jpeg" | "jpg" => "rgb8; jpeg compressed bgr8".to_owned(),
                "png" => "rgb8; png compressed bgr8".to_owned(),
                other => other.to_owned(),
            };
            (
                ros2::COMPRESSED_IMAGE,
                ros2::compressed_image(frame, &format, m.bytes("data"), time),
            )
        }
        "foxglove.RawImage" => (
            ros2::IMAGE,
            ros2::image(
                frame,
                [m.number("width") as u32, m.number("height") as u32],
                m.string("encoding"),
                false,
                m.number("step") as u32,
                m.bytes("data"),
                time,
            ),
        ),
        "foxglove.CameraCalibration" => (
            ros2::CAMERA_INFO,
            ros2::camera_info(
                frame,
                [m.number("width") as u32, m.number("height") as u32],
                m.string("distortion_model"),
                &m.numbers("D"),
                ninth(m.numbers("K"))?,
                time,
            ),
        ),
        "foxglove.PointCloud" => {
            if let Some(pose) = m.child("pose") {
                let at_origin = pose.vector("position") == [0.; 3]
                    && matches!(
                        pose.rotation("orientation"),
                        [0., 0., 0., 1.] | [0., 0., 0., 0.]
                    );
                anyhow::ensure!(at_origin, "PointCloud2 has no pose to hold this cloud's");
            }
            let stride = m.number("point_stride") as u32;
            let data = m.bytes("data");
            let fields = m
                .children("fields")
                .iter()
                .map(|field| {
                    Ok((
                        field.string("name"),
                        field.number("offset") as u32,
                        point_datatype(field)?,
                        1,
                    ))
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            let cloud = Cloud {
                frame,
                height: 1,
                width: data.len() as u32 / stride.max(1),
                fields: &fields,
                bigendian: false,
                point_step: stride,
                row_step: data.len() as u32,
                data,
            };
            (ros2::POINT_CLOUD2, ros2::point_cloud2(&cloud, time))
        }
        "foxglove.Odometry" => {
            let pose = m.child("pose").context("Odometry has no pose")?;
            (
                ros2::ODOMETRY,
                ros2::odometry(
                    frame,
                    m.string("body_frame_id"),
                    pose.vector("position"),
                    pose.rotation("orientation"),
                    time,
                ),
            )
        }
        "foxglove.LocationFix" => {
            // Unlike the ROS type, the Foxglove one may leave its covariance out.
            let covariance = m.numbers("position_covariance");
            let (covariance, kind) = if covariance.is_empty() {
                ([0.; 9], 0)
            } else {
                (ninth(covariance)?, covariance_type(&m))
            };
            (
                ros2::NAV_SAT_FIX,
                ros2::nav_sat_fix(
                    frame,
                    0,
                    [
                        m.number("latitude"),
                        m.number("longitude"),
                        m.number("altitude"),
                    ],
                    covariance,
                    kind,
                    time,
                ),
            )
        }
        "foxglove.FrameTransform" => (
            ros2::TF_MESSAGE,
            ros2::tf_message(
                &[(
                    m.string("parent_frame_id"),
                    m.string("child_frame_id"),
                    m.vector("translation"),
                    m.rotation("rotation"),
                )],
                time,
            ),
        ),
        _ => return Ok(None),
    }))
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, input, output, rest @ ..] = args.as_slice() else {
        bail!("Usage: foxglove_to_ros2 <input.mcap> <output.mcap> [seconds from the start]");
    };
    let input = Path::new(input);
    let seconds: Option<u64> = rest.first().map(|s| s.parse()).transpose()?;

    // SAFETY: the input is not modified while this short-lived program runs.
    let mapping = unsafe { memmap2::Mmap::map(&File::open(input)?)? };
    let summary = mcap::read::Summary::read(&mapping)?.context("MCAP has no summary")?;
    let start = summary
        .stats
        .as_ref()
        .context("MCAP has no statistics")?
        .message_start_time;
    let options = ReadOptions {
        time_range: seconds.map(|seconds| TimeRange {
            start: Some(start),
            end: Some(start + seconds * 1_000_000_000),
        }),
        parallel: Some(false),
        ..Default::default()
    };

    let reader = McapReader::builder().with_default_decoders().build();
    let mut writer = RosWriter::create(Path::new(output))?;
    for channel in reader.list_channels(input)? {
        let Some(schema) = channel.schema_name.as_deref() else {
            continue;
        };
        let Ok(defs) = reader.field_defs_by_channel_id(input, channel.id) else {
            println!("skip {} ({schema}): not decoded", channel.topic);
            continue;
        };
        let (mut written, mut failed) = (0u64, 0u64);
        let mut first_failure = None;
        reader.for_each_decoded_message_by_channel_id_with_options(
            input,
            channel.id,
            &options,
            &mut |message: mcapdecode::core::DecodedMessage| {
                let result = Fields::of(&defs, &message.value)
                    .and_then(|fields| rewrite(schema, fields, message.log_time));
                match result {
                    Ok(Some((ros_type, cdr))) => {
                        writer
                            .write(&channel.topic, ros_type, message.log_time, &cdr)
                            .map_err(std::io::Error::other)?;
                        written += 1;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        failed += 1;
                        first_failure.get_or_insert(error.to_string());
                    }
                }
                Ok(())
            },
        )?;
        println!(
            "{} ({schema}): {written} written, {failed} failed",
            channel.topic
        );
        if let Some(failure) = first_failure {
            println!("  first failure: {failure}");
        }
    }
    writer.finish()
}
