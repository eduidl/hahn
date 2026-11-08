//! Rewrites the standard Foxglove topics of an MCAP as ROS 2 CDR messages.
//!
//! This gives realistic images, points and paths for checking the ROS 2 views by eye.
//! The bytes come from this program's reading of the ROS definitions, so the result
//! does not show how a real ROS 2 driver fills its messages.
//!
//!     foxglove_to_ros2 <input.mcap> <output.mcap> [seconds from the start]

mod support;

use anyhow::{Context, bail};
use mcapdecode::{McapReader, Value};
use std::{ops::Bound, path::Path};
use support::ros2::{self, Cdr, Cloud, RosWriter};

/// A decoded struct, read by the field names its value carries.
#[derive(Clone, Copy)]
struct Fields<'a>(&'a Value);

impl<'a> Fields<'a> {
    fn get(&self, name: &str) -> Option<&'a Value> {
        self.0.get(name).ok()
    }
    fn string(&self, name: &str) -> &'a str {
        self.get(name).and_then(|v| v.try_str().ok()).unwrap_or("")
    }
    fn number(&self, name: &str) -> f64 {
        self.get(name).and_then(number).unwrap_or(0.)
    }
    fn numbers(&self, name: &str) -> Vec<f64> {
        self.list(name).iter().filter_map(number).collect()
    }
    fn bytes(&self, name: &str) -> &'a [u8] {
        self.get(name)
            .and_then(|v| v.try_bytes().ok())
            .unwrap_or(&[])
    }
    fn list(&self, name: &str) -> &'a [Value] {
        self.get(name)
            .and_then(|v| v.as_sequence().ok())
            .unwrap_or(&[])
    }
    fn child(&self, name: &str) -> Option<Fields<'a>> {
        self.get(name)
            .filter(|v| matches!(v, Value::Struct(_)))
            .map(Self)
    }
    fn children(&self, name: &str) -> Vec<Fields<'a>> {
        let structs = self.list(name).iter();
        structs
            .filter(|v| matches!(v, Value::Struct(_)))
            .map(Self)
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
    value.try_lossy_f64().ok()
}

fn ninth(values: Vec<f64>) -> anyhow::Result<[f64; 9]> {
    values
        .try_into()
        .map_err(|values: Vec<f64>| anyhow::anyhow!("Expected 9 values, got {}", values.len()))
}

/// `sensor_msgs/msg/PointField.datatype` of a `foxglove.PackedElementField`.
fn point_datatype(field: &Fields) -> anyhow::Result<u8> {
    let name = match field.get("type") {
        Some(Value::String(name)) => name.to_string(),
        Some(value) => match number(value).map(|v| v as i64) {
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
        Some(Value::String(name)) => match name.as_ref() {
            "APPROXIMATED" => 1,
            "DIAGONAL_KNOWN" => 2,
            "KNOWN" => 3,
            _ => 0,
        },
        Some(value) => number(value).unwrap_or(0.) as u8,
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

    let file = McapReader::open(input)?;
    let start = *file
        .message_time_range()
        .context("MCAP has no messages")?
        .start();
    let end = seconds.map(|seconds| start + seconds * 1_000_000_000);
    let mut writer = RosWriter::create(Path::new(output))?;
    for channel in file.channels() {
        let Some(schema) = channel.schema.as_ref().map(|schema| schema.name.as_str()) else {
            continue;
        };
        if file.read().channel(channel.id).field_defs().is_err() {
            println!("skip {} ({schema}): not decoded", channel.topic);
            continue;
        }
        let (mut written, mut failed) = (0u64, 0u64);
        let mut first_failure = None;
        file.read()
            .channel(channel.id)
            .time_range(match end {
                Some(end) => (Bound::Included(start), Bound::Excluded(end)),
                None => (Bound::Unbounded, Bound::Unbounded),
            })
            .parallel(false)
            .decoded()
            .try_for_each(|_, message| {
                let result = rewrite(schema, Fields(&message.value), message.log_time);
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
            })?;
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
