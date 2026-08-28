// ---------------------------------------------------------------------------
// Bridge: GameSession → EvalContext
//
// Compiled expressions operate on EvalContext (compiler-only type).
// This adapter builds one from a live GameSession at call time.
// ---------------------------------------------------------------------------

import type { GameSession } from "@chaincraft/runtime";
import type { EvalContext } from "#compiler/expressions/types.js";
import { compilePredicate } from "#compiler/expressions/index.js";

/** Converts a GameSession into an EvalContext. */
export function sessionToEvalContext(
  session: GameSession,
  actorId?: string,
  params?: Record<string, unknown>,
  sourcePieceId?: string,
  targetPieceId?: string,
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
    params,
    sourcePieceId,
    targetPieceId,
  };
}

/** Compile a piece-filter expression into the runtime's (session, pieceId) => boolean shape. */
export function compilePieceFilter(
  expr: string,
): (session: GameSession, pieceId: string) => boolean {
  const predicate = compilePredicate(expr);
  return (session, pieceId) =>
    predicate(
      sessionToEvalContext(session, undefined, undefined, undefined, pieceId),
    );
}

/** Compile a player-filter expression into the runtime's (session, playerId) => boolean shape. */
export function compilePlayerFilter(
  expr: string,
): (session: GameSession, playerId: string) => boolean {
  const predicate = compilePredicate(expr);
  return (session, playerId) =>
    predicate({ ...sessionToEvalContext(session), boundPlayerId: playerId });
}

/** Compile a precondition expression into the runtime's (session, actorId) => boolean shape. */
export function compilePrecondition(
  expr: string,
): (session: GameSession, actorId: string) => boolean {
  const predicate = compilePredicate(expr);
  return (session, actorId) =>
    predicate(sessionToEvalContext(session, actorId));
}
