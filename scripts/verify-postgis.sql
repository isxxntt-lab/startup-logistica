-- Verificación PostGIS tras restore. psql -v ON_ERROR_STOP=1 -f scripts/verify-postgis.sql
-- Fallo ≠ 0 si falta la extensión, el tipo geography o ST_DWithin.

\set ON_ERROR_STOP on
\echo == extensiones ==
SELECT extname, extversion
  FROM pg_extension
 WHERE extname IN ('postgis', 'pgcrypto')
 ORDER BY extname;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RAISE EXCEPTION 'falta la extensión postgis tras el restore';
  END IF;
END $$;

\echo == PostGIS_Version ==
SELECT PostGIS_Full_Version() AS postgis_full_version;

\echo == tipo geography ==
SELECT typname, typnamespace::regnamespace AS schema
  FROM pg_type
 WHERE typname = 'geography';

\echo == columnas geography (paradas / repartidores / puntos) ==
SELECT f_table_name, f_geography_column, type, srid, coord_dimension
  FROM geography_columns
 WHERE f_table_schema = 'public'
 ORDER BY f_table_name, f_geography_column;

DO $$
DECLARE
  n int;
BEGIN
  SELECT COUNT(*) INTO n
    FROM geography_columns
   WHERE f_table_schema = 'public'
     AND f_table_name IN ('paradas', 'repartidores', 'puntos_recogida');
  IF n < 3 THEN
    RAISE EXCEPTION 'geography_columns incompleto (%, se esperaban paradas/repartidores/puntos_recogida)', n;
  END IF;
END $$;

\echo == índices GIST ==
SELECT tablename, indexname
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND indexdef ILIKE '%gist%'
 ORDER BY tablename, indexname;

\echo == tablas de dominio ==
SELECT to_regclass('public.agencias') AS agencias,
       to_regclass('public.repartidores') AS repartidores,
       to_regclass('public.paradas') AS paradas,
       to_regclass('public.rutas') AS rutas;

DO $$
BEGIN
  IF to_regclass('public.paradas') IS NULL THEN
    RAISE EXCEPTION 'falta public.paradas tras el restore';
  END IF;
END $$;

\echo == ST_DWithin smoke (Madrid centro, no necesita filas) ==
SELECT ST_DWithin(
         ST_SetSRID(ST_MakePoint(-3.7038, 40.4168), 4326)::geography,
         ST_SetSRID(ST_MakePoint(-3.6995, 40.4180), 4326)::geography,
         600
       ) AS madrid_puntos_dentro_600m,
       ST_Distance(
         ST_SetSRID(ST_MakePoint(-3.7038, 40.4168), 4326)::geography,
         ST_SetSRID(ST_MakePoint(-3.6995, 40.4180), 4326)::geography
       )::int AS distancia_m;

DO $$
DECLARE
  ok boolean;
BEGIN
  SELECT ST_DWithin(
           ST_SetSRID(ST_MakePoint(-3.7038, 40.4168), 4326)::geography,
           ST_SetSRID(ST_MakePoint(-3.6995, 40.4180), 4326)::geography,
           600
         )
    INTO ok;
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'ST_DWithin no devolvió true en el smoke de Madrid';
  END IF;
END $$;

\echo == conteos (informativo; 0 filas no es error) ==
SELECT
  (SELECT COUNT(*) FROM agencias) AS agencias,
  (SELECT COUNT(*) FROM paradas) AS paradas,
  (SELECT COUNT(*) FROM paradas WHERE ubicacion IS NOT NULL) AS paradas_con_ubicacion;

\echo == verify-postgis OK ==
