import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

export function loadIntegrationOpenApiSpec(): Record<string, unknown> {
  const specPath = join(import.meta.dirname, "openapi.yaml");
  const yaml = readFileSync(specPath, "utf8");
  const doc = load(yaml);
  if (!doc || typeof doc !== "object") {
    throw new Error("invalid_openapi_spec");
  }
  return doc as Record<string, unknown>;
}
