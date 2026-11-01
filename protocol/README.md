# Hahn Protocol

This is the current implemented contract of the Hahn client and Rust server, including the binary format of view frames. It is a development baseline, not a stable compatibility promise. Update it together with implementation, callers and synthetic-data tests.

Unimplemented ideas are preserved in [drafts/README.md](drafts/README.md) and its OpenAPI file. They do not block changes to the current implementation or participate in client generation and conformance checks.

[`openapi.json`](openapi.json) holds the operations and every field: their types, whether they are required, their meaning, their units and examples. Its schemas follow the order of the operations rather than the alphabet. Each fact is written in only one of the two documents.

## Principles

- Servers are implemented by hand against these documents.
- The contract separates the client from server storage and decoding. Additional servers can test against the same current contract.
- Files are not exposed. The client deals in runs and groups. Layouts such as numbered files stay inside the server.

## Terms

| Term | Meaning |
|---|---|
| Run | One drive. The client opens only one at a time |
| Group | A kind of data in a run. The server decides how to divide them |
| Topic | A series of messages in a group, identified by its opaque `id`. Display names may be shared |
| Field | A value in a message |
| User type | A type defined by the user: the schema of a recording's topic, named by `schema_name` |
| Hahn type | A type defined by Hahn, such as `image` or `pose`, named by `kind` |

The `topic` field is a display name and may be duplicated. Use the topic's `id` as the `topic` query parameter for messages and views; do not interpret its contents.

## Time

Every `time_ns` of a message is its **primary time**.

- The server decides what the primary time is. MCAP uses `log_time`; other formats use their equivalent.
- `start_ns`, `end_ns`, the `time_ns` query parameter and the time range in `RecordingInfo` are all in primary time.
- The playback position and time axis are based on primary time too. `publish_time` and times inside messages (such as `header.stamp`) are not primary time. The former can be read as a `meta_fields` entry, and the latter as an ordinary field.
- `timezone` can declare the run's timezone, and the client decides which one to display. Recording times may be relative; a timestamp alone does not establish a wall-clock epoch.
- The current API has no measurement-clock mapping or reset-interval queries. Transform samples and lookups use recording time as well.

## Streams

`/messages` responds with `application/x-ndjson`, one event per line.

```json
{"type":"batch","rows":[{"time_ns":"1760000000123456789","value":14.0}],"scanned_messages":1}
{"type":"complete","scanned_messages":1}
```

**Treat a stream that ends with neither `complete` nor `error` as failed.** The HTTP status is fixed when delivery starts, so later failures are reported as events.

## Message values

These are the values of `/messages` and `/messages/latest`.

- A struct is an object keyed by field name, also inside lists.
- A map is an array of `[key, value]` pairs, which preserves the key type.
- i64 and u64 values are strings. Other numbers are JSON numbers.
- Missing and non-finite values (NaN, Infinity) are `null`. **They cannot be told apart at present.**
- Long values are cut down, unless `preview=false` asks for exact values.

| Target | Condition | Form |
|---|---|---|
| List, array, map | 101 items or more | `{"$truncated": true, "length": total, "items": [first 100 items]}` |
| bytes | Always | `{"$bytes": total bytes, "head": [first 32 bytes]}` |
| String | Over 10,000 characters | The first 10,000 characters followed by `…` |

At present, a shortened string can only be recognized by the trailing `…`.

## Views

Time Series and Table can show a topic from its schema alone, since a number is simply plotted as a number. Images and point clouds cannot: where an image keeps its data, for example, differs from one user type to another.

So Hahn defines common types for images, point clouds and the like (Hahn types), and the server converts messages of user types to them. This conversion is called a view. The client deals only in Hahn types and does not need to know user types.

The current views are encoded or raw images, camera calibration, point clouds and GeoJSON (`image`, `camera_calibration`, `pointcloud`, `geo`). The Rust server converts `foxglove.CompressedImage`, `foxglove.RawImage`, `foxglove.CameraCalibration`, `foxglove.PointCloud` and `foxglove.LocationFix`.

The API is the same for these types: `/views` and `/views/latest`, with the views of a topic listed in `/topics`. An encoded image supports `jpeg`, `png`, `webp` and `avif`; `jpg` is normalized to `jpeg`. Raw images retain their recorded pixels and row stride. Their supported encodings and required dimensions are in the schema.

**In every Hahn type, the latest value replaces everything shown before.** Clients keep no state between values. Use `/views` when past values are needed, for a trajectory for example.

### Wire format

Both operations respond with `application/vnd.hahn.frames`, a sequence of frames. Integers are little endian.

```
u32 header_len | u32 payload_len | header (UTF-8 JSON) | padding | payload
```

- `header_len` is the size of the JSON header in bytes.
- `payload_len` is the size of the payload in bytes, including the padding after each blob.
- `padding` brings the payload to an 8-byte boundary of the frame: `-(8 + header_len) mod 8` bytes of zeros.
- `payload` holds the frame's blobs. Each starts on an 8-byte boundary, so a client holding a frame in one `ArrayBuffer` can view blobs as typed arrays without copying.

Every frame therefore ends on an 8-byte boundary too.

The header is a `ViewEvent`, with the same shape as the events of `/messages`. As with `/messages`, **a response that ends without `complete` or `error` has failed**.

A value refers to binary data with a `BlobRef`, which holds no data itself. Only the fields a Hahn type defines as binary hold one: `data` in `image`, and `positions` and `fields[].data` in `pointcloud`. Anything else with the same shape is plain data, such as a `$blob` key in the free `properties` of `geo`, so a client finds references by field and does not scan values for `$blob`. What the bytes mean is defined by the Hahn type, and they are little endian.

For example, a frame with a JSON header of 100 bytes and a blob of 5 bytes is laid out like this:

| Bytes | Content |
|---|---|
| 0 to 3 | `header_len` = 100 |
| 4 to 7 | `payload_len` = 8 |
| 8 to 107 | The JSON header, holding `{"$blob": {"offset": 0, "length": 5}}` |
| 108 to 111 | Padding, which brings the payload to byte 112 |
| 112 to 116 | The blob |
| 117 to 119 | Padding, which ends the frame on a boundary |

### Rules common to Hahn types

A conversion failure is a `frame` with `error`, without a value, and does not stop the stream. Point clouds omit points with non-finite positions. Missing poses use identity; zero-length quaternions also mean identity. These are current converter behaviors, not a general validation policy for future kinds.

The client selects views by supported `kind`. Images in an unsupported format show an error. Current view values do not carry measurement stamps. The 3D view matches images to calibration by frame ID and uses the camera matrix and supported lens distortion to place each image on a tessellated plane. The image panel can project point clouds using `plumb_bob` or `rational_polynomial` distortion, the camera matrix, and transforms at the image recording time. The latest point cloud at or before that time is used; motion between its recording time and the image time is not compensated.

## Coordinate frames

Transforms are not a Hahn type. They are not something to show but the context for reading other values, they have to be merged across topics (`/tf`, `/tf_static`), and a single message may hold only some of the frames. So a run has one graph of frames, merged from all of its groups whether open or not, and the server resolves it. A view of any group refers to the same graph, since how a run divides into groups is up to the server. A group that cannot be read is left out. Which topics feed it is up to the server. Those topics are still readable through `/messages`.

The Rust server reads `foxglove.FrameTransform` and arrays in `foxglove.FrameTransforms`. It treats topics whose final path segment is `tf_static` or `tf-static` as static. It reads each channel and segment separately and combines their transforms in the run's graph.

Coordinates are right-handed, in meters and radians. The server converts recordings on other conventions.

`/transforms` resolves the graph by these rules:

- Dynamic transforms are interpolated between the samples around `time_ns`: linearly for translation, by slerp for rotation. Static ones hold at all times, and what counts as static is up to the server.
- Between samples with different parents, nothing is interpolated: the earlier sample holds unchanged until the later one, so the frame stays under its earlier parent. With several samples at the same time, the last in source order applies: recording order within a channel, then topic order within a group, then the order of the run's groups.
- Rotations are interpolated the short way round, since `q` and `-q` are the same rotation.
- A sample with a non-finite number, or without both of its frames, is ignored.
- A cycle of frames is invalid data. The response is still valid, but which way round the frames on it were resolved is unspecified.
- Nothing is extrapolated. A frame not connected to `target`, or reached through a dynamic transform outside its samples, is left out of `frames`.
- Samples are indexed by recording time (MCAP `log_time`), not by measurement stamps. The current 3D client also places point clouds using their message recording time. Recording delay can therefore cause spatial misalignment; accurate measurement-time placement remains in the draft.
- `/transforms` uses the graph as it was at `time_ns`, while `/frames` gives each frame the parent last recorded.

## Errors

HTTP errors contain `{ "error": "description" }`; terminal stream errors contain `type: "error"` and `message`. Stable machine-readable error codes are not implemented. Do not parse human-readable descriptions to identify errors.

An empty latest message is `null`; an empty history or latest view ends with `complete`. An empty group has no time range and its info request returns 422.

| Status | Meaning |
|---|---|
| 400 | Invalid request value or malformed query |
| 404 | The run or group does not exist |
| 422 | The topic, field, meta field, view or target frame does not exist, a non-scalar field was given with `preview=false`, or the recording could not be read |
| 500 | Internal server failure |

## Compression

A server may compress responses with HTTP content encoding when the client accepts it. Whether it does is up to the server.

Not compressing is faster locally, and compressing wins on slow links. When compressing a stream, flush every batch so that batches still arrive as they are produced. Compressing view frames is rarely worthwhile, since they hold compressed images and dense binary.

## Open issues

- NaN, Infinity and missing values cannot be told apart
- Relative times (starting at 0) cannot be told apart from epoch times
- f32 is widened to f64, so `0.1` appears as `0.10000000149011612`
- A shortened string cannot be recognized reliably
- `/messages` transfers a lot (rows of JSON)
- `known_time_ns` saves the transfer but not the server's work of reading the message
- Measurement timestamps and clock resets are not implemented
- Transform and point-cloud placement use recording time, so recording delay can cause spatial errors
