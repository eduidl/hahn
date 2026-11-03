# 作業ルール

- ユーザーが指示するまで勝手にpushをしない。
- 開発・レビューは [DEVELOPMENT.md](DEVELOPMENT.md) の完了条件に従う。
- 現行契約は `protocol/openapi.json` と `protocol/README.md`。設計の判断は `docs/adr/` に日本語で記録する。ADR は既存の実装や過去の案を参照せず、それ単体で読めるように書く。
- Rust のテストを `server/src/` に書かない（`#[cfg(test)]`・`#[test]`・`#[tokio::test]` を置かない）。テストは `server/tests/` に置き、HTTP API と `hahn` クレートの公開 API だけを通して確かめる。内部関数を確かめたいときは、その関数が利用者に見せる振る舞いを公開 API 経由で確かめる。`server/tests/sources.rs` がこの規則を検査する。
