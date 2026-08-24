// ---------------------------------------------------------------------------
// Bridge: GameSession → EvalContext
//
// Compiled expressions operate on EvalContext (compiler-only type).
// This adapter builds one from a live GameSession at call time.
// ---------------------------------------------------------------------------

import type { GameSession } from "@chaincraft/runtime";
import type { EvalContext } from "../expressions/types.js";

export function sessionToEvalContext(
  session: GameSession,
  actorId?: string,
): EvalContext {
  const players: EvalContext["players"] = {};
  for (const pid of session.players) {
    const ps = session.state.players[pid];
    players[pid] = {
      properties: ps.properties,
      inventories: ps.inventories,
    };
  }

  const gamepieces: EvalContext["gamepieces"] = {};
  for (const [id, gp] of Object.entries(session.state.gamepieces)) {
    gamepieces[id] = { typeId: gp.typeId, properties: gp.properties };
  }

  return {
    gameProperties: session.state.gameProperties,
    gameInventories: session.state.gameInventories,
    players,
    gamepieces,
    playerIds: session.players,
    actorId,
  };
}
