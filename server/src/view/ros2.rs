//! Converters from the standard ROS 2 message types to the protocol's fixed kinds.
//!
//! ROS keeps its frame name in `header` and nests some values differently from the
//! Foxglove schemas, while the kinds and their validation are shared.

use super::convert::{
    Message, ViewConverter, calibration, has, is_bytes, is_list, is_number, is_string, is_struct,
    location, pose_view, raw_image,
};
use super::value::{
    GeoView, ImageView, Kind, NumericType, PackedField, PathView, PointCloudView, PosesView,
    PositionView, View,
};
use anyhow::{Context, bail, ensure};
use mcapdecode::core::FieldDefs;
use std::sync::Arc;

pub(super) fn converters() -> Vec<Arc<dyn ViewConverter>> {
    vec![
        Arc::new(CompressedImage),
        Arc::new(Image),
        Arc::new(CameraInfo),
        Arc::new(PointCloud2),
        Arc::new(Odometry),
        Arc::new(PoseStamped),
        Arc::new(PointStamped),
        Arc::new(PoseArray),
        Arc::new(Path),
        Arc::new(NavSatFix),
    ]
}

fn header_frame(message: &Message) -> anyhow::Result<Option<String>> {
    Ok(match message.child("header")? {
        Some(header) => header.frame_id()?,
        None => None,
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

impl ViewConverter for CompressedImage {
    fn id(&self) -> &'static str {
        "ros_image"
    }
    fn kind(&self) -> Kind {
        Kind::Image
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
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        Ok(ImageView {
            frame_id: header_frame(message)?,
            format: compressed_format(message.string("format")?)?.to_owned(),
            data: message.bytes("data")?,
        }
        .into())
    }
}

struct Image;

impl ViewConverter for Image {
    fn id(&self) -> &'static str {
        "ros_raw_image"
    }
    fn kind(&self) -> Kind {
        Kind::Image
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
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        // Blobs are little endian. Bytes in other encodings have no byte order.
        ensure!(
            !(message.flag("is_bigendian")?
                && matches!(message.string("encoding")?, "mono16" | "16UC1" | "32FC1")),
            "Big-endian raw images are not supported"
        );
        raw_image(message, header_frame(message)?)
    }
}

struct CameraInfo;

impl ViewConverter for CameraInfo {
    fn id(&self) -> &'static str {
        "ros_camera_calibration"
    }
    fn kind(&self) -> Kind {
        Kind::CameraCalibration
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
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        calibration(message, header_frame(message)?, "k", "d")
    }
}

/// `sensor_msgs/msg/PointField.datatype`. The numbering differs from
/// `foxglove.NumericType`, which swaps each signed type with its unsigned one.
fn point_field_type(datatype: f64) -> anyhow::Result<NumericType> {
    Ok(match datatype as i64 {
        1 => NumericType::I8,
        2 => NumericType::U8,
        3 => NumericType::I16,
        4 => NumericType::U16,
        5 => NumericType::I32,
        6 => NumericType::U32,
        7 => NumericType::F32,
        8 => NumericType::F64,
        other => bail!("Unknown point field type: {other}"),
    })
}

struct PointCloud2;

impl ViewConverter for PointCloud2 {
    fn id(&self) -> &'static str {
        "ros_pointcloud"
    }
    fn kind(&self) -> Kind {
        Kind::PointCloud
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
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
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
            let numeric_type = point_field_type(field.number("datatype")?)?;
            let offset = field.number("offset")? as usize;
            ensure!(
                offset.saturating_add(numeric_type.size()) <= stride,
                "Point field {name} does not fit in a step of {stride} bytes"
            );
            packed.push(PackedField {
                name: name.to_owned(),
                offset,
                numeric_type,
            });
        }
        let points = data
            .chunks_exact(row_step.max(1))
            .take(height)
            .flat_map(|row_bytes| row_bytes[..row].chunks_exact(stride));
        Ok(PointCloudView::from_packed(header_frame(message)?, &packed, points)?.into())
    }
}

struct Odometry;

impl ViewConverter for Odometry {
    fn id(&self) -> &'static str {
        "ros_odometry"
    }
    fn kind(&self) -> Kind {
        Kind::Pose
    }
    fn name(&self) -> &'static str {
        "Pose"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "nav_msgs/msg/Odometry"
            && has(defs, "header", is_struct)
            && has(defs, "pose", is_struct)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        with_covariance(message)
    }
}

/// A pose nested in a `geometry_msgs/msg/PoseWithCovariance` named `pose`.
fn with_covariance(message: &Message) -> anyhow::Result<View> {
    let pose = message
        .child("pose")?
        .and_then(|pose| pose.child("pose").transpose())
        .transpose()?
        .context("Message has no pose")?;
    pose_view(&pose, header_frame(message)?)
}

/// `geometry_msgs/msg/PoseStamped` and `PoseWithCovarianceStamped`.
struct PoseStamped;

impl ViewConverter for PoseStamped {
    fn id(&self) -> &'static str {
        "ros_pose"
    }
    fn kind(&self) -> Kind {
        Kind::Pose
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
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        let pose = message.child("pose")?.context("Message has no pose")?;
        // Only the covariant form has a pose inside its pose.
        if pose.child("pose").is_ok() {
            return with_covariance(message);
        }
        pose_view(&pose, header_frame(message)?)
    }
}

struct NavSatFix;

impl ViewConverter for NavSatFix {
    fn id(&self) -> &'static str {
        "ros_location"
    }
    fn kind(&self) -> Kind {
        Kind::Geo
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
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        // STATUS_NO_FIX: the coordinates are whatever the receiver left there.
        if let Ok(Some(status)) = message.child("status") {
            ensure!(status.number("status")? >= 0., "No satellite fix");
        }
        let unknown = message
            .number("position_covariance_type")
            .is_ok_and(|kind| kind == 0.);
        // COVARIANCE_TYPE_UNKNOWN: the matrix holds no accuracy, whatever its values.
        Ok(GeoView {
            frame_id: header_frame(message)?,
            features: vec![location(message, !unknown)?],
        }
        .into())
    }
}

/// `geometry_msgs/msg/PointStamped`.
struct PointStamped;

impl ViewConverter for PointStamped {
    fn id(&self) -> &'static str {
        "ros_position"
    }
    fn kind(&self) -> Kind {
        Kind::Position
    }
    fn name(&self) -> &'static str {
        "Position"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "geometry_msgs/msg/PointStamped"
            && has(defs, "header", is_struct)
            && has(defs, "point", is_struct)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        Ok(PositionView {
            frame_id: header_frame(message)?,
            position: message.vector("point")?,
        }
        .into())
    }
}

/// `geometry_msgs/msg/PoseArray`: poses without an order.
struct PoseArray;

impl ViewConverter for PoseArray {
    fn id(&self) -> &'static str {
        "ros_poses"
    }
    fn kind(&self) -> Kind {
        Kind::Poses
    }
    fn name(&self) -> &'static str {
        "Poses"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "geometry_msgs/msg/PoseArray"
            && has(defs, "header", is_struct)
            && has(defs, "poses", is_list)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        // A pose that cannot be read is left out by itself, and counted, like one that
        // is not finite: the others do not depend on it.
        let unreadable = super::value::Pose {
            position: [f64::NAN; 3],
            ..Default::default()
        };
        let poses = message
            .children("poses")?
            .iter()
            .map(|pose| pose_of(pose).unwrap_or(unreadable))
            .collect();
        Ok(PosesView {
            frame_id: header_frame(message)?,
            poses,
        }
        .into())
    }
}

/// `nav_msgs/msg/Path`: poses in order, each a `PoseStamped`.
struct Path;

impl ViewConverter for Path {
    fn id(&self) -> &'static str {
        "ros_path"
    }
    fn kind(&self) -> Kind {
        Kind::Path
    }
    fn name(&self) -> &'static str {
        "Path"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "nav_msgs/msg/Path"
            && has(defs, "header", is_struct)
            && has(defs, "poses", is_list)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        let poses = message
            .children("poses")?
            .iter()
            .map(|stamped| stamped.pose("pose"))
            .collect::<anyhow::Result<_>>()?;
        Ok(PathView {
            frame_id: header_frame(message)?,
            poses,
        }
        .into())
    }
}

/// A `geometry_msgs/msg/Pose` itself.
fn pose_of(pose: &Message) -> anyhow::Result<super::value::Pose> {
    Ok(super::value::Pose {
        position: pose.vector("position")?,
        orientation: pose.quaternion("orientation")?,
    })
}
