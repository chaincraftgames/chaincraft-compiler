// ---------------------------------------------------------------------------
// Expression compiler — AST types and evaluation context
//
// The expression language supports infix conditions used in flow
// endConditions, player-target matching, and input validation.
//
// Path roots:
//   game.property.X       → gameProperties[X]
//   game.inventory.X      → gameInventories[X]
//   actor.property.X      → players[actorId].properties[X]
//   actor.inventory.X     → players[actorId].inventories[X]
//   player.property.X     → bound player (inside all/any quantifiers)
//   player.inventory.X    → bound player (inside all/any quantifiers)
//
// Functions:
//   count(inventoryPath)  → number of pieces in the resolved inventory
//   all(booleanExpr)      → true if expr holds for every player
//   any(booleanExpr)      → true if expr holds for at least one player
// ---------------------------------------------------------------------------

// --- AST node types ---------------------------------------------------------
/** Comparison operators. */
export type CompareOp = '==' | '!=' | '>=' | '<=' | '>' | '<';
/** Arithmetic operators. */
export type ArithOp = '+' | '-' | '*' | '/';

/** Expression AST node. */
export type Expr =
  | { kind: 'literal'; value: number | string | boolean }
  | { kind: 'path'; segments: string[] }
  | { kind: 'compare'; op: CompareOp; left: Expr; right: Expr }
  | { kind: 'arithmetic'; op: ArithOp; left: Expr; right: Expr }
  | { kind: 'logical'; op: 'and' | 'or'; left: Expr; right: Expr }
  | { kind: 'not'; operand: Expr }
  | { kind: 'call'; fn: string; args: Expr[] };

// --- Shapes for game state objects ----------------------------------------
/** Inventory-like object. */
export interface InventoryLike {
  structure?: string;
  pieceIds?: string[];
  slots?: (string | null)[];
  cells?: Record<string, string | null>;
  nodes?: Record<string, string | null>;
}

/** Player-like object. */
export interface PlayerLike {
  properties: Record<string, unknown>;
  inventories: Record<string, InventoryLike>;
}

/** Evaluation context for expressions. */
export interface EvalContext {
  gameProperties: Record<string, unknown>;
  gameInventories: Record<string, InventoryLike>;
  players: Record<string, PlayerLike>;
  gamepieces: Record<string, { typeId: string; properties: Record<string, unknown> }>;
  playerIds: string[];
  actorId?: string;
  params?: Record<string, unknown>;
}

// --- Error types -----------------------------------------------------------
/** Error thrown during expression evaluation. */
export class ExpressionError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
    public readonly source?: string,
  ) {
    super(source ? `${message} at position ${pos} in "${source}"` : `${message} at position ${pos}`);
    this.name = 'ExpressionError';
  }
}
