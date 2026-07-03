// Copies runtime assets that tsc does not emit into dist.
// exchange-rates.json is read with fs.readFile at runtime (relative to the
// compiled module), so it must exist next to dist/config/exchange-rates.js.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist/config", { recursive: true });
copyFileSync("src/config/exchange-rates.json", "dist/config/exchange-rates.json");

console.log("[build] copied src/config/exchange-rates.json -> dist/config/exchange-rates.json");
