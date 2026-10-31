# Hahn Protocol

This document describes the concepts of the HTTP protocol between the shared client and each server implementation, and the binary format of view frames.

[`openapi.json`](openapi.json) holds the operations and every field: their types, whether they are required, their meaning, their units and examples. Its schemas follow the order of the operations rather than the alphabet. Each fact is written in only one of the two documents.

## Principles

- Servers are implemented by hand against these documents.
- There is one client and several servers. The protocol contains nothing that depends on how a server is built.
- Files are not exposed. The client deals in runs and groups. Layouts such as numbered files stay inside the server.

## Terms

| Term | Meaning |
|---|---|
| Run | One drive. The client opens only one at a time |
| Group | A kind of data in a run. The server decides how to divide them |
| Topic | A series of messages in a group. Names are unique only within a group |
| Field | A value in a message |
| User type | A type defined by the user: the schema of a recording's topic, named by `schema_name` |
| Hahn type | A type defined by Hahn, such as `image` or `pose`, named by `kind` |

## Time

The playback position, message and view response `time_ns`, and the range in `RecordingInfo` use **log time**. MCAP uses `log_time`; the server supplies the equivalent for other formats. Log time identifies where data occurs in the recording, even when the measurement clock pauses or resets. It need not equal the time the data was measured.

A run also has a **simulation/measurement clock**, shared across its groups. Message `stamp_ns`, view value `stamp_ns`, and transform sample timestamps use this clock. The server decides how to extract and interpret measurement timestamps and establish clock correspondence; message fields such as `header.stamp` or MCAP `publish_time` are not automatically assumed to share a clock. Original timestamp fields remain readable through messages and meta fields. An unknown measurement time is omitted, not replaced with log time.

Timestamps do not inherently mean UTC or Unix epoch. `timezone` is a display hint for wall-clock time; simulation timestamps must not be interpreted as calendar dates.

### Common time queries

Single-time queries (`/messages/latest` and `/views/latest`) take a required `log_time_ns` and an optional `clock_time_ns`:

- With only `log_time_ns`, search by log time.
- With both parameters, `log_time_ns` identifies the recording interval between measurement-clock resets and `clock_time_ns` is the measurement time to search within it. The measurement clock may be a simulation or system clock; there is no clock selector parameter.
- In a measurement-time query, `log_time_ns` is a semantic context, not just a seek optimization or a cutoff for which messages may be read. It disambiguates repeated measurement times after resets. Only messages belonging to the selected interval by their log time participate.
- Latest selects the greatest lookup timestamp at or before the requested time: log time with only `log_time_ns`, measurement time when `clock_time_ns` is present. Equal timestamps are ordered by log time, then recording order, with the last winning. No matching message is a successful empty result, not a failure to resolve time.

`/messages/latest` and `/views/latest` also accept optional `log_start_ns`. This is an inclusive lower bound on the candidate message's log time, applied before latest selection, including when `clock_time_ns` is supplied. Omission imposes no lower bound. `log_start_ns` greater than `log_time_ns` is not an error for latest queries; the bound is applied to candidates as usual. If no candidate remains, the successful empty result is `null` for messages and just `complete` for views.

Each latest request is independent of earlier requests. It returns the selected value or conversion error even when a previous request selected the same message. Switching topic or view at the same time returns the result for that topic and view; the response does not depend on which value the client already holds.

History queries (`/messages` and `/views`) use only optional `log_start_ns` and `log_end_ns`. Bounds include the start and exclude the end. Omitted bounds cover the recording, including any measurement-clock resets. Malformed timestamps or a start greater than the end is `400`. Rows remain in recording order; repeated timestamps are separate messages. Measurement-clock range filtering and reset-interval context are not part of history queries; history selection requires neither measurement timestamps nor clock correspondence. Available measurement timestamps are still returned for plotting or subsequent spatial lookup.

`/transforms/dynamic` is the exception: it takes a required `log_time_ns` selecting one reset interval and a required measurement-clock range, `clock_start_ns` to `clock_end_ns`. A spatial lookup needs the samples around a measurement stamp, and the log times of those samples are shifted by recording delay, so a log-time range could miss them.

Message selection is shared: views convert the messages that the corresponding message query selects. Conversion does not define a second search rule. Field and meta-field selection do not change the measurement timestamp of the containing message. Message rows and view frames always return log time in `time_ns`, with measurement time in optional `stamp_ns`. A whole-message view value carries the same `stamp_ns` as its frame; nested values may have their own stamps.

For example, the first latest query searches by log time. The next two search measurement time `11000000000` in the interval containing that log time; the view converts the same message as the corresponding message query:

```http
GET /api/runs/r/groups/g/messages/latest?topic=/camera&log_time_ns=1760000000123456789
GET /api/runs/r/groups/g/messages/latest?topic=/camera&log_time_ns=1760000000123456789&clock_time_ns=11000000000
GET /api/runs/r/groups/g/views/latest?topic=/camera&view=image&log_time_ns=1760000000123456789&clock_time_ns=11000000000
```

A freshness bound can exclude old observations. In this query, a message at log time `1760000000100000000` is eligible, while one at `1760000000099999999` is excluded. If all messages are older than the bound, the stream contains only `complete`:

```http
GET /api/runs/r/groups/g/views/latest?topic=/camera&view=image&log_time_ns=1760000000200000000&log_start_ns=1760000000100000000
```

History queries select the same log-time range for messages and views:

```http
GET /api/runs/r/groups/g/messages?topic=/camera&log_start_ns=1760000000000000000&log_end_ns=1760000002000000000
GET /api/runs/r/groups/g/views?topic=/camera&view=image&log_start_ns=1760000000000000000&log_end_ns=1760000002000000000
```

### Clock resolution

`GET /api/runs/{run}/clock?log_time_ns=...` returns `{log_time_ns, clock_time_ns}`, resolving a log-time position to the run measurement clock. This clock may be a simulation or system clock. The server chooses the samples that form this correspondence so that a decrease means a real reset; jitter within or between clock sources and groups must not appear as one. For sampled correspondence:

- Order samples by log time. At equal log times, the last sample in recording order wins, and across groups the last in the run group order wins.
- At a sample's log time, return that sample's simulation time exactly.
- Between samples whose simulation time increases, interpolate linearly in log time. Round down to whole nanoseconds.
- Equal simulation times represent a pause: keep that simulation time constant.
- Decreasing simulation time represents a reset. Do not interpolate in the open interval between those two samples. The earlier sample ends the old interval; the later sample begins the new interval. Each maximal sequence of nondecreasing simulation times is a separate search interval. Neither Clock nor TF interpolation may cross the reset.
- Outside sampled coverage, do not extrapolate. An exact isolated sample is resolvable, but it provides no coverage on either side.

No interval ID is exposed: `log_time_ns` selects the interval containing that log-time position, using the same coverage and reset boundaries as Clock resolution. Where the server knows the clocks are identical, it may resolve their correspondence directly; how this knowledge is obtained, and how recordings without clock samples are handled, are server implementation details. A forward jump is treated as advancing time and is interpolated; this protocol does not distinguish jumps from fast simulation progress.

A clock, interval or measurement timestamp required for a query that cannot be resolved is `422` with `code: "time_unresolved"`. This includes a position in a reset gap or outside known clock coverage, or a candidate message whose missing measurement timestamp prevents measurement-time selection. Log-time message queries do not require measurement timestamps or clock correspondence. A successful empty search keeps its existing empty representation. A time-resolution failure must not be silently turned into an empty result or a query on another clock. After streaming begins, report the same code in a terminal stream error. Client display, playback and retry policies are not defined here.

For example, log/simulation sample pairs, in seconds for readability, are `(1, 10)`, `(2, 12)`, `(3, 12)`, `(4, 1)`, `(5, 3)`:

- Log time `1.5` resolves to simulation time `11`; log time `2.5` resolves to `12` during the pause.
- Log time `3.5` is unresolved, while `4` resolves to `1` and `4.5` resolves to `2` in the new interval.
- Log times before `1` or after `5` are unresolved without other known correspondence.
- If a later reset repeats a simulation timestamp, `log_time_ns` selects the occurrence's interval. Values from another interval do not participate in the query.
- A sensor message measured at simulation time `11` but recorded 100 ms late is selected for playback by its log time. Its spatial placement uses `stamp_ns=11000000000`, not Clock's simulation time at receipt. At 20 m/s, using the receipt-time pose would introduce a 2 m error when the simulation and log clocks advance at the same rate.

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
- Enum values are strings: use the name from `enum_values` when the numeric value is defined, or its decimal integer string when undefined. For aliases with the same numeric value, use the first name in `enum_values` order. This representation applies to both preview settings and throughout structs, lists, arrays and maps, including map keys. Enum strings are never shortened. Missing enum values remain `null`.
- Missing and non-finite values (NaN, Infinity) are `null`. **They cannot be told apart at present.**
- Long values are cut down, unless `preview=false` asks for exact values.

| Target | Condition | Form |
|---|---|---|
| List, array, map | 101 items or more | `{"$truncated": true, "length": total, "items": [first 100 items]}` |
| bytes | Always | `{"$bytes": total bytes, "head": [first 32 bytes]}` |
| String (excluding enum values) | Over 10,000 characters | The first 10,000 characters followed by `…` |

At present, a shortened string can only be recognized by the trailing `…`.

For example, with `enum_values` equal to `[{"name":"RUN","value":"1"},{"name":"ACTIVE","value":"1"}]`, numeric value `1` is returned as `"RUN"`, not `"ACTIVE"` or `"1"`. Undefined values `123` and `-1` are returned as `"123"` and `"-1"`; a missing value is `null`. A list containing these values is `["RUN","123","-1",null]`. The same strings are used when reading a single enum field with `preview=false`.

## Views

Time Series and Table can show a topic from its schema alone, since a number is simply plotted as a number. Images and point clouds cannot: where an image keeps its data, for example, differs from one user type to another.

So Hahn defines common types for images, point clouds and the like (Hahn types), and the server converts messages of user types to them. This conversion is called a view. The client deals only in Hahn types and does not need to know user types.

Messages converted to Hahn types are read through `/views` and `/views/latest`, with the views of a topic listed in `/topics`.

Every image value contains both pixel `data` and `camera_info`. The latter is a `CameraInfo` object or `null`, not an independent view. The server resolves the calibration matching each image's delivered pixels, optical frame and measurement time, even if calibration is recorded in another topic or group of the same run. It is included in each image returned by either history or latest; clients do not discover or fetch calibration separately.

Unknown, ambiguous, invalid or otherwise unresolvable calibration yields `camera_info: null`; the image is still returned. This also applies when a required calibration timestamp or reset interval cannot be resolved. Invalid image data itself continues to produce a frame conversion error. Each image carries its complete calibration state; a previous image's calibration does not fill a null value.

For time-varying calibration, use the latest associated sample at or before the image's measurement `stamp_ns`, within the same clock and reset interval. Equal measurement timestamps are ordered by log time, then recording order. Static calibration needs no measurement timestamp. No future measurement-time sample or sample from another interval may be substituted. The embedded object has no separate kind, frame or timestamp: it describes the containing image.

Raw and rectified views can share a topic and optical frame but require different calibrations. The embedded intrinsics and dimensions must describe the delivered image, including any crop or resize. A rectified image requires its own intrinsics and no distortion; raw calibration must not be substituted. Neither `frame_id` nor topic names alone establish an association.

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

Numbers in a value's JSON are finite and never `null`, unlike in `/messages`. A message with a non-finite or missing required number is a `frame` with `error`, and so is one with a non-finite number in an array, even an optional one, since leaving it out would shift the rest. An optional number outside an array that is not finite is left out. Embedded image calibration is the exception to failing the entire frame: if it cannot form a valid `CameraInfo`, return `camera_info: null` with the valid image.

`openapi.json` lists the values of this version of the protocol, and a later version can add more. A client treats values it does not know like this, so that older clients keep working:

| Unknown value | What a client does |
|---|---|
| `kind` | Ignores the view |
| `type` of a `scene` primitive | Skips the primitive and draws the rest |
| `format` of an `image` | Shows that it cannot display the image |
| `distortion.model` in an image's `camera_info` | Does not use the `camera_info`, since assuming no distortion would misplace what is drawn on the image |
| `fields[].type` of a `pointcloud` | Skips that field without interpreting its blob; continues using positions and supported fields |
| `FieldType.data_type` | Treats the field as unsupported for typed operations without guessing its type; continues with other fields and topics. Raw message values remain readable |
| `ViewEvent.type` | Skips the entire binary frame, including its payload, using the framing lengths, and continues reading. It is neither `complete` nor `error`; a stream ending without either known terminal event still fails |

`stamp_ns` determines when a spatial value was measured; the frame's `time_ns` locates its message in the recording. To place an image or point cloud, resolve the transform samples at its measurement stamp, requesting them with its message log time as `log_time_ns` and a range around the stamp. To inspect the graph at a playback position instead, first resolve that position through `/clock`. A missing measurement stamp is not permission to use log time as a measurement timestamp.

## Coordinate frames

Transforms are not a Hahn type. They are not something to show but the context for reading other values, they have to be merged across topics (`/tf`, `/tf_static`), and a single message may hold only some of the frames. So a run has one graph of frames, merged from all of its groups whether open or not. The server delivers its transforms as samples and the client resolves them. A view of any group refers to the same graph, since how a run divides into groups is up to the server. A group that cannot be read is left out. Which topics feed it is up to the server. Those topics are still readable through `/messages`.

Coordinates are right-handed, in meters and radians. The server converts recordings on other conventions.

- With several samples of a child frame at the same `stamp_ns`, the last row applies.
- Translation is interpolated linearly and rotation by slerp, between the samples around the time. Rotations go the short way round, since `q` and `-q` are the same rotation.
- Between samples with different parents, nothing is interpolated: the earlier sample holds unchanged until the later one, so the frame stays under its earlier parent.
- Nothing is interpolated across a reset, and nothing is extrapolated. A frame not connected to the chosen target, or reached through a dynamic transform outside its samples, has no transform at that time.
- A cycle of frames is invalid data. Which way round the frames on it are resolved is unspecified.

## Errors

Every HTTP error body has a required stable `code` and a human-readable `error`. Terminal stream errors have the same required `code` and a human-readable `message`; once streaming begins, the HTTP status cannot change. Clients distinguish failures by `code`, not by parsing either description. An unknown code is still an error, not an empty result. Per-frame view conversion errors remain separate: their existing `error` describes why that particular message could not be converted, and the stream can continue.

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed query, invalid parameter value or combination, or missing required parameter |
| 404 | `run_not_found` | The run does not exist |
| 404 | `group_not_found` | The group does not exist in the requested run |
| 422 | `empty_group` | Group information was requested for a readable group known to contain no messages; there is no time range |
| 422 | `unknown_topic` | The topic does not exist in the requested group |
| 422 | `unknown_field` | The path is well-formed but invalid in the schema, including traversal through a non-struct |
| 422 | `unknown_meta_field` | The requested meta field does not exist |
| 422 | `unknown_view` | The view ID does not exist on the requested topic |
| 422 | `invalid_selection` | A valid field is unsupported for the requested operation, such as a non-scalar field with `preview=false` |
| 422 | `recording_unreadable` | A recording cannot be opened, read or decoded, including corrupt or unsupported recording data |
| 422 | `time_unresolved` | A required clock, reset interval or measurement timestamp cannot be resolved |
| 500 | `internal_error` | An unexpected server failure, rather than an unreadable recording or an invalid selection |

An empty query result for an existing readable topic is successful: message history emits `complete` without rows, latest messages return `null`, and views emit only `complete`. Missing values on schema-valid paths remain `null`. For group information only, the existing `422` response is retained for an empty group and identified by `empty_group`. Do not report this code merely because a selected topic or requested range has no messages, or because message-count statistics are unknown. A read or decode failure must report `recording_unreadable` rather than fabricate a successful empty result; the exception is the frame graph, which leaves out a group that cannot be read. A nonexistent topic remains `unknown_topic` even when the group contains no messages.

## Compression

A server may compress responses with HTTP content encoding when the client accepts it. Whether it does is up to the server.

Not compressing is faster locally, and compressing wins on slow links. When compressing a stream, flush every batch so that batches still arrive as they are produced. Compressing view frames is rarely worthwhile, since they hold compressed images and dense binary.

## Open issues

- NaN, Infinity and missing values cannot be told apart
- Timestamps alone do not identify a wall-clock epoch; simulation time is not a calendar date
- f32 is widened to f64, so `0.1` appears as `0.10000000149011612`
- A shortened string cannot be recognized reliably
- `/messages` transfers a lot (rows of JSON)
- A message stamped before a measurement-clock reset but recorded after it belongs to the new interval by its log time. Its stamp is then matched against the new interval, so a spatial lookup can find no transform or, when the stamp values overlap, a wrong one
