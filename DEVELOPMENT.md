# 開発の進め方

現行のクライアントとRustサーバで動く範囲を基準に、一つの操作単位で変更します。各変更の説明に「できるようにする操作」と「確認方法」を短く書きます。

## 実装と仕様

- 実装・利用側・テスト・現行仕様を同じ変更で更新します。APIの変更後は `npm --prefix client run gen:api` で型を生成します。
- `protocol/openapi.json` と `protocol/README.md` が現行契約です。安定版の互換性保証はまだ設けません。
- 設計の判断は `docs/adr/` に記録します。契約の考え方を変えるときは、先に ADR を書くか直し、実装・現行仕様・テストをそれに合わせます。
- サーバのテストは `server/tests/` に置き、HTTP API と `hahn` クレートの公開 API だけを通して確かめます。`server/src/` にはテストを書きません（`server/tests/sources.rs` が検査します）。任意のスキーマと値は、`server/tests/api/memory.rs` のメモリ上の録画で用意できます。

## データと確認

`data/` 全体はGit管理外です。

通常の確認には、READMEに記載のRust・Node.jsが必要です。

```bash
npm --prefix client ci                       # 初回のみ
cargo test --manifest-path server/Cargo.toml --locked                      # 実録画テストは既定でignore
npm --prefix client test                    # 生成型の一致も検査
npm --prefix client run test:visual         # スクリーンショットを基準画像と比較
npm --prefix client run build
npm --prefix client run format:check      # Check formatting
npm --prefix client run lint              # Lint
scripts/conformance.sh                   # 合成録画の生成・起動・削除を含む
scripts/e2e.sh                           # ブラウザでの通しテスト（合成録画を使用）
```

Run `npm --prefix client run format` to format the client. Generated API types are excluded.

With mise, `mise run check` runs all of the checks above. `mise tasks` lists the individual tasks.

適合性テストは既定で `127.0.0.1:3918` を使います。使用中なら `CONFORMANCE_PORT=3919 scripts/conformance.sh` のように変更します。

通しテストは、ビルドしたクライアントを合成録画とともに `127.0.0.1:3920`（`E2E_PORT` で変更）で配信し、Chromium で操作します。結果は `client/playwright-report/index.html` に、各テストのスクリーンショットと操作の記録付きで残ります。意図して見た目を変えたときは `scripts/e2e.sh --update-snapshots` で基準画像を撮り直し、差分を確認してからコミットします。ウィジェット単位の基準画像（`client/test/visual/`）は `npm --prefix client run test:visual -- --update` で撮り直します。

別のサーバを検査する合成録画は、次のコマンドで生成できます。出力先は `data/` 以下かリポジトリ外にしてください。

```bash
mkdir -p data/samples
cargo run --manifest-path server/Cargo.toml --locked --example generate_demo -- data/samples/demo.mcap 2200
cargo run --manifest-path server/Cargo.toml --locked --example generate_visual -- data/samples/visual.mcap
```

この2つの録画を配信するサーバに対して、`client/` で `BASE_URL=http://host:port npm run conformance` を実行します。実データの比較は任意のローカル確認です。必要な場合だけ `MCAP_TEST_DATA_DIR=/path/to/recordings cargo test --manifest-path server/Cargo.toml --locked --test real_data -- --ignored` を実行し、録画や出力を共有するテストへ持ち込みません。

ROS 2 と Foxglove の型を画面で見て確かめる録画は、次のコマンドで生成できます。車両が20秒かけて円を描き、カメラ画像とキャリブレーション、計測から 100 ms 遅れて記録される点群、画像と同じ計測時刻で 50 ms 遅れて記録される2Dの検出、3Dの箱、経路、姿勢の集まり、位置、GNSS、GeoJSON の図形を含みます。3D 表示の「Align by」を Log time にすると点群が遅れの分ずれ、画像ウィジェットに `/camera/detections` を足すと検出枠が動く四角に重なります。

```bash
cargo run --manifest-path server/Cargo.toml --locked --example generate_ros2_scene -- data/ros2_scene.mcap
```

ROS 2（CDR）の型を確認する録画は、次のコマンドで生成できます。`generate_ros2` は合成データです。`foxglove_to_ros2` はFoxgloveの録画を実際の画像や点群のままROS 2へ変換するので表示の確認に使えますが、実機のドライバが書くメッセージとは限りません。変換前の録画のライセンスは変換後にも適用されます。

```bash
cargo run --manifest-path server/Cargo.toml --locked --example generate_ros2 -- data/samples/ros2.mcap
cargo run --manifest-path server/Cargo.toml --locked --release --example foxglove_to_ros2 -- input.mcap data/samples/converted.mcap 20
```

## Running the client in development

Start the server, then run `npm --prefix client run dev`. Vite forwards `/api` to port 3000.

## Desktop app

`desktop/` wraps the server and the built client in a Tauri window ([ADR 0011](docs/adr/0011-desktop-app.md)). It adds no API, and the client differs only in what "Select run" does (`client/src/desktop.ts`), so the checks above cover what it shows. After changing `desktop/`, or the `hahn` crate's public API it uses, check that it builds, starts with no run when given no recording, opens the recording it is given, and opens another one from "Select run" and by dropping an MCAP file onto the window:

```bash
cargo clippy --manifest-path desktop/Cargo.toml --locked
npm --prefix desktop run dev -- data/ros2_scene.mcap
```

`npm --prefix desktop run dev` runs `tauri dev`. The window loads the client from Vite on port 5174 (`npm --prefix client run dev:desktop`), which forwards `/api` to the app on port 3917 instead of 3000, so it can run beside a server started for the browser. Client changes are applied in place; changes to `desktop/` or `server/src/` rebuild and restart the app. `npm --prefix desktop run build` merges `desktop/tauri.bundle.json`, which builds the client and bundles it; the app run from the repository serves `client/dist` instead.

Building it needs the system libraries listed in the README. `mise run check` does not build it, so that the other checks run without them.

## Measuring performance

Use a release build with a real topic and field.

```bash
python3 scripts/measure_stream.py http://127.0.0.1:3000/api/runs/$RUN/groups/$GROUP/messages \
  --topic <topic> --field <field>
```

This prints the seconds to the first batch and to completion, the bytes transferred, and the row count. To see the server's peak memory, start it with `/usr/bin/time -v server/target/release/hahn --data-dir ...`; memory-mapped file pages count toward it. In the browser, use the Performance and Memory tools. Measure the first load separately from later loads that benefit from the OS cache.

## UI wording

Follow these rules for all text a user can see or hear, including tooltips and `aria-label`s.

`client/test/wording.test.ts` checks the rules that can be checked mechanically.

### Terms

| Use | Meaning | Do not use |
| --- | --- | --- |
| run | What the user selects and opens | recording, file, log (for a run) |
| group | A part of a run that can be opened or closed | source, recording |
| topic | A message stream in a group | channel |
| field | A value inside a topic's messages | signal, column (except in Table) |
| series | A field or topic added to a widget | line, trace |
| widget | An item placed in the workspace | panel, tile, pane |
| tab | A page inside a Tabs widget | page |
| settings | A widget's options in the sidebar | panel settings |

### Widget names

3D, Data source info, Image, Map, Plot, Raw message, State table, State timeline, Table, Tabs, TF tree.

Each name is defined once, as `label` in `widgetSpecs`. The widget list, title bar, and menus all use it. Widget lists show the names in this alphabetical order.

### Actions

| Word | Use for |
| --- | --- |
| Select | Choosing or replacing one item, such as a run or a target |
| Add | Putting something new into a widget or the workspace |
| Remove | Taking a series out of a widget. The series' data is not affected |
| Clear | Removing all series from a widget, which stays in place |
| Delete | Destroying a widget or tab and what it contains |
| Close | Dismissing a dialog or closing a group. Nothing is lost |
| Reset | Returning to the initial state |

### Style

- Use sentence case: `State timeline`, not `State Timeline`. Keep the usual form of proper nouns and abbreviations such as `TF`, `3D`, and `OpenStreetMap`.
- Write headings in sentence case in the source. Use CSS for all-caps display.
- Start buttons and menu items with a verb. The exception is an add button, which uses `+ Noun` (`+ Field`, `+ Tab`) and has `aria-label="Add field"` or similar. The header's add widget button is an icon, with `aria-label` and `title` set to `Add widget`. A button that switches between two modes shows the current mode, and its `aria-label` and `title` start with a verb (`Switch to offset time`).
- End complete sentences with a period. Leave it off fragments and labels: `No errors`, `Show all`.
- End search placeholders with an ellipsis: `Search runs…`.
- In a confirmation dialog, ask a question in the title and use the action's verb on the confirm button (`Delete tab?` and `Delete`). State what will be lost.
- Say why an action cannot be done, and what to do instead when there is a next step.

## Reviewの完了条件

- 修正必須は、再現できる不具合、情報漏洩・データ損失、今回の操作に必要な時刻や座標の誤り、既存の利用側の破損です。指摘には具体的な発生条件か再現例を付けます。
- 将来の拡張、未採用の利用ケース、好みの設計変更は別課題として記録し、今回の完了条件に追加しません。
- 初回レビューと修正確認を基本にします。再レビューで必須指摘を追加する場合も、具体的な破損条件か再現例を必要とします。
- 変更に必要な合成データの確認が通り、必須指摘を解消したら完了です。未実施の確認や残る制限は明記します。
