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
                publish_time: time,
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
                publish_time: time,
            },
            &reference.encode_to_vec(),
        )?;
    }
    writer.finish()?;
    Ok(())
}
