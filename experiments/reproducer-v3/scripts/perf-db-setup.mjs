// V3 perf DB setup: creates + seeds v3shop_*/v3dir_* tables in repro_v2.
// Usage: node scripts/perf-db-setup.mjs
const PG_URL = new URL("../../reproducer-v2/node_modules/pg/lib/index.js", import.meta.url);
const { default: pg } = await import(PG_URL.href);

const pool = new pg.Pool({
  host: process.env["PGHOST"] ?? "localhost",
  port: Number(process.env["PGPORT"] ?? 5432),
  user: process.env["PGUSER"] ?? "wira",
  database: process.env["PGDATABASE"] ?? "repro_v2",
});

await pool.query(`CREATE TABLE IF NOT EXISTS v3shop_products (sku TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL)`);
await pool.query(`CREATE TABLE IF NOT EXISTS v3shop_inventory (sku TEXT PRIMARY KEY, qty INTEGER NOT NULL)`);
await pool.query(`CREATE TABLE IF NOT EXISTS v3shop_orders (id SERIAL PRIMARY KEY, sku TEXT NOT NULL, qty INTEGER NOT NULL, cost INTEGER NOT NULL)`);
await pool.query(`CREATE TABLE IF NOT EXISTS v3dir_users (id TEXT PRIMARY KEY, handle TEXT NOT NULL, role TEXT NOT NULL)`);
await pool.query(`CREATE TABLE IF NOT EXISTS v3dir_sessions (sid TEXT PRIMARY KEY, uid TEXT NOT NULL, role TEXT NOT NULL)`);
await pool.query(`CREATE TABLE IF NOT EXISTS v3dir_flags (name TEXT PRIMARY KEY, value TEXT NOT NULL)`);
await pool.query(`CREATE TABLE IF NOT EXISTS v3dir_events (id SERIAL PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL)`);
await pool.query(`DELETE FROM v3shop_orders`);
await pool.query(`DELETE FROM v3shop_inventory`);
await pool.query(`DELETE FROM v3shop_products`);
await pool.query(
  `INSERT INTO v3shop_products (sku, name, price) VALUES ('sku-1','Widget',999),('sku-2','Gadget',499),('sku-3','Doohickey',1299)`,
);
await pool.query(`INSERT INTO v3shop_inventory (sku, qty) VALUES ('sku-1',100),('sku-2',100),('sku-3',100)`);
await pool.query(`DELETE FROM v3dir_events`);
await pool.query(`DELETE FROM v3dir_sessions`);
await pool.query(`DELETE FROM v3dir_users`);
await pool.query(`DELETE FROM v3dir_flags`);
await pool.query(
  `INSERT INTO v3dir_users (id, handle, role) VALUES ('u-1','alice','member'),('u-2','bob','member'),('u-3','carol','admin')`,
);
await pool.query(`INSERT INTO v3dir_sessions (sid, uid, role) VALUES ('sess-alice','u-1','member'),('sess-anon','anon','guest')`);
await pool.query(`INSERT INTO v3dir_flags (name, value) VALUES ('directory-v2','on')`);
await pool.query(`INSERT INTO v3dir_events (kind, payload) VALUES ('seed','{}')`);
await pool.end();
console.log("v3 perf db ready");
