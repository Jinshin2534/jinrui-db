# 人類DB

人類の情報を恒久保存するデータベース。過去の人々を一人ずつ記録し、今生きている人は認証して自分を追加・管理できる。

## 現在地: データ形式の設計

中核となる新しいデータ形式 **HRF (Human Record Format)** を `format/` に定義した。

**拡張子**: `.hrf`(1人=1レコードのJSON文書・正準)/ `.hrfl`(*HRF Lines* = 1行1レコードのNDJSON・大量入出力用)。

```
人類DB/
├── format/
│   ├── SPEC.md                  # 形式仕様(設計原則・モデル・EDTF・Postgresマッピング)
│   ├── person.schema.json       # JSON Schema (draft 2020-12)
│   ├── schema.sql               # Postgres 物理スキーマ(DDL)
│   └── examples/
│       ├── curie.hrf            # 著名人(Wikidata取り込み・関係・disputed claim)
│       ├── parish-register.hrf  # 無名者(名前＋おおよその没年のみ=優雅な縮退)
│       ├── living-self.hrf      # 生者(自己統治: stewardship＋consent＋署名)
│       ├── people.hrfl          # 上記3名を1行1レコードで束ねた一括形式の例
│       ├── wd-Q7186.hrf         # ★Wikidataからの実インポート(マリ・キュリー)
│       └── curie-family.hrfl    # ★キュリー家3名(関係グラフが内部で解決)
├── tools/                       # CLI(Node 24)
│   ├── hrf.mjs                  #   hrf validate / info / selftest
│   ├── edtf.mjs                 #   EDTF検証＋通日変換(取込でも再利用)
│   ├── wikidata.mjs             #   Wikidataエンティティ→HRF 純粋変換(時間精度→EDTF)
│   ├── import-wikidata.mjs      #   インポータCLI(実フェッチ/オフライン両対応)
│   ├── db.mjs                   #   DB init/load/demo/query
│   ├── dbconn.mjs               #   ★DB接続抽象: PGlite ⇄ DATABASE_URLのマネージドPostgres
│   ├── serve.mjs                #   閲覧Webサーバ(JSON API＋静的配信)
│   └── web/                     #   フロント(index.html / styles.css / app.js)
├── data/                        # 量産した .hrfl(gitignore)
├── db/data/                     # PGlite の永続データ(gitignore)
├── Dockerfile · render.yaml     # ★デプロイ(Fly/Railway=Docker / Render=Node)
├── DEPLOY.md                    # ★デプロイ手順(Neon/Supabase + Render/Fly)
└── .vscode/settings.json        # .hrf を JSON 扱い＋person.schema.json を自動適用

# 使い方
node tools/hrf.mjs selftest                          # 形式バリデータの内蔵テスト
node tools/hrf.mjs validate format/examples          # examples をまとめて検証
node tools/hrf.mjs info     format/examples          # 1行サマリ
node tools/import-wikidata.mjs selftest              # インポータの変換テスト(ネット不要)
node tools/import-wikidata.mjs --out format/examples Q7186          # 1人をWikidataから取得
node tools/import-wikidata.mjs --hrfl out.hrfl Q7186 Q37463 Q7504   # 複数を一括(.hrfl)

# SPARQLで一括選定して量産(preset: nobel-physics/nobel-chemistry/us-presidents/ancient-philosophers/fields-medalists)
node tools/import-wikidata.mjs --preset ancient-philosophers --limit 40 --hrfl data/phil.hrfl
node tools/import-wikidata.mjs --sparql-file query.rq --hrfl data/custom.hrfl   # 任意SPARQL(?person のQID列)

# Postgres(PGlite=WASM版Postgres、システムインストール不要)
node tools/db.mjs init                # schema.sql を適用(db/data に永続化)
node tools/db.mjs load format/examples # .hrf/.hrfl を投入(EDTF→*_num・出典展開・関連人物stub化)
node tools/db.mjs demo                 # タイムライン/範囲検索/関係/来歴クエリを実行
node tools/db.mjs query "select prop,count(*) from claim group by 1"

# 閲覧Web(人物一覧・一生タイムライン・関係グラフ・出典・生者consent反映)
node tools/serve.mjs   # → http://localhost:5320
```

> **注意**: PGlite は単一プロセス前提。`db.mjs load` は **viewer を止めてから**(または load 後に起動)実行する。起動中サーバは投入を即時に反映しない(再起動で反映)。

**デプロイ**: 環境変数 `DATABASE_URL` を設定すると本番Postgres(Neon/Supabase等)に接続(無ければローカルPGlite)。スキーマ・ローダ・サーバは同一コードのまま。手順は [DEPLOY.md](DEPLOY.md)。

> 本番Web公開時はマネージドPostgres(Supabase/Neon等)へ接続文字列を差し替えるだけ。SQL(`format/schema.sql`)もローダ(`db.mjs`の各INSERT)もそのまま使える。

インポータは **P31=Q5(人間)以外を自動スキップ**し、関連人物を `hrf:person:wd-<QID>` の決定的IDで参照する(後で取り込むとグラフが繋がる)。生成物は書き出し前にHRFバリデータを通す。

### HRFの考え方(一言で)

人間を「行」ではなく、**不変IDの背骨に、出典付き・期間付きの言明(Claim)を束ねたもの**として表す。

- 矛盾する事実が共存できる(出典が事実単位で付く)
- 日付は **EDTF** で曖昧さごと保存(`1450~`「circa」、`../1500`「以前」、`1600/..`「存命」)
- いつ世界で真だったか(`valid`)と、いつ誰が記録したか(`asserted`)を分離(二時間性)
- 1事実の人も1万事実の人も同じ構造
- 生者は自分の記録を統治(項目別公開範囲・忘れられる権利・署名付き自己申告)

詳細は [format/SPEC.md](format/SPEC.md)。

## 技術スタック(決定済み)

- DB: **Postgres**(本格運用・大量データ・集計を見据える)
- データ源: **Wikidata**(CC0で約1,200万人物の構造化データ)＋ 他ソース ＋ 本人の自己申告
- 公開: Web デプロイ

## 進捗と次のステップ

- [x] データ形式 HRF v0.1 設計(`format/`)
- [x] 拡張子 `.hrf` / `.hrfl` ＋ バリデータCLI ＋ エディタ連携
- [x] **Wikidata → HRF インポータ**(実フェッチ済み・人間判定・関係グラフ・EDTF変換)
- [x] **Postgres(PGlite)に `schema.sql` 適用 ＋ `.hrfl` ロード**(EDTF→`*_num`・出典をassertion展開・関連人物stub化、demoクエリ動作)
- [x] **閲覧Web**(人物ページ・一生タイムライン・関係グラフ・出典表示・生者consent反映)— `tools/serve.mjs`(:5320)
- [x] **インポータ拡張: SPARQL一括選定**(`--preset`/`--sparql-file`・人間判定・並列取得・大域ラベル解決)
- [x] **量産＋デプロイ準備**: Nobel物理/化学・米大統領・フィールズ賞で **613名**規模(person 5,154/stub含・assertion 20,558)/ DB層を `DATABASE_URL` で本番Postgres対応(`dbconn.mjs`)/ Dockerfile・render.yaml・[DEPLOY.md](DEPLOY.md)
- [x] **GitHub公開** <https://github.com/Jinshin2534/jinrui-db>(public)＋ Render向け同梱シード起動 `tools/boot.mjs`(613名を起動時にPGlite再構築・外部DB不要)
- [ ] **Render接続**(あなたの操作のみ): repo を New Web Service / Blueprint で繋ぐ → 公開URL([DEPLOY.md](DEPLOY.md) §0)
- [ ] 認証＋本人登録フロー(OAuth → account → stewardship → 署名付き self claim)
- [ ] さらなる量産(数千〜)＋ 青空文庫等の他ソース
