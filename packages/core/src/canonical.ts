/**
 * Canonical JSON + hashing (Vol 02 §11, normative).
 *
 * JCS-style canonicalization: UTF-8, object keys sorted lexicographically, no
 * insignificant whitespace. Arrays are serialized in the order given — callers
 * are responsible for the documented sort order *before* hashing (Vol 01 §2.6).
 * The hash is the lowercase-hex SHA-256 of the canonical bytes.
 *
 * `node:crypto` is a pure, deterministic computation (not network/fs), so it is
 * permitted in `core`. The banned-API list (Vol 01 §2.6) covers `Date.now`,
 * `Math.random`, and `randomUUID` — not `createHash`.
 */
import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [k: string]: JsonValue };

/**
 * Produce the canonical JSON string of a value.
 *
 * Rejects values that have no deterministic JSON encoding (`undefined`,
 * functions, symbols, `bigint`, `NaN`, `±Infinity`) instead of silently
 * dropping or coercing them — non-determinism must fail loudly.
 */
export function canonicalize(value: JsonValue): string {
  return serialize(value);
}

function serialize(value: JsonValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalize: non-finite number ${String(value)}`);
      }
      // JSON.stringify emits the shortest round-tripping decimal for finite numbers.
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(serialize).join(",")}]`;
      }
      const obj = value as { readonly [k: string]: JsonValue };
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = obj[k];
        if (v === undefined) continue; // absent optional — never encode `undefined`
        parts.push(`${JSON.stringify(k)}:${serialize(v)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(`canonicalize: unsupported value type ${typeof value}`);
  }
}

/** Lowercase-hex SHA-256 over the canonical bytes of `value`. */
export function canonicalHash(value: JsonValue): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/**
 * Hash an object with the given top-level keys omitted (Vol 02 §11.3): the
 * `*_hash` field itself plus any timestamp fields (`taken_at`, …) so the hash
 * is stable regardless of when the artifact was produced.
 */
export function hashWithout(
  value: { readonly [k: string]: JsonValue },
  omitKeys: readonly string[],
): string {
  const omit = new Set(omitKeys);
  const filtered: { [k: string]: JsonValue } = {};
  for (const k of Object.keys(value)) {
    if (omit.has(k)) continue;
    const v = value[k];
    if (v === undefined) continue;
    filtered[k] = v;
  }
  return canonicalHash(filtered);
}
