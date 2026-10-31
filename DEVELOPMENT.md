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

## Reviewの完了条件

- 修正必須は、再現できる不具合、情報漏洩・データ損失、今回の操作に必要な時刻や座標の誤り、既存の利用側の破損です。指摘には具体的な発生条件か再現例を付けます。
- 将来の拡張、未採用の利用ケース、好みの設計変更は別課題として記録し、今回の完了条件に追加しません。
- 初回レビューと修正確認を基本にします。再レビューで必須指摘を追加する場合も、具体的な破損条件か再現例を必要とします。
- 変更に必要な合成データの確認が通り、必須指摘を解消したら完了です。未実施の確認や残る制限は明記します。
