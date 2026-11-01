# Hahn

A local viewer for robot and sensor recordings. A Rust server decodes MCAP, CSV, and Parquet files and streams them to the browser, where you can arrange plots, tables, logs, images, 3D views, and maps on a shared timeline.

## Getting started

You need Rust 1.95 or later and Node.js 22.12 or later (or 20.19 or later).

`server/Cargo.toml` depends on a local checkout at `~/repos/eduidl/mcapdecode-rs/mcapdecode/mcapdecode`. If yours is elsewhere, change that path.

```bash
npm --prefix client ci
npm --prefix client run build
cargo run --manifest-path server/Cargo.toml --release
```

Open <http://127.0.0.1:3000> and select a run. Hahn looks for recordings in `data/`, which Git ignores.

### Sample recording

[CANOE Multimodal](https://huggingface.co/datasets/Voxel51/canoe-multimodal) is a public recording of an uncrewed boat, repackaged by Harpreet Sahota from the CANOE dataset by UTIAS ASRL and distributed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This 30-second recording is about 1.97 GB and includes camera images, LiDAR, GPS, and transforms.

```bash
mkdir -p data
curl -fL -o data/canoe-2025-08-20-16-07.mcap 'https://huggingface.co/datasets/Voxel51/canoe-multimodal/resolve/fedc018d2163661f696a4485d40e96bb84148ec8/data/canoe-2025-08-20-16-07_ep000.mcap'
```

Restart the server, select the run, and try `/cam_left` in Image, `/lidar` in 3D, `/gps` in Map or Plot, and the TF tree widget. The server cannot decode this recording's JSON-encoded topics or convert its raw radar and sonar images.

## Server options

| Option | Default | Description |
| --- | --- | --- |
| `--data-dir <DIR>` | `data` | Where to look for recordings |
| `--listen <ADDR>` | `127.0.0.1:3000` | Address to listen on |
| `--web-dir <DIR>` | `client/dist` | Built client to serve |
| `--timezone <ZONE>` | Not set | Time zone offered to the client, such as `Asia/Tokyo` |
| `--gzip` | Off | Compress API responses. Use it over a network; it is slower on localhost |

The server has no authentication, so take care when listening on anything other than localhost.

## Recordings

The server reads the data directory once at startup, so restart it after adding recordings. It does not follow symbolic links. Do not change, overwrite, or truncate a recording while the server is running.

### How files become runs

A run is what you open. It contains one or more groups, which you can open and close individually on a shared timeline.

- A file directly in the data directory is a run with one group.
- A directory directly in the data directory is a run. Each file inside it, at any depth, is a group.
- A directory with a rosbag2 `metadata.yaml` is a bag, whose `<prefix>_<n>.<ext>` files are read in order as one group. Their time ranges must not overlap. A bag directly in the data directory is a run with that one group.
- Numbered files outside a bag are separate groups.

### Formats

| Format | Requirements |
| --- | --- |
| MCAP | Must be chunked and indexed. Decodes ROS 2 and Protobuf. JSON channels are not decoded into fields |
| CSV | One file is one topic, and one row is one message |
| Parquet | One file is one topic, and one row is one message |

For CSV and Parquet:

- The first column is the time, in absolute time since the epoch. A time starting from 0 will not line up with other recordings.
- A numeric time column's unit comes from its name: `_ns`, `_us`, or `_ms`, and otherwise seconds. Parquet timestamp columns use their own unit.
- In CSV, a dot in a column name makes a nested field, so `pose.x` becomes `x` inside `pose`. An empty cell is a missing value.
- The whole file is loaded into memory.

## Controls

| Input | Action |
| --- | --- |
| Wheel | Zoom the time axis of a plot or state row |
| Shift + wheel | Zoom the value axis of a plot |
| Click a plot or state row | Move the playback position there |
| Click a legend item | Show or hide that series |
| Drag | Pan or box zoom, depending on the widget's mode |
| Double-click a plot or state row | Reset its view |
| Double-click a field, or press Enter on it | Add it to the selected widget |
| Space | Play or pause |
| Left / Right | Move 0.1 s back or forward |
| Shift + Left / Right | Move 1 s back or forward |
| Escape | Restore a maximized widget |

Your workspace is saved in the browser and restored on reload, except for the playback position.

## Privacy

The Map widget gets its tiles from OpenStreetMap by default, which sends the area you view to that service. You can change the tile URL or turn tiles off in the widget's settings.

## Limitations

- All points of a selected field are transferred and kept in browser memory, so memory use grows with the points you load.
- Live streaming, authentication, array expansion, expressions, and XY plots are not supported.

## Extending

- **Image converters:** Rust applications embedding Hahn can implement `hahn::ImageConverter` and pass it to `hahn::router_with_image_converters`. Other view types use the built-in converters. See `external_image_converter_is_declared_and_served` in [`server/tests/api.rs`](server/tests/api.rs).
- **Formats:** Implement the `Source` trait in [`server/src/source/mod.rs`](server/src/source/mod.rs).
- **Other servers:** The HTTP API is specified in [`protocol/openapi.json`](protocol/openapi.json) and [`protocol/README.md`](protocol/README.md).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md).
