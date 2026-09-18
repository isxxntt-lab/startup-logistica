# HTTPS local del stack de producción (sin ACME)

El `Caddyfile` de producción pide certificados Let's Encrypt para `SITE_TRACKING` / `SITE_API`. En un portátil (sin DNS público) eso falla o pelea con los dominios reales del `.env.production`.

Este repo **no** mete `tls internal` en el Caddyfile de prod. Para smoke local se usa un override.

## Arranque

```bash
cp .env.production.local.example .env.production
# edita POSTGRES_PASSWORD, REDIS_PASSWORD, JWT_MASTER_SECRET, OPS_TOKEN
# no commitees .env.production

docker compose -f docker-compose.prod.yml -f docker-compose.prod.local.yml \
  --env-file .env.production up -d --build
```

| Variable | Valor local |
|---|---|
| `SITE_TRACKING` | `localhost` |
| `SITE_API` | `api.localhost` (RFC 6761 → 127.0.0.1) |
| `PUBLIC_WEB_URL` | `https://localhost` |
| `VITE_API_URL` | `https://api.localhost` |
| Caddyfile | `Caddyfile.local` (`tls internal` + `local_certs`) |

El override **reemplaza** el mount de `/etc/caddy/Caddyfile`. El `Caddyfile` de prod (ACME + `email {$ACME_EMAIL}`) no se toca.

## Comprobar

```bash
curl -kfsS https://localhost/ >/dev/null
curl -kfsS https://api.localhost/health
curl -kfsS https://api.localhost/api/ops/health
```

`-k` hace falta porque el CA interno de Caddy no está en el almacén del SO. En el navegador, aceptar el aviso una vez o instalar el CA de Caddy (`caddy_data`).

El compose de prod **no** monta `02-seed.sql`. Sin agencia no hay `demo-api-key`. El smoke E2E con seed sigue siendo `docker compose up -d` (compose local) + `deploy/STAGING_SMOKE.md`.

## VPS / ACME real

```bash
cp .env.production.example .env.production
# SITE_TRACKING / SITE_API / ACME_EMAIL reales
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

**No** pases `-f docker-compose.prod.local.yml` en el VPS.
