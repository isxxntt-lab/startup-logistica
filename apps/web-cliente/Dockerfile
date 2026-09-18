FROM node:20-bookworm-slim AS build

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
COPY apps/web-cliente apps/web-cliente

ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL

RUN pnpm --filter @startup-logistica/web-cliente build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY apps/web-cliente/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /app/apps/web-cliente/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
