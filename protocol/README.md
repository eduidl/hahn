# Hahn Protocol

This document describes the concepts of the HTTP protocol between the shared client and each server implementation, and the binary format of view frames.

[`openapi.json`](openapi.json) holds the operations and every field: their types, whether they are required, their meaning, their units and examples. Its schemas follow the order of the operations rather than the alphabet. Each fact is written in only one of the two documents.

## Principles

- Servers are implemented by hand against these documents.
- There is one client and several servers. The protocol contains nothing that depends on how a server is built.
- Files are not exposed. The client deals in runs and groups. Layouts such as numbered files stay inside the server.

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
