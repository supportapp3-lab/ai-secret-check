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
node bin/github-qiita-x.js scan-history ./対象ディレクトリ
node bin/github-qiita-x.js scan-history ./対象ディレクトリ --json
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


### 会話ログの鍵点検（試験版）

```sh
node bin/github-qiita-x.js scan-logs
```

Claude Code の `~/.claude/projects/` 配下にある `.jsonl` を読み取り、`sk-ant-`、`sk-`、`ghp_`、`github_pat_`、`AKIA`、`xoxb-` などの既知プレフィックスと、鍵・トークン・秘密情報を表す名前の `KEY=値` 形式を数えます。出力するのはログの相対パス、形式名、件数だけで、検出した値は表示しません。

ログ保存先は `CLAUDE_CONFIG_DIR` が設定されていればその `projects/`、未設定なら `~/.claude/projects/` です。ディレクトリがない場合は対象0件として終了します。Codex の保存場所はこの版では走査しません（確認済みの JSONL 保存場所がないため対象外）。既知形式以外の鍵や値は検出しません。見つからないことは安全の保証ではありません。

この版はローカルの Claude Code ログ保存仕様を前提にした試験版で、ファイルは読み取るだけです。変更・削除・通信はしません。終了コードは一致なし=0、一致あり=1、使い方または読み取りエラー=2 です。テストには一時ディレクトリのダミーログだけを使います。

### Git履歴の環境変数ファイル点検

```sh
node bin/github-qiita-x.js scan-history
node bin/github-qiita-x.js scan-history ./対象ディレクトリ --json
```

Gitが必要です。省略時はカレントディレクトリが属するリポジトリの履歴を調べます。
どの階層の `.env` と `.env.*` も対象です。履歴検査では秘密鍵ファイルや `prod.env` などは対象にしません。
`.env.example`・`.env.sample`・`.env.template` はサンプルのINFOとして区別します。

シェルを介さず、Node.js標準の `spawnSync` で `git log --all --full-history --root -m --no-renames --diff-filter=A --name-only` を実行します。
NUL区切りでパスを扱い、追加したコミットの短いハッシュ（12桁・複数あればすべて）、件数、HEADのツリーにそのパスがあるかを出力します。
`git ls-tree --name-only` と `rev-parse` は参照とパスの確認にだけ使います。blobのハッシュや内容、コミットメッセージは出力しません。
`.gitignore` を追加して `git rm --cached` したファイル、別ブランチだけのファイル、`refs/stash` から到達できるファイルも含みます。
名前を `.env` に変更したコミットは、そのパスの追加として扱います。マージでは親との差分による追加も含め、同じパス・コミットの重複は除きます。

終了コードは、サンプル以外の対象あり=1、対象なし・サンプルのみ=0、引数・ディレクトリ・Git実行のエラー=2です。
Gitリポジトリでない場合は「gitリポジトリではないため履歴は確認できません」と表示して0、コミットのない空リポジトリは0件で0です。
`--json` は同じ判定と `path`・`commits`・`commitCount`・`inHead`・`sample`、対応手順を出します。

見つかったら、**最初に鍵・トークンを再発行（ローテーション）**してください。履歴を消しても、漏れた鍵は無効になりません。
そのうえで必要なら、新しく取ったクローンで git-filter-repo 2.47以上の
`git filter-repo --sensitive-data-removal --invert-paths --path <パス>` を実行し、force pushする手順を検討します。
書き換え前のクローン、フォーク、GitHub上のキャッシュには残ることがあります。
[GitHub公式の削除手順](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)に従ってください（2026-10-19確認）。
ツールは案内だけを行い、履歴の書き換え・filter-repo・push・gc・ファイル削除は実行しません。

限界: ファイル名を対象外の名前に変えてコミットした秘密情報は検出できません。
ローカル参照から到達できる履歴だけを見るため、未取得のリモート参照、フォーク、GitHubのキャッシュ、参照から到達できない古いオブジェクトは確認できません。
浅いクローンや部分クローンなどで必要な履歴がない場合も、外部通信による補完はしません。Git実行は1回あたり60秒・出力16MiBを上限とし、超えた場合は成功扱いせず2で終了します。
見つからなくても安全の保証にはなりません。

## 安全性

対象ファイルの中身や値は開かず、表示もしません。.claude/settings.json、.claude/settings.local.json、ユーザー設定（~/.claude/settings.json または CLAUDE_CONFIG_DIR/settings.json）、.cursorignore は設定確認に必要な場合だけ読みます。.codex/config.toml と .claudeignore は存在のみを確認します。スキャンは読み取り専用で、ファイルの作成・変更・削除をせず、外部通信もしません。

`scan-history` も読み取り専用で、内容を取得する `git show <rev>:<path>`、`git cat-file -p`、`git grep` は実行しません。
HEAD・参照・作業ツリー・インデックスを変更せず、Gitの外部diff・textconv・署名表示・fsmonitorは使いません。
遅延取得も無効にし、fetchなどの外部通信は行いません。

## テスト

~~~sh
npm test
~~~

Node.js標準の node:test を使い、対象の検出、サンプル・公開鍵・除外ディレクトリ・シンボリックリンクの除外、各設定との照合、終了コード、JSON出力、ダミー秘密値が出力に含まれないことを確認します。

