//! Values of the protocol's fixed kinds, as converters return them.
//!
//! Every converter, built in or added by an application, returns one of these. They
//! are checked and turned into a frame in one place, so a converter cannot send a
//! value the protocol does not allow.

use super::frame::Payload;
use anyhow::{bail, ensure};
use serde_json::json;
use std::sync::Arc;

/// A fixed kind of the protocol, which the client knows how to show.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Image,
    CameraCalibration,
    PointCloud,
    Pose,
    Geo,
}

impl Kind {
    /// The name of the kind in the protocol.
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Image => "image",
            Kind::CameraCalibration => "camera_calibration",
            Kind::PointCloud => "pointcloud",
            Kind::Pose => "pose",
            Kind::Geo => "geo",
        }
    }
}

/// One converted message.
#[derive(Clone, Debug)]
pub enum View {
    Image(ImageView),
    RawImage(RawImageView),
    CameraCalibration(CameraCalibrationView),
    PointCloud(PointCloudView),
    Pose(PoseView),
    Geo(GeoView),
}

impl View {
    pub fn kind(&self) -> Kind {
        match self {
            View::Image(_) | View::RawImage(_) => Kind::Image,
            View::CameraCalibration(_) => Kind::CameraCalibration,
            View::PointCloud(_) => Kind::PointCloud,
            View::Pose(_) => Kind::Pose,
            View::Geo(_) => Kind::Geo,
        }
    }
}

macro_rules! into_view {
    ($($variant:ident($type:ty)),*) => {$(
        impl From<$type> for View {
            fn from(value: $type) -> Self {
                View::$variant(value)
            }
        }
    )*};
}
into_view!(
    Image(ImageView),
    RawImage(RawImageView),
    CameraCalibration(CameraCalibrationView),
    PointCloud(PointCloudView),
    Pose(PoseView),
    Geo(GeoView)
);

/// An encoded image file: `jpeg` (or `jpg`), `png`, `webp` or `avif`, in any case.
#[derive(Clone, Debug)]
pub struct ImageView {
    pub frame_id: Option<String>,
    pub format: String,
    pub data: Arc<[u8]>,
}

/// Pixels as recorded, `step` bytes per row. `encoding` is a ROS 2 pixel encoding
/// listed in the protocol, such as `rgb8` or `mono16`. Multi-byte pixels are little
/// endian.
#[derive(Clone, Debug)]
pub struct RawImageView {
    pub frame_id: Option<String>,
    pub width: u32,
    pub height: u32,
    pub step: u32,
    pub encoding: String,
    pub data: Arc<[u8]>,
}

/// A pinhole camera calibration.
#[derive(Clone, Debug)]
pub struct CameraCalibrationView {
    pub frame_id: Option<String>,
    pub width: f64,
    pub height: f64,
    /// Row-major 3 by 3 camera matrix K.
    pub intrinsics: [f64; 9],
    /// Empty or all zero for none.
    pub distortion: Vec<f64>,
    /// Such as `plumb_bob` or `rational_polynomial`.
    pub distortion_model: String,
}

/// A position and orientation, moving a point into the parent frame:
/// `p_parent = orientation * p + position`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    /// Meters.
    pub position: [f64; 3],
    /// `[x, y, z, w]`. Normalized when sent; zero length means no rotation.
    pub orientation: [f64; 4],
}

impl Default for Pose {
    fn default() -> Self {
        Self {
            position: [0.; 3],
            orientation: [0., 0., 0., 1.],
        }
    }
}

#[derive(Clone, Debug)]
pub struct PoseView {
    pub frame_id: Option<String>,
    pub pose: Pose,
}

/// The type of a value in packed point data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NumericType {
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    F32,
    F64,
}

impl NumericType {
    pub fn size(self) -> usize {
        match self {
            NumericType::U8 | NumericType::I8 => 1,
            NumericType::U16 | NumericType::I16 => 2,
            NumericType::U32 | NumericType::I32 | NumericType::F32 => 4,
            NumericType::F64 => 8,
        }
    }

    fn name(self) -> &'static str {
        match self {
            NumericType::U8 => "u8",
            NumericType::I8 => "i8",
            NumericType::U16 => "u16",
            NumericType::I16 => "i16",
            NumericType::U32 => "u32",
            NumericType::I32 => "i32",
            NumericType::F32 => "f32",
            NumericType::F64 => "f64",
        }
    }

    /// Reads one little-endian value from the start of `bytes`.
    fn read(self, bytes: &[u8]) -> Option<f64> {
        macro_rules! read {
            ($type:ty) => {
                <$type>::from_le_bytes(bytes.get(..size_of::<$type>())?.try_into().ok()?) as f64
            };
        }
        Some(match self {
            NumericType::U8 => read!(u8),
            NumericType::I8 => read!(i8),
            NumericType::U16 => read!(u16),
            NumericType::I16 => read!(i16),
            NumericType::U32 => read!(u32),
            NumericType::I32 => read!(i32),
            NumericType::F32 => read!(f32),
            NumericType::F64 => read!(f64),
        })
    }
}

/// A value inside each packed point: its name, byte offset and type.
#[derive(Clone, Debug)]
pub struct PackedField {
    pub name: String,
    pub offset: usize,
    pub numeric_type: NumericType,
}

/// One value per point, as little-endian bytes of `numeric_type`.
#[derive(Clone, Debug)]
pub struct PointField {
    pub name: String,
    pub numeric_type: NumericType,
    pub data: Vec<u8>,
}

/// Points in `frame_id`, placed by `pose`. Points whose position is not finite are
/// left out when sent.
#[derive(Clone, Debug, Default)]
pub struct PointCloudView {
    pub frame_id: Option<String>,
    /// The origin of the points in `frame_id`.
    pub pose: Pose,
    /// Meters.
    pub positions: Vec<[f32; 3]>,
    /// Further values per point, such as `intensity`.
    pub fields: Vec<PointField>,
}

impl PointCloudView {
    /// Unpacks points that each hold their values at fixed offsets, as most recorded
    /// types do. `x`, `y` and `z` become the positions, at least two of them must be
    /// present, and the other fields are kept per point.
    pub fn from_packed<'a>(
        frame_id: Option<String>,
        fields: &[PackedField],
        points: impl IntoIterator<Item = &'a [u8]>,
    ) -> anyhow::Result<Self> {
        let axis = |name: &str| fields.iter().find(|field| field.name == name);
        let axes = [axis("x"), axis("y"), axis("z")];
        ensure!(
            axes.iter().flatten().count() >= 2,
            "A point cloud needs at least two of the fields x, y and z"
        );
        let others: Vec<_> = fields
            .iter()
            .filter(|field| !matches!(field.name.as_str(), "x" | "y" | "z"))
            .collect();
        let mut cloud = Self {
            frame_id,
            fields: others
                .iter()
                .map(|field| PointField {
                    name: field.name.clone(),
                    numeric_type: field.numeric_type,
                    data: Vec::new(),
                })
                .collect(),
            ..Self::default()
        };
        let read = |point: &[u8], field: &PackedField| {
            field
                .numeric_type
                .read(point.get(field.offset..).unwrap_or_default())
                .ok_or_else(|| anyhow::anyhow!("Point field {} is outside the point", field.name))
        };
        for point in points {
            let mut position = [0.; 3];
            for (axis, value) in axes.iter().zip(&mut position) {
                if let Some(field) = axis {
                    *value = read(point, field)? as f32;
                }
            }
            cloud.positions.push(position);
            for (field, column) in others.iter().zip(&mut cloud.fields) {
                let start = field.offset;
                let bytes = point
                    .get(start..start + field.numeric_type.size())
                    .ok_or_else(|| {
                        anyhow::anyhow!("Point field {} is outside the point", field.name)
                    })?;
                column.data.extend_from_slice(bytes);
            }
        }
        Ok(cloud)
    }
}

/// GeoJSON features, with positions as `[longitude, latitude]` or
/// `[longitude, latitude, altitude]` in degrees and meters, WGS 84.
#[derive(Clone, Debug)]
pub struct GeoView {
    pub frame_id: Option<String>,
    pub features: Vec<GeoFeature>,
}

#[derive(Clone, Debug)]
pub struct GeoFeature {
    /// Any GeoJSON geometry object.
    pub geometry: serde_json::Value,
    /// Free to fill. The client may show them; `accuracy_m` and `heading` it uses.
    pub properties: serde_json::Map<String, serde_json::Value>,
}

impl GeoFeature {
    /// A point at a location. An altitude that is not finite is left out.
    pub fn point(latitude: f64, longitude: f64, altitude: Option<f64>) -> Self {
        let mut coordinates = vec![longitude, latitude];
        coordinates.extend(altitude.filter(|a| a.is_finite()));
        Self {
            geometry: json!({ "type": "Point", "coordinates": coordinates }),
            properties: Default::default(),
        }
    }
}

const IMAGE_FORMATS: [&str; 4] = ["jpeg", "png", "webp", "avif"];

/// Bytes per pixel of a raw encoding, for the encodings the client can show.
fn bytes_per_pixel(encoding: &str) -> Option<usize> {
    Some(match encoding {
        "mono8" | "8UC1" | "nv12" | "bayer_rggb8" | "bayer_bggr8" | "bayer_gbrg8"
        | "bayer_grbg8" => 1,
        "mono16" | "16UC1" | "yuv422" | "uyvy" | "yuv422_yuy2" | "yuyv" => 2,
        "rgb8" | "bgr8" | "8UC3" => 3,
        "rgba8" | "bgra8" | "32FC1" => 4,
        _ => return None,
    })
}

fn finite(values: &[f64]) -> bool {
    values.iter().all(|v| v.is_finite())
}

/// `pose` with a unit quaternion, or an error if it has a number that is not finite.
pub(super) fn checked(pose: Pose) -> anyhow::Result<Pose> {
    ensure!(finite(&pose.position), "Non-finite vector");
    ensure!(finite(&pose.orientation), "Non-finite rotation");
    let q = pose.orientation;
    let length = q.iter().map(|v| v * v).sum::<f64>().sqrt();
    let orientation = if length == 0. {
        [0., 0., 0., 1.]
    } else {
        q.map(|v| v / length)
    };
    Ok(Pose {
        position: pose.position,
        orientation,
    })
}

fn pose_json(pose: Pose) -> serde_json::Value {
    json!({ "position": pose.position, "orientation": pose.orientation })
}

/// Checks `view` against the protocol and turns it into a frame's value, adding its
/// binary data to `payload`.
pub(crate) fn encode(view: View, payload: &mut Payload) -> anyhow::Result<serde_json::Value> {
    Ok(match view {
        View::Image(image) => {
            let format = image.format.to_ascii_lowercase();
            let format = if format == "jpg" { "jpeg" } else { &format };
            ensure!(
                IMAGE_FORMATS.contains(&format),
                "Unsupported image format: {format:?}"
            );
            json!({"kind": "image", "frame_id": image.frame_id, "format": format, "role": "color", "data": payload.add(image.data)})
        }
        View::RawImage(image) => {
            let RawImageView {
                frame_id,
                width,
                height,
                step,
                encoding,
                data,
            } = image;
            ensure!(width > 0, "Invalid image width");
            ensure!(height > 0, "Invalid image height");
            ensure!(step > 0, "Invalid image step");
            let (width, height, step) = (width as usize, height as usize, step as usize);
            let Some(bytes_per_pixel) = bytes_per_pixel(&encoding) else {
                bail!("Unsupported raw image encoding: {encoding:?}");
            };
            if matches!(
                encoding.as_str(),
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
                step >= width * bytes_per_pixel,
                "Raw image step is too small"
            );
            let rows = height + if encoding == "nv12" { height / 2 } else { 0 };
            ensure!(
                step.checked_mul(rows) == Some(data.len()),
                "Raw image data length does not match step and height"
            );
            json!({"kind":"image", "frame_id":frame_id, "format":"raw", "width":width, "height":height, "step":step, "encoding":encoding, "data":payload.add(data)})
        }
        View::CameraCalibration(calibration) => {
            let CameraCalibrationView {
                frame_id,
                width,
                height,
                intrinsics: k,
                distortion,
                distortion_model,
            } = calibration;
            ensure!(
                width.is_finite() && width > 0. && height.is_finite() && height > 0.,
                "Invalid camera dimensions"
            );
            ensure!(
                finite(&k) && k[0] > 0. && k[4] > 0.,
                "Invalid camera matrix"
            );
            ensure!(finite(&distortion), "Invalid distortion coefficients");
            json!({"kind":"camera_calibration", "frame_id":frame_id, "width":width, "height":height, "intrinsics":k, "distortion":distortion, "distortion_model":distortion_model})
        }
        View::Pose(pose) => {
            json!({"kind":"pose", "frame_id":pose.frame_id, "pose":pose_json(checked(pose.pose)?)})
        }
        View::PointCloud(cloud) => {
            let points = cloud.positions.len();
            for field in &cloud.fields {
                ensure!(
                    field.data.len() == points * field.numeric_type.size(),
                    "Point field {} does not have one value per point",
                    field.name
                );
            }
            let pose = checked(cloud.pose)?;
            // A point with no return has no position to draw.
            let keep: Vec<bool> = cloud
                .positions
                .iter()
                .map(|p| p.iter().all(|v| v.is_finite()))
                .collect();
            let count = keep.iter().filter(|k| **k).count();
            let mut positions = Vec::with_capacity(count * 12);
            for (position, _) in cloud.positions.iter().zip(&keep).filter(|(_, k)| **k) {
                for v in position {
                    positions.extend_from_slice(&v.to_le_bytes());
                }
            }
            let fields: Vec<_> = cloud
                .fields
                .into_iter()
                .map(|field| {
                    let size = field.numeric_type.size();
                    let data: Arc<[u8]> = if count == points {
                        field.data.into()
                    } else {
                        field
                            .data
                            .chunks_exact(size)
                            .zip(&keep)
                            .filter(|(_, k)| **k)
                            .flat_map(|(value, _)| value)
                            .copied()
                            .collect()
                    };
                    json!({ "name": field.name, "type": field.numeric_type.name(), "data": payload.add(data) })
                })
                .collect();
            json!({
                "kind": "pointcloud",
                "frame_id": cloud.frame_id,
                "count": count,
                "pose": pose_json(pose),
                "positions": payload.add(positions.into()),
                "fields": fields,
            })
        }
        View::Geo(geo) => {
            let features = geo
                .features
                .into_iter()
                .map(|feature| {
                    let geometry = &feature.geometry;
                    ensure!(
                        geometry["type"].is_string(),
                        "A feature's geometry must have a type"
                    );
                    if geometry["type"] == "Point" {
                        let coordinates = geometry["coordinates"].as_array();
                        let at = |i: usize| coordinates.and_then(|c| c.get(i)?.as_f64());
                        let (Some(longitude), Some(latitude)) = (at(0), at(1)) else {
                            bail!(
                                "Invalid location: a point needs a finite longitude and latitude"
                            );
                        };
                        ensure!(
                            (-90. ..=90.).contains(&latitude)
                                && (-180. ..=180.).contains(&longitude),
                            "Invalid location: {latitude}, {longitude}"
                        );
                    }
                    Ok(json!({
                        "type": "Feature",
                        "geometry": feature.geometry,
                        "properties": feature.properties,
                    }))
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            json!({ "kind": "geo", "frame_id": geo.frame_id, "features": features })
        }
    })
}
