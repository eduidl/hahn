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
