# ai-secret-check

AIコーディングエージェントから `.env` や鍵が読めないかを点検する、Node.js製の読み取り専用CLIです。ファイルを変更せず、秘密の値や対象ファイルの中身を出力せず、外部通信を行いません。

役に立ったら Star を押してもらえると、続けて改善する励みになります。見落としや誤検出は Issue で教えてください。

次の6項目を点検します。

- Claude Codeの `permissions.deny`
- Cursorの `.cursorignore`
- Codexのpermission profileのdeny
- Claude Codeの会話ログにある既知の鍵形式（`scan-logs`）
- Git履歴に残った `.env` 系ファイルのパス（`scan-history`）
- npmパッケージの配布対象に入る秘密ファイルらしいパス（`scan-package`）

`scan` は秘密情報らしい**ファイル名とパスだけ**を探し、拒否設定と照合します。`scan-logs` は指定の会話ログを読みますが、値は出力しません。点検で問題が見つからなくても、実際の読み取り防止や秘密情報が存在しないことを保証するものではありません。

## 必要環境とセットアップ

- Node.js 20以上（LTS版を推奨）
- npm（Node.jsに同梱）

GitHubからnpxで実行できます（Node.js 20以上とGitが必要です）。

~~~sh
npx github:supportapp3-lab/ai-secret-check scan
~~~

cloneして実行する場合:

~~~sh
git clone https://github.com/supportapp3-lab/ai-secret-check.git && cd ai-secret-check && node bin/ai-secret-check.js scan
~~~

追加の依存パッケージはありません。npxによる取得やcloneは通信しますが、CLI自体の点検は外部通信を行いません。
上記URLは公開時の名前を示します。リポジトリ改名・公開設定の変更はこの実装には含まれません。`private: true` を維持し、npmには公開していません。

## 使い方

~~~sh
node bin/ai-secret-check.js scan
node bin/ai-secret-check.js scan ./対象ディレクトリ
node bin/ai-secret-check.js scan ./対象ディレクトリ --json
node bin/ai-secret-check.js scan-logs
node bin/ai-secret-check.js scan-history ./対象ディレクトリ
node bin/ai-secret-check.js scan-history ./対象ディレクトリ --json
node bin/ai-secret-check.js scan-package ./対象ディレクトリ
node bin/ai-secret-check.js --version
node bin/ai-secret-check.js --help
~~~

コマンドをPATHに導入した環境では、`ai-secret-check scan`、`ai-secret-check scan-history`、`ai-secret-check scan-logs` のように実行します。
旧コマンド `github-qiita-x` は非推奨の別名として残しています。実行するとstderrへ `github-qiita-x は非推奨です。ai-secret-check を使ってください` の1行を表示し、新しいCLIと同じ本文出力・終了コードを返します。

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
node bin/ai-secret-check.js scan-logs
```

Claude Code の `~/.claude/projects/` 配下にある `.jsonl` を読み取り、`sk-ant-`、`sk-`、`ghp_`、`github_pat_`、`AKIA`、`xoxb-` などの既知プレフィックスと、鍵・トークン・秘密情報を表す名前の `KEY=値` 形式を数えます。出力するのはログの相対パス、形式名、件数だけで、検出した値は表示しません。

ログ保存先は `CLAUDE_CONFIG_DIR` が設定されていればその `projects/`、未設定なら `~/.claude/projects/` です。ディレクトリがない場合は対象0件として終了します。Codex の保存場所はこの版では走査しません（確認済みの JSONL 保存場所がないため対象外）。既知形式以外の鍵や値は検出しません。見つからないことは安全の保証ではありません。

この版はローカルの Claude Code ログ保存仕様を前提にした試験版で、ファイルは読み取るだけです。変更・削除・通信はしません。終了コードは一致なし=0、一致あり=1、使い方または読み取りエラー=2 です。テストには一時ディレクトリのダミーログだけを使います。

### Git履歴の環境変数ファイル点検

```sh
node bin/ai-secret-check.js scan-history
node bin/ai-secret-check.js scan-history ./対象ディレクトリ --json
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

### npmパッケージの配布ファイル点検

```sh
npx github:supportapp3-lab/ai-secret-check scan-package ./対象ディレクトリ
# clone済みの場合（省略するとカレントディレクトリ）
node bin/ai-secret-check.js scan-package
```

対象の`package.json`とnpmが必要です。`npm pack . --dry-run --json --ignore-scripts --offline --workspaces=false --global=false`で、現在の対象パッケージの配布ファイル一覧を取得します。tarballの作成・publish・インストール・外部通信は行いません。prepack・prepare・postpackも実行しないため、生成前のファイルは含めず、必要なビルドは別途行ってから点検してください。初回のnpx取得自体には通信が必要です。

一覧の各階層の`.env`・`.env.*`、`*.pem`、`*.key`、`id_rsa*`をファイル名だけで判定し、`.env.example`・`.env.sample`・`.env.template`は除外します。検出パスは引用して表示し、ファイルの値、npmの生の出力・エラー、パッケージのハッシュは表示しません。JSON出力には対応していません。

検出あり=1、なし=0、package.jsonやnpmがない・実行/解析できない場合=2です。見つかったら、ルートの`.npmignore`が`.gitignore`の代わりになることや、`files`に含めたディレクトリを原因の目安として案内します。修正例は`.npmignore`へ`.env*`・`*.pem`・`*.key`・`id_rsa*`を追加、または`files`を必要な範囲に絞る方法です。ルートの`.npmignore`だけでは`files`の明示指定を除外できない場合があるため、修正後も再点検してください。公開を阻止するフックは追加しません。

2026-10-21に[npm packの公式仕様](https://docs.npmjs.com/cli/v11/commands/npm-pack/)と[package.jsonのfiles仕様](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files)を確認しました。npmのバージョンや設定で配布対象は変わるため、実際に使う環境で点検してください。

## 安全性

対象ファイルの中身や値は開かず、表示もしません。.claude/settings.json、.claude/settings.local.json、ユーザー設定（~/.claude/settings.json または CLAUDE_CONFIG_DIR/settings.json）、.cursorignore は設定確認に必要な場合だけ読みます。Codexのユーザー設定と対象直下の .codex/config.toml は上記の判定に必要な範囲で解析し、トークンなど無関係な設定値や解析に失敗した行の内容は出力しません。.claudeignore は存在のみを確認します。スキャンは読み取り専用で、ファイルの作成・変更・削除をせず、外部コマンドの実行や外部通信もしません。

`scan-history` も読み取り専用で、内容を取得する `git show <rev>:<path>`、`git cat-file -p`、`git grep` は実行しません。
HEAD・参照・作業ツリー・インデックスを変更せず、Gitの外部diff・textconv・署名表示・fsmonitorは使いません。
遅延取得も無効にし、fetchなどの外部通信は行いません。

`scan-package`は上記のnpm dry-runを子プロセスとして実行します。点検対象の秘密ファイルの内容をCLIから読み取る処理はありませんが、npm自身はパッケージ一覧の計算のためにファイルを処理します。対象のファイルを変更せず、npmのスクリプト・外部通信・更新通知・ログ保存を無効にします。npm実行は60秒・出力16MiBを上限とし、超過・失敗は2で終了します。

## テスト

~~~sh
npm test
~~~

Node.js標準の node:test を使い、対象の検出、サンプル・公開鍵・除外ディレクトリ・シンボリックリンクの除外、各設定との照合、終了コード、JSON出力、ダミー秘密値が出力に含まれないことを確認します。

## 関連記事（Qiita）

- [.env点検CLI](https://qiita.com/supportapp3/items/76254d663f4da32d41da)
- [Codex CLIに.envを読ませない設定](https://qiita.com/supportapp3/items/949794973a65fa5aac11)
- [過去にコミットした.envはGitの履歴から読める](https://qiita.com/supportapp3/items/5833f7d38254ad4f6cf6)
- [pre-commitで.envや鍵のコミットを止める](https://qiita.com/supportapp3/items/d10c7f510955059f53dc)
- [.npmignoreがあると.envがnpmパッケージに入る](https://qiita.com/supportapp3/items/fa4f271888e6f6899100)

## ライセンス

[MIT License](LICENSE)。Copyright (c) 2026 supportapp3-lab。

## English summary

ai-secret-check is a read-only Node.js CLI for checking whether coding agents may
access `.env` files or private-key-like paths. It inspects Claude Code deny rules,
Cursor ignore rules, Codex permission profiles, Claude Code conversation logs,
and `.env` paths recorded in Git history. It does not print secret values, modify
files, or make network requests. Results are advisory and do not guarantee that
secrets are protected.

If you find this useful, please give it a Star to encourage continued improvements, and report missed detections or false positives in an Issue.

### Check npm package contents

Run `ai-secret-check scan-package [directory]` (or `node bin/ai-secret-check.js scan-package`). This requires npm and a local package.json. It uses an offline `npm pack --dry-run --json` with lifecycle scripts disabled, without creating a tarball, publishing, or installing dependencies. It reports only packaged paths matching `.env`/`.env.*`, `*.pem`, `*.key`, or `id_rsa*`, excluding `.env.example`, `.env.sample`, and `.env.template`. It does not display file contents or npm's raw output. Exit codes: findings=1, none=0, unable to check=2; JSON output is not supported. Hints explain `.npmignore` replacing `.gitignore` and broad `files` entries; narrow `files` or add exclusions and scan again. Build-generated files must already exist because prepare/prepack/postpack do not run. Initial retrieval through npx requires network access; the scan itself runs offline.

Requires Node.js 20 or later. Run `npx github:supportapp3-lab/ai-secret-check scan`,
or clone [the repository](https://github.com/supportapp3-lab/ai-secret-check) and
run `node bin/ai-secret-check.js --help`. `scan` and `scan-history` support `--json`.
Licensed under MIT. This package remains private and is not published to npm.

