use crate::{
    AppState, blocking,
    error::{ApiError, Code, coded},
    scalar_fields,
    source::{MessageTimes, Source, TimeRange},
    stream::{indexes, stream_rows},
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use mcapdecode::{DataTypeDef, EnumDef, FieldDefs, Value};
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
        group.require_topic(&query.topic)?;
        let defs = source.field_defs(&query.topic)?;
        check_meta(&*source, &query.meta)?;
        let index = field_index(&defs, &field)?;
        let data_type = if index.is_empty() {
            DataTypeDef::structure(defs.clone().into())
        } else {
            field_type(&defs, &index).clone()
        };
        let json_text = source.is_json_text(&query.topic)?;
        Ok(source
            .latest_at(&query.topic, time)?
            .map(|(times, value)| MessageResponse {
                time_ns: times.log_time.to_string(),
                value: match &query.meta {
                    Some(name) => meta_value(name, times),
                    None => displayed(&value, &index, &data_type, json_text),
                },
            }))
    })
    .await
    .map(Json)
}

pub(crate) fn parse_time(value: &str) -> Result<u64, ApiError> {
    value.parse().map_err(|_| {
        ApiError::new(
            Code::InvalidRequest,
            "Timestamps must be unsigned nanosecond strings",
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
        return Err(ApiError::new(
            Code::InvalidRequest,
            "Start must not exceed end",
        ));
    }
    Ok(TimeRange { start, end })
}

fn parse_field(path: &Option<String>, meta: &Option<String>) -> Result<Vec<String>, ApiError> {
    if path.is_some() && meta.is_some() {
        return Err(ApiError::new(
            Code::InvalidRequest,
            "Path and meta cannot be combined",
        ));
    }
    match path {
        Some(path) => serde_json::from_str(path)
            .map_err(|_| ApiError::new(Code::InvalidRequest, "Invalid field path")),
        None => Ok(Vec::new()),
    }
}

fn check_meta(source: &dyn Source, meta: &Option<String>) -> anyhow::Result<()> {
    match meta {
        Some(name) if !source.meta_fields().contains(&name.as_str()) => Err(coded(
            Code::UnknownMetaField,
            format!("Unknown meta field: {name}"),
        )),
        _ => Ok(()),
    }
}

/// Where `field` is in a message of `defs`; empty for the whole message.
fn field_index(defs: &FieldDefs, field: &[String]) -> anyhow::Result<Vec<usize>> {
    if field.is_empty() {
        return Ok(Vec::new());
    }
    indexes(defs, field)
        .ok_or_else(|| coded(Code::UnknownField, format!("Unknown field: {field:?}")))
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

/// The selected value for display. JSON text is shown parsed, or as text if it is not valid JSON.
fn displayed(
    value: &Value,
    index: &[usize],
    data_type: &DataTypeDef,
    json_text: bool,
) -> serde_json::Value {
    let Some(selected) = select(value, index) else {
        return serde_json::Value::Null;
    };
    let parsed = |text: &str| serde_json::from_str(text).ok().map(limit_json);
    if json_text {
        match (selected, data_type) {
            (Value::String(text), _) => {
                if let Some(document) = parsed(text) {
                    return document;
                }
            }
            (Value::Struct(values), DataTypeDef::Struct(defs)) => {
                if let ([Value::String(text)], [def]) = (&values[..], &defs.fields[..])
                    && let Some(document) = parsed(text)
                {
                    return json!({ def.name.clone(): document });
                }
            }
            _ => {}
        }
    }
    to_json(selected, data_type)
}

/// Applies the display limits of [`to_json`] to a parsed document. Integers
/// JavaScript cannot represent exactly become strings.
fn limit_json(value: serde_json::Value) -> serde_json::Value {
    const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
    use serde_json::Value as Json;
    match value {
        Json::Number(number) => {
            let exact = number.as_i64().map(i64::unsigned_abs).or(number.as_u64());
            if exact.is_some_and(|v| v > MAX_SAFE_INTEGER) {
                number.to_string().into()
            } else {
                number.into()
            }
        }
        Json::String(text) => shorten(&text),
        Json::Array(values) => {
            let length = values.len();
            let shown = values.into_iter().take(MAX_ITEMS).map(limit_json).collect();
            preview(length, shown)
        }
        Json::Object(fields) => fields
            .into_iter()
            .map(|(name, value)| (name, limit_json(value)))
            .collect::<serde_json::Map<_, _>>()
            .into(),
        other => other,
    }
}

/// A long string as `{"$truncated", "length", "text"}`, so that it cannot be
/// mistaken for a whole string.
fn shorten(text: &str) -> serde_json::Value {
    let length = text.chars().count();
    if length > MAX_CHARS {
        let shown: String = text.chars().take(MAX_CHARS).collect();
        json!({ "$truncated": true, "length": length, "text": shown })
    } else {
        text.into()
    }
}

/// A float as a JSON number, or `"NaN"`, `"Infinity"` or `"-Infinity"`, which JSON
/// cannot hold as numbers and which must not read as missing.
fn float(v: f64) -> serde_json::Value {
    match serde_json::Number::from_f64(v) {
        Some(number) => number.into(),
        None if v.is_nan() => "NaN".into(),
        None if v > 0. => "Infinity".into(),
        None => "-Infinity".into(),
    }
}

/// The shortest decimal that reads back as the same `f32`: `0.1`, not the
/// `0.10000000149011612` the widened `f64` would print.
fn single(v: f32) -> serde_json::Value {
    if v.is_finite() {
        float(v.to_string().parse().unwrap_or(v as f64))
    } else {
        float(v as f64)
    }
}

/// A 64-bit integer: exact as a string, since a JSON reader may hold numbers as doubles.
fn wide(v: impl ToString) -> serde_json::Value {
    v.to_string().into()
}

/// An enum as its recorded number; the client looks up its name. Decoders that
/// give the name are mapped back, and a number outside the variants is kept.
fn enum_number(value: &Value, def: &EnumDef) -> serde_json::Value {
    const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;
    let number = match value {
        Value::String(name) => def
            .variants
            .iter()
            .find(|variant| variant.name == **name)
            .map(|variant| variant.value)
            .or_else(|| name.parse().ok()),
        _ => None,
    };
    match number {
        Some(n) if n.abs() <= MAX_SAFE_INTEGER => n.into(),
        Some(n) => n.to_string().into(),
        None => scalar_json(value, &DataTypeDef::Null, true),
    }
}

/// A value that is not a struct, list or map. `exact` keeps strings whole.
fn scalar_json(value: &Value, data_type: &DataTypeDef, exact: bool) -> serde_json::Value {
    if let DataTypeDef::Enum(def) = data_type {
        return enum_number(value, def);
    }
    match value {
        Value::Bool(v) => (*v).into(),
        Value::I8(v) => (*v).into(),
        Value::I16(v) => (*v).into(),
        Value::I32(v) => (*v).into(),
        Value::U8(v) => (*v).into(),
        Value::U16(v) => (*v).into(),
        Value::U32(v) => (*v).into(),
        Value::I64(v) => wide(v),
        Value::U64(v) => wide(v),
        Value::F32(v) => single(*v),
        Value::F64(v) => float(*v),
        Value::String(v) if exact => v.to_string().into(),
        Value::String(v) => shorten(v),
        _ => serde_json::Value::Null,
    }
}

/// The exact value of a scalar field, for `preview=false`.
fn scalar(root: &Value, index: &[usize], data_type: &DataTypeDef) -> serde_json::Value {
    select(root, index).map_or(serde_json::Value::Null, |value| {
        scalar_json(value, data_type, true)
    })
}

/// JSON for display: named struct fields, exact 64-bit integers as strings,
/// and large lists, byte buffers and strings cut down to a preview.
fn to_json(value: &Value, data_type: &DataTypeDef) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Bytes(v) => json!({ "$bytes": v.len(), "head": &v[..v.len().min(MAX_BYTES)] }),
        Value::Uint8List(v) if v.len() > MAX_ITEMS => {
            json!({ "$truncated": true, "length": v.len(), "items": &v[..MAX_ITEMS] })
        }
        Value::Uint8List(v) => json!(v.as_ref()),
        Value::Struct(values) => match data_type {
            DataTypeDef::Struct(defs) => defs
                .fields
                .iter()
                .zip(values.iter())
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
        scalar => scalar_json(scalar, data_type, false),
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
    let (source, index, data_type, json_text) = blocking(move || {
        let source = group.source()?;
        group.require_topic(&topic)?;
        let defs = source.field_defs(&topic)?;
        check_meta(&*source, &checked)?;
        let index = field_index(&defs, &field)?;
        if !preview {
            let mut scalars = Vec::new();
            scalar_fields(&defs, &[], &mut scalars);
            if !scalars.contains(&field) {
                return Err(coded(
                    Code::InvalidSelection,
                    format!("Exact values need a scalar field: {field:?}"),
                ));
            }
        }
        let data_type = if index.is_empty() {
            DataTypeDef::structure(defs.into())
        } else {
            field_type(&defs, &index).clone()
        };
        let json_text = source.is_json_text(&topic)?;
        Ok((source, index, data_type, json_text))
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
                None if preview => displayed(&value, &index, &data_type, json_text),
                None => scalar(&value, &index, &data_type),
            },
        },
    ))
}
