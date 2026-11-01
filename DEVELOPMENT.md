# 開発の進め方

現行のクライアントとRustサーバで動く範囲を基準に、一つの操作単位で変更します。各変更の説明に「できるようにする操作」と「確認方法」を短く書きます。

## 実装と仕様

- 実装・利用側・テスト・現行仕様を同じ変更で更新します。APIの変更後は `npm --prefix client run gen:api` で型を生成します。
- `protocol/openapi.json` と `protocol/README.md` が現行契約です。安定版の互換性保証はまだ設けません。
- `protocol/drafts/` は未実装案の保存場所です。案の完成を現在の変更の条件にせず、必要になった部分だけ実装と合成データのテストを伴って取り込みます。

## データと確認

`data/` 全体はGit管理外です。

通常の確認には、READMEに記載のRust・Node.jsとローカルの `mcapdecode` 依存が必要です。

```bash
npm --prefix client ci                       # 初回のみ
cargo test --manifest-path server/Cargo.toml --locked                      # 実録画テストは既定でignore
npm --prefix client test                    # 生成型の一致も検査
npm --prefix client run build
npm --prefix client run format:check      # Check formatting
scripts/conformance.sh                   # 合成録画の生成・起動・削除を含む
```

Run `npm --prefix client run format` to format the client. Generated API types are excluded.

適合性テストは既定で `127.0.0.1:3918` を使います。使用中なら `CONFORMANCE_PORT=3919 scripts/conformance.sh` のように変更します。

別のサーバを検査する合成録画は、次のコマンドで生成できます。出力先は `data/` 以下かリポジトリ外にしてください。

```bash
mkdir -p data/samples
cargo run --manifest-path server/Cargo.toml --locked --example generate_demo -- data/samples/demo.mcap 2200
cargo run --manifest-path server/Cargo.toml --locked --example generate_visual -- data/samples/visual.mcap
```

この2つの録画を配信するサーバに対して、`client/` で `BASE_URL=http://host:port npm run conformance` を実行します。実データの比較は任意のローカル確認です。必要な場合だけ `MCAP_TEST_DATA_DIR=/path/to/recordings cargo test --manifest-path server/Cargo.toml --locked --test real_data -- --ignored` を実行し、録画や出力を共有するテストへ持ち込みません。

## Running the client in development

Start the server, then run `npm --prefix client run dev`. Vite forwards `/api` to port 3000.

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

Time series, State transition, Log, Table, Raw message, Image, 3D, Map, TF tree, Data source info, Tabs.

Each name is defined once, as `label` in `widgetSpecs`. The widget list, title bar, and menus all use it.

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

- Use sentence case: `Time series`, not `Time Series`. Keep the usual form of proper nouns and abbreviations such as `TF`, `3D`, and `OpenStreetMap`.
- Write headings in sentence case in the source. Use CSS for all-caps display.
- Start buttons and menu items with a verb. The exception is an add button, which uses `+ Noun` (`+ Widget`, `+ Field`, `+ Tab`) and has `aria-label="Add widget"` or similar.
- End complete sentences with a period. Leave it off fragments and labels: `No errors`, `Show all`.
- End search placeholders with an ellipsis: `Search runs…`.
- In a confirmation dialog, ask a question in the title and use the action's verb on the confirm button (`Delete tab?` and `Delete`). State what will be lost.
- Say why an action cannot be done, and what to do instead when there is a next step.

## Reviewの完了条件

- 修正必須は、再現できる不具合、情報漏洩・データ損失、今回の操作に必要な時刻や座標の誤り、既存の利用側の破損です。指摘には具体的な発生条件か再現例を付けます。
- 将来の拡張、未採用の利用ケース、好みの設計変更は別課題として記録し、今回の完了条件に追加しません。
- 初回レビューと修正確認を基本にします。再レビューで必須指摘を追加する場合も、具体的な破損条件か再現例を必要とします。
- 変更に必要な合成データの確認が通り、必須指摘を解消したら完了です。未実施の確認や残る制限は明記します。
