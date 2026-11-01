# Hahn

The TF Tree widget shows the coordinate-frame hierarchy for the open run. Drag to pan, use the mouse wheel or buttons to zoom, and select Fit to show the whole tree. It displays each frame's last recorded parent; the hierarchy does not change with playback time.

Select a frame to see its translation and quaternion relative to that displayed parent at the playback time. The timestamp shown with the pose identifies the response currently displayed. A transform unavailable at that time is reported instead of extrapolated.

ローカルの録画（MCAP・CSV・Parquet）をRustでデコードし、ブラウザへ逐次配信するプロットビューワ。複数の録画を共通の時間軸に並べて表示できます。

## Public sample recording

[CANOE Multimodal](https://huggingface.co/datasets/Voxel51/canoe-multimodal) is a public recording of an uncrewed boat, repackaged by Harpreet Sahota from the CANOE dataset by UTIAS ASRL and distributed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This 30-second, approximately 1.97 GB recording includes camera images, LiDAR, GPS and transforms:

```bash
mkdir -p data
curl -fL -o data/canoe-2025-08-20-16-07.mcap 'https://huggingface.co/datasets/Voxel51/canoe-multimodal/resolve/fedc018d2163661f696a4485d40e96bb84148ec8/data/canoe-2025-08-20-16-07_ep000.mcap'
```

Restart the server, select `canoe-2025-08-20-16-07.mcap`, and try `/cam_left` in Image, `/lidar` in 3D, `/gps` in Map or Time Series, and TF Tree. The recording also includes JSON-encoded IMU, motor, and velocity topics and raw radar and sonar images; the current server cannot decode JSON topics or convert raw images to views.

## Custom image converters

Rust applications embedding Hahn can implement `hahn::ImageConverter` and pass it to `hahn::router_with_image_converters`. The built-in converters remain available. Each converter needs a unique, nonempty ID and must check the schema name and fields in `accepts`. Its `convert` method reads the decoded `Message` and returns an `ImageView`; Hahn validates the image format and handles framing and delivery. See `external_image_converter_is_declared_and_served` in [`server/tests/api.rs`](server/tests/api.rs) for a complete example.

This extension currently covers encoded images only. Point clouds, geographic views, and transforms still use the built-in converters. The decoded message types come from `mcapdecode`, which is currently a local path dependency.

## 起動

Rust 1.95以上、Node.js 22.12以上（または20.19以上）が必要です。
`server/Cargo.toml` は手元の `~/repos/eduidl/mcapdecode-rs/mcapdecode/mcapdecode` を相対パスで参照しています。
別の場所にチェックアウトした場合は、この依存パスを変更してください。

```bash
cd client
npm ci
npm run build
cd ..
cargo run --manifest-path server/Cargo.toml --release
```

録画は既定でリポジトリ直下の `data/` から探します（サブディレクトリも対象）。別の場所は `--data-dir` で指定します。
`data/` 全体はGit管理から除外しています。

<http://127.0.0.1:3000> を開き、録画と数値フィールドを選択します。
起動時、またはヘッダーの走行選択ボタンから、走行を検索できる一覧ダイアログを開きます。走行を開いている間、このボタンには走行名を表示します。走行を選ぶと、サーバが既定に指定したグループを開きます。複数のグループがある場合は、ヘッダーのフォルダアイコンで開閉します。データは届いたものから表示します。

- 中央エリアはTIME SERIES・STATE TRANSITIONウィジェットを上下左右に分割して配置します。ヘッダーの「ウィジェットを追加」で種類の一覧を開き、既存ウィジェットへドラッグすると（一覧はドラッグを始めると閉じます）、ドロップ位置に最も近い辺（左右上下）の側へ分割して空のウィジェットを追加します。ウィジェットがないときは中央エリアへドロップします。タイトルバーをドラッグして組み替え、境界線でサイズを変更できます。中央エリアの全体サイズは表示領域に固定し、分割を増やしてもスクロールせず各ウィジェットが縮みます。
- 各ウィジェットの最大化ボタンで一時的に中央エリア全体へ広げられます。同じボタンまたはEscapeで元の配置に戻り、表示範囲と取得済みデータは維持します。
- 各ウィジェットのメニューから左右分割・上下分割・ウィジェットの変更・クリア・削除ができます。「ウィジェットを変更」にポインタを合わせると右（右端では左）にサブメニューが開き、別の種類へ切り替えます。切り替えると、同じ位置にその種類の初期状態のウィジェットを置きます（系列や設定は引き継ぎません）。

  クリアはそのウィジェットの系列をすべて外して表示範囲を初期状態に戻し、型の制約も未指定に戻します（横軸の時刻表示などの設定は維持）。系列がないときは無効です。

  分割は元のウィジェット（種類・系列・色・線幅・表示状態・横軸の時刻表示）を複製します。複製先の軸は初期状態です。空のウィジェットが必要ならクリアするか、「ウィジェットを追加」から配置します。
- クリックで設定対象を選択し、歯車ボタンで左のパネル設定を開きます。フィールドのドロップは対象ウィジェットだけに適用し、サイドバーのタブは切り替えません。
- パン／ズーム・リセット・系列の表示設定はウィジェットごとに独立します。同じフィールドの取得データは共有し、配置・サイズ・表示設定の変更では再取得しません。
- 同時に開ける走行は1つです。開いているグループの最も早い開始時刻から最も遅い終了時刻までを共通の時間軸とします。トピック一覧にはグループごとの見出しを表示し、複数のグループを開いているときは系列にもグループ名を表示します。別のグループにある同名のトピックは区別します。
- グループを開閉しても配置と他のグループの系列は保持します。閉じたグループの系列は削除し、すべての軸をリセットします。取得済みデータは時間軸の開始が変わったときだけ再取得します。走行を切り替えると配置とウィジェット設定は保持し、すべての系列をクリアします。配置は保存せず、ページを再読み込みすると空のウィジェット1つに戻ります。タブの保存は未対応です。

- 複数のトピック・数値フィールドを重ね描き。
- TIME SERIESは数値・bool・enumを表示します。系列のない状態では全型を受け付け、最初に追加した系列の型（数値／bool／定義が一致するenum）だけを重ねられます。系列をすべて削除すると再び全型を受け付けます。bool・enumは縦軸を離散値で表示します。STATE TRANSITIONはbool・enum・stringを1系列1行で表示し（空文字列は「（空文字列）」と灰色で表示）、型やenumの定義が異なる系列も並べられます。
- DATA SOURCE INFOは開いているグループの開始・終了時刻、長さ、メッセージ数、トピック数と、トピックごとのスキーマ・メッセージ数を表示します。メッセージ数はサーバが返さない場合「—」と表示します。読み込めなかったグループとトピックはエラーを表示します。
- LOGはstring・enum・boolフィールドの値が変わった時点だけを、複数系列まとめて時刻順の一覧で表示します（系列は色で区別）。再生位置の行を強調して自動でスクロールし、行をクリックするとその時刻へ移動します。見えている行だけを描画するので長い録画でも軽量です。
- TABLEはヘッダー右端のドラッグでカラム幅を調整できます（左右キーでも調整可、ダブルクリックまたはHomeキーで初期幅に戻す）。各カラムのヘッダーにマウスを重ねると表示される×ボタンで、そのカラムを非表示にできます。既定幅は型に応じて変え、boolは72px、小さい整数は80〜104px、64bit整数は160px、浮動小数は104〜136px、文字列は160px、enumはラベルの長さに応じて96〜160px、配列などは180pxです。時刻は実時刻192px／相対時刻104pxとし、手動調整した幅を優先します。幅はウィジェットごとに保持し、表示対象の変更で初期化します。
- TABLEのパネル設定では「全表示」「全非表示」でカラムを一括切り替えでき、「カラム」のチェックボックスで列ごとにも表示・非表示を切り替えられます（時刻列は常に表示）。表示設定はウィジェットごとに独立し、切り替えても再取得しません。表示対象を変更すると全カラム表示に戻ります。
- TABLEはRAW MESSAGEと同じくトピックまたはフィールドを1つ指定し、その配下の履歴を1メッセージ1行で表示します。構造体は末端まで列に展開し、配列・bytes・mapは1セルにまとめます。長い値の省略基準はRAW MESSAGEと共通です。再生位置の行を強調して自動スクロールし、クリックまたはEnter／Spaceでその時刻へ移動します。固定ヘッダー・時刻列、横スクロールと行の仮想化を備え、共通の「停止」で受信を止めて部分データを確認できます。
- RAW MESSAGEは任意のトピック（メッセージ全体）またはフィールドを1つ選び、再生位置の時点で最新のメッセージを折りたたみ可能なツリーで表示します。再生中も追従し、「すべて展開」で全階層を開き、「初期表示に戻す」で最上位の1階層だけを開いた状態に戻せます。長い配列は先頭100件、bytesは長さと先頭32バイトに省略します。取得には `GET /api/runs/{run}/groups/{group}/messages/latest?topic=&path=&time_ns=` を使います。
- ホイールは横軸だけ、Shift＋ホイールは縦軸だけをマウス位置中心で拡大縮小。片方の操作で他方の範囲は変更しません。
- ホイール1イベントにつき拡大は1.1倍、縮小はその逆数を掛け、両軸とも1倍を下限とします。
- ドラッグは標準でパン（横・縦方向の移動）。「パン／範囲ズーム」ボタンでモードを切り替え、範囲ズームでは横方向にドラッグして時間範囲を拡大します。ホイール操作はどちらのモードでも共通です。
- パンの移動範囲は両軸とも制限しません。1倍のままでも録画範囲の外へ移動でき、移動先でズームしても位置を元の範囲に引き戻しません。
- 横軸の表示は標準で実時刻（日付・ミリ秒付き）です。タイムゾーンはヘッダー右上で全体に対して選びます。パネル設定の「横軸の時刻表示」で録画開始からの秒数に切り替えられます。表示形式はウィジェットごとに独立し、変更しても表示範囲や取得データは変わりません。
- 横軸は録画全期間、縦軸は取得済み全点の範囲を基準（1倍）とします。表示操作を始めた時点で縦軸の基準も固定し、時間範囲に合わせた自動リスケールは行いません。
- 縦軸の目盛りは1・2・5×10ⁿ刻みです。ラベルが長くなる場合、大きな値が少し変化するときはオフセット（例: `+1,767,569,400`）、それ以外は共通の指数（例: `×10⁹`）を軸の上にまとめて表示し、両方を併用することもあります。左の余白はラベル幅に合わせて変わります。正確な値はツールチップで確認できます。
- ダブルクリックまたは「リセット」で両軸の倍率・位置を戻します。縦軸の基準はその時点で取得済みの全点から更新します。読み込み中は表示操作をするまで新しいデータに合わせて初期範囲を広げます。
- 初期表示ではリセットボタンは無効です。表示範囲を変更すると有効になり、リセット後は再び無効になります。
- TIME SERIESは色と系列の対応を示す凡例を常時表示します（既定は左上）。凡例の表示・非表示と位置（左上・右上・左下・右下）はパネル設定で変更できます。ホバー時はカーソルの近くにツールチップを出し、時刻と各系列の最寄りのサンプル値を色付きで表示します。パネル設定で系列の表示を切り替えられます。
- 左カラムは「パネル設定」「トピック」「エラー」の3タブで、初期表示はパネル設定です。数値フィールドをプロットまたはパネル設定へドロップして追加できます。パネル設定の「＋ フィールドを追加」で、選択中のウィジェットに今追加できるフィールドだけを検索欄付きの一覧で開き、選ぶ（またはEnterで先頭を選ぶ）と追加して閉じます（候補は録画ごとに事前計算した索引から絞り込みます）。

  TABLE・RAW MESSAGEは「表示対象を指定」でトピックまたはフィールドを1つ選び、現在の表示対象を置き換えます。この2種類のパネル設定では表示対象の名前を表示し、表示切替・削除ボタンは設けません。

  複数系列を扱うウィジェットのパネル設定には選択した系列の読み込み状況・表示切替・削除・色・線幅（Time Seriesのみ）の設定をまとめ、フィールド選択のチェックボックスは設けません。

  トピック自体はルートメッセージのstructとして扱い、プロット系ウィジェットには追加できません。トピック一覧はパネルと独立した共通設定で、選択チェックボックスは持たず、ドロップしてもタブは切り替えません。文字列・配列・構造体なども表示・ドラッグでき、ドラッグ中は各ウィジェットに追加できるかを表示し、追加できないウィジェットには理由を表示してドロップを受け付けません。スクロール領域はバーの幅を事前に確保します。
- トピック一覧は各トピックの型とメッセージ数（例: `sensor_msgs/msg/PointCloud2 · 151 件`）を表示します。メッセージが0件のトピックは薄く表示し、ウィジェットへのドロップやフィールド追加の候補から外します。
- 読み取り不可トピックは初期状態で非表示。「エラーのあるトピックを表示」のチェックボックス1つで一括表示を切り替え、理由はトピックの展開部分とエラータブに表示します。
- 受信中は画面下部の再生バー右端の「停止」で全ウィジェットの受信を中断できます。
- 画面最下部の再生バーは全ウィジェット共通の再生時刻を操作します。再生／一時停止、先頭・末尾への移動、0.1秒ステップ、倍速（0.1〜10×）、ループ再生を備え、トラックのクリック・ドラッグでシークします（再生中のドラッグ後は再生を続けます）。録画の末尾で再生すると先頭から再生します。キーボードはSpaceで再生／一時停止、←/→で0.1秒、Shift＋←/→で1秒移動します（入力欄にフォーカスがあるときは無効）。録画を切り替えると先頭で停止した状態に戻り、倍速とループの設定は維持します。
- IMAGEは画像トピックを1つ指定し、再生位置の時点の画像を表示します。3Dは点群トピックを重ねて表示し（ドラッグで回転、右ドラッグで移動、ホイールで拡大縮小）、各座標系の軸も描きます。点群は取得時刻の変換で固定座標系に置き、固定座標系はパネル設定で選びます。MAPは位置トピックの軌跡と再生位置を表示します。これらはトピック単位で指定し、サーバが変換に対応している型だけを受け付けます（トピック一覧の型名の後に表示します）。現在の対応は `foxglove.CompressedImage`・`foxglove.PointCloud`・`foxglove.LocationFix` で、座標系は `foxglove.FrameTransform` と `foxglove.FrameTransforms` から読みます。
- MAPの背景タイルは既定でOpenStreetMapから取得するため、表示範囲がその配信元に送られます。パネル設定でURLの変更や「使わない」を選べます。
- TIME SERIES・STATE TRANSITIONは再生時刻に縦線を表示します。縦線は表示範囲を動かさず、横軸の外にあるときは表示しません。ズーム・パン・系列の表示切替では通信せず、取得済みデータを使います。

`--timezone Asia/Tokyo` を指定すると、全走行のタイムゾーンとしてクライアントに伝えます。ヘッダー右上の「タイムゾーン」で、ブラウザとサーバのどちらのタイムゾーンで表示するかを選べます。

`--gzip` を指定すると、圧縮に対応するクライアントへのAPI応答を最速レベルで圧縮します。ネットワーク経由で使う場合に指定してください。localhostでは圧縮しない場合より遅くなります。

サーバは既定でlocalhostのみで待ち受けます。`--listen` と `--web-dir` で変更できます。
開発時はサーバを起動したうえで `cd client && npm run dev` を実行します。Viteは `/api` をポート3000へ転送します。

選択中の走行、開いたグループ、ウィジェットの配置と設定、系列、表示範囲はブラウザの `localStorage` に自動保存され、リロード後に復元します。再生位置は復元しません。サイドバー下部の「Reset workspace」から、確認ダイアログで「Reset」を選ぶと、ウィジェット・タブ・系列を消して初期配置に戻せます。開いている走行とグループ、タイムゾーンは維持します。

## 実データでの検証

通常の操作確認には `data/` の録画を使います。実データは容量が大きいため `.gitignore` で除外しているので、新しい環境では `data/` に置いてください。

`data/samples/` には境界条件用のデモMCAP（`demo.mcap`、下記の生成コマンドの出力）、時刻が `demo.mcap` と重なるCSV（`imu.csv`）とParquet（`wheels.parquet`。構造体・dictionary・リストの列を含む）を置いています。まとめて開くと、形式の違う録画を共通の時間軸で確認できます。

`visual.mcap` は画像・点群・位置・座標変換の変換（View）を確認するための録画です。`cargo run --manifest-path server/Cargo.toml --example generate_visual -- data/samples/visual.mcap` で生成します。

```bash
cargo test --manifest-path server/Cargo.toml --test real_data -- --ignored
```

このテストは、データディレクトリ直下の各MCAPから数値フィールドを持つトピックを1つ選び、配信された最初のサンプルをライブラリの直接デコード結果と照合します。
別の保存先を使う場合は `MCAP_TEST_DATA_DIR=/path/to/data` を指定できます。
読み取れないトピックは初期状態でトピック一覧から隠し、エラータブに理由を表示します。「エラーのあるトピックを表示」をオンにすると「読み取り不可」と表示します。スキーマencodingが空のトピックなどを推測でデコードしません。

## 自動テストと境界条件用データ

```bash
mkdir -p /tmp/hahn-demo
cargo run --manifest-path server/Cargo.toml --example generate_demo -- /tmp/hahn-demo/demo.mcap 30000
cargo run --manifest-path server/Cargo.toml -- --data-dir /tmp/hahn-demo
cargo test --manifest-path server/Cargo.toml
cargo clippy --manifest-path server/Cargo.toml --all-targets -- -D warnings
cd client
npm test
npm run build
```

生成データは境界条件の再現用です。2トピック、各30,000サンプル（300秒）を生成し、NaN、欠損したネスト構造、逆転・重複した時刻、JavaScriptの安全な整数範囲を超える値を含みます。

## 対応形式

録画の形式は `server/src/source/mod.rs` の `Source` trait（時間範囲・トピック一覧・スキーマ・時間範囲指定の読み出し）を実装して追加します。値とスキーマは `mcapdecode-core` の `Value`・`FieldDefs` で表し、HTTPハンドラは形式に依存しません。拡張子で形式を判定し、録画は最初のリクエストで開いて保持します。

- MCAP（`.mcap`）: `src/source/mcap.rs`。mmapしたSummaryのStatisticsまたはChunkIndexから時間範囲を取得し、インデックス付き・チャンク化された録画だけを受け付けます。
- CSV（`.csv`）: `src/source/csv.rs`。1ファイルが1トピック（`/ファイル名`）、1行が1メッセージです。全体をメモリに読み込み、時刻順に並べ替えます。
  - 先頭列が時刻です。列名の末尾で単位を決め（`_ns`・`_us`・`_ms`、それ以外は秒）、エポックからの絶対時刻として扱います。小数も丸めずにナノ秒へ変換します。
  - 他の列は全セルから型を推定します（整数→i64、数値→f64、`true`/`false`→bool、それ以外→string）。空セルは欠損値です。
  - `pose.x` のようにドットを含む列名は入れ子の構造体になります。列名の重複や `a` と `a.b` の衝突はエラーです。
  - 0から始まる相対時刻のCSVはMCAPの時間軸と揃いません（録画ごとの時刻オフセットは未対応）。
- Parquet（`.parquet`）: `src/source/parquet.rs`。CSVと同じく1ファイルが1トピック、1行が1メッセージです。全体をArrowの列形式でメモリに読み込み、値は読み出し時に行ごとに組み立てます。
  - 先頭列が時刻です。timestamp型はその単位を使い、整数・浮動小数点の列は列名の末尾で単位を決めます（CSVと同じ規則）。欠損値・負の時刻はエラーです。
  - 他の列はArrowの型をそのまま使います。構造体・リスト・固定長リスト・マップは入れ子のまま扱い、dictionaryは値の型に展開します。最上位の列のdate・time・timestamp・durationはi64、decimalはf64、float16はf32に変換します（入れ子の内側にあるこれらの型は未対応です）。
  - 0から始まる相対時刻はMCAPの時間軸と揃いません（CSVと同様）。

## 構成

- Rust API: `mcapdecode-rs` のROS 2 msg/IDL・Protobufデコーダを利用。構造体内の数値スカラーをフィールド名の配列で指定。JSONチャンネル（`jsonschema` + `json`）はスキーマを読まず、メッセージ全文を文字列フィールド `json` として読みます。表示用の値（`preview=false` 以外）では `serde_json` で解析してツリーとして返し、JSONとして不正なメッセージは文字列のまま返します。RAW MESSAGEでは `json` の階層を省略し、トピック名の直下に内容を表示します。
- 配信: トピックごとのHTTP GETにNDJSONで応答。1024メッセージまたはコールバック時点で100msが経過したらバッチを送信。圧縮チャンクの読み取り・デコード中はバッチが遅れる場合があります。
- フロント: React＋TypeScript＋Canvas 2D。受信による描画更新は最大10回／秒。ファイル順のデータを時刻順に安定整列し、重複時刻を保持。選択したフィールドは全期間を取得して録画ごとに保持し、ズーム・パンは描画範囲だけを変更。追加フィールドだけを取得し、既存系列を読み直しません。キャッシュは時間軸の開始が変わったときに破棄します。
- バックプレッシャー: 4バッチのキューで読み取り速度を制御。クライアント切断後、次のメッセージコールバックで読み取りを停止。

元の整数値とナノ秒時刻は文字列で保持します。描画座標の数値変換では64bit整数が丸められる場合がありますが、カーソル表示の元値は保持されます。欠損値・非有限値は線の切れ目になります。

## API

現行のクライアントとRustサーバが使うHTTP仕様は、操作と各フィールドを [`protocol/openapi.json`](protocol/openapi.json)、全体にまたがる概念とバイナリ形式を [`protocol/README.md`](protocol/README.md) に記録します。未実装の案は [`protocol/drafts/README.md`](protocol/drafts/README.md) に保存しており、現行仕様や互換性保証には含めません。

APIを変更するときは、実装・利用側・テスト・仕様を同じ変更でそろえ、`client/` で `npm run gen:api` を実行します。仕様の完成を実装開始の条件にはしません。生成した型が古いままだと `npm test` が失敗します。開発とレビューの完了条件は [`DEVELOPMENT.md`](DEVELOPMENT.md) を参照してください。

適合性テストは起動中のサーバをHTTP経由で検査するため、どの実装にも使えます。`scripts/conformance.sh` は一時ディレクトリに合成録画を生成し、専用のRustサーバを起動して、終了時に削除します。普段の `data/` は読みません。現行仕様にある操作を1つでも検査しなかった場合は失敗します。

```bash
scripts/conformance.sh                                   # the Rust server
cd client && BASE_URL=http://host:port npm run conformance  # any other server
```

別のサーバを検査する場合も、`generate_demo` と `generate_visual` の出力をそれぞれ `demo.mcap` と `visual.mcap` というグループ名で配信してください。生成方法と通常の検証コマンドは [`DEVELOPMENT.md`](DEVELOPMENT.md) にあります。

runは1回の走行を表し、その走行で記録したデータの種類をgroupとしてまとめます。録画をrunとgroupにどう対応させるかはサーバが自由に決められ、APIにはファイルを公開しません。

`GET /api/runs` は走行の `id` と `name` を `items` に返します。件数は最大 `limit` 件で、1〜200を指定でき、既定は50です。条件に一致する走行がほかにもあるかは `truncated` で示します。`q` を指定すると、大文字・小文字を区別せず、名前にその文字列を含む走行に絞ります。順序はサーバが決め、Rustサーバではパス順です。

`GET /api/runs/{run}` はさらに `groups` を返します。各グループは `id`・`name`・`default_open` を持ち、`default_open` で走行と一緒に開くグループをクライアントへ伝えます。IDの内部構造はAPIの利用側では解釈しません。

`GET /api/runs/{run}/groups/{group}` は `start_ns`・`end_ns`・`message_count` を返します。`end_ns` は最後のタイムスタンプで、その時刻も範囲に含みます。録画に統計情報がない場合、`message_count` はnullです。

`GET /api/runs/{run}/groups/{group}/topics` はトピック ID・トピック名・スキーマ名・メッセージ数・デコードできない理由と、各フィールドのツリーを返します。フィールドは `name`・`data_type`・`type_name` を持ち、該当する型では `enum_values`、structの `fields`、list・arrayの `element` も持ちます。

### Rustサーバの走行とグループ

サーバは起動時に一度だけ `--data-dir` のディレクトリを読み取り、シンボリックリンクはたどりません。録画を追加したらサーバを再起動してください。IDは相対パスを符号化したもので、再起動しても変わりません。

- データディレクトリ直下のファイルは1グループを持つ走行です。
- データディレクトリ直下のディレクトリは1走行です。その中にあるファイルは階層の深さを問わず、それぞれ相対パスを名前とするグループになります。
- rosbag2の `metadata.yaml` があるディレクトリはbagとして扱い、その中の `<prefix>_<n>.<ext>` ファイルを1グループのセグメントとして番号順に読みます。データディレクトリ直下のbagはその1グループを持つ走行です。YAMLの内容は解析しません。
- bagの外にある連番ファイルは別々のグループとして扱います。`cam_0.mcap` と `cam_1.mcap` が2台のカメラの録画である可能性があるためです。
- Segment time ranges must not overlap. Each segment and channel is listed as a separate topic, even when names or schemas match.
- すべてのグループは `default_open` です。

履歴の取得（`GET /api/runs/{run}/groups/{group}/messages`）、値の形式、エラーは [`protocol/README.md`](protocol/README.md) を参照してください。

## 前提と制限

- 起動中の録画は変更・上書き・切り詰めをしないでください。mmapと既存Readerの前提です。
- Summary、ChunkIndex、対象チャネルのメッセージ索引を持つ、チャンク化された録画を対象とします。Channels are listed and read separately, including channels with the same topic name.
- ライブ配信、GCS固有のアクセス、認証、配列展開、式、XY表示、複数パネルは対象外です。GCSFuse経由でも通常のファイルとしてアクセスしますが、その環境での性能は別途測定が必要です。
- 全期間のプロットには選択トピックを含むチャンクを読み取ります。異なるトピックのリクエスト間でチャンク解凍は共有しません。
- 初版は全点を転送・保持します。ブラウザのメモリはその録画で取得したフィールドの総点数に比例します。一度取得した系列は選択を外しても再利用のため保持し、録画を切り替えると破棄します。

## 実録画での測定

releaseビルドで起動し、実際のトピックとフィールドを指定してください。

```bash
python3 scripts/measure_stream.py http://127.0.0.1:3000/api/runs/$RUN/groups/$GROUP/messages \
  --topic <トピック> --field <フィールド>
```

スクリプトは最初のバッチまでの秒数、完了までの秒数、転送バイト数、行数を表示します。
サーバの最大RSSは `/usr/bin/time -v server/target/release/hahn --data-dir ...` で起動して終了時に確認できます。
ブラウザでは開発者ツールのPerformance/Memoryで、全期間読み込み・ズーム・中断時の操作性とメモリを確認します。初回とOSキャッシュが効いた2回目を分けて測定してください。

mmapで触れたファイルページもRSSに含まれるため、4バッチの配信キューだけでプロセス全体のRSSが制限されるわけではありません。

### 共有フィールドキャッシュ

ブラウザの `FieldCache` は録画・トピック・フィールドパス単位の値を保持します。構造体は子フィールドへの参照として格納し、全期間の履歴と再生用の時間区間が同じ値を共有します。メッセージはtimestampと同時刻内の出現順で識別し、同一timestampの値を混ぜません。親メッセージの取得済み範囲では子フィールドの欠損を判定でき、未取得とは区別します。配列やbytesは一つの値として扱い、従来のプレビュー制限を維持します。省略された文字列は正確なプロット用文字列を上書きしません。

Tableの親履歴は子フィールドを参照するTable・Raw Message・数値プロットから再利用できます。数値プロットの取得済みフィールドはRaw Messageでも利用します。同じ親・子を取得中の利用者はリクエストを共有し、利用者の一つが選択を変えても他の利用者の取得は止めません。

Raw Messageは2秒単位の区間を取得し、次の2区間を先読みします。表示するメッセージはAPIへの定期ポーリングではなく再生時刻から選び、必要な区間が未取得なら再生時計をバッファ待機させます。疎なトピックでは区間開始以前の最新メッセージも取得します。表示中の区間は保持し、それ以外の再生用区間は全体で12区間を目安に、区間開始時の単発検索は32件まで保持し、録画の時間原点が変わるとキャッシュを破棄します。全期間の履歴は録画を開いている間保持します（メモリのバイト数による上限は未導入）。

While the requested interval is loading, Raw Message keeps the last known message if it is not later than the playback position. Playback waits until the requested interval is ready; a backward seek never displays a message from the future.

Raw Message displays scalar integer fields without quotes, including 64-bit integers carried as strings to preserve their exact values. Actual string fields remain quoted.

The widget toolbar lists the selected topics and field paths. Long selections are truncated; hover over them to see the full list.

`GET /api/runs/{run}/groups/{group}/messages` では任意の `start_ns`（以上）・`end_ns`（未満）を指定できます。省略すると従来どおり全期間を返します。

### Tabウィジェット

空のルートやタブにはウィジェット一覧を表示し、クリックで追加できます。「ウィジェットを追加」のTabを配置すると、各タブにルートと同様の分割レイアウトを作れます。Tabはルートに複数配置できます。タブ内には通常ウィジェットだけを配置でき、Tabの入れ子は作れません。ウィジェットのタイトルバーをドラッグすると、ルートとタブ間、別タブ間で移動できます。タブ見出しへのドロップでそのタブに追加し、見出しに500msホバーすると配置先のタブへ切り替わります。ウィジェットを含むタブを閉じるときは確認ダイアログを表示し、空のタブはそのまま閉じます。

タブバーの＋で追加、アクティブなタブの見出し内の×でそのタブを削除します（最後の1タブは削除不可）。名前は見出しのダブルクリックまたはパネル設定で変更し、見出しのドラッグまたは設定の矢印で並べ替えます。タブ見出しを別のTabウィジェットのタブバーへドラッグすると、名前・分割配置・ウィジェットの設定を保ったまま移動できます。最後のタブを移動した元のTabには空のタブを残します。移動先に空の初期タブだけがある場合は置き換えます。左右キー・Home・Endでもタブを選択できます。非表示タブもデータ取得を継続し、系列・表示設定・分割配置を保持します。Tabを削除・クリア・別の種類へ変更すると、その配下も削除されます。配置とタブは現在のセッション中だけ保持します。
