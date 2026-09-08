// Initialize + seed the calibration database. Usage: node cal-db.mjs
import { createPool, initSchema, seed } from "../calibration/service/db.mjs";

const pool = createPool();
await initSchema(pool);
await seed(pool);
await pool.end();
console.log("calibration db ready");
