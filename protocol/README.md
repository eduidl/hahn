# Hahn Protocol

This is the current implemented contract of the Hahn client and Rust server, including the binary format of view frames. It is a development baseline, not a stable compatibility promise. Update it together with implementation, callers and synthetic-data tests.

The decisions behind it, and the options not taken, are recorded in [../docs/adr/](../docs/adr/).

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
- A value's measurement time, such as its `header.stamp`, is a field like any other, except that view values and transform samples also carry it as `stamp_ns`. The protocol defines no mapping between recording and measurement time and no clock resets.

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
- i64 and u64 values are strings. Other integers are JSON numbers. Every nanosecond time in the protocol is a decimal string too.
- Finite floats are JSON numbers. An f32 is written as the shortest decimal that reads back as the same f32, so `0.1` stays `0.1`.
- NaN and infinities are the strings `"NaN"`, `"Infinity"` and `"-Infinity"`. `null` means only that the value is missing.
- An enum is its recorded number. The client shows the name from the field's `enum_values`; with several names for one number, the first in `enum_values`. A number without a name is shown as the number.
- Long values are cut down, unless `preview=false` asks for exact values.

| Target | Condition | Form |
|---|---|---|
| List, array, map | 101 items or more | `{"$truncated": true, "length": total, "items": [first 100 items]}` |
| bytes | Always | `{"$bytes": total bytes, "head": [first 32 bytes]}` |
| String | Over 10,000 characters | `{"$truncated": true, "length": total characters, "text": "first 10,000 characters"}` |

A client knows a shortened value by an object where the field's type is a string, list, array, map or bytes.

A field with `data_type` `json` holds a JSON document as text. A `jsonschema` + `json` MCAP topic has one such field, `json`, holding the message text. Its preview value is the parsed document instead of the text, under the same limits, with integers beyond ±(2^53 − 1) as strings. Text that is not valid JSON stays a string, and `preview=false` always returns the text.

## Views

Time Series and Table can show a topic from its schema alone, since a number is simply plotted as a number. Images and point clouds cannot: where an image keeps its data, for example, differs from one user type to another.

So Hahn defines common types for images, point clouds and the like (Hahn types), and the server converts messages of user types to them. This conversion is called a view. The client deals only in Hahn types and does not need to know user types.

The current views are encoded or raw images, camera calibration, point clouds, positions, poses, unordered sets of poses, paths, 3D boxes, marks over images, locations on the earth and GeoJSON shapes (`image`, `camera_calibration`, `pointcloud`, `position`, `pose`, `poses`, `path`, `bbox3d`, `image_annotations`, `geo_location`, `geo`). A single value (`position`, `pose`, `geo_location`) may be drawn with its history as a trail; a set (`poses`, `path`, `bbox3d`, `image_annotations`, `pointcloud`, `geo`) replaces the last and is never joined across messages. The Rust server converts these types, including the same Foxglove schemas from the `foxglove_msgs` ROS 2 package:

| Hahn type | Foxglove | ROS 2 |
|---|---|---|
| `image` | `foxglove.CompressedImage`, `foxglove.RawImage` | `sensor_msgs/msg/CompressedImage`, `sensor_msgs/msg/Image` |
| `camera_calibration` | `foxglove.CameraCalibration` | `sensor_msgs/msg/CameraInfo` |
| `pointcloud` | `foxglove.PointCloud` | `sensor_msgs/msg/PointCloud2` |
| `position` | | `geometry_msgs/msg/PointStamped` |
| `pose` | `foxglove.Odometry`, `foxglove.PoseInFrame` | `nav_msgs/msg/Odometry`, `geometry_msgs/msg/PoseStamped`, `geometry_msgs/msg/PoseWithCovarianceStamped` |
| `poses` | | `geometry_msgs/msg/PoseArray` |
| `path` | `foxglove.PosesInFrame` | `nav_msgs/msg/Path` |
| `bbox3d` | | `vision_msgs/msg/Detection3DArray`, labeled by each detection's most likely hypothesis |
| `image_annotations` | `foxglove.ImageAnnotations` | `vision_msgs/msg/Detection2DArray`, each box a closed outline turned by its angle |
| `geo_location` | `foxglove.LocationFix` | `sensor_msgs/msg/NavSatFix` |
| `geo` | `foxglove.GeoJSON` | |

The API is the same for these types: `/views` and `/views/latest`, with the views of a topic listed in `/topics`. An encoded image supports `jpeg`, `png`, `webp` and `avif`; `jpg` is normalized to `jpeg`. A ROS 2 compressed image names its format as `<pixel format>; <format> compressed <pixel format>` or as the format alone; `compressedDepth` images are not supported. Raw images retain their recorded pixels and row stride. Their supported encodings and required dimensions are in the schema.

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

`POST /views/batch` reads up to 32 views of the same group and time range. Its JSON body contains `views` as an array of `{topic, view}`, and optional `start_ns` and exclusive `end_ns`. Every response event has a zero-based `stream` identifying its entry in that array. Each stream ends with its own `complete` or `error`; a failure in one does not stop the others. A missing terminal event means that stream failed. Frame order is recording order within each stream. The regular `/views` endpoint remains available.

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

A conversion failure is a `frame` with `error`, without a value, and does not stop the stream. The odometry view exposes its current pose in `frame_id`; velocities and covariances remain available as message fields. Point clouds omit points with non-finite positions and count them in `omitted`, `poses` omits poses that are not finite or cannot be read `bbox3d` boxes that are not finite or have a negative size, `image_annotations` marks that are not finite or of no known type, and `geo` features without a valid geometry, counting them; a `path` with such a pose fails, since leaving it out would reshape the route. Missing poses use identity; zero-length quaternions also mean identity. ROS 2 messages with multi-byte big-endian pixels or points, and `NavSatFix` messages without a fix, are conversion failures. A `PointCloud2` field holding several values per point is left out, as is padding named `_`. These are current converter behaviors, not a general validation policy for future kinds.

An image view may suggest the calibration of its camera and whether its pixels are rectified, from topic names (`/cam/image_rect/compressed` and `/cam/camera_info`, or `/cam` and `/cam/calibration`). The client uses the suggestion unless the user chooses another calibration, none, or raw or rectified pixels. For each image it takes the calibration value at or before the image: by `stamp_ns` when both have one and the 3D view aligns by measurement time, else by recording time, and the first value when none precedes the image. Raw pixels use the camera matrix and distortion; rectified ones use `projection` without distortion. A calibration of another size than the image is not used.

The client selects views by supported `kind`. Images in an unsupported format show an error. View values carry their measurement time as `stamp_ns` when the message records one (`header.stamp`, or `timestamp` in Foxglove schemas); a zero or invalid stamp is left out, never replaced by recording time. The 3D view matches images to calibration by frame ID and uses the camera matrix and supported lens distortion to place each image on a tessellated plane. The image panel can project point clouds using `plumb_bob` or `rational_polynomial` distortion, the camera matrix, and transforms at the image's measurement time, or its recording time without one. The latest point cloud at or before that time is used; motion between its recording time and the image time is not compensated.

## Coordinate frames

Transforms are not a Hahn type. They are not something to show but the context for reading other values, they have to be merged across topics (`/tf`, `/tf_static`), and a single message may hold only some of the frames. So a run has one graph of frames, merged from all of its groups whether open or not. The server delivers it as samples and the client resolves it, so that the time and interpolation used can change without a request. A view of any group refers to the same graph, since how a run divides into groups is up to the server. Which topics feed it is up to the server. Those topics are still readable through `/messages`.

The Rust server reads `foxglove.FrameTransform`, arrays in `foxglove.FrameTransforms`, and `tf2_msgs/msg/TFMessage`. It treats topics whose final path segment is `tf_static` or `tf-static` as static. It reads each channel and segment separately and combines their transforms in the run's graph.

Coordinates are right-handed, in meters and radians. The server converts recordings on other conventions.

### What the server delivers

- Each frame with a parent is either `static` or `dynamic` in `/frames`. A frame recorded on both static and dynamic topics is dynamic; one with a single sample, which is all there is to know about it, is static. `/frames` also lists every parent of a frame, the samples left out of it, and the groups that could not be read and are left out of the graph.
- `/transforms/static` gives each static frame's last transform, without times.
- `/transforms/dynamic` gives the samples of dynamic frames recorded in a range of recording time, in recording order, each with its recording time and, when its message has one, its measurement `stamp_ns`. Equal times stay separate rows. Request a margin around what is shown: stamps lag recording time.
- A sample with a non-finite number, or without both of its frames, is left out and counted.

### How the client resolves

- The client resolves at a value's measurement time on the stamps of samples, or at its recording time on their recording times, as the user chooses. A value without a stamp is placed by recording time, and the client says so. Frames with no value of their own, such as their axes, are shown at the playback position by recording time.
- Between the samples around a time, translation is interpolated linearly and rotation by slerp, the short way round. The user can turn interpolation off, and the earlier sample then holds until the next.
- Between samples with different parents, nothing is interpolated: the earlier sample holds unchanged until the later one. With several samples at the same time, the last in recording order applies.
- Nothing is extrapolated. A frame not connected to the target, or reached through a dynamic frame outside its samples, has no transform then.
- A cycle of frames is invalid data. Which way round the frames on it are resolved is unspecified.

## Errors

HTTP errors contain a stable `code` and a human-readable `error`; terminal stream errors contain `type: "error"`, the same `code` and a human-readable `message`. Clients tell failures apart by `code` and never parse the descriptions. A code the client does not know is still a failure, never an empty result. A message that cannot be converted to a view is a `frame` with `error`, not a terminal error, and the stream goes on.

An empty latest message is `null`; an empty history or latest view ends with `complete`. A group without messages is not a failure: its info has no time range, and its topics read as empty. A recording that cannot be read is `recording_unreadable`, never an empty result.

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed query, invalid value or combination, or a missing required parameter |
| 404 | `run_not_found` | The run does not exist |
| 404 | `group_not_found` | The group does not exist in the run |
| 422 | `unknown_topic` | The topic does not exist in the group |
| 422 | `unknown_field` | The field path is well-formed but not in the schema |
| 422 | `unknown_meta_field` | The meta field does not exist |
| 422 | `unknown_view` | The topic has no view with this ID |
| 422 | `invalid_selection` | The field exists but cannot be used for the request, such as a non-scalar field with `preview=false` |
| 422 | `recording_unreadable` | The recording cannot be opened, read or decoded |
| 500 | `internal_error` | An unexpected server failure |

## Compression

A server may compress responses with HTTP content encoding when the client accepts it. Whether it does is up to the server.

Not compressing is faster locally, and compressing wins on slow links. When compressing a stream, flush every batch so that batches still arrive as they are produced. Compressing view frames is rarely worthwhile, since they hold compressed images and dense binary.

## Open issues

- Relative times (starting at 0) cannot be told apart from epoch times
- `/messages` transfers a lot (rows of JSON)
- `known_time_ns` saves the transfer but not the server's work of reading the message
- Measurement time that goes backwards within a recording, after a simulation restart for example, is not modeled: a lookup by stamp may match samples from another stretch of it
- Values whose stamps are on another clock than the transforms, as after replaying a recording, are not detected; aligning by recording time works around it
