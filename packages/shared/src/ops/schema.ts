import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlClient } from "./types.js";

function schemaCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, "../../../../infra/postgres/04-ops.sql"),
    resolve(process.cwd(), "infra/postgres/04-ops.sql"),
    resolve(process.cwd(), "../../infra/postgres/04-ops.sql"),
    resolve(process.cwd(), "../infra/postgres/04-ops.sql"),
  ];
}

export function loadOpsSchemaSql(): string {
  for (const candidate of schemaCandidates()) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error("No se encontró infra/postgres/04-ops.sql");
}

export async function applyOpsSchema(db: SqlClient): Promise<void> {
  await db.query(loadOpsSchemaSql());
}
