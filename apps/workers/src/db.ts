import pg from "pg";
import { buildPoolConfig } from "@startup-logistica/shared/db";

export const pool = new pg.Pool(buildPoolConfig());

// Evita que un error en un cliente idle del pool tumbe el proceso del worker.
pool.on("error", (err) => {
  console.error("[db] error en cliente idle del pool de Postgres:", err.message);
});
