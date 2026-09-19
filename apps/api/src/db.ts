import pg from "pg";
import { buildPoolConfig } from "@startup-logistica/shared/db";
import { config } from "./config.js";

export const pool = new pg.Pool(
  buildPoolConfig({ ...process.env, DATABASE_URL: config.databaseUrl }),
);

// Sin este manejador, un error en un cliente idle (p. ej. Postgres reiniciando o
// cerrando la conexión) emite un evento 'error' no capturado que tumba el proceso.
pool.on("error", (err) => {
  console.error("[db] error en cliente idle del pool de Postgres:", err.message);
});
