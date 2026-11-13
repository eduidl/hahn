# Hahn

A local viewer for robot and sensor recordings. A Rust server decodes MCAP files and streams them to the browser, where you can arrange plots, tables, logs, images, 3D views, and maps on a shared timeline.

## Getting started

You need Rust 1.95 or later and Node.js 22.12 or later (or 20.19 or later).

With [mise](https://mise.jdx.dev/), `mise install` sets up the versions the project is checked with (`mise.toml`).

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
| `--data-dir <DIR>` | `data` | Where to look for recordings. A recording file is served as the only run |
| `--listen <ADDR>` | `127.0.0.1:3000` | Address to listen on |
| `--web-dir <DIR>` | `client/dist` | Built client to serve |
| `--timezone <ZONE>` | Not set | Time zone offered to the client, such as `Asia/Tokyo` |
| `--gzip` | Off | Compress API responses. Use it over a network; it is slower on localhost |

The server has no authentication, so take care when listening on anything other than localhost.

## Desktop app

Hahn can also run as a desktop application built with [Tauri](https://tauri.app/). It opens one MCAP file at a time: drop it onto the window, or click "Select run" in the header to pick it from your files. Dropping files is not available on Windows. It serves the recording on `127.0.0.1` itself and shows the client in its own window, so no browser or separate server is needed.

Building it needs, in addition to the above, the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform. On Debian or Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev
```

To run it from the repository, install its tools once with `npm --prefix desktop ci`, then:

```bash
npm --prefix desktop run dev -- [recording.mcap]    # or: mise run desktop:dev
```

This starts the client's development server and the app together. Changes to the client show in the window at once, and changes to `desktop/` or `server/src/` rebuild and restart the app on the same recording. Without a recording, it starts with no run open.

To build an installer for your platform, run `npm --prefix desktop run build` (or `mise run desktop:build`). It builds the client and bundles it into the packages written to `desktop/target/release/bundle/`.

| Option | Default | Description |
| --- | --- | --- |
| `<FILE>` | None | Recording to open when it starts |
| `--port <PORT>` | `3917` | Port on `127.0.0.1` to serve on. When it is in use, any free port is used |
| `--web-dir <DIR>` | The bundled client, or `client/dist` | Built client to serve |
| `--dev` | Off | Show the client from the development server in `build.devUrl`. `npm --prefix desktop run dev` sets it |
| `--timezone <ZONE>` | This computer's time zone | Time zone offered to the client. An empty value offers none |

The workspace is saved for each port, so it is restored only when the app serves on the same port as before. Opening another recording keeps the widgets and moves their series to it. Links to other sites open in your default browser.

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

To read other formats, see [Showing your own message types](#showing-your-own-message-types).

## Controls

| Input | Action |
| --- | --- |
| Wheel | Zoom the time axis of a plot or state row |
| Shift + wheel | Zoom the value axis of a plot |
| Wheel or drag on an image | Zoom, or pan while zoomed |
| Click a plot or state row | Move the playback position there |
| Click a legend item | Show or hide that series |
| Drag | Pan or box zoom, depending on the widget's mode |
| Drag a state row while zoomed | Pan the time axis |
| Double-click a field, or press Enter on it | Add it to the selected widget |
| Space | Play or pause |
| Left / Right | Move 0.1 s back or forward |
| Shift + Left / Right | Move 1 s back or forward |
| Escape | Restore a maximized widget |

Your workspace is saved in the browser and restored on reload, except for the playback position. To open a run from a link, add `?run=<id>` to the address with the run's ID from the API; the widgets stay and their series move to that run.

Selecting another run keeps your series. Each moves to the group with the same name, or otherwise the first open one, and finds its topic and field by name. A series that cannot be shown stays in its widget with a warning in the settings, and comes back when a run or group that has it is open.

## Privacy

The Map widget gets its tiles from OpenStreetMap by default, which sends the area you view to that service. You can change the tile URL or turn tiles off in the widget's settings.

## Limitations

- All points of a selected field are transferred and kept in browser memory, so memory use grows with the points you load.
- Live streaming, authentication, array expansion, expressions, and XY plots are not supported.

## Extending

### Showing your own message types

Hahn shows a topic as an image, point cloud, pose, map location or camera calibration when a converter accepts its type, and reads it as transforms between coordinate frames when a transform reader accepts it. To add either for your own types, or to read a file format other than MCAP, build your own server on the `hahn` crate:

1. Create a Rust crate that depends on `hahn` (for now, as a path dependency on `server/`).
2. For each type, implement `hahn::ViewConverter`: `accepts` decides from the schema name and fields (`hahn::schema` has checks for field types), and `convert` reads a `hahn::Message` and returns a `hahn::View`, such as a `PoseView` or `PointCloudView`. Hahn checks every value before sending it, and a message that cannot be converted shows an error for that message only. The value's measurement time is read from `header.stamp` or `timestamp`; override `stamp` if your type keeps it elsewhere.
3. For each type that holds coordinate frames, implement `hahn::TransformReader`: `read` returns the transforms a message holds as `hahn::TransformSample`s, each with its measurement time in `stamp_ns` when the message has one. They join the run's frames with those of `/tf`. Transforms on a topic ending in `tf_static` hold at all times; override `is_static` to decide otherwise.
4. For a file format, implement `hahn::Format`, which recognizes its files by path and opens them as a `hahn::Source`. A source lists its topics with their fields (`hahn::FieldDefs`), reports its time range (none for a recording without messages), and reads the messages of a topic within a time range as `hahn::Value`s. Files of your format become runs and groups like MCAP files, and are tried before MCAP.
5. In `main`, call `hahn::cli::main(|builder| builder.view(MyConverter).transforms(MyReader).format(MyFormat))`. The server takes the same options as Hahn and lists every view it offers when it starts.

[`server/examples/custom_server.rs`](server/examples/custom_server.rs) shows a type `acme_msgs/msg/Pose2D` as a pose, reads `acme_msgs/msg/Link2D` as transforms, and opens a text format `.acmelog` ([`server/examples/support/acme_log.rs`](server/examples/support/acme_log.rs)). To try it:

```bash
cargo run --manifest-path server/Cargo.toml --example generate_acme -- data/samples/acme/acme.mcap
cargo run --manifest-path server/Cargo.toml --example custom_server -- --data-dir data/samples/acme
```

Then select `acme.mcap` and add `/acme_pose` to a 3D widget, or open the TF tree widget to see `map`, `base` and `sensor`. Select `acme.acmelog` to plot `/speed` and `/battery`.

### Other servers

The HTTP API is specified in [`protocol/openapi.json`](protocol/openapi.json) and [`protocol/README.md`](protocol/README.md).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md).
