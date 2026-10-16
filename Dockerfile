# solbot2 — image mince, pas de build TS (tsx en runtime comme npm start)
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# dépendances only (cache layer)
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY public ./public
COPY config ./config
RUN npm ci --omit=dev

# volume workspace : DB SQLite, STOP, .env
VOLUME ["/app/data"]
ENV SOLBOT_DATA_DIR=/app/data

EXPOSE 4100

# paper par défaut ; MODE surchargé par .env/-e
CMD ["npx", "tsx", "src/index.ts", "start"]
