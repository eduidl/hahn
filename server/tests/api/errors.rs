//! Every failure carries a stable code beside its human-readable description.

use crate::common::*;

/// The status and code of a failed JSON request.
async fn failure(app: &axum::Router, url: &str) -> (StatusCode, String) {
    let (status, body) = get(app.clone(), url).await;
    assert!(!body["error"].as_str().unwrap().is_empty(), "{url}: {body}");
    (status, body["code"].as_str().unwrap().to_owned())
}

fn expect(actual: (StatusCode, String), status: StatusCode, code: &str) {
    assert_eq!(actual, (status, code.to_owned()));
}

#[tokio::test]
async fn lookups_name_what_is_missing() {
    let dir = fixture(10, true);
    let app = hahn::router(dir.path()).unwrap();
    let (_, runs) = get(app.clone(), "/api/runs").await;
    let run = runs["items"][0]["id"].as_str().unwrap();
    let not_found = StatusCode::NOT_FOUND;
    let unprocessable = StatusCode::UNPROCESSABLE_ENTITY;
    expect(
        failure(&app, "/api/runs/none").await,
        not_found,
        "run_not_found",
    );
    expect(
        failure(&app, &format!("/api/runs/{run}/groups/none")).await,
        not_found,
        "group_not_found",
    );
    let latest = |query: &str| format!("/g/messages/latest?time_ns=5{query}");
    expect(
        failure(&app, &latest("&topic=/missing")).await,
        unprocessable,
        "unknown_topic",
    );
    expect(
        failure(&app, &latest("&topic=/telemetry&path=%5B%22missing%22%5D")).await,
        unprocessable,
        "unknown_field",
    );
    expect(
        failure(&app, &latest("&topic=/telemetry&meta=missing")).await,
        unprocessable,
        "unknown_meta_field",
    );
    for body in [
        json!({"topic":"/missing"}),
        json!({"topic":"/telemetry","path":["missing"]}),
        json!({"topic":"/telemetry","path":["tags"],"preview":false}),
    ] {
        let (status, events) = stream(app.clone(), "/g/messages", body.clone()).await;
        assert_eq!(status, unprocessable, "{body}");
        assert!(events[0]["code"].is_string(), "{body}");
    }
    let (_, events) = stream(
        app.clone(),
        "/g/messages",
        json!({"topic":"/telemetry","path":["tags"],"preview":false}),
    )
    .await;
    assert_eq!(events[0]["code"], "invalid_selection");
}

#[tokio::test]
async fn views_name_what_is_missing() {
    let (_dir, app) = visual_app();
    let unprocessable = StatusCode::UNPROCESSABLE_ENTITY;
    expect(
        failure(
            &app,
            &view_url("views/latest", "/missing", "image", "&time_ns=1"),
        )
        .await,
        unprocessable,
        "unknown_topic",
    );
    expect(
        failure(
            &app,
            &view_url("views/latest", "/camera", "none", "&time_ns=1"),
        )
        .await,
        unprocessable,
        "unknown_view",
    );
    expect(
        failure(
            &app,
            &view_url("views", "/camera", "image", "&start_ns=2&end_ns=1"),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "invalid_request",
    );
}

#[tokio::test]
async fn malformed_requests_are_invalid_requests() {
    let dir = fixture(10, true);
    let app = hahn::router(dir.path()).unwrap();
    for url in [
        "/api/runs?limit=0",
        "/g/messages/latest?topic=/telemetry&time_ns=bad",
        "/g/messages/latest?topic=/telemetry",
        "/g/messages?topic=/telemetry&preview=maybe",
        "/g/messages?topic=/telemetry&path=nope",
        "/g/messages?topic=/telemetry&start_ns=2&end_ns=1",
        "/g/messages?topic=/telemetry&path=%5B%22signal%22%5D&meta=log_time",
    ] {
        expect(
            failure(&app, url).await,
            StatusCode::BAD_REQUEST,
            "invalid_request",
        );
    }
}

#[tokio::test]
async fn unreadable_recordings_are_reported_as_such() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("bad.mcap"), b"not MCAP").unwrap();
    let app = hahn::router(dir.path()).unwrap();
    expect(
        failure(&app, "/g").await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "recording_unreadable",
    );
}

#[tokio::test]
async fn stream_errors_carry_a_code() {
    let dir = tempfile::tempdir().unwrap();
    support::write_fixture_with_options(&dir.path().join("broken.mcap"), 2200, true, Some(1500))
        .unwrap();
    let (status, events) = stream(
        hahn::router(dir.path()).unwrap(),
        "/g/messages",
        json!({"topic":"/telemetry"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let last = events.last().unwrap();
    assert_eq!(last["type"], "error");
    assert_eq!(last["code"], "recording_unreadable");
    assert!(!last["message"].as_str().unwrap().is_empty());
}
