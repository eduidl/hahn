//! A Hahn server that also shows a type of its own, `acme_msgs/msg/Pose2D`, as a pose,
//! and reads another, `acme_msgs/msg/Link2D`, as transforms between frames. It also
//! opens files of a format of its own, `.acmelog`, defined in
//! [`support/acme_log.rs`](support/acme_log.rs).
//!
//! An application's server is a small crate depending on `hahn` with a `main` like
//! this one. It takes the same options as Hahn:
//!
//! ```sh
//! cargo run --example generate_acme -- data/samples/acme/acme.mcap
//! cargo run --example custom_server -- --data-dir data/samples/acme
//! ```

mod support;

use hahn::{
    FieldDefs, Kind, Message, Pose, PoseView, TransformReader, TransformSample, View,
    ViewConverter,
    schema::{has, is_number, is_string},
};

/// `string frame_id`, `float64 x`, `float64 y`, `float64 theta`: a pose on a plane.
struct AcmePose2d;

impl ViewConverter for AcmePose2d {
    fn id(&self) -> &'static str {
        "acme_pose2d"
    }
    fn kind(&self) -> Kind {
        Kind::Pose
    }
    fn name(&self) -> &'static str {
        "Pose"
    }
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "acme_msgs/msg/Pose2D"
            && has(defs, "frame_id", is_string)
            && has(defs, "x", is_number)
            && has(defs, "y", is_number)
            && has(defs, "theta", is_number)
    }
    fn convert(&self, message: &Message) -> anyhow::Result<View> {
        let half = message.number("theta")? / 2.;
        Ok(PoseView {
            frame_id: message.frame_id()?,
            pose: Pose {
                position: [message.number("x")?, message.number("y")?, 0.],
                orientation: [0., 0., half.sin(), half.cos()],
            },
        }
        .into())
    }
}

/// `string parent`, `string child`, `float64 x`, `float64 y`, `float64 theta`: where
/// frame `child` is in frame `parent`, on a plane.
struct AcmeLink2d;

impl TransformReader for AcmeLink2d {
    fn accepts(&self, schema_name: &str, defs: &FieldDefs) -> bool {
        schema_name == "acme_msgs/msg/Link2D"
            && has(defs, "parent", is_string)
            && has(defs, "child", is_string)
            && has(defs, "x", is_number)
            && has(defs, "y", is_number)
            && has(defs, "theta", is_number)
    }
    fn read(&self, message: &Message) -> anyhow::Result<Vec<TransformSample>> {
        let half = message.number("theta")? / 2.;
        Ok(vec![TransformSample {
            parent: message.string("parent")?.to_owned(),
            child: message.string("child")?.to_owned(),
            translation: [message.number("x")?, message.number("y")?, 0.],
            rotation: [0., 0., half.sin(), half.cos()],
            stamp_ns: None,
        }])
    }
}

fn main() -> anyhow::Result<()> {
    hahn::cli::main(|builder| {
        builder
            .view(AcmePose2d)
            .transforms(AcmeLink2d)
            .format(support::acme_log::AcmeLog)
    })
}
