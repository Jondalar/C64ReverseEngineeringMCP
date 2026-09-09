// Spec 833 D5(b) — walking a tool's input schema for path parameters, at ANY depth.
//
// The path-portability gate used to look only at a tool's TOP-LEVEL parameter
// names. `sandbox_6502_run` takes its paths NESTED — `loads[].prg_path`,
// `loads[].raw_path` — so the tool read as taking no path at all, and the rule
// that no default tool may be cwd-coupled never got a chance to fire on it. A
// rule that only sees the top level is a rule with a hole in it; this is the
// walk that closes it.
//
// Input is a ZodRawShape — the plain `{ name: ZodType }` object handed to
// `server.tool(name, description, shape, handler)` — not a ZodObject. Output is
// a list of dotted parameter paths, with `[]` marking an array hop, e.g.
// `loads[].prg_path`.

// Names that mean "a place on a filesystem". Deliberately conservative: it
// matches a whole segment (`path`, `dir`, `file`) or one of the `_path` /
// `_dir` / `_file` suffixes the surface actually uses, so `pathMode`-style
// substrings and `profile` do not get swept in.
// Spec 834 — `output` and `out` are here because `runtime_trace_start` is a
// SIXTEENTH instance of the defect this walk exists to find, and the walk could
// not see it: its path parameter is called `output`, which matched nothing. A
// name list is only as good as the names people chose, so a parameter that IS a
// path under another word is exactly the case worth adding when it turns up.
const PATH_NAME = /^(.*_)?(path|paths|dir|dirs|directory|file|files|filename|output|out|outfile|source|src|dest|destination)$/i;

export function isPathParamName(name) {
  return PATH_NAME.test(name);
}

// Unwrap the wrappers that carry an inner type: optional / nullable / default /
// effects (.refine/.transform) / branded / readonly / lazy / pipeline.
function unwrap(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return node;
  const def = node._def;
  if (!def) return node;
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodBranded":
    case "ZodReadonly":
      return unwrap(def.innerType, depth + 1);
    case "ZodEffects":
      return unwrap(def.schema, depth + 1);
    case "ZodLazy":
      try { return unwrap(def.getter(), depth + 1); } catch { return node; }
    case "ZodPipeline":
      return unwrap(def.out ?? def.in, depth + 1);
    default:
      return node;
  }
}

function shapeOf(node) {
  const def = node?._def;
  if (!def) return undefined;
  if (def.typeName === "ZodObject") {
    return typeof def.shape === "function" ? def.shape() : def.shape;
  }
  return undefined;
}

// Every parameter path in `shape`, at any depth. `arrays` marks an array hop
// with `[]` so a caller can tell `loads[].prg_path` from `loads.prg_path`.
export function walkSchemaParams(shape, prefix = "", depth = 0) {
  const out = [];
  if (!shape || typeof shape !== "object" || depth > 8) return out;
  for (const [name, raw] of Object.entries(shape)) {
    const node = unwrap(raw);
    const def = node?._def;
    const here = prefix ? `${prefix}.${name}` : name;
    out.push({ path: here, name, typeName: def?.typeName ?? "unknown", nested: depth > 0 });

    if (def?.typeName === "ZodArray") {
      const item = unwrap(def.type);
      const itemShape = shapeOf(item);
      if (itemShape) out.push(...walkSchemaParams(itemShape, `${here}[]`, depth + 1));
      continue;
    }
    if (def?.typeName === "ZodUnion" || def?.typeName === "ZodDiscriminatedUnion") {
      const options = def.options instanceof Map ? [...def.options.values()] : (def.options ?? []);
      for (const opt of options) {
        const optShape = shapeOf(unwrap(opt));
        if (optShape) out.push(...walkSchemaParams(optShape, here, depth + 1));
      }
      continue;
    }
    const objShape = shapeOf(node);
    if (objShape) out.push(...walkSchemaParams(objShape, here, depth + 1));
  }
  return out;
}

// The path-shaped parameters of one tool's schema, nested ones included.
export function pathParamsOf(shape) {
  return walkSchemaParams(shape).filter((p) => isPathParamName(p.name));
}

// True when a tool's paths are reachable ONLY through a nested parameter — the
// exact blind spot a top-level-only gate has.
export function hasOnlyNestedPathParams(shape) {
  const found = pathParamsOf(shape);
  return found.length > 0 && found.every((p) => p.nested);
}
