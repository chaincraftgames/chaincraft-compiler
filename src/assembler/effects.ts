// ---------------------------------------------------------------------------
// Effects assembler
//
// Produces:
//   1. effectExecutors: Record<string, EffectRegistration> — one entry per
//      distinct effect kind used in the spec, mapped to the runtime executor.
//   2. effectDefs: Record<string, Record<string, unknown>> — every named
//      effect compiled and stored by ID.
//   3. walkEffectBody: shared walker that compiles a single effect body
//      (walks value fields, handles { expr } compilation in the future).
//
// Design: inline effects are NOT passed through as opaque JSON. Every effect
// body is walked via walkEffectBody so the expression-compilation hook
// has a single integration point.
// ---------------------------------------------------------------------------

import type {
  ModularGameSpec,
  NamedEffect,
  Effect,
  EffectCall,
} from "@chaincraft/gamedef";
import type { EffectRegistration, EffectRef } from "@chaincraft/runtime";
import {
  executeDistribute,
  executeFlip,
  executeHide,
  executeMessage,
  executeMove,
  executeOrient,
  executeReveal,
  executeRoll,
  executeSetRandom,
  executeSetState,
  executeShuffle,
  executeUpdate,
  createCustomExecutor,
} from "@chaincraft/runtime";

/**
 * Map of effect kind to executor factory function.
 */
const EXECUTOR_MAP: Record<string, (() => EffectRegistration) | undefined> = {
  shuffle: () => ({ kind: "effect-executor", execute: executeShuffle }),
  move: () => ({ kind: "effect-executor", execute: executeMove }),
  distribute: () => ({ kind: "effect-executor", execute: executeDistribute }),
  message: () => ({ kind: "effect-executor", execute: executeMessage }),
  "set-state": () => ({ kind: "effect-executor", execute: executeSetState }),
  update: () => ({ kind: "effect-executor", execute: executeUpdate }),
  flip: () => ({ kind: "effect-executor", execute: executeFlip }),
  roll: () => ({ kind: "effect-executor", execute: executeRoll }),
  "set-random": () => ({ kind: "effect-executor", execute: executeSetRandom }),
  orient: () => ({ kind: "effect-executor", execute: executeOrient }),
  reveal: () => ({ kind: "effect-executor", execute: executeReveal }),
  hide: () => ({ kind: "effect-executor", execute: executeHide }),
  custom: () => createCustomExecutor({}),
};

/**
 * Walk a single effect body, compiling value expressions where needed.
 * Returns a new object suitable for storage in effectDefs.
 *
 * Today this is largely structural passthrough — the { expr } compilation
 * hook will add compileExpression() calls here. The walk
 * ensures we never store raw unparsed YAML; every field is explicitly
 * handled or passed through as a known shape.
 */
export function walkEffectBody(
  effect: NamedEffect | Effect,
): Record<string, unknown> {
  const raw = effect as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (key === "id") continue; // strip the name — stored as the effectDefs key
    result[key] = walkValue(value);
  }

  return result;
}

/**
 * Normalize an EffectCall[] into EffectRef[], accumulating inline effects into
 * effectDefs with synthetic IDs derived from the given prefix.
 *
 * Named refs (`{ ref }`) pass through unchanged. Inline effects are walked via
 * walkEffectBody and stored under `${prefix}_${index}`.
 *
 * This is the single shared implementation used by both the actions assembler
 * (prefix = `${actionId}._effect`) and the flow assembler (prefix = `${nodeId}.${hookName}`).
 */
export function normalizeEffectList(
  calls: EffectCall[],
  prefix: string,
  effectDefs: Record<string, Record<string, unknown>>,
): EffectRef[] {
  return calls.map((call, i): EffectRef => {
    if ("ref" in call) return { ref: call.ref };
    const syntheticId = `${prefix}_${i}`;
    effectDefs[syntheticId] = walkEffectBody(call);
    return { ref: syntheticId };
  });
}

/**
 * Recursively walk a value, compiling { expr } nodes when encountered.
 * For now, { expr } is passed through unchanged.
 */
function walkValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(walkValue);

  const obj = value as Record<string, unknown>;

  // Future hook: compile expr strings to closures
  // if ('expr' in obj && typeof obj.expr === 'string') {
  //   return { expr: compileExpression(obj.expr) };
  // }

  // Recurse into nested objects (from/to/target/value/etc.)
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = walkValue(v);
  }
  return result;
}

/**
 * Scan all effect kinds used in the spec and build the executor registry.
 * Scans both the effects module and action inline effects.
 */
export function assembleEffectExecutors(
  spec: ModularGameSpec,
): Record<string, EffectRegistration> {
  const kinds = new Set<string>();

  // Scan named effects
  if (spec.effects?.effects) {
    for (const effect of spec.effects.effects) {
      kinds.add(effect.kind);
    }
  }

  // Scan action inline effects
  if (spec.actions?.actions) {
    for (const action of spec.actions.actions) {
      for (const call of action.effects) {
        if ("kind" in call) {
          kinds.add(call.kind as string);
        }
      }
    }
  }

  // Build registry
  const registry: Record<string, EffectRegistration> = {};
  for (const kind of kinds) {
    const factory = EXECUTOR_MAP[kind];
    if (factory) {
      registry[kind] = factory();
    }
    // Unknown kinds are silently skipped — the validator (Phase 7) will
    // catch references to unsupported kinds before we get here.
  }

  return registry;
}

// ---------------------------------------------------------------------------
// assembleEffectDefs
// ---------------------------------------------------------------------------

/**
 * Compile all named effects from the effects module into effectDefs.
 * Each entry is keyed by the effect's `id` and contains the walked body.
 */
export function assembleEffectDefs(
  spec: ModularGameSpec,
): Record<string, Record<string, unknown>> {
  const defs: Record<string, Record<string, unknown>> = {};

  if (spec.effects?.effects) {
    for (const effect of spec.effects.effects) {
      defs[effect.id] = walkEffectBody(effect);
    }
  }

  return defs;
}
