// Generates packages/sdk/src/generated from the relayfor.si OpenAPI document.
//
//   pnpm generate         regenerate, warn if the spec differs from openapi.lock.json
//   pnpm generate:check   regenerate, fail if the spec differs from openapi.lock.json
//   pnpm spec:accept      regenerate and update openapi.lock.json
//
// RELAYFOR_OPENAPI_URL overrides the source: an http(s) URL or a path relative to the repo.
// The lock hashes the spec without descriptions, so documentation-only changes do not count.
// Error codes come from the Error schema's enum and webhook events from the `webhooks` section;
// a spec without either fails the build rather than ship guessed types.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import openapiTS, { astToString } from "openapi-typescript";

import { leaks } from "../../scripts/public-names.mjs";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Operation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
}

interface Lock {
  readonly shape: string;
  readonly specVersion: string;
  readonly operations: Record<string, string>;
  readonly schemas: Record<string, string>;
}

const DEFAULT_URL = "https://relayfor.si/api/project/v1/openapi.json";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, "packages/sdk/src/generated");
const LOCK = resolve(ROOT, "openapi.lock.json");
const METHODS = ["get", "post", "put", "patch", "delete"];
// Keys ignored when hashing.
const PROSE = new Set(["description", "summary", "example", "examples", "title"]);

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const accept = args.has("--accept");

function fail(message: string): never {
  console.error(`generate: ${message}`);
  process.exit(1);
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchSpec(url: string): Promise<Json> {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        lastError = `${url} returned ${response.status}`;
      } else if (!type.includes("json")) {
        fail(`${url} returned ${type || "no content-type"}, expected JSON.`);
      } else {
        return (await response.json()) as Json;
      }
    } catch (error) {
      lastError = `${url}: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (attempt < 3) await new Promise((done) => setTimeout(done, attempt * 1_000));
  }
  return fail(`could not fetch the spec: ${lastError}`);
}

function readSpec(path: string): Json {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch (error) {
    return fail(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** A copy without the keys `drop` names, at any depth. */
function without(value: Json, drop: (key: string) => boolean): Json {
  if (Array.isArray(value)) return value.map((item) => without(item, drop));
  if (!isObject(value)) return value;
  const copy: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (!drop(key)) copy[key] = without(item, drop);
  }
  return copy;
}

/** JSON with sorted keys, so a hash never depends on key order. */
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  const keys = Object.keys(value).toSorted();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key] as Json)}`).join(",")}}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function shapeHash(value: Json): string {
  return sha256(canonical(without(value, (key) => PROSE.has(key))));
}

const source = process.env["RELAYFOR_OPENAPI_URL"] ?? DEFAULT_URL;
const raw = /^https?:\/\//.test(source)
  ? await fetchSpec(source)
  : readSpec(resolve(ROOT, source.replace(/^file:\/\//, "")));

if (!isObject(raw)) fail("the spec is not a JSON object");
const version = raw["openapi"];
if (typeof version !== "string" || !version.startsWith("3.1.")) {
  fail(`expected OpenAPI 3.1.x, got ${JSON.stringify(version)}`);
}
const info = raw["info"];
const specVersion = isObject(info) && typeof info["version"] === "string" ? info["version"] : "";
if (!specVersion.startsWith("1.")) {
  fail(`expected info.version 1.x (API v1), got ${JSON.stringify(specVersion)}`);
}
const paths = raw["paths"];
const components = raw["components"];
if (!isObject(paths) || !isObject(components) || !isObject(components["schemas"])) {
  fail("the spec has no paths or no components.schemas");
}

// Component `$id`s can be misread as base URIs during $ref resolution.
const unscrubbed = without(raw, (key) => key === "$id") as JsonObject;

/**
 * The spec with every description, summary or example that names the team behind the API (see
 * scripts/public-names.mjs) taken out, so the published types never carry one. A value that is
 * part of the API's shape (an enum, a const, a key) fails the build instead.
 */
function scrub(value: Json, pointer: string, dropped: string[]): Json {
  if (typeof value === "string") {
    if (leaks(value)) fail(`${pointer} is part of the API and names what it must not`);
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, index) => scrub(item, `${pointer}/${index}`, dropped));
  if (!isObject(value)) return value;
  const copy: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (leaks(key)) fail(`${pointer}/${key}: a key names what it must not`);
    if (PROSE.has(key) && JSON.stringify(item) !== undefined && leaks(JSON.stringify(item))) {
      dropped.push(`${pointer}/${key}`);
      continue;
    }
    copy[key] = PROSE.has(key) ? item : scrub(item, `${pointer}/${key}`, dropped);
  }
  return copy;
}
const dropped: string[] = [];
const spec = scrub(unscrubbed, "#", dropped) as JsonObject;
for (const pointer of dropped) {
  console.warn(`generate: dropped ${pointer}: it names what the published types must not`);
}

/** The value at `path` inside `value`, or undefined. */
function at(value: Json | undefined, ...path: string[]): Json | undefined {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function stringList(value: Json | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}

// Every error code, from the Error schema's enum: the API's own list.
const codeList = stringList(
  at(components, "schemas", "Error", "properties", "error", "properties", "code", "enum"),
);
if (!codeList || codeList.length === 0) {
  fail("components.schemas.Error has no error.code enum");
}
const codes = new Set(codeList);

/** The error codes one error response lists, from its schema (allOf: [Error, {code enum}]). */
function responseCodes(response: JsonObject): string[] {
  const schema = at(response, "content", "application/json", "schema");
  const parts = Array.isArray(at(schema, "allOf")) ? (at(schema, "allOf") as Json[]) : [schema];
  return parts.flatMap(
    (part) => stringList(at(part, "properties", "error", "properties", "code", "enum")) ?? [],
  );
}

const operations: Operation[] = [];
for (const [path, item] of Object.entries(paths)) {
  if (!isObject(item)) continue;
  for (const method of METHODS) {
    const operation = item[method];
    if (!isObject(operation)) continue;
    const id = operation["operationId"];
    if (typeof id !== "string") fail(`${method.toUpperCase()} ${path} has no operationId`);
    operations.push({ id, method: method.toUpperCase(), path });
    const responses = operation["responses"];
    if (!isObject(responses)) continue;
    for (const [status, response] of Object.entries(responses)) {
      if (Number(status) < 400 || !isObject(response)) continue;
      for (const code of responseCodes(response)) {
        if (!codes.has(code)) fail(`${id} ${status} lists ${code}, which the Error enum lacks`);
      }
    }
  }
}
if (operations.length === 0) fail("the spec has no operations");
const sortedOperations = operations.toSorted((a, b) => a.id.localeCompare(b.id));

// Webhook events: each type and the schema of its payload, from the spec's `webhooks` section.
const webhooks = raw["webhooks"];
if (!isObject(webhooks) || Object.keys(webhooks).length === 0) {
  fail("the spec has no webhooks section");
}
const events: { readonly type: string; readonly schema: string }[] = [];
for (const [type, item] of Object.entries(webhooks)) {
  const ref = at(item, "post", "requestBody", "content", "application/json", "schema", "$ref");
  const schema = typeof ref === "string" ? /^#\/components\/schemas\/(.+)$/.exec(ref)?.[1] : "";
  if (!schema || !isObject(components["schemas"][schema])) {
    fail(`webhook ${type} names no schema in components.schemas`);
  }
  const constant = at(components, "schemas", schema, "properties", "type", "const");
  if (constant !== type) fail(`webhook ${type}: ${schema}.type is not the const "${type}"`);
  events.push({ type, schema });
}
const sortedEvents = events.toSorted((a, b) => a.type.localeCompare(b.type));

const lock: Lock = {
  shape: shapeHash(spec),
  specVersion,
  operations: Object.fromEntries(
    sortedOperations.map((operation) => {
      const item = paths[operation.path] as JsonObject;
      return [operation.id, shapeHash(item[operation.method.toLowerCase()] as Json)];
    }),
  ),
  schemas: Object.fromEntries(
    Object.entries(components["schemas"] as JsonObject)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, schema]) => [name, shapeHash(schema)]),
  ),
};

const banner = `// Generated by tools/codegen/generate.ts from ${source.startsWith("http") ? source : "a local spec file"}.
// Do not edit: run \`pnpm generate\`.
`;

const ast = await openapiTS(spec as Parameters<typeof openapiTS>[0], {
  alphabetize: false,
  exportType: false,
});
mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "schema.ts"), `${banner}\n${astToString(ast)}`);
writeFileSync(
  resolve(OUT, "spec.ts"),
  `${banner}
/** info.version of the OpenAPI document this build was generated from. */
export const SPEC_VERSION: string = ${JSON.stringify(specVersion)};

/** SHA-256 of the OpenAPI document's shape. */
export const SPEC_SHA256: string = ${JSON.stringify(lock.shape)};

/** Error codes documented by the API (the Error schema's enum). */
export type ApiErrorCode =
${[...codes]
  .toSorted()
  .map((code) => `  | ${JSON.stringify(code)}`)
  .join("\n")};

/** Each webhook event type the API sends, and the schema of its payload. */
export interface WebhookEventSchemas {
${sortedEvents.map((event) => `  ${JSON.stringify(event.type)}: ${JSON.stringify(event.schema)};`).join("\n")}
}
`,
);
writeFileSync(
  resolve(OUT, "operations.ts"),
  `${banner}
/** Every operation in the spec. Tests only: the coverage test checks each has an SDK method. */
export const OPERATIONS: readonly { readonly id: string; readonly method: string; readonly path: string }[] = ${JSON.stringify(sortedOperations, null, 2)};

/** Every error code in the spec. Tests only. */
export const ERROR_CODES: readonly string[] = ${JSON.stringify([...codes].toSorted())};

/** Every webhook event type in the spec. Tests only. */
export const EVENT_TYPES: readonly string[] = ${JSON.stringify(sortedEvents.map((event) => event.type))};
`,
);

console.info(
  `generate: ${operations.length} operations, ${Object.keys(lock.schemas).length} schemas, ${codes.size} error codes, ${events.length} webhook events (spec ${specVersion}, shape ${lock.shape.slice(0, 12)})`,
);

let previous: Lock | undefined;
try {
  previous = JSON.parse(readFileSync(LOCK, "utf8")) as Lock;
} catch {
  previous = undefined;
}

function changes(before: Record<string, string>, after: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const name of Object.keys(after)) {
    if (!(name in before)) lines.push(`  + ${name}`);
    else if (before[name] !== after[name]) lines.push(`  ~ ${name}`);
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) lines.push(`  - ${name}`);
  }
  return lines;
}

if (accept) {
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  if (previous && previous.shape !== lock.shape) {
    console.info("spec:accept: the API changed:");
    const ops = changes(previous.operations, lock.operations);
    const schemas = changes(previous.schemas, lock.schemas);
    if (ops.length) console.info(`operations:\n${ops.join("\n")}`);
    if (schemas.length) console.info(`schemas:\n${schemas.join("\n")}`);
  } else {
    console.info(`spec:accept: ${previous ? "no shape change" : "lock written"}`);
  }
} else if (!previous) {
  const message = "openapi.lock.json is missing: run `pnpm spec:accept` and commit it.";
  if (check) fail(message);
  console.warn(`generate: ${message}`);
} else if (previous.shape !== lock.shape) {
  const message = `the API's shape changed since openapi.lock.json was accepted:\n${[
    ...changes(previous.operations, lock.operations).map((line) => `operation ${line.trim()}`),
    ...changes(previous.schemas, lock.schemas).map((line) => `schema ${line.trim()}`),
  ].join("\n")}\nRun \`pnpm spec:accept\`, review the change and commit the lock.`;
  if (check) fail(message);
  console.warn(`generate: ${message}`);
}
