// ---------------------------------------------------------------------------
// Expression compiler — public API
//
// compileExpression(input) → (ctx: EvalContext) => unknown
// compilePredicate(input)  → (ctx: EvalContext) => boolean
// parseExpression(input)   → Expr AST (for inspection/testing)
// ---------------------------------------------------------------------------

export { parseExpression } from './parser.js';
export { buildEvaluator, buildPredicate } from './evaluator.js';
export type { ExprFn, PredicateFn } from './evaluator.js';
export type { Expr, CompareOp, ArithOp, EvalContext, InventoryLike, PlayerLike } from './types.js';
export { ExpressionError } from './types.js';

import { parseExpression } from './parser.js';
import { buildEvaluator, buildPredicate } from './evaluator.js';
import type { EvalContext } from './types.js';

/**
 * Compile an infix expression string into a function that evaluates it
 * against an EvalContext, returning the expression's value.
 */
export function compileExpression(input: string): (ctx: EvalContext) => unknown {
  const ast = parseExpression(input);
  return buildEvaluator(ast);
}

/**
 * Compile an infix expression string into a boolean predicate function.
 * The expression's result is coerced to boolean.
 */
export function compilePredicate(input: string): (ctx: EvalContext) => boolean {
  const ast = parseExpression(input);
  return buildPredicate(ast);
}
