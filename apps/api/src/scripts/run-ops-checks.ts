import {
  applyOpsSchema,
  initOps,
  runOpsChecks,
} from "@startup-logistica/shared/ops";
import { pool } from "../db.js";

initOps(pool);
await applyOpsSchema(pool);
const result = await runOpsChecks(pool);
console.log(JSON.stringify(result, null, 2));
await pool.end();
