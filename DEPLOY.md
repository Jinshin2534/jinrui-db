# デプロイ手順

閲覧サーバ(`tools/serve.mjs`)は **`DATABASE_URL` があればマネージドPostgres**、無ければローカルPGliteに接続する(`tools/dbconn.mjs`)。
SQL(`format/schema.sql`)もローダ(`tools/db.mjs`)も同一なので、ローカルで作ったデータをそのまま本番Postgresへ載せられる。

## 構成

```
[あなたのPC] --db.mjs load--> [マネージドPostgres(Neon/Supabase)] <--query-- [Render/Fly/Railway の serve.mjs]
```

- DB: **Neon** または **Supabase**(どちらもPostgres・無料枠あり・サーバレス)
- ホスティング: **Render**(Node ランタイムで `serve.mjs` をそのまま起動)/ **Fly.io・Railway**(Dockerfile)

---

## 1. Postgres を用意して接続文字列を得る

例: [Neon](https://neon.tech) でプロジェクト作成 → 接続文字列をコピー(`?sslmode=require` 付き)。

```bash
export DATABASE_URL="postgresql://USER:PASS@ep-xxx.region.aws.neon.tech/neondb?sslmode=require"
```

Supabase の場合は Project → Settings → Database → Connection string(URI)。

## 2. スキーマ適用＋データ投入(自分のPCから本番DBへ)

```bash
cd 人類DB
DATABASE_URL="$DATABASE_URL" node tools/db.mjs init                              # schema.sql 適用(postgres と表示される)
DATABASE_URL="$DATABASE_URL" node tools/db.mjs load format/examples data/*.hrfl   # 例＋量産データを投入
DATABASE_URL="$DATABASE_URL" node tools/db.mjs query "select count(*) from person where exists(select 1 from name n where n.person_id=person.id)"
```

> `db.mjs` は同じトランザクション/冪等ロードがPostgresでも動く(`dbconn.mjs` の `transaction()` が専用クライアントでBEGIN/COMMIT)。

## 3. 閲覧サーバをデプロイ

### Render(推奨・Dockerなし)
1. リポジトリをGitHubに置く。
2. Render で **New → Blueprint** を選び、リポジトリの `render.yaml` を使う(または手動で Web Service: Root Directory=`tools` / Build=`npm install --omit=dev` / Start=`node serve.mjs`)。
3. 環境変数 **`DATABASE_URL`** を設定。Render が割り当てる `PORT` は `serve.mjs` が自動で読む。
4. デプロイ完了後の URL を開く。

### Fly.io / Railway(Dockerfile)
```bash
# Fly
fly launch --no-deploy        # 既存 Dockerfile を検出
fly secrets set DATABASE_URL="$DATABASE_URL"
fly deploy
```
Railway も同様に Dockerfile を検出し、`DATABASE_URL` を Variables に設定するだけ。

## 4. データ更新

`db.mjs load` を本番 `DATABASE_URL` に対して再実行すれば、人物単位で冪等に上書き(削除→再投入)される。新規プリセットの追加も同じ。

```bash
DATABASE_URL="$DATABASE_URL" node tools/import-wikidata.mjs --preset nobel-physics --hrfl data/nobel-physics.hrfl
DATABASE_URL="$DATABASE_URL" node tools/db.mjs load data/nobel-physics.hrfl
```

---

## メモ
- `serve.mjs` は読み取り専用で、生者 `consent` を適用して非公開項目を配信しない。
- 本番イメージは PGlite を読み込まない(`dbconn.mjs` が動的importで `pg` のみ使用)。
- **Vercel** に載せる場合は、`serve.mjs` のハンドラ(`/api/people` `/api/person` `/api/graph`)をサーバレス関数に分割し、`tools/web` を静的配信する形へ要改修(Neonはサーバレス関数と相性良好)。現状は常駐サーバ前提の Render/Fly/Railway が最短。
