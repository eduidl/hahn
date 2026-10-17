use crate::{ApiError, AppState, blocking, stream::indexes};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use mcapdecode::core::{DataTypeDef, FieldDefs, Value};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Elements kept per list or array; the rest is summarized by its length.
const MAX_ITEMS: usize = 100;
/// Leading bytes kept from a byte buffer.
const MAX_BYTES: usize = 32;
/// Characters kept from a string.
const MAX_CHARS: usize = 10_000;

#[derive(Deserialize)]
pub(crate) struct MessageQuery {
    topic: String,
    /// JSON array of struct field names; omit for the whole message.
    path: Option<String>,
    time_ns: String,
}

#[derive(Serialize)]
pub(crate) struct MessageResponse {
    time_ns: String,
    value: serde_json::Value,
}

/// The message current at `time_ns`: the latest one at or before it, or the
/// first one after it when the topic has not published yet.
pub(crate) async fn message(
    State(state): State<AppState>,
    Path(id): Path<usize>,
    Query(query): Query<MessageQuery>,
) -> Result<Json<Option<MessageResponse>>, ApiError> {
    state.check(id)?;
    let time: u64 = query.time_ns.parse().map_err(|_| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "Timestamps must be unsigned nanosecond strings".into(),
        )
    })?;
    let field: Vec<String> = match &query.path {
        Some(path) => serde_json::from_str(path)
            .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "Invalid field path".into()))?,
        None => Vec::new(),
    };
    blocking(move || {
        let source = state.source(id)?;
        let defs = source.field_defs(&query.topic)?;
        let index = if field.is_empty() {
            Vec::new()
        } else {
            indexes(&defs, &field).ok_or_else(|| anyhow::anyhow!("Unknown field: {field:?}"))?
        };
        let data_type = if index.is_empty() {
            DataTypeDef::Struct(defs.clone().into())
        } else {
            field_type(&defs, &index).clone()
        };
        let found = match source.latest_at(&query.topic, time)? {
            Some(found) => Some(found),
            None => source.first_after(&query.topic, time)?,
        };
        Ok(found.map(|(log_time, value)| MessageResponse {
            time_ns: log_time.to_string(),
            value: select(&value, &index)
                .map_or(serde_json::Value::Null, |v| to_json(v, &data_type)),
        }))
    })
    .await
    .map(Json)
}

fn field_type<'a>(defs: &'a FieldDefs, index: &[usize]) -> &'a DataTypeDef {
    let data_type = &defs[index[0]].element.data_type;
    match (&index[1..], data_type) {
        ([], _) => data_type,
        (tail, DataTypeDef::Struct(children)) => field_type(&children.fields, tail),
        _ => data_type,
    }
}

fn select<'a>(value: &'a Value, index: &[usize]) -> Option<&'a Value> {
    index.iter().try_fold(value, |value, &i| match value {
        Value::Struct(values) => values.get(i),
        _ => None,
    })
}

fn items(values: &[Value], element: &DataTypeDef) -> serde_json::Value {
    let shown: Vec<_> = values
        .iter()
        .take(MAX_ITEMS)
        .map(|v| to_json(v, element))
        .collect();
    if values.len() > MAX_ITEMS {
        json!({ "$truncated": true, "length": values.len(), "items": shown })
    } else {
        shown.into()
    }
}

/// JSON for display: named struct fields, exact 64-bit integers as strings,
/// and large lists, byte buffers and strings cut down to a preview.
fn to_json(value: &Value, data_type: &DataTypeDef) -> serde_json::Value {
    let number =
        |v: f64| serde_json::Number::from_f64(v).map_or(serde_json::Value::Null, Into::into);
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Bool(v) => (*v).into(),
        Value::I8(v) => (*v).into(),
        Value::I16(v) => (*v).into(),
        Value::I32(v) => (*v).into(),
        Value::U8(v) => (*v).into(),
        Value::U16(v) => (*v).into(),
        Value::U32(v) => (*v).into(),
        Value::I64(v) => v.to_string().into(),
        Value::U64(v) => v.to_string().into(),
        Value::F32(v) => number(*v as f64),
        Value::F64(v) => number(*v),
        Value::String(v) if v.chars().count() > MAX_CHARS => {
            format!("{}…", v.chars().take(MAX_CHARS).collect::<String>()).into()
        }
        Value::String(v) => v.to_string().into(),
        Value::Bytes(v) => json!({ "$bytes": v.len(), "head": &v[..v.len().min(MAX_BYTES)] }),
        Value::Uint8List(v) if v.len() > MAX_ITEMS => {
            json!({ "$truncated": true, "length": v.len(), "items": &v[..MAX_ITEMS] })
        }
        Value::Uint8List(v) => json!(v.as_ref()),
        Value::Struct(values) => match data_type {
            DataTypeDef::Struct(defs) => defs
                .fields
                .iter()
                .zip(values)
                .map(|(def, v)| (def.name.clone(), to_json(v, &def.element.data_type)))
                .collect::<serde_json::Map<_, _>>()
                .into(),
            _ => items(values, &DataTypeDef::Null),
        },
        Value::List(values) | Value::Array(values) => match data_type {
            DataTypeDef::List(element)
            | DataTypeDef::BoundedList(element, _)
            | DataTypeDef::Array(element, _) => items(values, &element.data_type),
            _ => items(values, &DataTypeDef::Null),
        },
        Value::Map(entries) => {
            let (key, value) = match data_type {
                DataTypeDef::Map { key, value } => (&key.data_type, &value.data_type),
                _ => (&DataTypeDef::Null, &DataTypeDef::Null),
            };
            entries
                .iter()
                .take(MAX_ITEMS)
                .map(|(k, v)| json!([to_json(k, key), to_json(v, value)]))
                .collect::<Vec<_>>()
                .into()
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct MessagesRequest {
    topic: String,
    #[serde(default)]
    path: Vec<String>,
    start_ns: Option<String>,
    end_ns: Option<String>,
}

