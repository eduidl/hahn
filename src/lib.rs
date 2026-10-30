mod catalog;
mod message;
mod source;
mod stream;
mod view;

use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    middleware::map_response,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use catalog::{Group, Run};
use mcapdecode::core::{DataTypeDef, FieldDefs};
use serde::{Deserialize, Serialize};
use std::{path::Path as FsPath, sync::Arc};
use tower_http::compression::{
    CompressionLayer, CompressionLevel,
    predicate::{DefaultPredicate, NotForContentType, Predicate},
};

#[derive(Clone)]
struct AppState {
    runs: Arc<Vec<Run>>,
}

#[derive(Serialize)]
struct FileEntry {
    id: usize,
    name: String,
    size_bytes: u64,
    format: &'static str,
    #[serde(skip)]
    path: PathBuf,
    #[serde(skip)]
    opener: &'static dyn Format,
    /// Opened on first use; failures are not cached so each request reports them.
    #[serde(skip)]
    source: OnceLock<Arc<dyn Source>>,
}

pub fn router(root: &FsPath) -> anyhow::Result<Router> {
    let root = root.canonicalize()?;
    let mut paths = Vec::new();
    discover(&root, &mut paths)?;
    paths.sort_by(|a, b| a.0.cmp(&b.0));
    let files = paths
        .into_iter()
        .enumerate()
        .map(|(id, (path, opener))| {
            Ok(FileEntry {
                id,
                name: path.strip_prefix(&root)?.to_string_lossy().into_owned(),
                size_bytes: path.metadata()?.len(),
                format: opener.name(),
                path,
                opener,
                source: OnceLock::new(),
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(Router::new()
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
            "/api/runs/{run}/groups/{group}/views/latest",
            get(view::latest),
        )
        .route("/api/runs/{run}/frames", get(view::frames))
        .route("/api/runs/{run}/transforms", get(view::transforms))
        .layer(map_response(json_errors))
        .with_state(AppState {
            runs: Arc::new(runs),
        }))
}

#[derive(Debug)]
struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"error": self.1}))).into_response()
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
    let status = response.status();
    let message = match to_bytes(response.into_body(), usize::MAX).await {
        Ok(body) => String::from_utf8_lossy(&body).into_owned(),
        Err(e) => e.to_string(),
    };
    ApiError(status, message).into_response()
}
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self(StatusCode::UNPROCESSABLE_ENTITY, error.to_string())
    }
}
impl AppState {
    fn run(&self, run: &str) -> Result<&Run, ApiError> {
        self.runs
            .iter()
            .find(|r| r.id == run)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Run not found".into()))
    }

    fn group(&self, run: &str, group: &str) -> Result<Arc<Group>, ApiError> {
        self.run(run)?
            .groups
            .iter()
            .find(|g| g.id == group)
            .cloned()
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Group not found".into()))
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
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("Limit must be between 1 and {MAX_RUNS}"),
        ));
    }
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
            start_ns: info.start_ns.to_string(),
            end_ns: info.end_ns.to_string(),
            message_count: info.message_count,
        })
    })
    .await
    .map(Json)
}

#[derive(Serialize)]
struct RecordingInfo {
    start_ns: String,
    /// Last message timestamp, inclusive.
    end_ns: String,
    message_count: Option<u64>,
}

#[derive(Serialize)]
struct Topic {
    topic: String,
    schema_name: Option<String>,
    /// Lets the client name types in the schema's own language (ROS 2, protobuf, ...).
    schema_encoding: Option<String>,
    message_count: Option<u64>,
    fields: Vec<FieldInfo>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    type_name: Option<String>,
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
    value: i64,
}

fn enum_values(data_type: &DataTypeDef) -> Option<Vec<EnumValue>> {
    match data_type {
        DataTypeDef::Enum(values) => Some(
            values
                .variants
                .iter()
                .map(|value| EnumValue {
                    name: value.name.clone(),
                    value: value.value,
                })
                .collect(),
        ),
        _ => None,
    }
}

fn schema_fields(defs: &FieldDefs, prefix: &[String], out: &mut Vec<FieldInfo>) {
    for field in defs.iter() {
        let mut path = prefix.to_vec();
        path.push(field.name.clone());
        out.push(FieldInfo {
            path: path.clone(),
            data_type: field.element.data_type.type_name().into(),
            type_name: Some(field.element.data_type.to_string()),
            enum_values: enum_values(&field.element.data_type),
        });
        if let DataTypeDef::Struct(children) = &field.element.data_type {
            schema_fields(&children.fields, &path, out);
        }
    }
}

/// Scalar fields the `/series` stream can return: numbers, bools, enums and strings.
fn series_fields(defs: &FieldDefs, prefix: &[String], out: &mut Vec<FieldInfo>) {
    for field in defs.iter() {
        let mut path = prefix.to_vec();
        path.push(field.name.clone());
        match &field.element.data_type {
            DataTypeDef::Struct(children) => series_fields(&children.fields, &path, out),
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
            | DataTypeDef::BoundedWString(_) => out.push(FieldInfo {
                path,
                data_type: field.element.data_type.type_name().into(),
                type_name: None,
                enum_values: enum_values(&field.element.data_type),
            }),
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
        let topics = state.source(id)?.topics()?;
        Ok(topics
            .into_iter()
            .map(|meta| {
                let mut fields = Vec::new();
                let error = match meta.fields {
                    Ok(defs) => {
                        schema_fields(&defs, &[], &mut fields);
                        None
                    }
                    Err(e) => Some(e),
                };
                Topic {
                    topic: meta.topic,
                    schema_name: meta.schema_name,
                    schema_encoding: meta.schema_encoding,
                    message_count: meta.message_count,
                    fields,
                    error,
                }
            })
            .collect())
    })
    .await
    .map(Json)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(Into::into)
}
