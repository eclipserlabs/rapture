// Boot the fake external dependency. Usage: PORT=4892 node fake-runner.mjs
import { createFakeExternal } from "./fake-external.mjs";

const port = Number(process.env["PORT"] ?? 4892);
createFakeExternal().listen(port, () => {
  console.log(`READY ${port}`);
});
