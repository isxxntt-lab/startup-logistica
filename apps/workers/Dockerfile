FROM node:20-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Copy workspace manifests + the sources this image actually runs *before*
# `pnpm install`. Installing first creates package-local node_modules
# (directories/symlinks) that later COPY of packages/shared or apps/* collides
# with, especially on Windows hosts.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/workers apps/workers
COPY apps/api/package.json apps/api/
COPY apps/web-cliente/package.json apps/web-cliente/
COPY apps/web-repartidor/package.json apps/web-repartidor/
COPY apps/web-dashboard/package.json apps/web-dashboard/
COPY infra/postgres infra/postgres

# Drop any host node_modules that snuck past .dockerignore (symlinks on Windows).
RUN rm -rf node_modules packages/*/node_modules apps/*/node_modules \
 && pnpm install --frozen-lockfile

RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid 10001 --home-dir /app --no-create-home --shell /usr/sbin/nologin app \
    && chown -R app:app /app

WORKDIR /app/apps/workers
ENV NODE_ENV=production
USER 10001:10001

CMD ["pnpm", "start:prod"]
