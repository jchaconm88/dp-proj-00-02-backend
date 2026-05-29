import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, "..");
const yamlPath = join(root, "src/integration/openapi.yaml");
const jsonPath = join(root, "src/integration/openapi.json");
const doc = load(readFileSync(yamlPath, "utf8"));
writeFileSync(jsonPath, JSON.stringify(doc, null, 2));
console.log("Wrote", jsonPath);
