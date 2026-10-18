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
- **Codex**: ユーザーの `~/.codex/config.toml`（`CODEX_HOME` があればその `config.toml`）と、対象直下の `.codex/config.toml` を読み、選択されたpermission profileの `:workspace_roots` 配下のdenyルールとパスを照合します。設定ファイルがなければ警告しません。読めない・対応する構文として解析できない場合は「判定できません」と警告して続行します。終了コードは従来どおり対象ファイルの有無で決まり、設定警告では変えません。

ツールの仕様、設定の読み込み条件、OSやサンドボックスは変化することがあります。この結果だけで機密ファイルを保護できるとは判断しないでください。設定ファイルのルールと実行環境の制限を別途確認してください。

仕様確認先（2026-10-15確認）:

- [Claude Codeの設定](https://code.claude.com/docs/en/settings)
- [Claude Codeの権限](https://code.claude.com/docs/en/permissions)
- [Cursorのignoreファイル](https://cursor.com/docs/reference/ignore-file)
- [Codexの高度な設定](https://developers.openai.com/codex/config-advanced)
- [Codexの設定リファレンス](https://developers.openai.com/codex/config-reference)

### Codexのpermission profile判定（Beta）

2026-10-19に[公式Permissions](https://developers.openai.com/codex/permissions)と[Config basics](https://developers.openai.com/codex/config-basic)を確認しました。
プロジェクト設定をユーザー設定より優先して照合します。ただし、**プロジェクト設定は信頼済みプロジェクトでのみ有効**です。
このツールは信頼状態を確認できないため、プロジェクト設定があればこの条件を注記します。

- どちらかの設定にトップレベルの `sandbox_mode` があれば、古いサンドボックス設定が優先されてdenyが使われない可能性を表示します。
- `default_permissions` がない場合、`:workspace`・`:read-only` などの組み込みプロファイルだけの場合は「拒否設定なし → 読める可能性あり」です。
- 名前付きプロファイルでは `extends` の継承をたどり、親のルールと深さを引き継ぎます。同じキーは子の指定、同じ設定キーはプロジェクトの指定を優先します。循環・不明な継承先などは判定不能です。
- 一致すれば「拒否設定あり」とその設定元（`~/.codex/config.toml`、`CODEX_HOME/config.toml`、`.codex/config.toml`）を表示します。`.env` の完全一致はルートだけに一致します。`**/*.env` だけでは `.env.local` は一致しません。
- `**` を含むルールだけが一致し、`glob_scan_max_depth` が未指定、またはファイルのディレクトリ階層がその値を超える場合は、Linux・WSL・Windowsで拒否されない可能性を警告します。比較ではルート直下を0階層として扱いますが、Codex内部の深さの数え方を実証したものではありません。

拒否設定なし、解析不能、深さの警告があるファイルには、テキストの `修正例: Codex:` とJSONの `suggestions.codex` に次の設定例を表示します。
深さの警告なしに拒否ルールが一致したファイルには修正例を出しません。

```toml
# ~/.codex/config.toml（または $CODEX_HOME/config.toml）
default_permissions = "no-env"

[permissions.no-env]
extends = ":workspace"

[permissions.no-env.filesystem]
glob_scan_max_depth = 6  # リポジトリの深さに合わせて調整

[permissions.no-env.filesystem.":workspace_roots"]
"**/.env" = "deny"
"**/.env.*" = "deny"
"**/*.env" = "deny"
```

`sandbox_mode` と一緒に書かないでください。`"**/.env.*"` は `.env.example` も拒否します。
設定後、`codex sandbox -- cat .env` が `Permission denied` になるか、自分で確かめてください。このツールはCodexを実行せず、設定例を表示するだけです。

依存を増やさない最小限のTOMLパーサーです。単一行の文字列・整数・真偽値、通常/引用付きキーとテーブル、コメントを扱います。
配列・インラインテーブル・複数行文字列・dotted keyによる代入など、未対応の書き方や重複・矛盾があれば、設定全体を推測せず判定不能にします。
globは `*`・`**`・`?` に対応し、文字クラスなど未対応のルールも判定不能にします。

限界: 仕様はBetaで変わる可能性があります。Issue #15で報告された実機確認はCodex CLI 0.163.0・Linuxだけで、macOS・Windowsの実際の遮断動作は未確認です。
この変更のテストはダミー設定の静的照合であり、拒否設定があってもOSレベルの読み取り防止を保証しません。
`/etc/codex/config.toml`、managed `requirements.toml`、`--profile`・CLI引数による上書き、network、`:root`・絶対パスのdeny、Git履歴にある値は対象外です。
ファイルの検出対象は従来どおりで、`app/prod.env` など `*.env` 全般への拡張はしていません。そのパスは照合単体テストだけで確認します。

### 会話ログの鍵点検（試験版）

```sh
node bin/github-qiita-x.js scan-logs
```

Claude Code の `~/.claude/projects/` 配下にある `.jsonl` を読み取り、`sk-ant-`、`sk-`、`ghp_`、`github_pat_`、`AKIA`、`xoxb-` などの既知プレフィックスと、鍵・トークン・秘密情報を表す名前の `KEY=値` 形式を数えます。出力するのはログの相対パス、形式名、件数だけで、検出した値は表示しません。

ログ保存先は `CLAUDE_CONFIG_DIR` が設定されていればその `projects/`、未設定なら `~/.claude/projects/` です。ディレクトリがない場合は対象0件として終了します。Codex の保存場所はこの版では走査しません（確認済みの JSONL 保存場所がないため対象外）。既知形式以外の鍵や値は検出しません。見つからないことは安全の保証ではありません。

この版はローカルの Claude Code ログ保存仕様を前提にした試験版で、ファイルは読み取るだけです。変更・削除・通信はしません。終了コードは一致なし=0、一致あり=1、使い方または読み取りエラー=2 です。テストには一時ディレクトリのダミーログだけを使います。

## 安全性

対象ファイルの中身や値は開かず、表示もしません。.claude/settings.json、.claude/settings.local.json、ユーザー設定（~/.claude/settings.json または CLAUDE_CONFIG_DIR/settings.json）、.cursorignore は設定確認に必要な場合だけ読みます。Codexのユーザー設定と対象直下の .codex/config.toml は上記の判定に必要な範囲で解析し、トークンなど無関係な設定値や解析に失敗した行の内容は出力しません。.claudeignore は存在のみを確認します。スキャンは読み取り専用で、ファイルの作成・変更・削除をせず、外部コマンドの実行や外部通信もしません。

## テスト

~~~sh
npm test
~~~

Node.js標準の node:test を使い、対象の検出、サンプル・公開鍵・除外ディレクトリ・シンボリックリンクの除外、各設定との照合、終了コード、JSON出力、ダミー秘密値が出力に含まれないことを確認します。

