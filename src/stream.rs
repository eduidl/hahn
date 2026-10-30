use crate::{ApiError, AppState, blocking, series_fields, source::TimeRange};
use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use mcapdecode::core::{FieldDefs, Value};
use serde::{Deserialize, Serialize};
use std::{
    convert::Infallible,
    io,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event<T> {
    Batch {
        rows: Vec<T>,
        scanned_messages: usize,
    },
    Complete {
        scanned_messages: usize,
    },
    Error {
        message: String,
    },
}
pub(crate) fn indexes(defs: &FieldDefs, path: &[String]) -> Option<Vec<usize>> {
    let (head, tail) = path.split_first()?;
    let index = defs.iter().position(|f| &f.name == head)?;
    let mut result = vec![index];
    if !tail.is_empty() {
        let mcapdecode::core::DataTypeDef::Struct(children) = &defs[index].element.data_type else {
            return None;
        };
        result.extend(indexes(&children.fields, tail)?);
    }
    Some(result)
}

pub(crate) fn scalar(root: &Value, path: &[usize]) -> serde_json::Value {
    let mut value = root;
    for &index in path {
        let Value::Struct(values) = value else {
            return serde_json::Value::Null;
        };
        let Some(next) = values.get(index) else {
            return serde_json::Value::Null;
        };
        value = next;
    }
    match value {
        Value::I8(v) => (*v).into(),
        Value::I16(v) => (*v).into(),
        Value::Bool(v) => (*v).into(),
        Value::I32(v) => (*v).into(),
        Value::U8(v) => (*v).into(),
        Value::U16(v) => (*v).into(),
        Value::U32(v) => (*v).into(),
        Value::I64(v) => v.to_string().into(),
        Value::U64(v) => v.to_string().into(),
        Value::String(v) => v.to_string().into(),
        Value::F32(v) => {
            serde_json::Number::from_f64(*v as f64).map_or(serde_json::Value::Null, Into::into)
        }
        Value::F64(v) => {
            serde_json::Number::from_f64(*v).map_or(serde_json::Value::Null, Into::into)
        }
        _ => serde_json::Value::Null,
    }
}

fn send<T: Serialize>(
    tx: &mpsc::Sender<Result<Bytes, Infallible>>,
    event: &Event<T>,
) -> Result<(), io::Error> {
    let mut bytes = serde_json::to_vec(event)?;
    bytes.push(b'\n');
    tx.blocking_send(Ok(bytes.into()))
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "Client disconnected"))
}

pub(crate) async fn series(
    State(state): State<AppState>,
    Path(id): Path<usize>,
    Json(request): Json<SeriesRequest>,
) -> Result<Response, ApiError> {
    state.check(id)?;
    if request.fields.is_empty() || request.fields.len() > 64 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Select between 1 and 64 scalar fields".into(),
        ));
    }
    let parse = |s: &Option<String>| -> Result<Option<u64>, ApiError> {
        s.as_ref()
            .map(|s| {
                s.parse().map_err(|_| {
                    ApiError(
                        StatusCode::BAD_REQUEST,
                        "Timestamps must be unsigned nanosecond strings".into(),
                    )
                })
            })
            .transpose()
    };
    let start = parse(&request.start_ns)?;
    let end = parse(&request.end_ns)?;
    if matches!((start, end), (Some(a), Some(b)) if a > b) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Start must not exceed end".into(),
        ));
    }
    let topic = request.topic.clone();
    let fields = request.fields.clone();
    let (source, paths) = blocking(move || {
        let source = state.source(id)?;
        let defs = source.field_defs(&topic)?;
        let mut available = Vec::new();
        series_fields(&defs, &[], &mut available);
        fields
            .iter()
            .map(|field| {
                anyhow::ensure!(
                    available.iter().any(|f| &f.path == field),
                    "Unknown scalar field: {field:?}"
                );
                indexes(&defs, field).ok_or_else(|| anyhow::anyhow!("Invalid field"))
            })
            .collect::<anyhow::Result<Vec<_>>>()
            .map(|paths| (source, paths))
    })
    .await?;
    Ok(stream_rows(
        source,
        request.topic,
        TimeRange { start, end },
        move |log_time, value| Row {
            time_ns: log_time.to_string(),
            values: paths.iter().map(|p| scalar(&value, p)).collect(),
        },
    ))
}

/// Bounded, cancellable NDJSON delivery shared by scalar and message history.
pub(crate) fn stream_rows<T: Serialize + Send + 'static>(
    source: std::sync::Arc<dyn crate::source::Source>,
    topic: String,
    range: TimeRange,
    convert: impl Fn(u64, Value) -> T + Send + 'static,
) -> Response {
    let (tx, rx) = mpsc::channel(4);
    tokio::task::spawn_blocking(move || {
        let mut rows = Vec::with_capacity(1024);
        let mut scanned = 0;
        let mut last_flush = Instant::now();
        let result = source.read(&topic, range, None, &mut |log_time, value| {
            if tx.is_closed() {
                return Err(
                    io::Error::new(io::ErrorKind::BrokenPipe, "Client disconnected").into(),
                );
            }
            scanned += 1;
            rows.push(convert(log_time, value));
            if rows.len() >= 1024 || last_flush.elapsed() >= Duration::from_millis(100) {
                send(
                    &tx,
                    &Event::Batch {
                        rows: std::mem::take(&mut rows),
                        scanned_messages: scanned,
                    },
                )?;
                last_flush = Instant::now();
            }
            Ok(())
        });
        if tx.is_closed() {
            return;
        }
        if !rows.is_empty()
            && send(
                &tx,
                &Event::Batch {
                    rows,
                    scanned_messages: scanned,
                },
            )
            .is_err()
        {
            return;
        }
        match result {
            Ok(()) => {
                let _ = send(
                    &tx,
                    &Event::<T>::Complete {
                        scanned_messages: scanned,
                    },
                );
            }
            Err(e) => {
                let _ = send(
                    &tx,
                    &Event::<T>::Error {
                        message: e.to_string(),
                    },
                );
            }
        }
    });
    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-store"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(ReceiverStream::new(rx)),
    )
        .into_response()
}
