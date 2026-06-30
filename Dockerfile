# 人類DB 閲覧サーバ。本番は環境変数 DATABASE_URL のマネージドPostgresに接続する。
FROM node:24-slim
WORKDIR /app

# 依存を先に入れてレイヤキャッシュを効かせる
COPY tools/package.json ./tools/
RUN cd tools && npm install --omit=dev --no-audit --no-fund

# アプリ本体 ＋ 事前ビルド済みDB(db/data)＋ シード元(format, data)
COPY tools ./tools
COPY format ./format
COPY data ./data
COPY db ./db

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
# 事前ビルド済みPGlite(db/data)をそのまま配信(空のときのみ同梱.hrflから再構築)。外部DB不要・低メモリ。
CMD ["node", "tools/boot.mjs"]
