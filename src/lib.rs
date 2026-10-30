mod message;
mod source;
mod stream;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use mcapdecode::core::{DataTypeDef, FieldDefs};
use serde::Serialize;
use source::{Format, Source};
use std::{
    path::{Path as FsPath, PathBuf},
    sync::{Arc, OnceLock},
};

#[derive(Clone)]
struct AppState {
    files: Arc<Vec<FileEntry>>,
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
        .route("/api/files", get(files_list))
        .route("/api/files/{id}", get(info))
        .route("/api/files/{id}/topics", get(topics))
        .route("/api/files/{id}/series", post(stream::series))
        .route("/api/files/{id}/messages", post(message::messages))
        .route("/api/files/{id}/message", get(message::message))
        .with_state(AppState {
            files: Arc::new(files),
        }))
}

fn discover(root: &FsPath, paths: &mut Vec<(PathBuf, &'static dyn Format)>) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        // Do not traverse symlinks outside the configured directory.
        if kind.is_dir() {
            discover(&entry.path(), paths)?;
        } else if kind.is_file()
            && let Some(format) = source::formats().iter().find(|f| f.accepts(&entry.path()))
        {
            paths.push((entry.path(), *format));
        }
    }
    Ok(())
}

#[derive(Debug)]
struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"error": self.1}))).into_response()
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self(StatusCode::UNPROCESSABLE_ENTITY, error.to_string())
    }
}
impl AppState {
    /// Opens the recording on first use. Blocks, so call it inside [`blocking`].
    fn source(&self, id: usize) -> anyhow::Result<Arc<dyn Source>> {
        let file = &self.files[id];
        if let Some(source) = file.source.get() {
            return Ok(source.clone());
        }
        let source = file.opener.open(&file.path)?;
        Ok(file.source.get_or_init(|| source).clone())
    }

    fn check(&self, id: usize) -> Result<(), ApiError> {
        if id < self.files.len() {
            Ok(())
        } else {
            Err(ApiError(
                StatusCode::NOT_FOUND,
                "Recording not found".into(),
            ))
        }
    }
}

async fn files_list(State(state): State<AppState>) -> Response {
    Json(&*state.files).into_response()
}

async fn info(
    State(state): State<AppState>,
    Path(id): Path<usize>,
) -> Result<Json<RecordingInfo>, ApiError> {
    state.check(id)?;
    blocking(move || {
        let info = state.source(id)?.info()?;
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
    Path(id): Path<usize>,
) -> Result<Json<Vec<Topic>>, ApiError> {
    state.check(id)?;
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
