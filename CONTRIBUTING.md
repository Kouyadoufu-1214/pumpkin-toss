# みんなで改善するには

遊ぶだけなら公開ページを開けばOKです。GitHubアカウントやインストールは必要ありません。
感想や不具合はリポジトリの「Issues」に、使った端末・ブラウザー・起きたことを書いてください。
カメラ映像や個人情報を添付する必要はありません。

## 自分のPCで動かす

Node.js 24以上を使います。

```sh
git clone https://github.com/Kouyadoufu-1214/pumpkin-toss.git
cd pumpkin-toss
npm run assets
npm start
```

ブラウザーで `http://localhost:4173/` を開きます。
モデル類は最初の `npm run assets` で取得します。以後はネットなしでもローカルで起動できます。

## 変更を提案する

1. リポジトリをForkするか、編集権限がある場合は作業ブランチを作ります。
2. 変更後に `npm test` と `npm run build` を実行します。
3. Pull requestを作り、変えたこと・確認したことを書きます。
4. `main` に取り込まれると、公開ページが自動更新されます。

主な画面は `public/index.html`、動作は `public/experience.mjs`、見た目は `public/experience.css` です。
手や顔の判定は `public/exhibit-logic.mjs`、3D描画は `public/pumpkin-3d.mjs` にあります。

## 公開の仕組み

GitHub Pagesを使います。リポジトリの **Settings → Pages → Source: GitHub Actions** を選びます。
`main` の更新時に `.github/workflows/pages.yml` が依存データの取得・テスト・ビルド・公開を順に実行します。
公開用フォルダーは `dist` です。`dist` と `public/vendor` は生成物なのでGitには含めません。
APIキーや追加の外部サービスの契約は不要です。

公開URLでもカメラ映像は端末内で処理します。GitHubへカメラ映像を送る仕組みはありません。
