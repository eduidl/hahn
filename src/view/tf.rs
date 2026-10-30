#[derive(Serialize)]
struct FrameInfo<'a> {
    id: &'a str,
    parent: Option<&'a str>,
}

#[derive(Serialize)]
struct FrameList<'a> {
    frames: Vec<FrameInfo<'a>>,
}

#[derive(Deserialize)]
pub(crate) struct TransformsQuery {
    target: String,
    time_ns: String,
}

#[derive(Serialize)]
pub(crate) struct Transforms {
    time_ns: String,
    target: String,
    frames: BTreeMap<Arc<str>, Transform>,
}

