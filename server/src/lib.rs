//! Hahn's server: runs and groups of recordings over HTTP, for the Hahn client.
//!
//! An application that records its own message types builds its own server with
//! [`Builder`], adding a [`ViewConverter`] for each type it wants shown as an image,
//! point cloud, pose, map location or camera calibration, and a [`TransformReader`]
//! for each type that holds coordinate frames. A [`Format`] adds a kind of recording
//! file other than MCAP. [`cli::main`] gives that
//! server the same command line as Hahn's.

mod catalog;
pub mod cli;
mod error;
mod message;
mod source;
mod stream;
mod view;

pub use mcapdecode::{DataTypeDef, ElementDef, EnumDef, EnumVariant, FieldDef, FieldDefs, Value};
pub use source::{
    BatchVisit, Format, MessageTimes, Source, SourceInfo, TimeRange, TopicMeta, Visit,
};
pub use view::{
    Annotation, AnnotationsView, Box3, BoxesView, CameraCalibrationView, GeoFeature,
    GeoLocationView, GeoView, ImageView, Kind, Message, NumericType, PackedField, PathView,
    PointCloudView, PointField, Pose, PoseView, PosesView, PositionView, RawImageView, Shape,
    TransformReader, TransformSample, View, ViewConverter, schema,
};

use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Path, Query, State},
    http::header,
    middleware::map_response,
    response::{IntoResponse, Response},
    routing::get,
};
use catalog::{Group, Run};
use error::{ApiError, Code};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};
use tower_http::compression::{
    CompressionLayer, CompressionLevel,
    predicate::{DefaultPredicate, NotForContentType, Predicate},
};

/// Runs returned when a request sets no limit.
const DEFAULT_RUNS: usize = 50;
const MAX_RUNS: usize = 200;

#[derive(Clone)]
struct AppState {
    runs: Arc<Vec<Run>>,
    converters: Arc<Vec<Arc<dyn ViewConverter>>>,
    transforms: Arc<Vec<Arc<dyn TransformReader>>>,
}

/// Compresses API responses at the fastest level, which beats higher ones once their
/// compression time counts; on a fast link, compressing at all costs more than it saves.
/// View frames are left alone: they hold compressed images and dense binary.
pub fn gzip(router: Router) -> Router {
    let predicate = DefaultPredicate::new().and(NotForContentType::const_new(view::CONTENT_TYPE));
    router.layer(
        CompressionLayer::new()
            .quality(CompressionLevel::Fastest)
            .compress_when(predicate),
    )
}

pub fn router(root: &FsPath) -> anyhow::Result<Router> {
    Builder::new(root).router()
}

/// `timezone` is the IANA name to declare for every run.
pub fn router_with_timezone(root: &FsPath, timezone: Option<String>) -> anyhow::Result<Router> {
    Builder::new(root).timezone(timezone).router()
}

/// Sets up a server: where its recordings are, and what it can convert them to.
pub struct Builder {
    data_dir: PathBuf,
    timezone: Option<String>,
    views: Vec<Arc<dyn ViewConverter>>,
    transforms: Vec<Arc<dyn TransformReader>>,
    formats: Vec<Arc<dyn source::Format>>,
}

impl Builder {
    /// Serves the recordings in `data_dir`, read once when the router is built.
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            timezone: None,
            views: Vec::new(),
            transforms: Vec::new(),
            formats: Vec::new(),
        }
    }

    /// The IANA name of where the runs took place, such as `Asia/Tokyo`, declared for
    /// every run.
    pub fn timezone(mut self, timezone: Option<String>) -> Self {
        self.timezone = timezone;
        self
    }

    /// Adds a converter after the built-in ones. Its ID must differ from theirs and
    /// from those added before; building the router fails otherwise.
    pub fn view(mut self, converter: impl ViewConverter + 'static) -> Self {
        self.views.push(Arc::new(converter));
        self
    }

    /// Adds a reader of transforms. A topic is read by the first reader that accepts
    /// it, trying the built-in ones first.
    pub fn transforms(mut self, reader: impl TransformReader + 'static) -> Self {
        self.transforms.push(Arc::new(reader));
        self
    }

    /// Adds a file format. Each file is opened by the first format that accepts it,
    /// trying the added ones before the built-in MCAP format.
    pub fn format(mut self, format: impl Format + 'static) -> Self {
        self.formats.push(Arc::new(format));
        self
    }

    /// The API, under `/api`.
    pub fn router(self) -> anyhow::Result<Router> {
        Ok(self.build()?.0)
    }

    /// The API and every converter it offers, built in or added.
    fn build(self) -> anyhow::Result<(Router, Vec<view::ViewInfo>)> {
        let converters = Arc::new(view::converters(self.views)?);
        let infos = converters
            .iter()
            .map(|converter| view::ViewInfo::of(&**converter))
            .collect();
        let runs = catalog::discover(
            &self.data_dir.canonicalize()?,
            self.timezone,
            &source::formats(self.formats),
        )?;
        let router = Router::new()
            .route("/api/runs", get(runs_list))
            .route("/api/runs/{run}", get(run_detail))
            .route("/api/runs/{run}/groups/{group}", get(info))
            .route("/api/runs/{run}/groups/{group}/topics", get(topics))
            .route(
                "/api/runs/{run}/groups/{group}/messages",
                get(message::messages),
            )
            .route(
                "/api/runs/{run}/groups/{group}/messages/latest",
                get(message::latest),
            )
            .route("/api/runs/{run}/groups/{group}/views", get(view::views))
            .route(
                "/api/runs/{run}/groups/{group}/views/batch",
                axum::routing::post(view::batch_views),
            )
            .route(
                "/api/runs/{run}/groups/{group}/views/latest",
                get(view::latest),
            )
            .route("/api/runs/{run}/frames", get(view::frames))
            .route(
                "/api/runs/{run}/transforms/static",
                get(view::static_transforms),
            )
            .route(
                "/api/runs/{run}/transforms/dynamic",
                get(view::dynamic_transforms),
            )
            .layer(map_response(json_errors))
            .with_state(AppState {
                runs: Arc::new(runs),
                converters,
                transforms: Arc::new(view::readers(self.transforms)),
            });
        Ok((router, infos))
    }
}

/// Extractor rejections are plain text; the API reports every error as JSON.
async fn json_errors(response: Response) -> Response {
    let plain = response
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|value| value.as_bytes().starts_with(b"text/plain"));
    if response.status().is_success() || !plain {
        return response;
    }
    let code = if response.status().is_client_error() {
        Code::InvalidRequest
    } else {
        Code::InternalError
    };
    let message = match to_bytes(response.into_body(), usize::MAX).await {
        Ok(body) => String::from_utf8_lossy(&body).into_owned(),
        Err(e) => e.to_string(),
    };
    ApiError::new(code, message).into_response()
}
impl AppState {
    fn run(&self, run: &str) -> Result<&Run, ApiError> {
        self.runs
            .iter()
            .find(|r| r.id == run)
            .ok_or_else(|| ApiError::new(Code::RunNotFound, "Run not found"))
    }

    fn group(&self, run: &str, group: &str) -> Result<Arc<Group>, ApiError> {
        self.run(run)?
            .groups
            .iter()
            .find(|g| g.id == group)
            .cloned()
            .ok_or_else(|| ApiError::new(Code::GroupNotFound, "Group not found"))
    }
}

#[derive(Serialize)]
struct RunSummary<'a> {
    id: &'a str,
    name: &'a str,
}

#[derive(Deserialize)]
struct RunsQuery {
    q: Option<String>,
    limit: Option<usize>,
}

#[derive(Serialize)]
struct RunList<'a> {
    items: Vec<RunSummary<'a>>,
    truncated: bool,
}

async fn runs_list(
    State(state): State<AppState>,
    Query(query): Query<RunsQuery>,
) -> Result<Response, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_RUNS);
    if !(1..=MAX_RUNS).contains(&limit) {
        return Err(ApiError::new(
            Code::InvalidRequest,
            format!("Limit must be between 1 and {MAX_RUNS}"),
        ));
    }
    let needle = query.q.unwrap_or_default().to_lowercase();
    let mut matches = state
        .runs
        .iter()
        .filter(|r| r.name.to_lowercase().contains(&needle));
    let items: Vec<_> = matches
        .by_ref()
        .take(limit)
        .map(|r| RunSummary {
            id: &r.id,
            name: &r.name,
        })
        .collect();
    let truncated = matches.next().is_some();
    Ok(Json(RunList { items, truncated }).into_response())
}

async fn run_detail(
    State(state): State<AppState>,
    Path(run): Path<String>,
) -> Result<Response, ApiError> {
    Ok(Json(state.run(&run)?).into_response())
}

async fn info(
    State(state): State<AppState>,
    Path((run, group)): Path<(String, String)>,
) -> Result<Json<RecordingInfo>, ApiError> {
    let group = state.group(&run, &group)?;
    blocking(move || {
        let info = group.source()?.info()?;
        Ok(RecordingInfo {
            start_ns: info.time_range.map(|(start, _)| start.to_string()),
            end_ns: info.time_range.map(|(_, end)| end.to_string()),
            message_count: info.message_count,
        })
    })
    .await
    .map(Json)
}

#[derive(Serialize)]
struct RecordingInfo {
    /// Omitted for a group without messages, like `end_ns`.
    #[serde(skip_serializing_if = "Option::is_none")]
    start_ns: Option<String>,
    /// Last message timestamp, inclusive.
    #[serde(skip_serializing_if = "Option::is_none")]
    end_ns: Option<String>,
    message_count: Option<u64>,
}

#[derive(Serialize)]
struct Topic {
    id: String,
    topic: String,
    schema_name: Option<String>,
    /// Lets the client name types in the schema's own language (ROS 2, protobuf, ...).
    schema_encoding: Option<String>,
    message_count: Option<u64>,
    fields: Vec<FieldInfo>,
    meta_fields: Vec<FieldInfo>,
    /// The fixed kinds this topic can be converted to.
    views: Vec<view::ViewInfo>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
struct FieldInfo {
    name: String,
    #[serde(flatten)]
    field_type: FieldType,
}

#[derive(Clone, Serialize)]
struct FieldType {
    data_type: String,
    type_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    enum_values: Option<Vec<EnumValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fields: Option<Vec<FieldInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    element: Option<Box<FieldType>>,
}

#[derive(Clone, Serialize)]
struct EnumValue {
    name: String,
    /// A string like other 64-bit integers.
    value: String,
}

fn enum_values(data_type: &DataTypeDef) -> Option<Vec<EnumValue>> {
    match data_type {
        DataTypeDef::Enum(values) => Some(
            values
                .variants
                .iter()
                .map(|value| EnumValue {
                    name: value.name.clone(),
                    value: value.value.to_string(),
                })
                .collect(),
        ),
        _ => None,
    }
}

fn schema_fields(defs: &FieldDefs) -> Vec<FieldInfo> {
    defs.iter()
        .map(|field| FieldInfo {
            name: field.name.clone(),
            field_type: field_type(&field.element.data_type),
        })
        .collect()
}

/// A JSON text topic's fields: its one string field is declared as a JSON document.
fn json_text_fields(defs: &FieldDefs) -> Vec<FieldInfo> {
    let mut fields = schema_fields(defs);
    for field in &mut fields {
        field.field_type.data_type = "json".into();
        field.field_type.type_name = "json".into();
    }
    fields
}

fn field_type(data_type: &DataTypeDef) -> FieldType {
    FieldType {
        data_type: data_type.type_name().into(),
        type_name: data_type.to_string(),
        enum_values: enum_values(data_type),
        fields: match data_type {
            DataTypeDef::Struct(children) => Some(schema_fields(&children.fields)),
            _ => None,
        },
        element: match data_type {
            DataTypeDef::List(element)
            | DataTypeDef::BoundedList(element, _)
            | DataTypeDef::Array(element, _) => Some(Box::new(field_type(&element.data_type))),
            DataTypeDef::Uint8List | DataTypeDef::BoundedUint8List(_) => {
                Some(Box::new(field_type(&DataTypeDef::U8)))
            }
            _ => None,
        },
    }
}

/// Paths of the fields exact `/messages` can return: numbers, bools, enums and strings.
fn scalar_fields(defs: &FieldDefs, prefix: &[String], out: &mut Vec<Vec<String>>) {
    for field in defs.iter() {
        let mut path = prefix.to_vec();
        path.push(field.name.clone());
        match &field.element.data_type {
            DataTypeDef::Struct(children) => scalar_fields(&children.fields, &path, out),
            DataTypeDef::I8
            | DataTypeDef::I16
            | DataTypeDef::I32
            | DataTypeDef::I64
            | DataTypeDef::U8
            | DataTypeDef::U16
            | DataTypeDef::U32
            | DataTypeDef::U64
            | DataTypeDef::F32
            | DataTypeDef::F64
            | DataTypeDef::Bool
            | DataTypeDef::Enum(_)
            | DataTypeDef::String
            | DataTypeDef::BoundedString(_)
            | DataTypeDef::WString
            | DataTypeDef::BoundedWString(_) => out.push(path),
            _ => {}
        }
    }
}

async fn topics(
    State(state): State<AppState>,
    Path((run, group)): Path<(String, String)>,
) -> Result<Json<Vec<Topic>>, ApiError> {
    let group = state.group(&run, &group)?;
    blocking(move || {
        let source = group.source()?;
        let meta_fields: Vec<_> = source
            .meta_fields()
            .iter()
            .map(|name| FieldInfo {
                name: (*name).into(),
                field_type: field_type(&DataTypeDef::U64),
            })
            .collect();
        let topics = source.topics()?;
        let mut topics = topics
            .into_iter()
            .map(|meta| {
                // Only this encoding can be JSON text; the check reads the channel list.
                let json_text = meta.schema_encoding.as_deref() == Some("jsonschema")
                    && source.is_json_text(&meta.id)?;
                let (fields, meta_fields, views, error) = match meta.fields {
                    Ok(defs) => (
                        if json_text {
                            json_text_fields(&defs)
                        } else {
                            schema_fields(&defs)
                        },
                        meta_fields.clone(),
                        view::declared(meta.schema_name.as_deref(), &defs, &state.converters),
                        None,
                    ),
                    Err(e) => (Vec::new(), Vec::new(), Vec::new(), Some(e)),
                };
                Ok(Topic {
                    id: meta.id,
                    topic: meta.topic,
                    schema_name: meta.schema_name,
                    schema_encoding: meta.schema_encoding,
                    message_count: meta.message_count,
                    fields,
                    meta_fields,
                    views,
                    error,
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let mut views: Vec<_> = topics
            .iter_mut()
            .map(|t| (t.id.clone(), t.topic.clone(), std::mem::take(&mut t.views)))
            .collect();
        view::suggest_calibrations(&mut views);
        for (topic, (_, _, views)) in topics.iter_mut().zip(views) {
            topic.views = views;
        }
        Ok(topics)
    })
    .await
    .map(Json)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| ApiError::new(Code::InternalError, e.to_string()))?
        .map_err(Into::into)
}
