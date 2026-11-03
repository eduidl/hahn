//! Stable error codes, so that clients tell failures apart without parsing text.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use std::fmt;

/// What went wrong, as the protocol names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Code {
    InvalidRequest,
    RunNotFound,
    GroupNotFound,
    UnknownTopic,
    UnknownField,
    UnknownMetaField,
    UnknownView,
    UnknownFrame,
    InvalidSelection,
    RecordingUnreadable,
    InternalError,
}

impl Code {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::RunNotFound => "run_not_found",
            Self::GroupNotFound => "group_not_found",
            Self::UnknownTopic => "unknown_topic",
            Self::UnknownField => "unknown_field",
            Self::UnknownMetaField => "unknown_meta_field",
            Self::UnknownView => "unknown_view",
            Self::UnknownFrame => "unknown_frame",
            Self::InvalidSelection => "invalid_selection",
            Self::RecordingUnreadable => "recording_unreadable",
            Self::InternalError => "internal_error",
        }
    }

    fn status(self) -> StatusCode {
        match self {
            Self::InvalidRequest => StatusCode::BAD_REQUEST,
            Self::RunNotFound | Self::GroupNotFound => StatusCode::NOT_FOUND,
            Self::InternalError => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        }
    }

    /// The code an error carries, if it was made with [`coded`]. Any other failure
    /// comes from reading the recording.
    pub(crate) fn of(error: &anyhow::Error) -> Self {
        error
            .downcast_ref::<Coded>()
            .map_or(Self::RecordingUnreadable, |coded| coded.code)
    }
}

/// An error that keeps its code while it travels as an [`anyhow::Error`].
#[derive(Debug)]
struct Coded {
    code: Code,
    message: String,
}

impl fmt::Display for Coded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Coded {}

pub(crate) fn coded(code: Code, message: impl Into<String>) -> anyhow::Error {
    Coded {
        code,
        message: message.into(),
    }
    .into()
}

/// The response of a failed request: `{code, error}` with the code's status.
#[derive(Debug)]
pub(crate) struct ApiError {
    code: Code,
    message: String,
}

impl ApiError {
    pub(crate) fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.code.status(),
            Json(serde_json::json!({"code": self.code.as_str(), "error": self.message})),
        )
            .into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self::new(Code::of(&error), error.to_string())
    }
}
