pub mod ros2;

use prost::Message;
use prost_types::{
    DescriptorProto, EnumDescriptorProto, EnumValueDescriptorProto, FieldDescriptorProto,
    FileDescriptorProto, FileDescriptorSet,
    field_descriptor_proto::{Label, Type},
};
use std::{fs::File, path::Path};

pub const ORIGIN: u64 = 1_760_000_000_123_456_789;
/// How long after its log time each message claims to have been published.
#[allow(dead_code)]
pub const PUBLISH_DELAY_NS: u64 = 5;

#[derive(Clone, PartialEq, Message)]
pub struct Sample {
    #[prost(double, tag = "1")]
    pub signal: f64,
    #[prost(int64, tag = "2")]
    pub counter: i64,
    #[prost(message, optional, tag = "3")]
    pub position: Option<Position>,
    #[prost(string, tag = "4")]
    pub label: String,
    #[prost(bool, tag = "5")]
    pub active: bool,
    #[prost(string, repeated, tag = "6")]
    pub tags: Vec<String>,
    #[prost(enumeration = "Mode", tag = "7")]
    pub mode: i32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
#[repr(i32)]
pub enum Mode {
    Idle = 0,
    Active = 1,
}
#[derive(Clone, PartialEq, Message)]
pub struct Position {
    #[prost(double, tag = "1")]
    pub x: f64,
}

fn field(name: &str, tag: i32, kind: Type, type_name: Option<&str>) -> FieldDescriptorProto {
    FieldDescriptorProto {
        name: Some(name.into()),
        number: Some(tag),
        r#type: Some(kind as i32),
        label: Some(Label::Optional as i32),
        type_name: type_name.map(Into::into),
        ..Default::default()
    }
}

#[allow(dead_code)]
pub fn write_fixture(path: &Path, count: usize, stats: bool) -> anyhow::Result<()> {
    write_fixture_with_options(path, count, stats, None)
}

#[allow(dead_code)]
pub fn write_fixture_with_options(
    path: &Path,
    count: usize,
    stats: bool,
    corrupt_at: Option<usize>,
) -> anyhow::Result<()> {
    write_fixture_at(path, count, stats, corrupt_at, 0)
}

/// Writes the fixture with its timestamps shifted later by `offset_ns`.
pub fn write_fixture_at(
    path: &Path,
    count: usize,
    stats: bool,
    corrupt_at: Option<usize>,
    offset_ns: u64,
) -> anyhow::Result<()> {
    let descriptor = FileDescriptorSet {
        file: vec![FileDescriptorProto {
            name: Some("sample.proto".into()),
            package: Some("hahn".into()),
            syntax: Some("proto3".into()),
            message_type: vec![
                DescriptorProto {
                    name: Some("Sample".into()),
                    field: vec![
                        field("signal", 1, Type::Double, None),
                        field("counter", 2, Type::Int64, None),
                        field("position", 3, Type::Message, Some(".hahn.Position")),
                        field("label", 4, Type::String, None),
                        field("active", 5, Type::Bool, None),
                        FieldDescriptorProto {
                            label: Some(Label::Repeated as i32),
                            ..field("tags", 6, Type::String, None)
                        },
                        field("mode", 7, Type::Enum, Some(".hahn.Mode")),
                    ],
                    ..Default::default()
                },
                DescriptorProto {
                    name: Some("Position".into()),
                    field: vec![field("x", 1, Type::Double, None)],
                    ..Default::default()
                },
            ],
            enum_type: vec![EnumDescriptorProto {
                name: Some("Mode".into()),
                value: vec![
                    EnumValueDescriptorProto {
                        name: Some("IDLE".into()),
                        number: Some(0),
                        ..Default::default()
                    },
                    EnumValueDescriptorProto {
                        name: Some("ACTIVE".into()),
                        number: Some(1),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
    .encode_to_vec();
    let options = mcap::WriteOptions::new()
        .chunk_size(Some(4096))
        .emit_statistics(stats);
    let mut writer = options.create(File::create(path)?)?;
    let schema = writer.add_schema("hahn.Sample", "protobuf", &descriptor)?;
    let channel = writer.add_channel(schema, "/telemetry", "protobuf", &Default::default())?;
    let other = writer.add_channel(schema, "/reference", "protobuf", &Default::default())?;
    for i in 0..count {
        let t = i as f64 / 100.;
        let sample = Sample {
            signal: if i == 9 {
                f64::NAN
            } else {
                (t * 2.).sin() * 12. + (t * 7.).cos() * 2.
            },
            counter: 9_007_199_254_740_993 + i as i64,
            label: "sample".into(),
            active: true,
            tags: vec!["test".into()],
            mode: if i % 2 == 0 {
                Mode::Idle as i32
            } else {
                Mode::Active as i32
            },
            position: if i == 10 {
                None
            } else {
                Some(Position {
                    x: (t * 0.7).cos() * 5.,
                })
            },
        };
        // Deliberate timestamp inversion and duplicate, to exercise plot ordering.
        let index = match i {
            3 => 4,
            4 => 3,
            6 => 5,
            _ => i,
        };
        let time = ORIGIN + offset_ns + index as u64 * 10_000_000;
        let payload = if corrupt_at == Some(i) {
            vec![0xff]
        } else {
            sample.encode_to_vec()
        };
        writer.write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: channel,
                sequence: i as u32,
                log_time: time,
                publish_time: time + PUBLISH_DELAY_NS,
            },
            &payload,
        )?;
        let reference = Sample {
            signal: (t * 1.2).cos() * 7.,
            ..sample
        };
        writer.write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: other,
                sequence: i as u32,
                log_time: time,
                publish_time: time + PUBLISH_DELAY_NS,
            },
            &reference.encode_to_vec(),
        )?;
    }
    writer.finish()?;
    Ok(())
}

#[derive(Clone, PartialEq, Message)]
pub struct CompressedImage {
    #[prost(string, tag = "2")]
    pub frame_id: String,
    #[prost(bytes = "vec", tag = "3")]
    pub data: Vec<u8>,
    #[prost(string, tag = "4")]
    pub format: String,
}
#[derive(Clone, PartialEq, Message)]
pub struct Vector3 {
    #[prost(double, tag = "1")]
    pub x: f64,
    #[prost(double, tag = "2")]
    pub y: f64,
    #[prost(double, tag = "3")]
    pub z: f64,
}
#[derive(Clone, PartialEq, Message)]
pub struct Quaternion {
    #[prost(double, tag = "1")]
    pub x: f64,
    #[prost(double, tag = "2")]
    pub y: f64,
    #[prost(double, tag = "3")]
    pub z: f64,
    #[prost(double, tag = "4")]
    pub w: f64,
}
#[derive(Clone, PartialEq, Message)]
pub struct Pose {
    #[prost(message, optional, tag = "1")]
    pub position: Option<Vector3>,
    #[prost(message, optional, tag = "2")]
    pub orientation: Option<Quaternion>,
}
#[derive(Clone, PartialEq, Message)]
pub struct PackedElementField {
    #[prost(string, tag = "1")]
    pub name: String,
    #[prost(fixed32, tag = "2")]
    pub offset: u32,
    #[prost(int32, tag = "3")]
    pub r#type: i32,
}
#[derive(Clone, PartialEq, Message)]
pub struct PointCloud {
    #[prost(string, tag = "2")]
    pub frame_id: String,
    #[prost(message, optional, tag = "3")]
    pub pose: Option<Pose>,
    #[prost(fixed32, tag = "4")]
    pub point_stride: u32,
    #[prost(message, repeated, tag = "5")]
    pub fields: Vec<PackedElementField>,
    #[prost(bytes = "vec", tag = "6")]
    pub data: Vec<u8>,
}
#[derive(Clone, PartialEq, Message)]
pub struct LocationFix {
    #[prost(string, tag = "6")]
    pub frame_id: String,
    #[prost(double, tag = "2")]
    pub latitude: f64,
    #[prost(double, tag = "3")]
    pub longitude: f64,
    #[prost(double, tag = "4")]
    pub altitude: f64,
    #[prost(double, repeated, tag = "5")]
    pub position_covariance: Vec<f64>,
}
#[derive(Clone, PartialEq, Message)]
pub struct FrameTransform {
    #[prost(string, tag = "2")]
    pub parent_frame_id: String,
    #[prost(string, tag = "3")]
    pub child_frame_id: String,
    #[prost(message, optional, tag = "4")]
    pub translation: Option<Vector3>,
    #[prost(message, optional, tag = "5")]
    pub rotation: Option<Quaternion>,
}

#[derive(Clone, PartialEq, Message)]
pub struct FrameTransforms {
    #[prost(message, repeated, tag = "1")]
    pub transforms: Vec<FrameTransform>,
}

/// A 1x1 PNG, so that an image taken from a response can be opened.
pub const PNG: [u8; 70] = [
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 218, 99, 100, 96, 248, 95, 15, 0, 2,
    135, 1, 128, 235, 71, 186, 146, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];
/// Messages per topic of the visual fixture, 100 ms apart from [`ORIGIN`].
pub const VISUAL_COUNT: usize = 10;
#[allow(dead_code)]
pub const VISUAL_STEP_NS: u64 = 100_000_000;
/// The image without a usable format, to exercise a conversion failing on one message.
#[allow(dead_code)]
pub const BAD_IMAGE: usize = 5;
/// Fields per point of the visual fixture: x, y and z as f32, then an intensity byte.
pub const POINT_STRIDE: u32 = 16;

fn message(name: &str, field: Vec<FieldDescriptorProto>) -> DescriptorProto {
    DescriptorProto {
        name: Some(name.into()),
        field,
        ..Default::default()
    }
}

fn repeated(field: FieldDescriptorProto) -> FieldDescriptorProto {
    FieldDescriptorProto {
        label: Some(Label::Repeated as i32),
        ..field
    }
}

/// Foxglove's schemas, reduced to the fields views read.
fn foxglove_descriptor() -> Vec<u8> {
    let vector = |tag, name| field(name, tag, Type::Double, None);
    let vector3 = vec![vector(1, "x"), vector(2, "y"), vector(3, "z")];
    let quaternion = vec![
        vector(1, "x"),
        vector(2, "y"),
        vector(3, "z"),
        vector(4, "w"),
    ];
    FileDescriptorSet {
        file: vec![FileDescriptorProto {
            name: Some("foxglove.proto".into()),
            package: Some("foxglove".into()),
            syntax: Some("proto3".into()),
            message_type: vec![
                message("Vector3", vector3),
                message("Quaternion", quaternion),
                message(
                    "Pose",
                    vec![
                        field("position", 1, Type::Message, Some(".foxglove.Vector3")),
                        field(
                            "orientation",
                            2,
                            Type::Message,
                            Some(".foxglove.Quaternion"),
                        ),
                    ],
                ),
                message(
                    "CompressedImage",
                    vec![
                        field("frame_id", 2, Type::String, None),
                        field("data", 3, Type::Bytes, None),
                        field("format", 4, Type::String, None),
                    ],
                ),
                message(
                    "PackedElementField",
                    vec![
                        field("name", 1, Type::String, None),
                        field("offset", 2, Type::Fixed32, None),
                        field("type", 3, Type::Enum, Some(".foxglove.NumericType")),
                    ],
                ),
                message(
                    "PointCloud",
                    vec![
                        field("frame_id", 2, Type::String, None),
                        field("pose", 3, Type::Message, Some(".foxglove.Pose")),
                        field("point_stride", 4, Type::Fixed32, None),
                        repeated(field(
                            "fields",
                            5,
                            Type::Message,
                            Some(".foxglove.PackedElementField"),
                        )),
                        field("data", 6, Type::Bytes, None),
                    ],
                ),
                message(
                    "LocationFix",
                    vec![
                        field("frame_id", 6, Type::String, None),
                        field("latitude", 2, Type::Double, None),
                        field("longitude", 3, Type::Double, None),
                        field("altitude", 4, Type::Double, None),
                        repeated(field("position_covariance", 5, Type::Double, None)),
                    ],
                ),
                message(
                    "FrameTransform",
                    vec![
                        field("parent_frame_id", 2, Type::String, None),
                        field("child_frame_id", 3, Type::String, None),
                        field("translation", 4, Type::Message, Some(".foxglove.Vector3")),
                        field("rotation", 5, Type::Message, Some(".foxglove.Quaternion")),
                    ],
                ),
            ],
            enum_type: vec![EnumDescriptorProto {
                name: Some("NumericType".into()),
                value: [
                    ("UNKNOWN", 0),
                    ("UINT8", 1),
                    ("INT8", 2),
                    ("UINT16", 3),
                    ("INT16", 4),
                    ("UINT32", 5),
                    ("INT32", 6),
                    ("FLOAT32", 7),
                    ("FLOAT64", 8),
                ]
                .into_iter()
                .map(|(name, number)| EnumValueDescriptorProto {
                    name: Some(name.into()),
                    number: Some(number),
                    ..Default::default()
                })
                .collect(),
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
    .encode_to_vec()
}

/// A recording of one topic per kind of view, plus transforms: `map` to `base_link`
/// moving 1 m along x per message, and a static `base_link` to `lidar`.
#[allow(dead_code)]
pub fn write_visual_fixture(path: &Path) -> anyhow::Result<()> {
    let descriptor = foxglove_descriptor();
    let mut writer = mcap::WriteOptions::new()
        .chunk_size(Some(4096))
        .emit_statistics(true)
        .create(File::create(path)?)?;
    let mut channel = |schema: &str, topic: &str| -> anyhow::Result<u16> {
        let schema = writer.add_schema(schema, "protobuf", &descriptor)?;
        Ok(writer.add_channel(schema, topic, "protobuf", &Default::default())?)
    };
    let camera = channel("foxglove.CompressedImage", "/camera")?;
    let lidar = channel("foxglove.PointCloud", "/lidar")?;
    let gps = channel("foxglove.LocationFix", "/gps")?;
    let tf = channel("foxglove.FrameTransform", "/tf")?;
    let tf_static = channel("foxglove.FrameTransform", "/tf_static")?;
    let mut write = |channel_id, time: u64, payload: Vec<u8>| {
        writer.write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id,
                sequence: 0,
                log_time: time,
                publish_time: time,
            },
            &payload,
        )
    };
    let identity = || {
        Some(Quaternion {
            w: 1.,
            ..Default::default()
        })
    };
    write(
        tf_static,
        ORIGIN,
        FrameTransform {
            parent_frame_id: "base_link".into(),
            child_frame_id: "lidar".into(),
            translation: Some(Vector3 {
                z: 2.,
                ..Default::default()
            }),
            rotation: identity(),
        }
        .encode_to_vec(),
    )?;
    // Unusable, so it must be ignored: no frame `broken` may appear.
    write(
        tf_static,
        ORIGIN,
        FrameTransform {
            parent_frame_id: "base_link".into(),
            child_frame_id: "broken".into(),
            translation: Some(Vector3 {
                x: f64::NAN,
                ..Default::default()
            }),
            rotation: identity(),
        }
        .encode_to_vec(),
    )?;
    for i in 0..VISUAL_COUNT {
        let time = ORIGIN + i as u64 * VISUAL_STEP_NS;
        write(
            camera,
            time,
            CompressedImage {
                frame_id: "camera".into(),
                data: PNG.to_vec(),
                format: if i == BAD_IMAGE { "bmp" } else { "png" }.into(),
            }
            .encode_to_vec(),
        )?;
        let point = |x: f32, intensity: u8| {
            let mut bytes = Vec::with_capacity(POINT_STRIDE as usize);
            for value in [x, 0., 1.] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes.extend_from_slice(&[intensity, 0, 0, 0]);
            bytes
        };
        let packed = |name: &str, offset, r#type: NumericType| PackedElementField {
            name: name.into(),
            offset,
            r#type: r#type as i32,
        };
        write(
            lidar,
            time,
            PointCloud {
                frame_id: "lidar".into(),
                pose: None,
                point_stride: POINT_STRIDE,
                fields: vec![
                    packed("x", 0, NumericType::Float32),
                    packed("y", 4, NumericType::Float32),
                    packed("z", 8, NumericType::Float32),
                    packed("intensity", 12, NumericType::Uint8),
                ],
                data: [point(i as f32, 1), point(i as f32 + 1., 2)].concat(),
            }
            .encode_to_vec(),
        )?;
        write(
            gps,
            time,
            LocationFix {
                frame_id: "gps".into(),
                latitude: 35.68 + i as f64 * 1e-5,
                longitude: 139.76,
                altitude: 40.,
                position_covariance: vec![4., 0., 0., 0., 9., 0., 0., 0., 1.],
            }
            .encode_to_vec(),
        )?;
        write(
            tf,
            time,
            FrameTransform {
                parent_frame_id: "map".into(),
                child_frame_id: "base_link".into(),
                translation: Some(Vector3 {
                    x: i as f64,
                    ..Default::default()
                }),
                rotation: identity(),
            }
            .encode_to_vec(),
        )?;
    }
    writer.finish()?;
    Ok(())
}

#[allow(dead_code)]
pub fn write_duplicate_images(path: &Path) -> anyhow::Result<()> {
    let mut writer = mcap::Writer::new(File::create(path)?)?;
    let schema = writer.add_schema(
        "foxglove.CompressedImage",
        "protobuf",
        &foxglove_descriptor(),
    )?;
    for id in [50, 51] {
        let channel =
            writer.add_channel_with_id(id, schema, "/camera", "protobuf", &Default::default())?;
        writer.write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: channel,
                sequence: 0,
                log_time: u64::from(id),
                publish_time: u64::from(id),
            },
            &CompressedImage {
                frame_id: format!("camera-{id}"),
                data: PNG.to_vec(),
                format: "png".into(),
            }
            .encode_to_vec(),
        )?;
    }
    writer.finish()?;
    Ok(())
}

#[allow(dead_code)]
pub fn write_batch_tf_fixture(path: &Path) -> anyhow::Result<()> {
    let mut writer = mcap::Writer::new(File::create(path)?)?;
    let mut descriptor = FileDescriptorSet::decode(foxglove_descriptor().as_slice())?;
    descriptor.file[0].message_type.push(message(
        "FrameTransforms",
        vec![repeated(field(
            "transforms",
            1,
            Type::Message,
            Some(".foxglove.FrameTransform"),
        ))],
    ));
    let schema = writer.add_schema(
        "foxglove.FrameTransforms",
        "protobuf",
        &descriptor.encode_to_vec(),
    )?;
    let static_first =
        writer.add_channel_with_id(50, schema, "/tf-static", "protobuf", &Default::default())?;
    let static_channel =
        writer.add_channel_with_id(51, schema, "/tf-static", "protobuf", &Default::default())?;
    writer.add_channel_with_id(52, schema, "/tf-static", "protobuf", &Default::default())?;
    let single_schema = writer.add_schema(
        "foxglove.FrameTransform",
        "protobuf",
        &foxglove_descriptor(),
    )?;
    let single_channel = writer.add_channel_with_id(
        53,
        single_schema,
        "/tf-static",
        "protobuf",
        &Default::default(),
    )?;
    let dynamic_channel = writer.add_channel(schema, "/arm-tf", "protobuf", &Default::default())?;
    let transform = |parent: &str, child: &str, x: f64| FrameTransform {
        parent_frame_id: parent.into(),
        child_frame_id: child.into(),
        translation: Some(Vector3 {
            x,
            ..Default::default()
        }),
        rotation: Some(Quaternion {
            w: 1.,
            ..Default::default()
        }),
    };
    let mut write = |channel_id, time, transforms| {
        writer.write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id,
                sequence: 0,
                log_time: time,
                publish_time: time,
            },
            &FrameTransforms { transforms }.encode_to_vec(),
        )
    };
    write(
        static_first,
        1,
        vec![transform("base", "camera", 2.), transform("", "broken", 0.)],
    )?;
    write(
        static_channel,
        2,
        vec![
            transform("base", "camera", 3.),
            transform("base", "lidar", 4.),
        ],
    )?;
    write(dynamic_channel, 10, vec![transform("map", "base", 10.)])?;
    write(dynamic_channel, 20, vec![transform("map", "base", 20.)])?;
    writer.write_to_known_channel(
        &mcap::records::MessageHeader {
            channel_id: single_channel,
            sequence: 0,
            log_time: 2,
            publish_time: 2,
        },
        &transform("base", "imu", 5.).encode_to_vec(),
    )?;
    writer.finish()?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
enum NumericType {
    Uint8 = 1,
    Float32 = 7,
}

#[derive(Clone, PartialEq, Message)]
struct CameraCalibration {
    #[prost(string, tag = "4")]
    distortion_model: String,
    #[prost(string, tag = "9")]
    frame_id: String,
    #[prost(fixed32, tag = "2")]
    width: u32,
    #[prost(fixed32, tag = "3")]
    height: u32,
    #[prost(double, repeated, tag = "5")]
    d: Vec<f64>,
    #[prost(double, repeated, tag = "6")]
    k: Vec<f64>,
}

#[allow(dead_code)]
pub fn write_camera_calibration(path: &Path) -> anyhow::Result<()> {
    let mut descriptor = FileDescriptorSet::decode(foxglove_descriptor().as_slice())?;
    descriptor.file[0].message_type.push(message(
        "CameraCalibration",
        vec![
            field("frame_id", 9, Type::String, None),
            field("width", 2, Type::Fixed32, None),
            field("height", 3, Type::Fixed32, None),
            field("distortion_model", 4, Type::String, None),
            repeated(field("D", 5, Type::Double, None)),
            repeated(field("K", 6, Type::Double, None)),
        ],
    ));
    let mut writer = mcap::Writer::new(File::create(path)?)?;
    let schema = writer.add_schema(
        "foxglove.CameraCalibration",
        "protobuf",
        &descriptor.encode_to_vec(),
    )?;
    let channel = writer.add_channel(schema, "/calibration", "protobuf", &Default::default())?;
    for (time, k) in [
        (1, vec![400., 0., 320., 0., 400., 240., 0., 0., 1.]),
        (2, vec![0.; 9]),
    ] {
        writer.write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: channel,
                sequence: time as u32,
                log_time: time,
                publish_time: time,
            },
            &CameraCalibration {
                frame_id: "camera".into(),
                distortion_model: "plumb_bob".into(),
                width: 640,
                height: 480,
                d: vec![0.1],
                k,
            }
            .encode_to_vec(),
        )?;
    }
    writer.finish()?;
    Ok(())
}

#[derive(Clone, PartialEq, Message)]
struct RawImage {
    #[prost(string, tag = "7")]
    frame_id: String,
    #[prost(fixed32, tag = "2")]
    width: u32,
    #[prost(fixed32, tag = "3")]
    height: u32,
    #[prost(string, tag = "4")]
    encoding: String,
    #[prost(fixed32, tag = "5")]
    step: u32,
    #[prost(bytes = "vec", tag = "6")]
    data: Vec<u8>,
}

#[allow(dead_code)]
pub fn write_raw_images(path: &Path) -> anyhow::Result<()> {
    let mut descriptor = FileDescriptorSet::decode(foxglove_descriptor().as_slice())?;
    descriptor.file[0].message_type.push(message(
        "RawImage",
        vec![
            field("frame_id", 7, Type::String, None),
            field("width", 2, Type::Fixed32, None),
            field("height", 3, Type::Fixed32, None),
            field("encoding", 4, Type::String, None),
            field("step", 5, Type::Fixed32, None),
            field("data", 6, Type::Bytes, None),
        ],
    ));
    let mut writer = mcap::Writer::new(File::create(path)?)?;
    let schema = writer.add_schema("foxglove.RawImage", "protobuf", &descriptor.encode_to_vec())?;
    let channel = writer.add_channel(schema, "/raw", "protobuf", &Default::default())?;
    for (time, encoding, step, data) in [
        (1, "rgb8", 8, vec![255, 0, 0, 0, 255, 0, 9, 9]),
        (2, "rgb8", 5, vec![0; 5]),
        (3, "unknown", 2, vec![0; 2]),
        (4, "nv12", 2, vec![0; 2]),
    ] {
        writer.write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: channel,
                sequence: time as u32,
                log_time: time,
                publish_time: time,
            },
            &RawImage {
                frame_id: "camera".into(),
                width: 2,
                height: 1,
                encoding: encoding.into(),
                step,
                data,
            }
            .encode_to_vec(),
        )?;
    }
    writer.finish()?;
    Ok(())
}

#[derive(Clone, PartialEq, Message)]
struct Odometry {
    #[prost(string, tag = "2")]
    frame_id: String,
    #[prost(string, tag = "3")]
    body_frame_id: String,
    #[prost(message, optional, tag = "4")]
    pose: Option<Pose>,
}

#[allow(dead_code)]
pub fn write_odometry(path: &Path) -> anyhow::Result<()> {
    let mut descriptor = FileDescriptorSet::decode(foxglove_descriptor().as_slice())?;
    descriptor.file[0].message_type.push(message(
        "Odometry",
        vec![
            field("frame_id", 2, Type::String, None),
            field("body_frame_id", 3, Type::String, None),
            field("pose", 4, Type::Message, Some(".foxglove.Pose")),
        ],
    ));
    let mut writer = mcap::Writer::new(File::create(path)?)?;
    let schema = writer.add_schema("foxglove.Odometry", "protobuf", &descriptor.encode_to_vec())?;
    let channel = writer.add_channel(schema, "/odometry", "protobuf", &Default::default())?;
    for (time, pose) in [
        (
            1,
            Some(Pose {
                position: Some(Vector3 {
                    x: 2.,
                    y: 3.,
                    z: 4.,
                }),
                orientation: Some(Quaternion {
                    x: 0.,
                    y: 0.,
                    z: 0.,
                    w: 2.,
                }),
            }),
        ),
        (2, None),
        (
            3,
            Some(Pose {
                position: Some(Vector3 {
                    x: f64::NAN,
                    y: 0.,
                    z: 0.,
                }),
                orientation: None,
            }),
        ),
        (
            4,
            Some(Pose {
                position: Some(Vector3 {
                    x: 1.,
                    y: 0.,
                    z: 0.,
                }),
                orientation: None,
            }),
        ),
    ] {
        writer.write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: channel,
                sequence: time as u32,
                log_time: time,
                publish_time: time,
            },
            &Odometry {
                frame_id: "map".into(),
                body_frame_id: "robot".into(),
                pose,
            }
            .encode_to_vec(),
        )?;
    }
    let tf_schema = writer.add_schema(
        "foxglove.FrameTransform",
        "protobuf",
        &foxglove_descriptor(),
    )?;
    let tf_channel = writer.add_channel(tf_schema, "/tf", "protobuf", &Default::default())?;
    for (time, x) in [(1, 10.), (5, 30.)] {
        writer.write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: tf_channel,
                sequence: time as u32,
                log_time: time,
                publish_time: time,
            },
            &FrameTransform {
                parent_frame_id: "fixed".into(),
                child_frame_id: "map".into(),
                translation: Some(Vector3 { x, y: 0., z: 0. }),
                rotation: Some(Quaternion {
                    x: 0.,
                    y: 0.,
                    z: 0.,
                    w: 1.,
                }),
            }
            .encode_to_vec(),
        )?;
    }
    writer.finish()?;
    Ok(())
}
