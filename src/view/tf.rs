//! A group's coordinate frame graph, merged from all of its transform topics.

use super::convert::{Message, has, is_string, is_struct, quaternion, vector};
use crate::{
    ApiError, AppState, blocking,
    message::parse_time,
    source::{Source, TimeRange},
};
use anyhow::ensure;
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use mcapdecode::core::FieldDefs;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::Arc,
};

#[derive(Serialize)]
struct FrameInfo<'a> {
    id: &'a str,
    parent: Option<&'a str>,
}

async fn run_index(state: &AppState, run: &str) -> Result<Arc<TfIndex>, ApiError> {
    state.run(run)?;
    let (runs, run) = (state.runs.clone(), run.to_owned());
    blocking(move || {
        runs.iter()
            .find(|r| r.id == run)
            .expect("checked above")
            .tf()
    })
    .await
}

#[derive(Serialize)]
struct FrameList<'a> {
    frames: Vec<FrameInfo<'a>>,
}

pub(crate) async fn frames(
    State(state): State<AppState>,
    Path(run): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    use axum::response::IntoResponse;
    let index = run_index(&state, &run).await?;
    Ok(Json(FrameList {
        frames: index.frames(),
    })
    .into_response())
}

#[derive(Deserialize)]
pub(crate) struct TransformsQuery {
    target: String,
    time_ns: String,
}

#[derive(Serialize)]
pub(crate) struct Transforms {
    time_ns: String,
    target: String,
    frames: BTreeMap<Arc<str>, Transform>,
}

