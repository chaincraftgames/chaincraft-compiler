// ---------------------------------------------------------------------------
// Actions assembler
//
// Produces: Record<string, ActionDef> — one entry per action in the spec,
// keyed by action ID. Inline effects within actions are walked via
// walkEffectBody and stored in a shared effectDefs accumulator with
// synthetic IDs.
// ---------------------------------------------------------------------------

import type { ModularGameSpec, ActionInput } from '@chaincraft/gamedef';
import type { ActionDef, ActionInputDef, ActionInputType } from '@chaincraft/runtime';
import { normalizeEffectList } from './effects.js';

/**
 * Map a gamedef ActionInput to the runtime's ActionInputDef.
 * The shapes are structurally close — this is a typed passthrough.
 */
function mapActionInput(input: ActionInput): ActionInputDef {
  return {
    id: input.id,
    ...(input.label != null && { label: input.label }),
    type: input.type as ActionInputType,
    ...(input.validation != null && { validation: input.validation }),
  };
}

/**
 * Compile all actions from the spec into ActionDef objects.
 *
 * Inline effects within actions are walked and assigned synthetic IDs,
 * then added to the provided effectDefs accumulator. The action's effects[]
 * array becomes all { ref } entries.
 *
 * @param spec - The parsed game spec
 * @param effectDefs - Mutable accumulator; inline effects are added here
 * @returns Record of ActionDef keyed by action ID
 */
export function assembleActions(
  spec: ModularGameSpec,
  effectDefs: Record<string, Record<string, unknown>>,
): Record<string, ActionDef> {
  const actions: Record<string, ActionDef> = {};

  if (!spec.actions?.actions) return actions;

  for (const action of spec.actions.actions) {
    const effects = normalizeEffectList(action.effects, `${action.id}._effect`, effectDefs);

    const inputs: ActionInputDef[] = (action.inputs ?? []).map(
      (input) => mapActionInput(input),
    );

    actions[action.id] = {
      id: action.id,
      label: action.label ?? action.id,
      description: action.description ?? "",
      inputs,
      effects,
    };
  }

  return actions;
}
