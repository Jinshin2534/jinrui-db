# HRF — Human Record Format v0.1

> 人類を恒久保存するためのデータ形式。
> 1人の人間を「不変IDの背骨」に「出典付き・期間付きの言明(Claim)」を束ねたものとして表す。
> 古代の無名者(1事実)から著名人(1万事実)まで、生者の自己申告から教会簿まで、同じ器で扱う。

- 拡張子:
  - **`.hrf`** — 1ファイル = 1 Person Record(背骨 + その人に紐づく全言明)。JSON文書。これが正準。
  - **`.hrfl`** — *HRF Lines*。1行 = 1 Person Record の NDJSON(改行区切りJSON)。数百万人の一括入出力・ストリーム取込用。
- メディアタイプ: `application/vnd.hrf+json`(`.hrf`)/ `application/vnd.hrf+json-seq`(`.hrfl`)
- ID接頭辞: `hrf:person:`, `hrf:account:`
- 物理保存はPostgres(`schema.sql`参照)。`.hrf`/`.hrfl` は交換・バックアップ・取込の可搬形式。
- ツール: `tools/`(`hrf validate` / `hrf info` / `hrf selftest`、依存ゼロ)。エディタ連携は `.vscode/settings.json`(`.hrf` に `person.schema.json` を自動適用)。

---

## 0. 設計原則(なぜこの形か)

| # | 原則 | 解決する難所 |
|---|------|------|
| P1 | **Claim原子性**: 事実は「行の列」ではなく独立した言明オブジェクト | 矛盾値の共存・事実単位の出典・1〜1万事実の同一構造 |
| P2 | **二時間性 (bitemporal)**: `valid`(世界で真な期間) と `asserted`(記録された時刻/撤回) を分離 | 歴史的改訂・監査・「いつ分かったか」 |
| P3 | **不確実性ネイティブ**: 日付は EDTF、各claimに `confidence`(0–1) と `epistemic` | 「circa」「以前」「1620年代」「一説には」 |
| P4 | **出典必須**: あらゆる claim/event/bond は ≥1 の source を参照 | Wikidata と本人申告の混在を明示的に区別 |
| P5 | **ID統治**: person は merge/split 可能・確信度付き同一視 | 重複・誤統合を可逆に、データを失わず統合 |
| P6 | **生者の自己統治**: stewardship・consent・署名付き自己申告 | 同意範囲、忘れられる権利、本人発言の真正性 |
| P7 | **関係はグラフ**: bond で person↔person を型付き辺に | 血縁・社会ネットワーク |

設計の非目標: 新しいバイナリエンコードの発明はしない。革新は*モデル*にあり、JSONで表現しPostgresに保存する。

---

## 1. オブジェクトモデル

Person Record は7種のオブジェクトで構成される。

```
Person (背骨/不変ID)
 ├─ identity      外部ID・same_as・merge/split
 ├─ stewardship   (生者のみ) 本人アカウントとの紐付け
 ├─ names[]       Name claim(多書体・型・期間つき)
 ├─ claims[]      汎用の言明(職業・国籍・身体特徴…)
 ├─ events[]      時点/期間に紐づく出来事(誕生・結婚・移住・死…)
 ├─ bonds[]       person↔person の関係辺
 ├─ sources[]     来歴(claim等から参照される)
 ├─ consent       (生者のみ) 項目別公開範囲・RTBF・署名
 └─ meta          作成/更新時刻ほか
```

すべての知識単位(name/claim/event/bond)は次の共通フィールドを持つ:

- `valid` — EDTF時間オブジェクト(その事実が世界で真だった期間)。
- `epistemic` — `attested`(出典が文書化) / `asserted`(誰かが主張) / `inferred`(推論) / `self`(本人申告) / `disputed`(係争中)。
- `confidence` — 0.0–1.0。
- `src` — `sources[]` 内 source id の配列。
- `asserted` — `{ by, at, retracted }`(記録した主体・時刻・撤回時刻)。撤回は削除せず `retracted` を立てる(P2)。

---

## 2. EDTF時間型(この形式の要)

歴史データの曖昧さを失わずに保持・比較するため、日付は **EDTF (ISO 8601-2, Library of Congress 拡張日時形式)** を採用する。

| EDTF | 意味 |
|------|------|
| `1879-03-14` | 確定(日精度) |
| `1450~` | およそ(circa) |
| `1450?` | 不確実 |
| `1450%` | およそ かつ 不確実 |
| `15XX` | 16世紀のどこか |
| `1867-11` | 月精度 |
| `[1450..1455]` | このいずれか1つ |
| `../1500` | 1500年以前(開始不明) |
| `1600/..` | 1600年から継続中(存命など) |
| `1879/1955` | 期間(生没など) |

`valid` オブジェクトの形:

```json
{
  "from": "1867-11-07",
  "to":   "1934-07-04",
  "edtf": "1867-11-07/1934-07-04",
  "precision": "day",
  "note": "生没期間"
}
```

`edtf` が正本(人間可読・相互運用の単一の真実)。`from`/`to` は導出した便宜値。Postgres取り込み時に `*_num`(符号付き通日, 紀元前は負)を計算し範囲検索に使う(§5)。

---

## 3. 各オブジェクトの仕様

### 3.1 Person(背骨)

```json
{
  "hrf": "0.1",
  "id": "hrf:person:01J9Z3K8QF7M2N6V4T8B0WXYZ",
  "kind": "person",
  "status": "deceased",
  "identity": {
    "external_ids": [
      { "scheme": "wikidata", "value": "Q7186" },
      { "scheme": "viaf", "value": "75121530" }
    ],
    "same_as":     [{ "id": "hrf:person:...", "confidence": 0.7, "by": "import:census-1881", "note": "綴り違いの重複候補" }],
    "merged_into": null,
    "split_from":  null
  }
}
```

- `id` は不変・不透明(ULID推奨)。一度発行したら絶対に再利用しない。
- `status`: `living` | `deceased` | `unknown`。
- `merged_into` が非nullなら、このレコードは墓標(tombstone)で、正準IDを指す。物理削除しない。

### 3.2 Name(名前 claim)

名前は多書体・型・期間を持つため専用構造にする。

```json
{
  "type": "birth",
  "full": "Maria Salomea Skłodowska",
  "parts": { "given": ["Maria", "Salomea"], "family": ["Skłodowska"], "particle": null },
  "script": "Latn",
  "lang": "pl",
  "valid": { "edtf": "1867-11-07/1895", "precision": "year" },
  "epistemic": "attested",
  "confidence": 0.98,
  "src": ["src:wd"]
}
```

`type`: `legal` | `birth` | `married` | `regnal`(即位名) | `pen`(筆名) | `religious` | `nick` | `romanization` | `other`。

### 3.3 Claim(汎用言明)

```json
{
  "id": "c:nationality-fr",
  "prop": "citizenship",
  "value": { "entity": "France", "ref": { "scheme": "wikidata", "value": "Q142" } },
  "qualifiers": { "basis": "naturalization" },
  "valid": { "edtf": "1908/1934", "precision": "year" },
  "epistemic": "attested",
  "confidence": 0.95,
  "src": ["src:wd"],
  "asserted": { "by": "import:wikidata", "at": "2026-06-30", "retracted": null }
}
```

- `prop` は語彙(controlled vocabulary)。初期セット: `birth_date` `death_date` `citizenship` `occupation` `residence` `religion` `education` `field_of_work` `member_of` `eye_color` `height` `cause_of_death` `language` `sex_or_gender` … 拡張は名前空間付き(例 `x:blood_type`)。
- `value` は3形のいずれか: スカラ(`{"text":...}`/`{"number":...}`) / 実体参照(`{"entity":..,"ref":..}`) / 構造体。

### 3.4 Event(出来事)

```json
{
  "id": "e:nobel-physics-1903",
  "type": "award",
  "when": { "edtf": "1903", "precision": "year" },
  "where": { "label": "Stockholm", "ref": { "scheme":"wikidata","value":"Q1754" }, "geo": [59.33, 18.06] },
  "label": "ノーベル物理学賞",
  "participants": [
    { "role": "self", "person": "hrf:person:01J9Z3K8..." },
    { "role": "co_recipient", "person": "hrf:person:PIERRE..." }
  ],
  "epistemic": "attested",
  "confidence": 0.99,
  "src": ["src:wd"]
}
```

`type`: `birth` `death` `marriage` `divorce` `residence_change` `migration` `education` `occupation_start` `award` `publication` `military_service` `imprisonment` `religious_rite` … 拡張は `x:` 名前空間。

### 3.5 Bond(関係辺)

```json
{
  "id": "b:spouse-pierre",
  "rel": "spouse_of",
  "with": "hrf:person:PIERRE...",
  "valid": { "edtf": "1895-07-26/1906-04-19", "precision": "day", "note": "結婚〜ピエール死去" },
  "via_event": "e:marriage-1895",
  "epistemic": "attested",
  "confidence": 0.99,
  "src": ["src:wd"]
}
```

`rel`: `parent_of` `child_of` `spouse_of` `sibling_of` `mentor_of` `student_of` `colleague_of` `friend_of` … 対称関係(spouse/sibling)は両person記録に1本ずつ持たせ、`bond.id` を共有して双方向を表す。

### 3.6 Source(来歴)

```json
{
  "id": "src:wd",
  "kind": "wikidata",
  "ref": "Q7186",
  "retrieved": "2026-06-30",
  "reliability": "tertiary",
  "license": "CC0-1.0",
  "signature": null
}
```

`kind`: `wikidata` | `url` | `book` | `archival`(教会簿・戸籍等) | `census` | `oral` | `self`。
`reliability`: `primary` | `secondary` | `tertiary` | `self-reported`。

### 3.7 生者レイヤー: stewardship / consent

```json
"stewardship": {
  "account": "hrf:account:01J...",
  "claimed_at": "2026-06-30",
  "verification": "oauth"
},
"consent": {
  "scope": "public",
  "fields": { "birth_date": "public", "residence": "private", "contact": "researchers" },
  "rtbf": false,
  "license": "CC-BY-4.0",
  "signed_by": "hrf:account:01J...",
  "signature": "ed25519:BASE64..."
}
```

- 生者の `epistemic:"self"` な claim は、本人アカウント鍵で署名できる → 「本人が本人について言った」ことが検証可能で、第三者claimと構造的に区別される(P6)。
- `consent.fields` は項目別公開範囲(`public`/`researchers`/`private`)。エクスポート/API はこれを必ず適用する。
- `rtbf:true`(忘れられる権利)要求時は、self由来claimをトゥームストーン化し、第三者の公的事実のみ残す等のポリシーをアプリ層で適用。

---

## 4. 同一性: merge / split / same_as(P5)

- **same_as**: 別IDだが同一人物の可能性。確信度付き。自動重複検出はここに低確信で書き、人手で昇格。
- **merge**: 2レコードを統合 → 片方を `merged_into` 墓標化し、claim/event/bond を正準側へ移送(`asserted.by` に統合操作を記録)。**元IDは永久に正準IDへ解決され続ける**(リンク切れ防止)。
- **split**: 誤統合の取消。新IDを発行し `split_from` で由来を残す。

いずれも破壊的削除をしない。同一性の判断そのものが監査対象。

---

## 5. Postgres物理モデル(`schema.sql`)

- コア実体はテーブル化(`person`/`name`/`claim`/`event`/`bond`/`source`/`assertion`/`account`/`stewardship`/`consent`)。
- claim の `value` と `qualifiers` は `jsonb`(GINインデックス)で長い裾を吸収。
- EDTFは `*_edtf`(正本テキスト)に加え、取り込み時に `*_from_num`/`*_to_num`(符号付き通日, BCEは負)を計算してbtree索引 → 範囲検索を高速化。
- 出典紐付けは多態 `assertion(subject_kind, subject_id, source_id, method, confidence)` に集約。

### クエリ例(この複雑さが報われる場面)

```sql
-- 1850年代にパリに居住していた人物
select distinct p.id
from claim c join person p on p.id = c.person_id
where c.prop = 'residence'
  and c.value->>'entity' = 'Paris'
  and c.valid_from_num <= edtf_num('1859-12-31')
  and c.valid_to_num   >= edtf_num('1850-01-01');

-- 生年が出典間で食い違う人物(disputed検出)
select person_id, array_agg(distinct value->>'text') vals
from claim where prop='birth_date'
group by person_id having count(distinct value->>'text') > 1;
```

---

## 6. バージョニング

- `hrf` フィールドが形式バージョン(SemVer)。後方非互換変更でメジャーを上げる。
- 語彙(prop/type/rel/scheme)は別ファイル `vocab.json` で管理し、フォーマット本体と独立に拡張可能。
- 未知の `prop`/`type` は破棄せず保持(forward-compatible)。

---

## 7. 最小例(優雅な縮退 — 1事実だけの人)

教会簿に名前と埋葬記録しか残らない人物も、同じ構造で表せる:

```json
{
  "hrf": "0.1",
  "id": "hrf:person:01J9PARISH00000000000000",
  "kind": "person",
  "status": "deceased",
  "identity": { "external_ids": [] },
  "names": [{ "type": "legal", "full": "Anne Lefèvre", "script": "Latn", "lang": "fr",
              "epistemic": "attested", "confidence": 0.6, "src": ["src:reg"] }],
  "events": [{ "id": "e:burial", "type": "death", "when": { "edtf": "1703~" },
              "where": { "label": "Saint-Sulpice, Paris" },
              "epistemic": "attested", "confidence": 0.5, "src": ["src:reg"] }],
  "sources": [{ "id": "src:reg", "kind": "archival",
                "ref": "Paris, Saint-Sulpice 埋葬簿 1703, fol. 12", "reliability": "primary" }]
}
```

著名人との違いは claim の*数*だけ。スキーマは変わらない。
