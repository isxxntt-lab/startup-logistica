# HTTPS local (localhost / api.localhost)

Smoke del stack **prod** en la máquina de desarrollo, con TLS interno de Caddy.
**No** pidas certificados Let's Encrypt. **No** apuntes DNS público. **No** uses este overlay en el VPS.

El `Caddyfile` de producción sigue con ACME (`email {$ACME_EMAIL}`) y los dominios `SITE_TRACKING` / `SITE_API`. Este flujo monta `Caddyfile.local` encima, solo en local.

## Arranque

```bash
cp .env.production.local.example .env.production.local
# opcional: cambia POSTGRES_PASSWORD / REDIS_PASSWORD / JWT_MASTER_SECRET
# no commitees .env.production.local ni .env.production

docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.prod.local.yml \
  --env-file .env.production.local \
  up -d --build
```

| Host | Destino |
|---|---|
| `https://localhost` | SPA (`web:8080`) |
| `https://api.localhost` | API (`api:3000`) |

Los navegadores actuales resuelven `*.localhost` a `127.0.0.1`. En Windows, si `api.localhost` no resuelve, añade `127.0.0.1 api.localhost` en `C:\Windows\System32\drivers\etc\hosts`.

## Confiar el CA interno

Caddy guarda la CA en el volumen `caddy_data`. El navegador avisará de certificado no confiable hasta que importes esa CA (o aceptes la excepción una vez).

```bash
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.prod.local.yml \
  --env-file .env.production.local \
  exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > caddy-local-root.crt
```

Instala `caddy-local-root.crt` en el almacén de autoridades de tu SO/navegador. No subas ese fichero al repo.

## Qué no hacer

- No pongas `tls internal` en el `Caddyfile` de producción.
- No uses `SITE_TRACKING=seguimiento.rutacerca.es` contra este overlay: ACME fallará sin DNS público.
- Prod en el VPS: `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build` **sin** el overlay local.
