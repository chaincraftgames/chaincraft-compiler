// ---------------------------------------------------------------------------
// Phase 4 — Flow assembler
//
// Converts a gamedef FlowModule (YAML-parsed) into the runtime FlowNode tree.
// Inline effects in hooks are normalized to { ref } entries and added to the
// effectDefs accumulator (same pattern as Phase 3 actions assembler).
//
// Vocabulary translation:
//   gamedef TurnOrder.kind  →  runtime TurnOrdering.kind
//   'seat'  + actor:'all-players'  → 'round-robin'
//   'ranked'                       → 'round-robin' with sort
//   'explicit'                     → not yet supported (Phase 6)
//
//   gamedef TurnGrammarNode.kind   →  runtime Grammar.kind
//   'action'   → ActionGrammar   (passthrough)
//   'choice'   → ChoiceGrammar   (extracts action refs from options)
//   'sequence' → SequenceGrammar (extracts action refs from steps)
//   'repeat'   → RepeatGrammar   (body recursed)
//   'slot'     → not yet supported
// ---------------------------------------------------------------------------

import type {
  ModularGameSpec,
  EffectCall,
  WinCondition,
} from "@chaincraft/gamedef";
import type {
  FlowNode,
  GameFlowNode,
  LoopFlowNode,
  TurnFlowNode,
  TurnOrdering,
  Grammar,
  FlowHooks,
  EffectRef,
  WinConditionDef,
  GameSession,
} from "@chaincraft/runtime";
import { normalizeEffectList } from "./effects.js";
import { sessionToEvalContext } from "../expressions/eval-bridge.js";
import { compileExpression, compilePredicate } from "../expressions/index.js";
import type {
  ActorSpec,
  TurnOrder,
  TurnGrammarNode,
  FlowNode as GamedefFlowNode,
} from "@chaincraft/gamedef";

// ---------------------------------------------------------------------------
// Hook conversion
// ---------------------------------------------------------------------------

/**
 * Convert a gamedef EffectCall array into runtime EffectRef[] + populate effectDefs.
 * This function will convert inline effects into synthetic IDs and add them to the
 * effectDefs accumulator.
 */
function assembleHooks(
  calls: EffectCall[] | undefined,
  nodeId: string,
  hookName: "onEnter" | "onComplete",
  effectDefs: Record<string, Record<string, unknown>>,
): EffectRef[] | undefined {
  if (!calls?.length) return undefined;

  return normalizeEffectList(calls, `${nodeId}.${hookName}`, effectDefs);
}

/**
 * Convert a gamedef FlowNode hooks object into runtime FlowHooks + populate effectDefs.
 */
function assembleFlowHooks(
  // node.hooks is typed as _FlowHooks (unknown arrays) in the gamedef FlowNode
  // type alias — a workaround for a Zod circular-type constraint. The runtime
  // values are always EffectCall[], so the cast here is safe.
  hooks: { onEnter?: unknown; onComplete?: unknown } | undefined,
  nodeId: string,
  effectDefs: Record<string, Record<string, unknown>>,
): FlowHooks | undefined {
  if (!hooks) return undefined;
  const onEnter = assembleHooks(
    hooks.onEnter as EffectCall[] | undefined,
    nodeId,
    "onEnter",
    effectDefs,
  );
  const onComplete = assembleHooks(
    hooks.onComplete as EffectCall[] | undefined,
    nodeId,
    "onComplete",
    effectDefs,
  );
  if (!onEnter && !onComplete) return undefined;
  return {
    ...(onEnter && { onEnter }),
    ...(onComplete && { onComplete }),
  };
}

// ---------------------------------------------------------------------------
// TurnOrdering mapping
// ---------------------------------------------------------------------------

function assembleTurnOrdering(
  actor: ActorSpec,
  turnOrder: TurnOrder | undefined,
): TurnOrdering {
  const roleIds =
    typeof actor === "object" && "roles" in actor ? actor.roles : undefined;

  if (!turnOrder || turnOrder.kind === "seat") {
    return {
      kind: "round-robin",
      ...(roleIds && { roleIds }),
    };
  }

  if (turnOrder.kind === "ranked") {
    const by = turnOrder.by as {
      playerProperty?: string;
      playerInventory?: string;
    };
    const sortBy: { playerProperty: string } | { playerInventory: string } =
      by.playerProperty
        ? { playerProperty: by.playerProperty }
        : {
            playerInventory: (by as { playerInventory: string })
              .playerInventory,
          };
    return {
      kind: "round-robin",
      sort: { by: sortBy, order: turnOrder.order },
      ...(roleIds && { roleIds }),
    };
  }

  throw new Error(
    `flow assembler: TurnOrder kind 'explicit' is not yet supported. Use 'seat' or 'ranked'.`,
  );
}

// ---------------------------------------------------------------------------
// Grammar mapping
// ---------------------------------------------------------------------------

function assembleGrammar(node: TurnGrammarNode): Grammar {
  if (node.kind === "action") {
    return { kind: "action", ref: node.ref };
  }

  if (node.kind === "slot") {
    throw new Error(
      `flow assembler: grammar kind 'slot' is not yet supported.`,
    );
  }

  if (node.kind === "sequence") {
    const actions = node.steps.map((step) => {
      if (step.kind !== "action") {
        throw new Error(
          `flow assembler: sequence steps must all be 'action' nodes (got '${step.kind}').`,
        );
      }
      return step.ref;
    });
    return { kind: "sequence", actions };
  }

  if (node.kind === "choice") {
    const actions = node.options.map((opt) => {
      if (opt.kind !== "action") {
        throw new Error(
          `flow assembler: choice options must all be 'action' nodes (got '${opt.kind}').`,
        );
      }
      return opt.ref;
    });
    return {
      kind: "choice",
      actions,
      ...(node.passable != null && { passable: node.passable }),
    };
  }

  // repeat
  return {
    kind: "repeat",
    body: assembleGrammar(node.body),
    count: node.count,
  };
}

// ---------------------------------------------------------------------------
// FlowNode recursive assembly
// ---------------------------------------------------------------------------

function assembleFlowNode(
  node: GamedefFlowNode,
  effectDefs: Record<string, Record<string, unknown>>,
): FlowNode {
  const nodeId = node.id ?? node.kind;

  if (node.kind === "loop") {
    if (node.count != null && node.endCondition != null) {
      throw new Error(
        `flow assembler: loop '${nodeId}' has both 'count' and 'endCondition'; provide only one.`,
      );
    }
    if (node.endCondition === "until-pass") {
      throw new Error(
        `flow assembler: loop '${nodeId}' endCondition 'until-pass' is not yet supported.`,
      );
    }
    const checkAfter = node.checkAfter ?? "iteration";
    if (node.finalRound && checkAfter !== "turn") {
      throw new Error(
        `flow assembler: loop '${nodeId}' finalRound requires checkAfter: turn.`,
      );
    }
    const endExpr =
      typeof node.endCondition === "string" ? node.endCondition : undefined;
    if (endExpr && checkAfter === "iteration" && /\bactor\./.test(endExpr)) {
      throw new Error(
        `flow assembler: loop '${nodeId}' endCondition references 'actor', which is only bound with checkAfter: turn.`,
      );
    }
    const endPred = endExpr ? compilePredicate(endExpr) : undefined;
    const result: LoopFlowNode = {
      kind: "loop",
      id: nodeId,
      label: node.label ?? nodeId,
      children: node.children.map((child) =>
        assembleFlowNode(child, effectDefs),
      ),
      ...(node.count != null && { count: node.count }),
      ...(node.finalRound != null && { finalRound: node.finalRound }),
      ...(node.writeIterationTo != null && {
        writeIterationTo: node.writeIterationTo,
      }),
      ...(endPred && {
        endCondition: (session: GameSession, actorId?: string) =>
          endPred(sessionToEvalContext(session, actorId)),
      }),
      ...(node.checkAfter != null && { checkAfter: node.checkAfter }),
    };
    const hooks = assembleFlowHooks(node.hooks, nodeId, effectDefs);
    if (hooks) result.hooks = hooks;
    return result;
  }

  if (node.kind === "simultaneous") {
    throw new Error(
      `flow assembler: FlowNode kind 'simultaneous' is not yet supported. Use 'loop' or 'turn'.`,
    );
  }

  // turn
  const result: TurnFlowNode = {
    kind: "turn",
    id: nodeId,
    label: node.label ?? nodeId,
    ordering: assembleTurnOrdering(node.actor, node.turnOrder),
    grammar: assembleGrammar(node.grammar),
  };
  const hooks = assembleFlowHooks(node.hooks, nodeId, effectDefs);
  if (hooks) result.hooks = hooks;
  return result;
}

// ---------------------------------------------------------------------------
// Win conditions
// ---------------------------------------------------------------------------

/** Assemble win conditions. */
function assembleWinConditions(
  specConditions: WinCondition[],
  specId: string,
  effectDefs: Record<string, Record<string, unknown>>,
): WinConditionDef[] {
  return specConditions.map((wc, i) => {
    const prefix = `${specId}.winConditions_${i}`;

    const onVictory = wc.onVictory?.length
      ? normalizeEffectList(wc.onVictory, `${prefix}.onVictory`, effectDefs)
      : undefined;

    switch (wc.rule) {
      case "ranking": {
        const propertyPath = wc.property;
        // TODO(Phase 6.5): replace with compileExpression(propertyPath) once expressions return numeric values.
        const match = propertyPath.match(/^player\.property\.(.+)$/);
        if (!match) {
          throw new Error(
            `flow assembler: winCondition[${i}] ranking property must be 'player.property.<key>' (got '${propertyPath}')`,
          );
        }
        const key = match[1];
        return {
          rule: "ranking" as const,
          value: (
            _session: import("@chaincraft/runtime").GameSession,
            playerId: string,
          ) => {
            return Number(
              _session.state.players[playerId]?.properties[key] ?? 0,
            );
          },
          order: wc.order ?? "highest",
          tiebreak: wc.tiebreak ?? "all-win",
          ...(onVictory && { onVictory }),
        };
      }
      case "condition": {
        const predFn = compilePredicate(wc.condition);
        return {
          rule: "condition" as const,
          condition: (
            session: import("@chaincraft/runtime").GameSession,
            actorId?: string,
          ) => {
            return predFn(sessionToEvalContext(session, actorId));
          },
          ...(onVictory && { onVictory }),
        };
      }
      case "role-condition":
        throw new Error(
          `flow assembler: winCondition[${i}] rule 'role-condition' is not yet supported.`,
        );
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the spec's flow module into a runtime FlowNode tree.
 *
 * Inline hook effects are walked and stored in the effectDefs accumulator
 * under synthetic IDs; their call sites become { ref } entries.
 *
 * @param spec    - Parsed game spec (spec.flow must be present)
 * @param specId  - Used as the game-root's id
 * @param effectDefs - Mutable accumulator; inline hook effects are added here
 */
export function assembleFlow(
  spec: ModularGameSpec,
  specId: string,
  effectDefs: Record<string, Record<string, unknown>>,
): GameFlowNode {
  if (!spec.flow) {
    throw new Error(`flow assembler: spec '${specId}' has no flow module`);
  }

  const root = spec.flow.root as {
    kind: "game";
    label?: string;
    hooks?: { onEnter?: EffectCall[]; onComplete?: EffectCall[] };
    children: GamedefFlowNode[];
    winConditions?: WinCondition[];
  };

  const gameNode: GameFlowNode = {
    kind: "game",
    id: specId,
    children: root.children.map((child) => assembleFlowNode(child, effectDefs)),
  };

  const hooks = assembleFlowHooks(root.hooks, specId, effectDefs);
  if (hooks) gameNode.hooks = hooks;

  if (root.winConditions?.length) {
    gameNode.winConditions = assembleWinConditions(
      root.winConditions,
      specId,
      effectDefs,
    );
  }

  return gameNode;
}
