//! ROS 2 messages encoded as CDR, as a rosbag2 MCAP holds them.
#![allow(dead_code)]

use std::{collections::BTreeMap, fs::File, io::BufWriter, path::Path};

const SEPARATOR: &str =
    "================================================================================";

const HEADER: (&str, &str) = (
    "std_msgs/Header",
    "builtin_interfaces/Time stamp\nstring frame_id\n",
);
const POINT: (&str, &str) = ("geometry_msgs/Point", "float64 x\nfloat64 y\nfloat64 z\n");
const VECTOR3: (&str, &str) = ("geometry_msgs/Vector3", "float64 x\nfloat64 y\nfloat64 z\n");
const QUATERNION: (&str, &str) = (
    "geometry_msgs/Quaternion",
    "float64 x 0\nfloat64 y 0\nfloat64 z 0\nfloat64 w 1\n",
);
const POSE: (&str, &str) = (
    "geometry_msgs/Pose",
    "Point position\nQuaternion orientation\n",
);
const POSE_WITH_COVARIANCE: (&str, &str) = (
    "geometry_msgs/PoseWithCovariance",
    "Pose pose\nfloat64[36] covariance\n",
);
const TWIST: (&str, &str) = ("geometry_msgs/Twist", "Vector3 linear\nVector3 angular\n");
const TWIST_WITH_COVARIANCE: (&str, &str) = (
    "geometry_msgs/TwistWithCovariance",
    "Twist twist\nfloat64[36] covariance\n",
);
const TRANSFORM: (&str, &str) = (
    "geometry_msgs/Transform",
    "Vector3 translation\nQuaternion rotation\n",
);
const TRANSFORM_STAMPED: (&str, &str) = (
    "geometry_msgs/TransformStamped",
    "std_msgs/Header header\nstring child_frame_id\nTransform transform\n",
);
const POINT_FIELD: (&str, &str) = (
    "sensor_msgs/PointField",
    "uint8 INT8 = 1\nuint8 UINT8 = 2\nuint8 INT16 = 3\nuint8 UINT16 = 4\nuint8 INT32 = 5\n\
     uint8 UINT32 = 6\nuint8 FLOAT32 = 7\nuint8 FLOAT64 = 8\n\
     string name\nuint32 offset\nuint8 datatype\nuint32 count\n",
);
const REGION_OF_INTEREST: (&str, &str) = (
    "sensor_msgs/RegionOfInterest",
    "uint32 x_offset\nuint32 y_offset\nuint32 height\nuint32 width\nbool do_rectify\n",
);
const NAV_SAT_STATUS: (&str, &str) = (
    "sensor_msgs/NavSatStatus",
    "int8 STATUS_NO_FIX = -1\nint8 STATUS_FIX = 0\nint8 status\nuint16 service\n",
);

/// The name of a type, its definition, and the types it refers to.
pub type RosType = (
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
);

pub const TF_MESSAGE: RosType = (
    "tf2_msgs/msg/TFMessage",
    "geometry_msgs/TransformStamped[] transforms\n",
    &[TRANSFORM_STAMPED, HEADER, TRANSFORM, VECTOR3, QUATERNION],
);
pub const COMPRESSED_IMAGE: RosType = (
    "sensor_msgs/msg/CompressedImage",
    "std_msgs/Header header\nstring format\nuint8[] data\n",
    &[HEADER],
);
pub const IMAGE: RosType = (
    "sensor_msgs/msg/Image",
    "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\n\
     uint32 step\nuint8[] data\n",
    &[HEADER],
);
pub const CAMERA_INFO: RosType = (
    "sensor_msgs/msg/CameraInfo",
    "std_msgs/Header header\nuint32 height\nuint32 width\nstring distortion_model\n\
     float64[] d\nfloat64[9] k\nfloat64[9] r\nfloat64[12] p\nuint32 binning_x\n\
     uint32 binning_y\nRegionOfInterest roi\n",
    &[HEADER, REGION_OF_INTEREST],
);
pub const POINT_CLOUD2: RosType = (
    "sensor_msgs/msg/PointCloud2",
    "std_msgs/Header header\nuint32 height\nuint32 width\nPointField[] fields\n\
     bool is_bigendian\nuint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense\n",
    &[HEADER, POINT_FIELD],
);
pub const ODOMETRY: RosType = (
    "nav_msgs/msg/Odometry",
    "std_msgs/Header header\nstring child_frame_id\ngeometry_msgs/PoseWithCovariance pose\n\
     geometry_msgs/TwistWithCovariance twist\n",
    &[
        HEADER,
        POSE_WITH_COVARIANCE,
        POSE,
        POINT,
        QUATERNION,
        TWIST_WITH_COVARIANCE,
        TWIST,
        VECTOR3,
    ],
);
pub const POSE_STAMPED: RosType = (
    "geometry_msgs/msg/PoseStamped",
    "std_msgs/Header header\nPose pose\n",
    &[HEADER, POSE, POINT, QUATERNION],
);
pub const POSE_WITH_COVARIANCE_STAMPED: RosType = (
    "geometry_msgs/msg/PoseWithCovarianceStamped",
    "std_msgs/Header header\nPoseWithCovariance pose\n",
    &[HEADER, POSE_WITH_COVARIANCE, POSE, POINT, QUATERNION],
);
pub const NAV_SAT_FIX: RosType = (
    "sensor_msgs/msg/NavSatFix",
    "uint8 COVARIANCE_TYPE_UNKNOWN = 0\nuint8 COVARIANCE_TYPE_DIAGONAL_KNOWN = 2\n\
     std_msgs/Header header\nNavSatStatus status\nfloat64 latitude\nfloat64 longitude\n\
     float64 altitude\nfloat64[9] position_covariance\nuint8 position_covariance_type\n",
    &[HEADER, NAV_SAT_STATUS],
);

/// A type of an application's own, unknown to Hahn: a pose on a plane.
pub const ACME_POSE2D: RosType = (
    "acme_msgs/msg/Pose2D",
    "string frame_id\nfloat64 x\nfloat64 y\nfloat64 theta\n",
    &[],
);

fn schema_text((_, root, dependencies): RosType) -> String {
    let mut text = root.to_owned();
    for (name, definition) in dependencies {
        text.push_str(&format!("{SEPARATOR}\nMSG: {name}\n{definition}"));
    }
    text
}

/// Little-endian CDR, with alignment counted from after the encapsulation header.
pub struct Cdr(Vec<u8>);

impl Cdr {
    pub fn new() -> Self {
        Self(vec![0, 1, 0, 0])
    }
    fn align(&mut self, size: usize) {
        while !(self.0.len() - 4).is_multiple_of(size) {
            self.0.push(0);
        }
    }
    pub fn u8(&mut self, value: u8) -> &mut Self {
        self.0.push(value);
        self
    }
    pub fn u16(&mut self, value: u16) -> &mut Self {
        self.align(2);
        self.0.extend_from_slice(&value.to_le_bytes());
        self
    }
    pub fn u32(&mut self, value: u32) -> &mut Self {
        self.align(4);
        self.0.extend_from_slice(&value.to_le_bytes());
        self
    }
    pub fn f64(&mut self, value: f64) -> &mut Self {
        self.align(8);
        self.0.extend_from_slice(&value.to_le_bytes());
        self
    }
    pub fn f64s(&mut self, values: &[f64]) -> &mut Self {
        for value in values {
            self.f64(*value);
        }
        self
    }
    /// A sequence of doubles, with its length first.
    pub fn f64_list(&mut self, values: &[f64]) -> &mut Self {
        self.u32(values.len() as u32).f64s(values)
    }
    pub fn string(&mut self, value: &str) -> &mut Self {
        self.u32(value.len() as u32 + 1);
        self.0.extend_from_slice(value.as_bytes());
        self.0.push(0);
        self
    }
    pub fn bytes(&mut self, value: &[u8]) -> &mut Self {
        self.u32(value.len() as u32);
        self.0.extend_from_slice(value);
        self
    }
    pub fn header(&mut self, time_ns: u64, frame: &str) -> &mut Self {
        self.u32((time_ns / 1_000_000_000) as u32)
            .u32((time_ns % 1_000_000_000) as u32)
            .string(frame)
    }
    /// A position and orientation.
    pub fn pose(&mut self, position: [f64; 3], orientation: [f64; 4]) -> &mut Self {
        self.f64s(&position).f64s(&orientation)
    }
    pub fn finish(&self) -> Vec<u8> {
        self.0.clone()
    }
}

/// Writes messages to a chunked, indexed MCAP as rosbag2 would, adding each topic
/// and its schema on first use.
pub struct RosWriter {
    writer: mcap::Writer<BufWriter<File>>,
    schemas: BTreeMap<&'static str, u16>,
    channels: BTreeMap<String, u16>,
    sequence: u32,
}

impl RosWriter {
    pub fn create(path: &Path) -> anyhow::Result<Self> {
        Ok(Self {
            writer: mcap::Writer::new(BufWriter::new(File::create(path)?))?,
            schemas: BTreeMap::new(),
            channels: BTreeMap::new(),
            sequence: 0,
        })
    }

    pub fn write(
        &mut self,
        topic: &str,
        ros_type: RosType,
        time_ns: u64,
        message: &Cdr,
    ) -> anyhow::Result<()> {
        let channel = match self.channels.get(topic) {
            Some(channel) => *channel,
            None => {
                let schema = match self.schemas.get(ros_type.0) {
                    Some(schema) => *schema,
                    None => {
                        let schema = self.writer.add_schema(
                            ros_type.0,
                            "ros2msg",
                            schema_text(ros_type).as_bytes(),
                        )?;
                        self.schemas.insert(ros_type.0, schema);
                        schema
                    }
                };
                let channel = self
                    .writer
                    .add_channel(schema, topic, "cdr", &Default::default())?;
                self.channels.insert(topic.to_owned(), channel);
                channel
            }
        };
        self.sequence += 1;
        self.writer.write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: channel,
                sequence: self.sequence,
                log_time: time_ns,
                publish_time: time_ns,
            },
            &message.finish(),
        )?;
        Ok(())
    }

    pub fn finish(mut self) -> anyhow::Result<()> {
        self.writer.finish()?;
        Ok(())
    }
}

/// `geometry_msgs/msg/TransformStamped`s in a `tf2_msgs/msg/TFMessage`.
pub fn tf_message(transforms: &[(&str, &str, [f64; 3], [f64; 4])], time_ns: u64) -> Cdr {
    let mut cdr = Cdr::new();
    cdr.u32(transforms.len() as u32);
    for (parent, child, translation, rotation) in transforms {
        cdr.header(time_ns, parent)
            .string(child)
            .pose(*translation, *rotation);
    }
    cdr
}

/// One `sensor_msgs/msg/PointField`: name, offset, datatype and count.
pub type PointField<'a> = (&'a str, u32, u8, u32);

/// The size fields are given separately so that a test can make them inconsistent.
pub struct Cloud<'a> {
    pub frame: &'a str,
    pub height: u32,
    pub width: u32,
    pub fields: &'a [PointField<'a>],
    pub bigendian: bool,
    pub point_step: u32,
    pub row_step: u32,
    pub data: &'a [u8],
}

pub fn point_cloud2(cloud: &Cloud, time_ns: u64) -> Cdr {
    let mut cdr = Cdr::new();
    cdr.header(time_ns, cloud.frame)
        .u32(cloud.height)
        .u32(cloud.width)
        .u32(cloud.fields.len() as u32);
    for (name, offset, datatype, count) in cloud.fields {
        cdr.string(name).u32(*offset).u8(*datatype).u32(*count);
    }
    cdr.u8(cloud.bigendian as u8)
        .u32(cloud.point_step)
        .u32(cloud.row_step)
        .bytes(cloud.data)
        .u8(1);
    cdr
}

pub fn camera_info(
    frame: &str,
    size: [u32; 2],
    model: &str,
    d: &[f64],
    k: [f64; 9],
    time_ns: u64,
) -> Cdr {
    let mut cdr = Cdr::new();
    cdr.header(time_ns, frame)
        .u32(size[1])
        .u32(size[0])
        .string(model)
        .f64_list(d)
        .f64s(&k)
        .f64s(&[1., 0., 0., 0., 1., 0., 0., 0., 1.])
        .f64s(&[
            k[0], k[1], k[2], 0., k[3], k[4], k[5], 0., k[6], k[7], k[8], 0.,
        ])
        .u32(0)
        .u32(0)
        .u32(0)
        .u32(0)
        .u32(size[1])
        .u32(size[0])
        .u8(0);
    cdr
}

pub fn image(
    frame: &str,
    size: [u32; 2],
    encoding: &str,
    bigendian: bool,
    step: u32,
    data: &[u8],
    time_ns: u64,
) -> Cdr {
    let mut cdr = Cdr::new();
    cdr.header(time_ns, frame)
        .u32(size[1])
        .u32(size[0])
        .string(encoding)
        .u8(bigendian as u8)
        .u32(step)
        .bytes(data);
    cdr
}

pub fn compressed_image(frame: &str, format: &str, data: &[u8], time_ns: u64) -> Cdr {
    let mut cdr = Cdr::new();
    cdr.header(time_ns, frame).string(format).bytes(data);
    cdr
}

pub fn odometry(
    frame: &str,
    child: &str,
    position: [f64; 3],
    rotation: [f64; 4],
    time_ns: u64,
) -> Cdr {
    let mut cdr = Cdr::new();
    cdr.header(time_ns, frame)
        .string(child)
        .pose(position, rotation)
        .f64s(&[0.; 36])
        .f64s(&[0.; 6])
        .f64s(&[0.; 36]);
    cdr
}

pub fn nav_sat_fix(
    frame: &str,
    status: i8,
    coordinates: [f64; 3],
    covariance: [f64; 9],
    covariance_type: u8,
    time_ns: u64,
) -> Cdr {
    let mut cdr = Cdr::new();
    cdr.header(time_ns, frame)
        .u8(status as u8)
        .u16(1)
        .f64s(&coordinates)
        .f64s(&covariance)
        .u8(covariance_type);
    cdr
}

/// Every supported type, with the awkward cases of each.
pub fn write_ros2_fixture(path: &Path) -> anyhow::Result<()> {
    let mut writer = RosWriter::create(path)?;
    let identity = [0., 0., 0., 1.];

    writer.write(
        "/tf_static",
        TF_MESSAGE,
        1,
        &tf_message(&[("base", "lidar", [0., 0., 2.], identity)], 1),
    )?;
    for (time, x) in [(10, 0.), (20, 10.)] {
        writer.write(
            "/tf",
            TF_MESSAGE,
            time,
            &tf_message(&[("map", "base", [x, 0., 0.], identity)], time),
        )?;
    }

    for (time, format) in [
        (1, "rgb8; jpeg compressed bgr8"),
        (2, "png"),
        (3, "16UC1; compressedDepth png"),
    ] {
        writer.write(
            "/camera/compressed",
            COMPRESSED_IMAGE,
            time,
            &compressed_image("camera", format, &[1, 2, 3], time),
        )?;
    }

    for (time, encoding, bigendian, step, data) in [
        (1, "rgb8", false, 8, vec![255, 0, 0, 0, 255, 0, 9, 9]),
        (2, "mono8", true, 2, vec![1, 2]),
        (3, "mono16", true, 4, vec![0; 4]),
    ] {
        writer.write(
            "/camera/image",
            IMAGE,
            time,
            &image("camera", [2, 1], encoding, bigendian, step, &data, time),
        )?;
    }

    for (time, fx) in [(1, 400.), (2, 0.)] {
        writer.write(
            "/camera/info",
            CAMERA_INFO,
            time,
            &camera_info(
                "camera",
                [640, 480],
                "plumb_bob",
                &[0.1],
                [fx, 0., 320., 0., fx, 240., 0., 0., 1.],
                time,
            ),
        )?;
    }

    // Two rows of two 16-byte points, each row followed by 4 bytes of padding. Field
    // types 1 and 2 are read the opposite way round in `foxglove.NumericType`.
    let fields = [
        ("x", 0, 7, 1),
        ("y", 4, 7, 1),
        ("z", 8, 7, 1),
        ("signed", 12, 1, 1),
        ("unsigned", 13, 2, 1),
        ("vector", 14, 2, 2),
    ];
    let mut data = Vec::new();
    for (i, x) in [1f32, f32::NAN, 3., 4.].into_iter().enumerate() {
        data.extend_from_slice(&x.to_le_bytes());
        data.extend_from_slice(&(i as f32 * 10.).to_le_bytes());
        data.extend_from_slice(&0f32.to_le_bytes());
        data.extend_from_slice(&[0xff, 0xfe, 0, 0]);
        if i % 2 == 1 {
            data.extend_from_slice(&[0xaa; 4]);
        }
    }
    let cloud = Cloud {
        frame: "lidar",
        height: 2,
        width: 2,
        fields: &fields,
        bigendian: false,
        point_step: 16,
        row_step: 36,
        data: &data,
    };
    writer.write("/lidar", POINT_CLOUD2, 1, &point_cloud2(&cloud, 1))?;
    let short = Cloud {
        row_step: 8,
        ..cloud
    };
    writer.write("/lidar", POINT_CLOUD2, 2, &point_cloud2(&short, 2))?;
    let swapped = Cloud {
        bigendian: true,
        ..cloud
    };
    writer.write("/lidar", POINT_CLOUD2, 3, &point_cloud2(&swapped, 3))?;

    writer.write(
        "/odom",
        ODOMETRY,
        1,
        &odometry("map", "base", [2., 3., 4.], identity, 1),
    )?;
    let mut pose = Cdr::new();
    pose.header(1, "map").pose([5., 6., 7.], identity);
    writer.write("/pose", POSE_STAMPED, 1, &pose)?;
    let mut covariant = Cdr::new();
    covariant
        .header(1, "map")
        .pose([8., 9., 10.], identity)
        .f64s(&[0.; 36]);
    writer.write(
        "/pose_covariance",
        POSE_WITH_COVARIANCE_STAMPED,
        1,
        &covariant,
    )?;

    let covariance = [4., 0., 0., 0., 9., 0., 0., 0., 1.];
    for (time, status, coordinates, covariance_type) in [
        (1, 0, [35., 139., 40.], 2),
        (2, 0, [35., 139., 40.], 0),
        (3, -1, [0., 0., 0.], 0),
        (4, 0, [f64::NAN, 139., 40.], 0),
    ] {
        writer.write(
            "/fix",
            NAV_SAT_FIX,
            time,
            &nav_sat_fix(
                "gps",
                status,
                coordinates,
                covariance,
                covariance_type,
                time,
            ),
        )?;
    }
    writer.finish()
}

/// Another type of an application's own: where frame `child` is in `parent`, on a plane.
pub const ACME_LINK2D: RosType = (
    "acme_msgs/msg/Link2D",
    "string parent\nstring child\nfloat64 x\nfloat64 y\nfloat64 theta\n",
    &[],
);

fn link2d(parent: &str, child: &str, x: f64, y: f64, theta: f64) -> Cdr {
    let mut cdr = Cdr::new();
    cdr.string(parent).string(child).f64(x).f64(y).f64(theta);
    cdr
}

/// Steps of the `acme_msgs/msg/Pose2D` fixture: 100 ms apart from 0.
pub const ACME_COUNT: u64 = 40;
pub const ACME_STEP_NS: u64 = 100_000_000;

/// `/acme_pose`, driving a circle of radius 5 m in `map` over the fixture, and
/// `/acme_link`, placing `base` on the same circle and `sensor` 1 m ahead of `base`.
///
/// With `faults`, as tests use it, every 10th pose has no frame, and the link also
/// holds a sample without a child and one that is not finite. Without, the fixture
/// shows cleanly as a demo.
pub fn write_acme_fixture(path: &Path, faults: bool) -> anyhow::Result<()> {
    let mut writer = RosWriter::create(path)?;
    for i in 0..ACME_COUNT {
        let angle = i as f64 / ACME_COUNT as f64 * std::f64::consts::TAU;
        let (x, y, theta) = (
            5. * angle.cos(),
            5. * angle.sin(),
            angle + std::f64::consts::FRAC_PI_2,
        );
        let frame = if faults && i % 10 == 9 { "" } else { "map" };
        let mut cdr = Cdr::new();
        cdr.string(frame).f64(x).f64(y).f64(theta);
        writer.write("/acme_pose", ACME_POSE2D, i * ACME_STEP_NS, &cdr)?;
        writer.write(
            "/acme_link",
            ACME_LINK2D,
            i * ACME_STEP_NS,
            &link2d("map", "base", x, y, theta),
        )?;
    }
    writer.write(
        "/acme_link",
        ACME_LINK2D,
        0,
        &link2d("base", "sensor", 1., 0., 0.),
    )?;
    if faults {
        writer.write(
            "/acme_link",
            ACME_LINK2D,
            0,
            &link2d("base", "", 1., 0., 0.),
        )?;
        writer.write(
            "/acme_link",
            ACME_LINK2D,
            0,
            &link2d("base", "broken", f64::NAN, 0., 0.),
        )?;
    }
    writer.finish()
}

const POINT2D: (&str, &str) = ("vision_msgs/Point2D", "float64 x\nfloat64 y\n");
const POSE2D: (&str, &str) = ("vision_msgs/Pose2D", "Point2D position\nfloat64 theta\n");
const BOUNDING_BOX2D: (&str, &str) = (
    "vision_msgs/BoundingBox2D",
    "Pose2D center\nfloat64 size_x\nfloat64 size_y\n",
);
const BOUNDING_BOX3D: (&str, &str) = (
    "vision_msgs/BoundingBox3D",
    "geometry_msgs/Pose center\ngeometry_msgs/Vector3 size\n",
);
const OBJECT_HYPOTHESIS: (&str, &str) = (
    "vision_msgs/ObjectHypothesis",
    "string class_id\nfloat64 score\n",
);
const OBJECT_HYPOTHESIS_WITH_POSE: (&str, &str) = (
    "vision_msgs/ObjectHypothesisWithPose",
    "ObjectHypothesis hypothesis\ngeometry_msgs/PoseWithCovariance pose\n",
);
const DETECTION2D: (&str, &str) = (
    "vision_msgs/Detection2D",
    "std_msgs/Header header\nObjectHypothesisWithPose[] results\nBoundingBox2D bbox\nstring id\n",
);
const DETECTION3D: (&str, &str) = (
    "vision_msgs/Detection3D",
    "std_msgs/Header header\nObjectHypothesisWithPose[] results\nBoundingBox3D bbox\nstring id\n",
);

pub const POINT_STAMPED: RosType = (
    "geometry_msgs/msg/PointStamped",
    "std_msgs/Header header\nPoint point\n",
    &[HEADER, POINT],
);
pub const POSE_ARRAY: RosType = (
    "geometry_msgs/msg/PoseArray",
    "std_msgs/Header header\nPose[] poses\n",
    &[HEADER, POSE, POINT, QUATERNION],
);
pub const PATH: RosType = (
    "nav_msgs/msg/Path",
    "std_msgs/Header header\ngeometry_msgs/PoseStamped[] poses\n",
    &[
        HEADER,
        (
            "geometry_msgs/PoseStamped",
            "std_msgs/Header header\nPose pose\n",
        ),
        POSE,
        POINT,
        QUATERNION,
    ],
);
pub const DETECTION3D_ARRAY: RosType = (
    "vision_msgs/msg/Detection3DArray",
    "std_msgs/Header header\nDetection3D[] detections\n",
    &[
        HEADER,
        DETECTION3D,
        OBJECT_HYPOTHESIS_WITH_POSE,
        OBJECT_HYPOTHESIS,
        POSE_WITH_COVARIANCE,
        BOUNDING_BOX3D,
        POSE,
        POINT,
        QUATERNION,
        VECTOR3,
    ],
);
pub const DETECTION2D_ARRAY: RosType = (
    "vision_msgs/msg/Detection2DArray",
    "std_msgs/Header header\nDetection2D[] detections\n",
    &[
        HEADER,
        DETECTION2D,
        OBJECT_HYPOTHESIS_WITH_POSE,
        OBJECT_HYPOTHESIS,
        POSE_WITH_COVARIANCE,
        BOUNDING_BOX2D,
        POSE2D,
        POINT2D,
        POSE,
        POINT,
        QUATERNION,
    ],
);
pub const GEOJSON: RosType = ("foxglove_msgs/msg/GeoJSON", "string geojson\n", &[]);

/// The start of the scene, in recording time.
pub const SCENE_ORIGIN: u64 = 1_760_000_000_000_000_000;
/// Seconds the vehicle takes to drive its circle.
pub const SCENE_SECONDS: u64 = 20;
const SCENE_RADIUS: f64 = 20.;
const SCENE_STEP_NS: u64 = 100_000_000;
/// How late each lidar cloud is recorded after it was measured.
pub const LIDAR_DELAY_NS: u64 = 100_000_000;
/// How late each detection is recorded after the image it was made from.
pub const DETECTION_DELAY_NS: u64 = 50_000_000;
const IMAGE_SIZE: [u32; 2] = [320, 240];

fn yaw(angle: f64) -> [f64; 4] {
    [0., 0., (angle / 2.).sin(), (angle / 2.).cos()]
}

/// Where the vehicle is at `seconds`, driving counterclockwise round the origin.
fn vehicle(seconds: f64) -> ([f64; 3], f64) {
    let angle = std::f64::consts::TAU * seconds / SCENE_SECONDS as f64;
    let position = [SCENE_RADIUS * angle.cos(), SCENE_RADIUS * angle.sin(), 0.];
    (position, angle + std::f64::consts::FRAC_PI_2)
}

/// The square drawn in the camera image at `seconds`: its center and side, in pixels.
fn image_square(seconds: f64) -> ([f64; 2], f64) {
    let x = 60. + 200. * (0.5 + 0.5 * (seconds * 1.5).sin());
    ([x, 120.], 40.)
}

fn hypothesis(cdr: &mut Cdr, class: &str, score: f64) {
    cdr.u32(1)
        .string(class)
        .f64(score)
        .pose([0.; 3], [0., 0., 0., 1.])
        .f64s(&[0.; 36]);
}

/// A scene to look at rather than to test edge cases with: a vehicle driving a circle
/// for [`SCENE_SECONDS`] with a camera, a lidar recorded late, detections in 2D and
/// 3D, a plan, particles, a tracked point, a GNSS fix and an area on the map.
pub fn write_ros2_scene(path: &Path) -> anyhow::Result<()> {
    let mut writer = RosWriter::create(path)?;
    let optical = [-0.5, 0.5, -0.5, 0.5];
    writer.write(
        "/tf_static",
        TF_MESSAGE,
        SCENE_ORIGIN,
        &tf_message(
            &[
                ("base_link", "camera", [1., 0., 1.5], optical),
                ("base_link", "lidar", [0., 0., 2.], [0., 0., 0., 1.]),
            ],
            SCENE_ORIGIN,
        ),
    )?;
    let area = serde_json::json!({
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"name": "Track"},
            "geometry": {"type": "Polygon", "coordinates": [[
                [139.7597, 35.6798], [139.7603, 35.6798], [139.7603, 35.6802],
                [139.7597, 35.6802], [139.7597, 35.6798],
            ]]},
        }],
    });
    let mut geojson = Cdr::new();
    geojson.string(&area.to_string());
    writer.write("/area", GEOJSON, SCENE_ORIGIN, &geojson)?;
    let steps = SCENE_SECONDS * 1_000_000_000 / SCENE_STEP_NS;
    for step in 0..=steps {
        let time = SCENE_ORIGIN + step * SCENE_STEP_NS;
        let seconds = (step * SCENE_STEP_NS) as f64 / 1e9;
        let (position, heading) = vehicle(seconds);
        writer.write(
            "/tf",
            TF_MESSAGE,
            time,
            &tf_message(&[("map", "base_link", position, yaw(heading))], time),
        )?;
        let mut odom = Cdr::new();
        odom.header(time, "map").pose(position, yaw(heading));
        writer.write("/pose", POSE_STAMPED, time, &odom)?;

        // A ring of posts round the lidar, measured now and recorded late.
        let mut data = Vec::new();
        for i in 0..360 {
            let angle = (i as f32).to_radians();
            for z in [-1.5f32, -1., -0.5] {
                for value in [8. * angle.cos(), 8. * angle.sin(), z] {
                    data.extend_from_slice(&value.to_le_bytes());
                }
            }
        }
        let fields = [("x", 0, 7, 1), ("y", 4, 7, 1), ("z", 8, 7, 1)];
        let cloud = Cloud {
            frame: "lidar",
            height: 1,
            width: (data.len() / 12) as u32,
            fields: &fields,
            bigendian: false,
            point_step: 12,
            row_step: data.len() as u32,
            data: &data,
        };
        writer.write(
            "/lidar",
            POINT_CLOUD2,
            time + LIDAR_DELAY_NS,
            &point_cloud2(&cloud, time),
        )?;

        // The camera sees a gray scene with a square moving across it.
        let ([cx, cy], side) = image_square(seconds);
        let [width, height] = IMAGE_SIZE;
        let mut pixels = Vec::with_capacity((width * height * 3) as usize);
        for y in 0..height {
            for x in 0..width {
                let inside = (x as f64 - cx).abs() < side / 2. && (y as f64 - cy).abs() < side / 2.;
                let shade = if inside {
                    [230, 80, 60]
                } else {
                    [70, (y / 2) as u8 + 40, 90]
                };
                pixels.extend_from_slice(&shade);
            }
        }
        writer.write(
            "/camera/image_raw",
            IMAGE,
            time,
            &image(
                "camera",
                IMAGE_SIZE,
                "rgb8",
                false,
                width * 3,
                &pixels,
                time,
            ),
        )?;
        let k = [300., 0., 160., 0., 300., 120., 0., 0., 1.];
        writer.write(
            "/camera/camera_info",
            CAMERA_INFO,
            time,
            &camera_info("camera", IMAGE_SIZE, "plumb_bob", &[0.; 5], k, time),
        )?;
        // A detector finds the square, stamped as the image and recorded after it.
        let mut detections = Cdr::new();
        detections.header(time, "camera").u32(1);
        detections.header(time, "camera");
        hypothesis(&mut detections, "square", 0.9);
        detections
            .f64(cx)
            .f64(cy)
            .f64(0.)
            .f64(side)
            .f64(side)
            .string("1");
        writer.write(
            "/camera/detections",
            DETECTION2D_ARRAY,
            time + DETECTION_DELAY_NS,
            &detections,
        )?;

        // Boxes round the track, a plan ahead and particles round the vehicle.
        let mut boxes = Cdr::new();
        boxes.header(time, "map").u32(4);
        for (i, class) in ["car", "tree", "car", "tree"].into_iter().enumerate() {
            let angle = std::f64::consts::FRAC_PI_2 * i as f64;
            let center = [26. * angle.cos(), 26. * angle.sin(), 1.];
            boxes.header(time, "map");
            hypothesis(&mut boxes, class, 0.6 + 0.1 * i as f64);
            boxes
                .pose(center, yaw(angle))
                .f64s(&[4., 2., 2.])
                .string(&i.to_string());
        }
        writer.write("/objects", DETECTION3D_ARRAY, time, &boxes)?;
        let mut plan = Cdr::new();
        plan.header(time, "map").u32(20);
        for i in 0..20 {
            let (at, toward) = vehicle(seconds + i as f64 * 0.25);
            plan.header(time, "map").pose(at, yaw(toward));
        }
        writer.write("/plan", PATH, time, &plan)?;
        let mut particles = Cdr::new();
        particles.header(time, "map").u32(30);
        for i in 0..30 {
            let spread = i as f64 * 2.4;
            let offset = [
                position[0] + spread.cos() * 1.5,
                position[1] + spread.sin() * 1.5,
                0.,
            ];
            particles.pose(offset, yaw(heading + (spread * 3.).sin() * 0.3));
        }
        writer.write("/particles", POSE_ARRAY, time, &particles)?;
        let mut target = Cdr::new();
        let orbit = seconds * 0.8;
        target
            .header(time, "map")
            .f64(10. * orbit.cos())
            .f64(10. * orbit.sin())
            .f64(1. + orbit.sin());
        writer.write("/target", POINT_STAMPED, time, &target)?;

        // GNSS at a tenth of the rate, two meters accurate.
        if step % 10 == 0 {
            let latitude = 35.68 + position[1] / 111_000.;
            let longitude = 139.76 + position[0] / (111_000. * 35.68f64.to_radians().cos());
            writer.write(
                "/gps",
                NAV_SAT_FIX,
                time,
                &nav_sat_fix(
                    "gps",
                    0,
                    [latitude, longitude, 40.],
                    [4., 0., 0., 0., 4., 0., 0., 0., 9.],
                    2,
                    time,
                ),
            )?;
        }
    }
    writer.finish()
}
