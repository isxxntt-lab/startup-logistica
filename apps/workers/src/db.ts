import pg from "pg";

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://logistica:logistica@localhost:5432/startup_logistica",
});
