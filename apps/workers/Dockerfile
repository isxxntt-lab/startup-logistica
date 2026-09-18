FROM node:20-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/workers/package.json apps/workers/
COPY apps/web-cliente/package.json apps/web-cliente/
COPY apps/web-repartidor/package.json apps/web-repartidor/
COPY apps/web-dashboard/package.json apps/web-dashboard/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/workers apps/workers
COPY infra/postgres infra/postgres

RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid 10001 --home-dir /app --no-create-home --shell /usr/sbin/nologin app \
    && chown -R app:app /app

WORKDIR /app/apps/workers
ENV NODE_ENV=production
USER 10001:10001

CMD ["pnpm", "start:prod"]
