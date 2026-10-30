use crate::{
    ApiError, AppState, blocking, scalar_fields,
    source::{MessageTimes, Source, TimeRange},
    stream::{indexes, scalar, stream_rows},
};
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
    /// A name from the topic\'s `meta_fields`, to read instead of the message.
    meta: Option<String>,
    time_ns: String,
}

#[derive(Serialize)]
pub(crate) struct MessageResponse {
    time_ns: String,
    value: serde_json::Value,
}

/// The latest message at or before `time_ns`, if the topic has published by then.
pub(crate) async fn latest(
    State(state): State<AppState>,
    Path((run, group)): Path<(String, String)>,
    Query(query): Query<MessageQuery>,
) -> Result<Json<Option<MessageResponse>>, ApiError> {
    let group = state.group(&run, &group)?;
    let time = parse_time(&query.time_ns)?;
    let field = parse_field(&query.path, &query.meta)?;
    blocking(move || {
        let source = group.source()?;
        let defs = source.field_defs(&query.topic)?;
        check_meta(&*source, &query.meta)?;
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
        Ok(source
            .latest_at(&query.topic, time)?
            .map(|(times, value)| MessageResponse {
                time_ns: times.log_time.to_string(),
                value: match &query.meta {
                    Some(name) => meta_value(name, times),
                    None => select(&value, &index)
                        .map_or(serde_json::Value::Null, |v| to_json(v, &data_type)),
                },
            }))
    })
    .await
    .map(Json)
}

pub(crate) fn parse_time(value: &str) -> Result<u64, ApiError> {
    value.parse().map_err(|_| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "Timestamps must be unsigned nanosecond strings".into(),
        )
    })
}

pub(crate) fn parse_range(
    start: &Option<String>,
    end: &Option<String>,
) -> Result<TimeRange, ApiError> {
    let start = start.as_deref().map(parse_time).transpose()?;
    let end = end.as_deref().map(parse_time).transpose()?;
    if matches!((start, end), (Some(start), Some(end)) if start > end) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Start must not exceed end".into(),
        ));
    }
    Ok(TimeRange { start, end })
}

fn parse_field(path: &Option<String>, meta: &Option<String>) -> Result<Vec<String>, ApiError> {
    if path.is_some() && meta.is_some() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Path and meta cannot be combined".into(),
        ));
    }
    match path {
        Some(path) => serde_json::from_str(path)
            .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "Invalid field path".into())),
        None => Ok(Vec::new()),
    }
}

fn check_meta(source: &dyn Source, meta: &Option<String>) -> anyhow::Result<()> {
    if let Some(name) = meta {
        anyhow::ensure!(
            source.meta_fields().contains(&name.as_str()),
            "Unknown meta field: {name}"
        );
    }
    Ok(())
}

/// Exact like any 64-bit integer, so a string.
fn meta_value(name: &str, times: MessageTimes) -> serde_json::Value {
    let time = match name {
        "log_time" => Some(times.log_time),
        "publish_time" => times.publish_time,
        _ => None,
    };
    time.map_or(serde_json::Value::Null, |time| time.to_string().into())
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

/// Keeps the first items of a long list or map; the rest is summarized by its length.
fn preview(length: usize, shown: Vec<serde_json::Value>) -> serde_json::Value {
    if length > MAX_ITEMS {
        json!({ "$truncated": true, "length": length, "items": shown })
    } else {
        shown.into()
    }
}

fn items(values: &[Value], element: &DataTypeDef) -> serde_json::Value {
    let shown = values
        .iter()
        .take(MAX_ITEMS)
        .map(|v| to_json(v, element))
        .collect();
    preview(values.len(), shown)
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
            let shown = entries
                .iter()
                .take(MAX_ITEMS)
                .map(|(k, v)| json!([to_json(k, key), to_json(v, value)]))
                .collect();
            preview(entries.len(), shown)
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct MessagesQuery {
    topic: String,
    /// JSON array of struct field names; omit for the whole message.
    path: Option<String>,
    /// A name from the topic's `meta_fields`, to read instead of the message.
    meta: Option<String>,
    start_ns: Option<String>,
    /// Exclusive upper bound. Omit to include the last timestamp of a recording.
    end_ns: Option<String>,
    /// `false` returns exact values of a scalar field.
    preview: Option<bool>,
}

/// Messages in the requested range and subtree, retaining message boundaries and ties.
pub(crate) async fn messages(
    State(state): State<AppState>,
    Path((run, group)): Path<(String, String)>,
    Query(query): Query<MessagesQuery>,
) -> Result<axum::response::Response, ApiError> {
    let group = state.group(&run, &group)?;
    let range = parse_range(&query.start_ns, &query.end_ns)?;
    let field = parse_field(&query.path, &query.meta)?;
    let meta = query.meta;
    let preview = query.preview.unwrap_or(true) || meta.is_some();
    let topic = query.topic.clone();
    let checked = meta.clone();
    let (source, index, data_type) = blocking(move || {
        let source = group.source()?;
        let defs = source.field_defs(&topic)?;
        check_meta(&*source, &checked)?;
        if !preview {
            let mut scalars = Vec::new();
            scalar_fields(&defs, &[], &mut scalars);
            anyhow::ensure!(scalars.contains(&field), "Unknown scalar field: {field:?}");
        }
        let index = if field.is_empty() {
            Vec::new()
        } else {
            indexes(&defs, &field).ok_or_else(|| anyhow::anyhow!("Unknown field: {field:?}"))?
        };
        let data_type = if index.is_empty() {
            DataTypeDef::Struct(defs.into())
        } else {
            field_type(&defs, &index).clone()
        };
        Ok((source, index, data_type))
    })
    .await?;
    Ok(stream_rows(
        source,
        query.topic,
        range,
        move |times, value| MessageResponse {
            time_ns: times.log_time.to_string(),
            value: match &meta {
                Some(name) => meta_value(name, times),
                None if preview => select(&value, &index)
                    .map_or(serde_json::Value::Null, |v| to_json(v, &data_type)),
                None => scalar(&value, &index),
            },
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mcapdecode::core::{ElementDef, FieldDef};

    fn point() -> DataTypeDef {
        DataTypeDef::Struct(vec![FieldDef::new("x", DataTypeDef::F64, false)].into())
    }

    fn point_value(x: f64) -> Value {
        Value::Struct(vec![Value::F64(x)])
    }

    #[test]
    fn structs_inside_lists_are_named() {
        let data_type = DataTypeDef::List(Box::new(ElementDef::new(point(), false)));
        let value = Value::List(vec![point_value(1.0)]);
        assert_eq!(to_json(&value, &data_type), json!([{"x": 1.0}]));
    }

    #[test]
    fn maps_are_pairs_with_a_truncation_marker() {
        let data_type = DataTypeDef::Map {
            key: Box::new(ElementDef::new(DataTypeDef::String, false)),
            value: Box::new(ElementDef::new(point(), false)),
        };
        let pair = (Value::string("k"), point_value(1.0));
        assert_eq!(
            to_json(&Value::Map(vec![pair.clone()]), &data_type),
            json!([["k", {"x": 1.0}]])
        );
        let long = to_json(&Value::Map(vec![pair; MAX_ITEMS + 1]), &data_type);
        assert_eq!(long["$truncated"], true);
        assert_eq!(long["length"], MAX_ITEMS + 1);
        assert_eq!(long["items"].as_array().unwrap().len(), MAX_ITEMS);
    }
}
