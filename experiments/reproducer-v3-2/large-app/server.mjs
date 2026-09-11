// Phase 7 launcher for the parse-server large-application case.
//
// This is a LAUNCHER, not a service fixture: it does exactly what
// `parse-server --appId ... --databaseURI ...` does, using the application's
// own ParseServer export and its own express app, with no route of ours and
// no application source change. Rapture is attached exclusively by the generic
// `--import <register.mjs>` bootstrap on the command line.
//
// The one thing we add is the standard `express()` host that the project's own
// bin/parse-server uses, because ParseServer.start() returns middleware.
//
// Usage: node --import <register.mjs> server.mjs
//   env: PARSE_ROOT (worktree), PORT, DATABASE_URI, APP_ID, MASTER_KEY
const root = process.env["PARSE_ROOT"];
if (!root) throw new Error("PARSE_ROOT is required");

const { createRequire } = await import("node:module");
const require = createRequire(`${root}/package.json`);
const express = require("express");
const { ParseServer } = require(`${root}/lib/index.js`);

const app = express();
const server = new ParseServer({
  databaseURI: process.env["DATABASE_URI"],
  appId: process.env["APP_ID"] ?? "v31app",
  masterKey: process.env["MASTER_KEY"] ?? "v31master",
  serverURL: `http://127.0.0.1:${process.env["PORT"] ?? 47900}/parse`,
  mountPath: "/parse",
  allowClientClassCreation: true,
  silent: true,
});
await server.start();
app.use("/parse", server.app);

app.listen(Number(process.env["PORT"] ?? 47900), () => console.log("READY"));
