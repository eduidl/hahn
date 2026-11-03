use crate::{
    error::Code,
    source::{MessageTimes, TimeRange},
};
use axum::{
    body::{Body, Bytes},
    http::header,
    response::{IntoResponse, Response},
};
use mcapdecode::core::{FieldDefs, Value};
use serde::Serialize;
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
        code: &'static str,
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

pub(crate) fn disconnected() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "Client disconnected")
}

fn send<T: Serialize>(
    tx: &mpsc::Sender<Result<Bytes, Infallible>>,
    event: &Event<T>,
) -> Result<(), io::Error> {
    let mut bytes = serde_json::to_vec(event)?;
    bytes.push(b'\n');
    tx.blocking_send(Ok(bytes.into()))
        .map_err(|_| disconnected())
}

/// Bounded, cancellable NDJSON delivery of message history.
pub(crate) fn stream_rows<T: Serialize + Send + 'static>(
    source: std::sync::Arc<dyn crate::source::Source>,
    topic: String,
    range: TimeRange,
    convert: impl Fn(MessageTimes, Value) -> T + Send + 'static,
) -> Response {
    let (tx, rx) = mpsc::channel(4);
    tokio::task::spawn_blocking(move || {
        let mut rows = Vec::with_capacity(1024);
        let mut scanned = 0;
        let mut last_flush = Instant::now();
        let result = source.read(&topic, range, &mut |times, value| {
            if tx.is_closed() {
                return Err(disconnected().into());
            }
            scanned += 1;
            rows.push(convert(times, value));
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
                        code: Code::of(&e).as_str(),
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
