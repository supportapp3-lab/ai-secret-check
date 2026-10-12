# product-slot-01

GithubQiitaX事業のNode.js製CLIです。現在はCLIの骨組みとして、
`package.json` に記載されたバージョンを表示できます。

## 必要環境

- Node.js 20以上（LTS版を推奨）
- npm（Node.jsに同梱）

## セットアップ

```sh
git clone https://github.com/supportapp3-lab/product-slot-01.git
cd product-slot-01
npm ci
```

追加の依存パッケージは使用していません。

## 使い方

```sh
node bin/github-qiita-x.js --version
```

現在のバージョンは `0.1.0` です。引数なしの場合は使い方を表示します。
未対応の引数を指定した場合は、使い方を標準エラーへ表示し、終了コード1で終了します。

`package.json` の `bin` には、コマンド名 `github-qiita-x` を登録しています。

## テスト

```sh
npm test
```

Node.js標準の `node:test` を使用しています。CLIを別の作業ディレクトリから実行し、
`--version` の出力が `package.json` のバージョンと一致すること、
終了コードが0であること、標準エラーが空であることを1件のテストで確認します。

GitHub ActionsでもpushとPull Request時にLTS版Node.jsで `npm ci` と `npm test` を実行します。
