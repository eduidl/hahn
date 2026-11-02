//! Converters from the standard ROS 2 message types to the protocol's fixed kinds.
//!
//! ROS keeps its frame name in `header` and nests some values differently from the
//! Foxglove schemas, while the kinds and their validation are shared.

use super::convert::{
    Converter, ImageAdapter, ImageConverter, ImageView, Message, PackedField, calibration_value,
    frame_id, has, is_bytes, is_list, is_number, is_string, is_struct, location_value,
    numeric_named, pointcloud_value, pose_value, raw_image_value,
};
use super::frame::Payload;
use anyhow::{Context, bail, ensure};
use mcapdecode::core::FieldDefs;
use std::sync::Arc;

pub(super) fn converters() -> Vec<Arc<dyn Converter>> {
    vec![
        Arc::new(ImageAdapter(Arc::new(CompressedImage))),
        Arc::new(Image),
        Arc::new(CameraInfo),
        Arc::new(PointCloud2),
        Arc::new(Odometry),
        Arc::new(PoseStamped),
        Arc::new(NavSatFix),
    ]
}

fn header_frame(message: &Message) -> anyhow::Result<serde_json::Value> {
    Ok(match message.child("header")? {
        Some(header) => frame_id(&header)?,
        None => serde_json::Value::Null,
    })
}

/// The image format inside `sensor_msgs/msg/CompressedImage.format`, which is either
/// the format alone or `<pixel format>; <format> compressed <pixel format>`.
fn compressed_format(format: &str) -> anyhow::Result<&str> {
    ensure!(
        !format.to_ascii_lowercase().contains("compresseddepth"),
        "compressedDepth images are not supported: {format:?}"
    );
    let encoded = format.rsplit(';').next().unwrap_or(format);
    encoded
        .split_whitespace()
        .next()
        .with_context(|| format!("Image format has no name: {format:?}"))
}

struct CompressedImage;

impl ImageConverter for CompressedImage {
    fn id(&self) -> &'static str {
        "ros_image"
    }
    fn name(&self) -> &'static str {
        "Image"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "sensor_msgs/msg/CompressedImage"
            && has(defs, "header", is_struct)
            && has(defs, "format", is_string)
            && has(defs, "data", is_bytes)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<ImageView> {
        Ok(ImageView {
            frame_id: header_frame(message)?.as_str().map(str::to_owned),
            format: compressed_format(message.string("format")?)?.to_owned(),
            data: message.bytes("data")?,
        })
    }
}

struct Image;

impl Converter for Image {
    fn id(&self) -> &'static str {
        "ros_raw_image"
    }
    fn kind(&self) -> &'static str {
        "image"
    }
    fn name(&self) -> &'static str {
        "Raw image"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "sensor_msgs/msg/Image"
            && has(defs, "header", is_struct)
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
        // Blobs are little endian. Bytes in other encodings have no byte order.
        ensure!(
            !(message.flag("is_bigendian")?
                && matches!(message.string("encoding")?, "mono16" | "16UC1" | "32FC1")),
            "Big-endian raw images are not supported"
        );
        raw_image_value(message, header_frame(message)?, payload)
    }
}

struct CameraInfo;

impl Converter for CameraInfo {
    fn id(&self) -> &'static str {
        "ros_camera_calibration"
    }
    fn kind(&self) -> &'static str {
        "camera_calibration"
    }
    fn name(&self) -> &'static str {
        "Camera calibration"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "sensor_msgs/msg/CameraInfo"
            && has(defs, "header", is_struct)
            && has(defs, "width", is_number)
            && has(defs, "height", is_number)
            && has(defs, "k", is_list)
            && has(defs, "d", is_list)
            && has(defs, "distortion_model", is_string)
    }
    fn convert(&self, message: &Message, _: &mut Payload) -> anyhow::Result<serde_json::Value> {
        calibration_value(message, header_frame(message)?, "k", "d")
    }
}

/// `sensor_msgs/msg/PointField.datatype`. The numbering differs from
/// `foxglove.NumericType`, which swaps each signed type with its unsigned one.
fn point_field_type(datatype: f64) -> anyhow::Result<&'static str> {
    Ok(match datatype as i64 {
        1 => "INT8",
        2 => "UINT8",
        3 => "INT16",
        4 => "UINT16",
        5 => "INT32",
        6 => "UINT32",
        7 => "FLOAT32",
        8 => "FLOAT64",
        other => bail!("Unknown point field type: {other}"),
    })
}

struct PointCloud2;

impl Converter for PointCloud2 {
    fn id(&self) -> &'static str {
        "ros_pointcloud"
    }
    fn kind(&self) -> &'static str {
        "pointcloud"
    }
    fn name(&self) -> &'static str {
        "Point cloud"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "sensor_msgs/msg/PointCloud2"
            && has(defs, "header", is_struct)
            && has(defs, "width", is_number)
            && has(defs, "height", is_number)
            && has(defs, "fields", is_list)
            && has(defs, "point_step", is_number)
            && has(defs, "row_step", is_number)
            && has(defs, "data", is_bytes)
    }
    fn convert(
        &self,
        message: &Message,
        payload: &mut Payload,
    ) -> anyhow::Result<serde_json::Value> {
        ensure!(
            !message.flag("is_bigendian")?,
            "Big-endian point clouds are not supported"
        );
        let size = |name| -> anyhow::Result<usize> { Ok(message.number(name)? as usize) };
        let (width, height) = (size("width")?, size("height")?);
        let (stride, row_step) = (size("point_step")?, size("row_step")?);
        ensure!(stride > 0, "Point step must not be zero");
        let row = width
            .checked_mul(stride)
            .context("Point row is too large")?;
        ensure!(row_step >= row, "Point row step is too small");
        let data = message.bytes("data")?;
        ensure!(
            height.checked_mul(row_step) == Some(data.len()),
            "Point data length does not match row step and height"
        );
        let fields = message.children("fields")?;
        let mut packed: Vec<PackedField> = Vec::with_capacity(fields.len());
        for field in &fields {
            let name = field.string("name")?;
            let count = field.number("count")? as usize;
            // Kinds hold one value per point: this leaves out vectors and padding.
            if count > 1 || name.is_empty() || name == "_" {
                continue;
            }
            let numeric = numeric_named(point_field_type(field.number("datatype")?)?)?;
            let offset = field.number("offset")? as usize;
            ensure!(
                offset.saturating_add(numeric.size) <= stride,
                "Point field {name} does not fit in a step of {stride} bytes"
            );
            packed.push((name, offset, numeric));
        }
        let points = data
            .chunks_exact(row_step.max(1))
            .take(height)
            .flat_map(|row_bytes| row_bytes[..row].chunks_exact(stride));
        pointcloud_value(
            &packed,
            points,
            width * height,
            None,
            header_frame(message)?,
            payload,
        )
    }
}

struct Odometry;

impl Converter for Odometry {
    fn id(&self) -> &'static str {
        "ros_odometry"
    }
    fn kind(&self) -> &'static str {
        "pose"
    }
    fn name(&self) -> &'static str {
        "Pose"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "nav_msgs/msg/Odometry"
            && has(defs, "header", is_struct)
            && has(defs, "pose", is_struct)
    }
    fn convert(&self, message: &Message, _: &mut Payload) -> anyhow::Result<serde_json::Value> {
        with_covariance(message)
    }
}

/// A pose nested in a `geometry_msgs/msg/PoseWithCovariance` named `pose`.
fn with_covariance(message: &Message) -> anyhow::Result<serde_json::Value> {
    let pose = message
        .child("pose")?
        .and_then(|pose| pose.child("pose").transpose())
        .transpose()?
        .context("Message has no pose")?;
    pose_value(&pose, header_frame(message)?)
}

/// `geometry_msgs/msg/PoseStamped` and `PoseWithCovarianceStamped`.
struct PoseStamped;

impl Converter for PoseStamped {
    fn id(&self) -> &'static str {
        "ros_pose"
    }
    fn kind(&self) -> &'static str {
        "pose"
    }
    fn name(&self) -> &'static str {
        "Pose"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        matches!(
            schema_name,
            "geometry_msgs/msg/PoseStamped" | "geometry_msgs/msg/PoseWithCovarianceStamped"
        ) && has(defs, "header", is_struct)
            && has(defs, "pose", is_struct)
    }
    fn convert(&self, message: &Message, _: &mut Payload) -> anyhow::Result<serde_json::Value> {
        let pose = message.child("pose")?.context("Message has no pose")?;
        // Only the covariant form has a pose inside its pose.
        if pose.child("pose").is_ok() {
            return with_covariance(message);
        }
        pose_value(&pose, header_frame(message)?)
    }
}

struct NavSatFix;

impl Converter for NavSatFix {
    fn id(&self) -> &'static str {
        "ros_location"
    }
    fn kind(&self) -> &'static str {
        "geo"
    }
    fn name(&self) -> &'static str {
        "Location"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "sensor_msgs/msg/NavSatFix"
            && has(defs, "header", is_struct)
            && has(defs, "latitude", is_number)
            && has(defs, "longitude", is_number)
            && has(defs, "altitude", is_number)
    }
    fn convert(&self, message: &Message, _: &mut Payload) -> anyhow::Result<serde_json::Value> {
        // STATUS_NO_FIX: the coordinates are whatever the receiver left there.
        if let Ok(Some(status)) = message.child("status") {
            ensure!(status.number("status")? >= 0., "No satellite fix");
        }
        let unknown = message
            .number("position_covariance_type")
            .is_ok_and(|kind| kind == 0.);
        let mut value = location_value(message, header_frame(message)?, Default::default())?;
        // COVARIANCE_TYPE_UNKNOWN: the matrix holds no accuracy, whatever its values.
        if unknown {
            value["features"][0]["properties"]
                .as_object_mut()
                .context("A feature has properties")?
                .remove("accuracy_m");
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressed_format_is_the_encoded_part() {
        assert_eq!(compressed_format("jpeg").unwrap(), "jpeg");
        assert_eq!(
            compressed_format("rgb8; jpeg compressed bgr8").unwrap(),
            "jpeg"
        );
        assert_eq!(compressed_format("mono8; png compressed ").unwrap(), "png");
        assert!(compressed_format("16UC1; compressedDepth png").is_err());
        assert!(compressed_format("").is_err());
    }

    #[test]
    fn point_field_numbers_differ_from_foxglove() {
        assert_eq!(point_field_type(1.).unwrap(), "INT8");
        assert_eq!(point_field_type(2.).unwrap(), "UINT8");
        assert!(point_field_type(9.).is_err());
    }
}
