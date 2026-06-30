-- HRF (Human Record Format) v0.1 — Postgres 物理スキーマ
-- 設計: コア実体はテーブル、長い裾は jsonb、EDTFは正本テキスト＋導出した通日(*_num)で範囲検索。
-- *_num は符号付き通日(proleptic Gregorian, 0001-01-01 = 1, 紀元前は負)。取り込み時に edtf_num() で計算。

begin;

-- ───────────────────────────── 識別の背骨 ─────────────────────────────
create table person (
  id           text primary key,                       -- hrf:person:ULID
  status       text not null check (status in ('living','deceased','unknown')),
  merged_into  text references person(id),              -- 非null = 墓標(正準IDを指す)
  split_from   text references person(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index person_merged_idx on person(merged_into) where merged_into is not null;

create table person_identifier (
  person_id text not null references person(id) on delete cascade,
  scheme    text not null,                              -- wikidata | viaf | orcid | ...
  value     text not null,
  primary key (person_id, scheme, value)
);
create index person_identifier_lookup on person_identifier(scheme, value);

-- same_as / split_from を確信度付きで(同一性判断そのものを監査対象に)
create table identity_link (
  id          bigserial primary key,
  person_id   text not null references person(id) on delete cascade,
  other_id    text not null references person(id) on delete cascade,
  kind        text not null check (kind in ('same_as','split_from')),
  confidence  real,
  asserted_by text,
  note        text,
  created_at  timestamptz not null default now()
);

-- ───────────────────────────── 来歴(出典) ─────────────────────────────
create table source (
  id          text primary key,                         -- src ULID
  kind        text not null check (kind in ('wikidata','url','book','archival','census','oral','self')),
  ref         text,
  retrieved   date,
  reliability text check (reliability in ('primary','secondary','tertiary','self-reported')),
  license     text,
  signature   text
);

-- ───────────────────────────── 名前 ─────────────────────────────
create table name (
  id            text primary key,
  person_id     text not null references person(id) on delete cascade,
  type          text,                                    -- legal|birth|married|regnal|pen|...
  full_name     text not null,                           -- HRFの name.full(FULLは予約語のため列名は full_name)
  parts         jsonb,
  script        text,                                    -- ISO 15924
  lang          text,                                    -- BCP-47
  valid_edtf    text,
  valid_from_num bigint,
  valid_to_num   bigint,
  epistemic     text check (epistemic in ('attested','asserted','inferred','self','disputed')),
  confidence    real
);
create index name_person_idx on name(person_id);
create index name_full_idx   on name(full_name);

-- ───────────────────────────── 汎用 claim ─────────────────────────────
create table claim (
  id             text primary key,
  person_id      text not null references person(id) on delete cascade,
  prop           text not null,                          -- 語彙(controlled vocabulary)
  value          jsonb not null,                         -- scalar | entity | structured
  qualifiers     jsonb,
  valid_edtf     text,
  valid_from_num bigint,
  valid_to_num   bigint,
  epistemic      text check (epistemic in ('attested','asserted','inferred','self','disputed')),
  confidence     real,
  asserted_by    text,
  asserted_at    timestamptz,
  retracted_at   timestamptz                              -- 撤回は削除せずここを立てる(二時間性)
);
create index claim_person_idx on claim(person_id);
create index claim_prop_idx   on claim(prop);
create index claim_value_gin  on claim using gin (value jsonb_path_ops);
create index claim_validnum   on claim(valid_from_num, valid_to_num);

-- ───────────────────────────── 出来事 ─────────────────────────────
create table event (
  id           text primary key,
  person_id    text not null references person(id) on delete cascade,  -- 主体
  type         text not null,                             -- birth|death|marriage|award|...
  label        text,
  when_edtf    text,
  when_from_num bigint,
  when_to_num   bigint,
  place_label  text,
  place_ref    jsonb,
  geo_lat      double precision,
  geo_lon      double precision,
  payload      jsonb,
  epistemic    text,
  confidence   real
);
create index event_person_idx on event(person_id);
create index event_type_idx   on event(type);
create index event_whennum    on event(when_from_num, when_to_num);

create table event_participant (
  event_id  text not null references event(id) on delete cascade,
  person_id text references person(id) on delete set null,
  role      text not null,                                -- self|spouse|parent|child|witness|co_recipient|...
  primary key (event_id, role, person_id)
);

-- ───────────────────────────── 関係(グラフ辺) ─────────────────────────────
create table bond (
  id             text primary key,
  person_id      text not null references person(id) on delete cascade,  -- 辺の起点
  rel            text not null,                            -- parent_of|spouse_of|...
  with_id        text not null references person(id) on delete cascade,  -- 辺の終点
  valid_edtf     text,
  valid_from_num bigint,
  valid_to_num   bigint,
  via_event      text references event(id) on delete set null,
  epistemic      text,
  confidence     real
);
create index bond_person_idx on bond(person_id);
create index bond_with_idx   on bond(with_id);
create index bond_rel_idx    on bond(rel);

-- ───────────────────────────── 出典紐付け(多態) ─────────────────────────────
create table assertion (
  id           bigserial primary key,
  subject_kind text not null check (subject_kind in ('name','claim','event','bond')),
  subject_id   text not null,
  source_id    text not null references source(id) on delete cascade,
  method       text,                                       -- wikidata-import|manual|ocr|self|...
  confidence   real
);
create index assertion_subject_idx on assertion(subject_kind, subject_id);
create index assertion_source_idx  on assertion(source_id);

-- ───────────────────────────── 生者レイヤー ─────────────────────────────
create table account (
  id            text primary key,                          -- hrf:account:ULID
  email         text unique,
  auth_provider text,
  pubkey        text,                                       -- ed25519 公開鍵(自己申告の署名検証)
  created_at    timestamptz not null default now()
);

create table stewardship (
  account_id   text not null references account(id) on delete cascade,
  person_id    text not null references person(id) on delete cascade,
  claimed_at   timestamptz not null default now(),
  verification text check (verification in ('email','gov-id','oauth','none')),
  primary key (account_id, person_id)
);
-- 1人の person は最大1アカウントに claim される
create unique index stewardship_one_per_person on stewardship(person_id);

create table consent (
  person_id text primary key references person(id) on delete cascade,
  scope     text check (scope in ('public','researchers','private')),
  fields    jsonb,                                          -- {prop: visibility}
  rtbf      boolean not null default false,
  license   text,
  signed_by text,
  signature text
);

commit;

-- ─── 任意の拡張(あいまい名寄せを使うとき) ───
-- create extension if not exists pg_trgm;
-- create index name_full_trgm on name using gin (full_name gin_trgm_ops);
--
-- EDTF → valid_from_num/to_num(符号付き通日)は取込側(tools/edtf.mjs の edtfBounds)で計算して投入する。
