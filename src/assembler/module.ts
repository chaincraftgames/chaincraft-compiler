// ---------------------------------------------------------------------------
// Phase 4 — assembleModule: top-level compiler entry point
//
// Pipeline:
//   1. assembleConfig        → GameConfig (immutable)
//   2. assembleEffectDefs    → effectDefs from named effects
//   3. assembleActions       → ActionDef map + inline action effects → effectDefs
//   4. assembleFlow          → FlowNode tree + inline hook effects → effectDefs
//   5. buildExecutorRegistry → EffectRegistration map from effectDefs kinds
//   6. applyMechanics        → mechanic passes extend effectDefs + effects
//   7. linkAndValidate       → error on unresolved refs
//   8. seal                  → CompiledGameModule
// ---------------------------------------------------------------------------

import type { ModularGameSpec } from '@chaincraft/gamedef';
import type { CompiledGameModule, EffectRegistration, ActionDef, FlowNode } from '@chaincraft/runtime';
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
} from '@chaincraft/runtime';
import { assembleConfig } from './config.js';
import { assembleEffectDefs } from './effects.js';
import { assembleActions } from './actions.js';
import { assembleFlow } from './flow.js';
import { applyMechanics } from './mechanics.js';
import { assembleSession } from './session.js';
import type { GameConfig } from './types.js';

// ---------------------------------------------------------------------------
// Built-in executor registry (keyed by effect kind string)
// ---------------------------------------------------------------------------

const BUILT_IN_EXECUTORS: Record<string, EffectRegistration> = {
  'shuffle':    { kind: 'effect-executor', execute: executeShuffle },
  'move':       { kind: 'effect-executor', execute: executeMove },
  'distribute': { kind: 'effect-executor', execute: executeDistribute },
  'message':    { kind: 'effect-executor', execute: executeMessage },
  'set-state':  { kind: 'effect-executor', execute: executeSetState },
  'update':     { kind: 'effect-executor', execute: executeUpdate },
  'flip':       { kind: 'effect-executor', execute: executeFlip },
  'roll':       { kind: 'effect-executor', execute: executeRoll },
  'set-random': { kind: 'effect-executor', execute: executeSetRandom },
  'orient':     { kind: 'effect-executor', execute: executeOrient },
  'reveal':     { kind: 'effect-executor', execute: executeReveal },
  'hide':       { kind: 'effect-executor', execute: executeHide },
  'custom':     createCustomExecutor({}),
};

/**
 * Build the executor registry from the kinds actually used in effectDefs.
 * Mechanic-provided kinds (chaincraft:*) are skipped here; mechanic passes
 * register their own executors.
 */
function buildExecutorRegistry(
  effectDefs: Record<string, Record<string, unknown>>,
): Record<string, EffectRegistration> {
  const registry: Record<string, EffectRegistration> = {};
  for (const def of Object.values(effectDefs)) {
    const kind = def.kind as string | undefined;
    if (!kind) continue;
    if (kind.startsWith('chaincraft:')) continue; // handled by mechanic passes
    if (!registry[kind] && BUILT_IN_EXECUTORS[kind]) {
      registry[kind] = BUILT_IN_EXECUTORS[kind];
    }
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Link / validate
// ---------------------------------------------------------------------------

/**
 * Collect all { ref } strings from a FlowNode tree's hooks.
 */
function collectFlowRefs(node: FlowNode, out: Set<string>): void {
  const hooks = (node as { hooks?: { onEnter?: Array<{ ref?: string }>; onComplete?: Array<{ ref?: string }> } }).hooks;
  for (const refs of [hooks?.onEnter, hooks?.onComplete]) {
    for (const r of refs ?? []) {
      if (r.ref) out.add(r.ref);
    }
  }
  const children = (node as { children?: FlowNode[] }).children;
  if (children) {
    for (const child of children) collectFlowRefs(child, out);
  }
}

/**
 * Verify all refs resolve to effectDefs and all effectDef kinds have executors.
 * Throws a single aggregated error listing all problems.
 */
function linkAndValidate(
  flow: FlowNode,
  actions: Record<string, ActionDef>,
  effectDefs: Record<string, Record<string, unknown>>,
  effects: Record<string, EffectRegistration>,
): void {
  const errors: string[] = [];

  // All effect def kinds must have an executor
  for (const [id, def] of Object.entries(effectDefs)) {
    const kind = def.kind as string | undefined;
    if (kind && !effects[kind]) {
      errors.push(`Effect def "${id}" uses kind "${kind}" — no executor registered`);
    }
  }

  // All flow hook refs must resolve
  const flowRefs = new Set<string>();
  collectFlowRefs(flow, flowRefs);
  for (const ref of flowRefs) {
    if (!effectDefs[ref]) {
      errors.push(`Flow hook ref "${ref}" has no effectDef`);
    }
  }

  // All action effect refs must resolve
  for (const [actionId, action] of Object.entries(actions)) {
    for (const eff of action.effects) {
      if ('ref' in eff && typeof eff.ref === 'string' && !effectDefs[eff.ref]) {
        errors.push(`Action "${actionId}" effect ref "${eff.ref}" has no effectDef`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Module link/validate failed:\n  ${errors.join('\n  ')}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble a complete CompiledGameModule from a parsed ModularGameSpec.
 *
 * This is the top-level Phase 4 entry point. All spec modules are compiled,
 * mechanic passes run, refs are validated, and the final module is sealed.
 */
export function assembleModule(spec: ModularGameSpec, specId: string): CompiledGameModule {
  // 1. Config (immutable, no side-effects)
  const config: GameConfig = assembleConfig(spec);

  // 2. Named effect defs
  const effectDefs: Record<string, Record<string, unknown>> = assembleEffectDefs(spec);

  // 3. Actions (inline action effects → effectDefs)
  const actions = assembleActions(spec, effectDefs);

  // 4. Flow tree (inline hook effects → effectDefs)
  const flow = assembleFlow(spec, specId, effectDefs);

  // 5. Built-in executor registry (from effectDef kinds)
  const effects = buildExecutorRegistry(effectDefs);

  // 6. Mechanic passes (extend effectDefs + effects)
  applyMechanics(spec.mechanics, { specId, config, effectDefs, effects, actions });

  // 7. Link/validate
  linkAndValidate(flow, actions, effectDefs, effects);

  // 8. Seal
  const { createSession } = assembleSession(spec, specId);

  return {
    specId,
    metadata: {
      name: spec.metadata?.name ?? specId,
      playerCount: config.playerCount,
    },
    createSession,
    flow,
    effects,
    effectDefs,
    actions,
  };
}
