pub(crate) use tf::{TfIndex, frames, transforms};

use crate::{
    ApiError, AppState, blocking,
    message::{parse_range, parse_time},
    source::{MessageTimes, Source},
    stream::disconnected,
};
use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
};
use convert::{CONVERTERS, Converter, Message};
pub(crate) use frame::CONTENT_TYPE;
use frame::{Payload, encode};
use mcapdecode::core::{FieldDefs, Value};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, convert::Infallible, sync::Arc};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

#[derive(Clone, Serialize)]
pub(crate) struct ViewInfo {
    id: &'static str,
    kind: &'static str,
    name: &'static str,
}

/// The JSON header of a frame.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Header {
    Frame {
        time_ns: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Unchanged,
    Complete {
        scanned_messages: usize,
    },
    Error {
        message: String,
    },
}

#[derive(Deserialize)]
pub(crate) struct ViewsQuery {
    topic: String,
    view: String,
    start_ns: Option<String>,
    /// Exclusive upper bound. Omit to include the last timestamp of a recording.
    end_ns: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct LatestQuery {
    topic: String,
    view: String,
    time_ns: String,
    /// The time of the frame the client already holds.
    known_time_ns: Option<String>,
}

