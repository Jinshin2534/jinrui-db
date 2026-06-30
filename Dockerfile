# 人類DB 閲覧サーバ。本番は環境変数 DATABASE_URL のマネージドPostgresに接続する。
FROM node:24-slim
WORKDIR /app

# 依存を先に入れてレイヤキャッシュを効かせる
COPY tools/package.json ./tools/
RUN cd tools && npm install --omit=dev --no-audit --no-fund

# アプリ本体(serve.mjs / web / dbconn / edtf)＋ 同梱シード(format, data)
COPY tools ./tools
COPY format ./format
COPY data ./data

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
# 起動時にDBが空なら同梱.hrflからPGliteを再構築してから配信(外部DB不要)
CMD ["node", "tools/boot.mjs"]
