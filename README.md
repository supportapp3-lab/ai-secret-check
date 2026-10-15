# product-slot-01

GithubQiitaX事業のNode.js製CLIです。リポジトリ内にある環境変数ファイルや秘密鍵らしい名前のファイルを、**ファイル名とパスだけ**で探し、Claude Code・Cursor・Codexのリポジトリ設定と照合します。

## 必要環境とセットアップ

- Node.js 20以上（LTS版を推奨）
- npm（Node.jsに同梱）

~~~sh
npm ci
~~~

追加の依存パッケージはありません。外部通信もしません。

## 使い方

~~~sh
node bin/github-qiita-x.js scan
node bin/github-qiita-x.js scan ./対象ディレクトリ
node bin/github-qiita-x.js scan ./対象ディレクトリ --json
node bin/github-qiita-x.js --version
~~~

ディレクトリを省略するとカレントディレクトリを調べます。--version と引数なしの使い方表示も利用できます。終了コードは、読めそうな対象ファイルがない場合 0、ある場合 1、引数や対象ディレクトリが不正な場合 2 です。サンプル環境変数ファイルだけの場合は INFO として表示し、終了コードは 0 です。

## 検出と照合

検出対象は .env と .env.*、*.pem / *.key / *.p12 / *.pfx、id_rsa / id_ed25519 / id_ecdsa です。.env.example、.env.sample、.env.template はサンプルとして別扱いにし、*.pub は除外します。.git/ と node_modules/ は走査せず、シンボリックリンクもたどりません。

- **Claude Code**: プロジェクトの .claude/settings.json と .claude/settings.local.json、およびユーザーの ~/.claude/settings.json にある permissions.deny の Read(...) ルールを対象パスに照合します。CLAUDE_CONFIG_DIR が設定されている場合は、そのディレクトリの settings.json をユーザー設定として読みます。拒否設定が見つかった場合は設定ファイルの場所を表示し、そのファイル向けの修正例は出しません。ユーザー設定が見つからない、読めない、JSONとして不正な場合は警告して続行します。.claudeignore があれば警告します。2026-10-15に確認した公式設定資料はJSON形式の設定と permissions.deny を案内し、.claudeignore をアクセス制御設定として記載していません。拒否ルールの存在確認は、OSレベルの読み取り防止を保証しません。
- **Cursor**: ルートの .cursorignore をgitignore形式のパターンとして照合します。一致したファイルもターミナルやMCP経由で読める可能性があります。.cursorignore は完全な保護境界ではありません。
- **Codex**: .codex/config.toml の有無だけを報告し、その内容は解析しません。Codexの公式資料にはプロジェクト単位の設定ファイルや権限プロファイルの説明がありますが、このMVPは適用中の権限やパス単位の効果を判定しないため、「読める可能性あり」と表示します。

ツールの仕様、設定の読み込み条件、OSやサンドボックスは変化することがあります。この結果だけで機密ファイルを保護できるとは判断しないでください。設定ファイルのルールと実行環境の制限を別途確認してください。

仕様確認先（2026-10-15確認）:

- [Claude Codeの設定](https://code.claude.com/docs/en/settings)
- [Claude Codeの権限](https://code.claude.com/docs/en/permissions)
- [Cursorのignoreファイル](https://cursor.com/docs/reference/ignore-file)
- [Codexの高度な設定](https://developers.openai.com/codex/config-advanced)
- [Codexの設定リファレンス](https://developers.openai.com/codex/config-reference)

## 安全性

対象ファイルの中身や値は開かず、表示もしません。.claude/settings.json、.claude/settings.local.json、ユーザー設定（~/.claude/settings.json または CLAUDE_CONFIG_DIR/settings.json）、.cursorignore は設定確認に必要な場合だけ読みます。.codex/config.toml と .claudeignore は存在のみを確認します。スキャンは読み取り専用で、ファイルの作成・変更・削除をせず、外部通信もしません。

## テスト

~~~sh
npm test
~~~

Node.js標準の node:test を使い、対象の検出、サンプル・公開鍵・除外ディレクトリ・シンボリックリンクの除外、各設定との照合、終了コード、JSON出力、ダミー秘密値が出力に含まれないことを確認します。

