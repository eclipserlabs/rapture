// Calibration database layer: pg Pool + schema init + seed.
// Reads PGHOST/PGPORT/PGUSER/PGDATABASE (defaults target local repro_v2).
import pg from "pg";

export function poolConfig() {
  return {
    host: process.env["PGHOST"] ?? "localhost",
    port: Number(process.env["PGPORT"] ?? 5432),
    user: process.env["PGUSER"] ?? "wira",
    database: process.env["PGDATABASE"] ?? "repro_v2",
  };
}

export function createPool() {
  return new pg.Pool(poolConfig());
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, status TEXT NOT NULL, total INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inventory (sku TEXT PRIMARY KEY, qty INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flags (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, entry TEXT NOT NULL);
`;

export async function initSchema(pool) {
  await pool.query(SCHEMA);
}

export async function seed(pool) {
  await pool.query("DELETE FROM audit_log");
  await pool.query("DELETE FROM flags");
  await pool.query("DELETE FROM users");
  await pool.query("DELETE FROM inventory");
  await pool.query("DELETE FROM products");
  await pool.query("DELETE FROM orders");
  await pool.query(
    "INSERT INTO orders (id, status, total) VALUES ('ord-ok', 'active', 100), ('ord-bad', 'suspended', 250), ('ord-noise', 'active', 30)",
  );
  await pool.query(
    "INSERT INTO products (sku, name, price) VALUES ('sku-1', 'Widget', 999), ('sku-noise', 'Gadget', 100)",
  );
  await pool.query("INSERT INTO inventory (sku, qty) VALUES ('sku-1', 2), ('sku-noise', 50)");
  await pool.query(
    "INSERT INTO users (id, email, role) VALUES ('u-ok', 'ok@example.com', 'member'), ('u-bad', NULL, 'banned')",
  );
  await pool.query("INSERT INTO flags (name, value) VALUES ('region-ok', 'us'), ('noise-flag', 'x')");
  await pool.query("INSERT INTO audit_log (entry) VALUES ('seed-1'), ('seed-2'), ('seed-3')");
}
