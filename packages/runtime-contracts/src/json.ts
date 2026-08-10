/**
 * The Runtime boundary persists and transports only JSON values.  Keeping this
 * definition here prevents a provider SDK object, Date, Error, or function
 * from leaking into a durable command or fact.
 */
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];

export class JsonValueError extends Error {
  readonly code = "json_value_invalid";

  constructor(message: string) {
    super(message);
    this.name = "JsonValueError";
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

export function assertJsonValue(value: unknown, path = "value"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new JsonValueError(`${path} must be a finite JSON number`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    Object.entries(value).forEach(([key, entry]) => assertJsonValue(entry, `${path}.${key}`));
    return;
  }
  throw new JsonValueError(`${path} is not JSON-serializable`);
}

/** A deep JSON clone is deliberate: callers cannot retain a mutable command payload. */
export function cloneJson<T extends JsonValue>(value: T): T {
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Stable key ordering makes hashes and idempotency evidence reproducible. */
export function canonicalJson(value: JsonValue): string {
  assertJsonValue(value);
  return canonicalize(value);
}

/**
 * A portable content fingerprint, not a cryptographic signature.  The Store
 * may additionally calculate SHA-256 for archive/checksum purposes.
 */
export function hashDefinition(value: JsonValue): string {
  const source = canonicalJson(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as JsonObject;
  const fields = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`);
  return `{${fields.join(",")}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
