FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN npm ci --no-audit --no-fund
COPY . .
ENTRYPOINT ["/usr/bin/tini", "--"]
FROM base AS api
USER node
CMD ["npm","run","api"]
FROM base AS worker
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
USER node
CMD ["npm","run","worker"]
FROM base AS web
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w apps/web
USER node
EXPOSE 3000
CMD ["npm","run","start","-w","apps/web"]
