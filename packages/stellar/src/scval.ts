/**
 * ScVal bridge (Vol 03 §6, FN-ST.14 / FN-ST.22).
 *
 * The ONLY module permitted the unsound-looking narrowing of `xdr.ScVal`
 * (Vol 01 §2.2); held to 100% branch coverage. Conversion is:
 *
 *  - `toScValJson`  — total over ALL ScVal variants. Known variants get a typed
 *    JSON `value`; unknown/future variants fall to `{type:"opaque", value:null}`
 *    via the `default` arm and NEVER throw (EC-X02). Every leaf keeps `xdr_b64`
 *    so the exact bytes survive a round-trip (INV-Trace-1).
 *  - `fromScValJson` — lossless: reconstructs by decoding the preserved
 *    `xdr_b64`. Because every `ScValJson` in the system is produced by decoding
 *    real chain XDR (or by the SDK when building install params), the byte-exact
 *    path is both correct and total.
 *
 * `resolvePath` (FN-ST.22) walks the JSON tree for `$.requests[*].amount`-style
 * paths, mirroring the on-chain path logic the pb policies implement (Vol 07)
 * so TS pre-validation and Rust enforcement agree.
 */
import { scValToBigInt, xdr, Address, nativeToScVal, StrKey } from "@stellar/stellar-sdk";
import { toXdrBase64, type ScValJson, type XdrBase64 } from "@ozpb/core";

const SCV = xdr.ScValType;

/** Lossless, total `xdr.ScVal` → `ScValJson`. Never throws. */
export function toScValJson(scv: xdr.ScVal): ScValJson {
  const xdr_b64 = toXdrBase64(scv.toXDR("base64"));
  const value = decodeValue(scv);
  return { type: scv.switch().name, value, xdr_b64 };
}

function decodeValue(scv: xdr.ScVal): unknown {
  switch (scv.switch()) {
    case SCV.scvBool():
      return scv.b();
    case SCV.scvVoid():
      return null;
    case SCV.scvU32():
      return scv.u32();
    case SCV.scvI32():
      return scv.i32();
    case SCV.scvTimepoint():
      // Uint64 wrappers that scValToBigInt does not accept — decode directly.
      return scv.timepoint().toString();
    case SCV.scvDuration():
      return scv.duration().toString();
    case SCV.scvU64():
    case SCV.scvI64():
    case SCV.scvU128():
    case SCV.scvI128():
    case SCV.scvU256():
    case SCV.scvI256():
      // All large-integer shapes render as a decimal string (EC-X07).
      return scValToBigInt(scv).toString();
    case SCV.scvBytes():
      return Buffer.from(scv.bytes()).toString("hex");
    case SCV.scvString(): {
      const s = scv.str();
      return Buffer.from(s as unknown as Uint8Array).toString("utf8");
    }
    case SCV.scvSymbol():
      return Buffer.from(scv.sym() as unknown as Uint8Array).toString("utf8");
    case SCV.scvAddress():
      // Preserves strkey kind (C/G/M) — EC-X05.
      return Address.fromScVal(scv).toString();
    case SCV.scvVec(): {
      const v = scv.vec();
      return (v ?? []).map(toScValJson);
    }
    case SCV.scvMap(): {
      const m = scv.map();
      return (m ?? []).map((entry) => ({
        key: toScValJson(entry.key()),
        val: toScValJson(entry.val()),
      }));
    }
    default:
      // scvError, scvContractInstance, scvLedgerKeyContractInstance,
      // scvLedgerKeyNonce, and any future variant — opaque, bytes preserved.
      return null;
  }
}

/** Lossless `ScValJson` → `xdr.ScVal` via the preserved XDR bytes. */
export function fromScValJson(json: ScValJson): xdr.ScVal {
  return xdr.ScVal.fromXDR(json.xdr_b64, "base64");
}

export function encodeI128ScValB64(value: string): XdrBase64 {
  return toXdrBase64(nativeToScVal(BigInt(value), { type: "i128" }).toXDR("base64"));
}

export function encodeAddressScValB64(value: string): XdrBase64 {
  return toXdrBase64(Address.fromString(value).toScVal().toXDR("base64"));
}

export function encodeU32ScValB64(value: number): XdrBase64 {
  return toXdrBase64(xdr.ScVal.scvU32(value).toXDR("base64"));
}

export function encodeBlendSupplyCollateralSubmitArgsB64(input: {
  account: string;
  reserve: string;
  amount: string;
}): XdrBase64[] {
  const request = xdr.ScVal.scvMap(sortScMapEntries([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("address"), val: Address.fromString(input.reserve).toScVal() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(BigInt(input.amount), { type: "i128" }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("request_type"), val: xdr.ScVal.scvU32(2) }),
  ]));
  return [
    Address.fromString(input.account).toScVal(),
    Address.fromString(input.account).toScVal(),
    Address.fromString(input.account).toScVal(),
    xdr.ScVal.scvVec([request]),
  ].map((arg) => toXdrBase64(arg.toXDR("base64")));
}

export function mutateScValB64(value: XdrBase64, hint = "mutation"): XdrBase64 {
  const decoded = xdr.ScVal.fromXDR(value, "base64");
  return toXdrBase64(mutateScVal(decoded, hint).toXDR("base64"));
}

function mutateScVal(scv: xdr.ScVal, hint: string): xdr.ScVal {
  switch (scv.switch()) {
    case SCV.scvBool():
      return xdr.ScVal.scvBool(!scv.b());
    case SCV.scvU32():
      return xdr.ScVal.scvU32((scv.u32() + 1) >>> 0);
    case SCV.scvI32():
      return xdr.ScVal.scvI32(scv.i32() + 1);
    case SCV.scvU64():
      return nativeToScVal(scValToBigInt(scv) + 1n, { type: "u64" });
    case SCV.scvI64():
      return nativeToScVal(scValToBigInt(scv) + 1n, { type: "i64" });
    case SCV.scvU128():
      return nativeToScVal(scValToBigInt(scv) + 1n, { type: "u128" });
    case SCV.scvI128():
      return nativeToScVal(scValToBigInt(scv) + 1n, { type: "i128" });
    case SCV.scvU256():
      return nativeToScVal(scValToBigInt(scv) + 1n, { type: "u256" });
    case SCV.scvI256():
      return nativeToScVal(scValToBigInt(scv) + 1n, { type: "i256" });
    case SCV.scvBytes(): {
      const bytes = Buffer.from(scv.bytes());
      const next = bytes.length === 0 ? Buffer.from([1]) : Buffer.from(bytes);
      next[0] = (next[0]! ^ 0x01) & 0xff;
      return xdr.ScVal.scvBytes(next);
    }
    case SCV.scvString():
      return xdr.ScVal.scvString(`${Buffer.from(scv.str() as unknown as Uint8Array).toString("utf8")}_mutated`);
    case SCV.scvSymbol():
      return xdr.ScVal.scvSymbol(`${Buffer.from(scv.sym() as unknown as Uint8Array).toString("utf8")}_mutated`);
    case SCV.scvAddress():
      return mutateAddressScVal(scv);
    case SCV.scvVec(): {
      const values = [...(scv.vec() ?? [])];
      if (values.length === 0) return xdr.ScVal.scvVec([xdr.ScVal.scvBool(true)]);
      values[0] = mutateScVal(values[0]!, `${hint}[0]`);
      return xdr.ScVal.scvVec(values);
    }
    case SCV.scvMap(): {
      const entries = [...(scv.map() ?? [])];
      if (entries.length === 0) {
        return xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("mutated"), val: xdr.ScVal.scvBool(true) }),
        ]);
      }
      const first = entries[0]!;
      entries[0] = new xdr.ScMapEntry({ key: first.key(), val: mutateScVal(first.val(), `${hint}.value`) });
      return xdr.ScVal.scvMap(entries);
    }
    default:
      return xdr.ScVal.scvBytes(Buffer.from(`mutated:${hint}`, "utf8"));
  }
}

function mutateAddressScVal(scv: xdr.ScVal): xdr.ScVal {
  const address = Address.fromScVal(scv).toString();
  if (address.startsWith("G")) {
    return Address.fromString(StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7))).toScVal();
  }
  return Address.fromString(StrKey.encodeContract(Buffer.alloc(32, 9))).toScVal();
}

function sortScMapEntries(entries: xdr.ScMapEntry[]): xdr.ScMapEntry[] {
  return entries.sort((a, b) => compareScSymbol(a.key(), b.key()));
}

function compareScSymbol(a: xdr.ScVal, b: xdr.ScVal): number {
  const left = Buffer.from(a.sym() as unknown as Uint8Array).toString("utf8");
  const right = Buffer.from(b.sym() as unknown as Uint8Array).toString("utf8");
  return left < right ? -1 : left > right ? 1 : 0;
}

// --- Path resolution (FN-ST.22) ------------------------------------------

type PathSegment = { kind: "key"; name: string } | { kind: "index"; index: number } | { kind: "wild" };

const SEGMENT_RE = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]|\[\*\]/g;

/**
 * Parse a JSONPath-lite string (`$`, `.name`, `[idx]`, `[*]`) into segments.
 * The grammar matches SCH-PolicyIntent's `path` regex; anything else throws
 * (caller pre-validates, so a bad path here is a programming error).
 */
export function parsePath(path: string): PathSegment[] {
  if (!path.startsWith("$")) throw new Error(`path must start with $: ${path}`);
  const rest = path.slice(1);
  const segments: PathSegment[] = [];
  let consumed = 0;
  SEGMENT_RE.lastIndex = 0;
  for (let m = SEGMENT_RE.exec(rest); m !== null; m = SEGMENT_RE.exec(rest)) {
    if (m.index !== consumed) throw new Error(`unparseable path segment near ${path}`);
    consumed = m.index + m[0].length;
    if (m[1] !== undefined) segments.push({ kind: "key", name: m[1] });
    else if (m[2] !== undefined) segments.push({ kind: "index", index: Number(m[2]) });
    else segments.push({ kind: "wild" });
  }
  if (consumed !== rest.length) throw new Error(`trailing characters in path: ${path}`);
  return segments;
}

/**
 * Resolve a path into the matching ScVal leaves (∀ semantics for `[*]`).
 * Missing key/index yields no result — the caller decides whether that is a
 * pre-validation failure or a deny (EC-P08).
 */
export function resolvePath(root: ScValJson, path: string): ScValJson[] {
  return walk([root], parsePath(path));
}

function walk(nodes: ScValJson[], segments: PathSegment[]): ScValJson[] {
  let current = nodes;
  for (const seg of segments) {
    const next: ScValJson[] = [];
    for (const node of current) {
      switch (seg.kind) {
        case "key": {
          // Struct = map with symbol keys; `.name` selects the matching entry.
          if (Array.isArray(node.value)) {
            for (const entry of node.value as unknown[]) {
              // Struct keys are ScVal symbols; the ScValJson `type` is the raw
              // SDK variant name (`scvSymbol`), not a normalized alias.
              if (isMapEntry(entry) && entry.key.type === "scvSymbol" && entry.key.value === seg.name) {
                next.push(entry.val);
              }
            }
          }
          break;
        }
        case "index": {
          if (Array.isArray(node.value)) {
            const el = (node.value as ScValJson[])[seg.index];
            if (el !== undefined && isScValJson(el)) next.push(el);
          }
          break;
        }
        case "wild": {
          if (Array.isArray(node.value)) {
            for (const el of node.value as unknown[]) {
              if (isScValJson(el)) next.push(el);
            }
          }
          break;
        }
      }
    }
    current = next;
  }
  return current;
}

interface MapEntry {
  key: ScValJson;
  val: ScValJson;
}

function isScValJson(x: unknown): x is ScValJson {
  return typeof x === "object" && x !== null && "type" in x && "xdr_b64" in x;
}

function isMapEntry(x: unknown): x is MapEntry {
  return (
    typeof x === "object" &&
    x !== null &&
    "key" in x &&
    "val" in x &&
    isScValJson((x as MapEntry).key) &&
    isScValJson((x as MapEntry).val)
  );
}
