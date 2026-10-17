mod recording;
mod stream;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use mcapdecode::{
    McapReader,
    core::{DataTypeDef, FieldDefs},
};
use mcapdecode_ros2_common::{ResolvedSchema, ResolvedType};
use prost::Message;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};

pub use recording::recording_info;

#[derive(Clone)]
struct AppState {
    files: Arc<Vec<FileEntry>>,
}

#[derive(Clone, Serialize)]
struct FileEntry {
    id: usize,
    name: String,
    size_bytes: u64,
    #[serde(skip)]
    path: PathBuf,
}

pub fn router(root: &FsPath) -> anyhow::Result<Router> {
    let root = root.canonicalize()?;
    let mut paths = Vec::new();
    discover(&root, &mut paths)?;
    paths.sort();
    let files = paths
        .into_iter()
        .enumerate()
        .map(|(id, path)| {
            Ok(FileEntry {
                id,
                name: path.strip_prefix(&root)?.to_string_lossy().into_owned(),
                size_bytes: path.metadata()?.len(),
                path,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(Router::new()
        .route("/api/files", get(files_list))
        .route("/api/files/{id}", get(info))
        .route("/api/files/{id}/topics", get(topics))
        .route("/api/files/{id}/series", post(stream::series))
        .with_state(AppState {
            files: Arc::new(files),
        }))
}

fn discover(root: &FsPath, paths: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        // Do not traverse symlinks outside the configured directory.
        if kind.is_dir() {
            discover(&entry.path(), paths)?;
        } else if kind.is_file() && entry.path().extension().is_some_and(|e| e == "mcap") {
            paths.push(entry.path());
        }
    }
    Ok(())
}

fn reader() -> McapReader {
    McapReader::builder()
        .with_default_decoders()
        .with_parallel(false)
        .build()
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
    fn file(&self, id: usize) -> Result<PathBuf, ApiError> {
        self.files
            .get(id)
            .map(|f| f.path.clone())
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Recording not found".into()))
    }
}

async fn files_list(State(state): State<AppState>) -> Json<Vec<FileEntry>> {
    Json((*state.files).clone())
}

async fn info(
    State(state): State<AppState>,
    Path(id): Path<usize>,
) -> Result<Json<recording::RecordingInfo>, ApiError> {
    let path = state.file(id)?;
    blocking(move || recording_info(&path)).await.map(Json)
}

#[derive(Clone, Serialize)]
struct FieldInfo {
    /// Field-name segments, rather than ambiguous dot-separated identifiers.
    path: Vec<String>,
    data_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    type_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enum_values: Option<Vec<EnumValue>>,
}

fn resolved_type_name(ty: &ResolvedType) -> Option<String> {
    match ty {
        ResolvedType::Struct(name) | ResolvedType::Enum(name) => Some(name.join("/")),
        ResolvedType::Sequence { elem, max_len } => {
            let name = resolved_type_name(elem)?;
            Some(match max_len {
                Some(size) => format!("{name}[<={size}]"),
                None => format!("{name}[]"),
            })
        }
        _ => None,
    }
}

fn resolved_struct_type_names(
    schema: &ResolvedSchema,
    owner: &[String],
    prefix: &[String],
    names: &mut HashMap<Vec<String>, String>,
) {
    let Some(definition) = schema.structs.get(owner) else {
        return;
    };
    for field in &definition.fields {
        let mut path = prefix.to_vec();
        path.push(field.name.clone());
        if let Some(name) = resolved_type_name(&field.ty) {
            names.insert(path.clone(), name);
        }
        if let ResolvedType::Struct(child) = &field.ty {
            resolved_struct_type_names(schema, child, &path, names);
        }
    }
}

fn protobuf_type_names(
    schema_name: &str,
    data: &[u8],
) -> anyhow::Result<HashMap<Vec<String>, String>> {
    use prost_types::{
        DescriptorProto,
        field_descriptor_proto::{Label, Type},
    };

    fn collect_messages<'a>(
        messages: &'a [DescriptorProto],
        prefix: &[String],
        out: &mut HashMap<String, &'a DescriptorProto>,
    ) {
        for message in messages {
            let Some(name) = message.name.as_ref() else {
                continue;
            };
            let mut path = prefix.to_vec();
            path.push(name.clone());
            out.insert(path.join("."), message);
            collect_messages(&message.nested_type, &path, out);
        }
    }

    fn visit_message(
        message: &DescriptorProto,
        full_names: &HashMap<String, &DescriptorProto>,
        prefix: &[String],
        names: &mut HashMap<Vec<String>, String>,
    ) {
        for field in &message.field {
            let Some(field_name) = field.name.as_ref() else {
                continue;
            };
            let mut path = prefix.to_vec();
            path.push(field_name.clone());
            let kind = Type::try_from(field.r#type.unwrap_or_default()).ok();
            if matches!(kind, Some(Type::Message | Type::Enum | Type::Group))
                && let Some(type_name) = field.type_name.as_deref()
            {
                let qualified = type_name.trim_start_matches('.').to_string();
                let repeated = field.label == Some(Label::Repeated as i32);
                names.insert(
                    path.clone(),
                    if repeated {
                        format!("{qualified}[]")
                    } else {
                        qualified.clone()
                    },
                );
                if kind == Some(Type::Message)
                    && let Some(child) = full_names.get(&qualified)
                {
                    visit_message(child, full_names, &path, names);
                }
            }
        }
    }

    let descriptor = prost_types::FileDescriptorSet::decode(data)?;
    let mut messages = HashMap::new();
    for file in &descriptor.file {
        let package = file.package.as_deref().unwrap_or("");
        let prefix: Vec<String> = package
            .split('.')
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect();
        collect_messages(&file.message_type, &prefix, &mut messages);
    }
    let root = messages
        .get(schema_name)
        .or_else(|| {
            messages
                .iter()
                .find(|(name, _)| name.ends_with(&format!(".{schema_name}")))
                .map(|(_, msg)| msg)
        })
        .copied();
    let mut names = HashMap::new();
    if let Some(root) = root {
        visit_message(root, &messages, &[], &mut names);
    }
    Ok(names)
}

fn schema_type_names(
    schema_name: &str,
    encoding: &str,
    data: &[u8],
) -> anyhow::Result<HashMap<Vec<String>, String>> {
    match encoding {
        "ros2idl" => {
            let schema =
                mcapdecode_ros2idl::resolve_schema(schema_name, &String::from_utf8_lossy(data))?;
            let mut names = HashMap::new();
            resolved_struct_type_names(&schema, &schema.root, &[], &mut names);
            Ok(names)
        }
        "ros2msg" => {
            let schema =
                mcapdecode_ros2msg::resolve_schema(schema_name, &String::from_utf8_lossy(data))?;
            let mut names = HashMap::new();
            resolved_struct_type_names(&schema, &schema.root, &[], &mut names);
            Ok(names)
        }
        "protobuf" => protobuf_type_names(schema_name, data),
        _ => Ok(HashMap::new()),
    }
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

fn schema_fields(
    defs: &FieldDefs,
    prefix: &[String],
    type_names: &HashMap<Vec<String>, String>,
    out: &mut Vec<FieldInfo>,
) {
    for field in defs.iter() {
        let mut path = prefix.to_vec();
        path.push(field.name.clone());
        out.push(FieldInfo {
            path: path.clone(),
            data_type: field.element.data_type.to_string(),
            type_name: type_names.get(&path).cloned(),
            enum_values: enum_values(&field.element.data_type),
        });
        if let DataTypeDef::Struct(children) = &field.element.data_type {
            schema_fields(children, &path, type_names, out);
        }
    }
}

fn numeric_fields(defs: &FieldDefs, prefix: &[String], out: &mut Vec<FieldInfo>) {
    for field in defs.iter() {
        let mut path = prefix.to_vec();
        path.push(field.name.clone());
        match &field.element.data_type {
            DataTypeDef::Struct(children) => numeric_fields(children, &path, out),
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
            | DataTypeDef::Enum(_) => out.push(FieldInfo {
                path,
                data_type: field.element.data_type.type_name().into(),
                type_name: None,
                enum_values: enum_values(&field.element.data_type),
            }),
            _ => {}
        }
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(Into::into)
}
