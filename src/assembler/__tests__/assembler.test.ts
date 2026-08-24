// ---------------------------------------------------------------------------
// Assembler — High Card slice-0 integration test
//
// Loads gamedef/examples/high-card.yaml through gamedef's validate(), then
// runs the assembler and checks the produced GameConfig + initial GameState
// against expectations. Per the 2026-07-28 decision, this does NOT diff
// against chaincraft-runtime's hand-written fixture directly — the fixture
// pre-seeds `deck` and includes stand-in properties (winner, roundWinner's
// mechanic wiring) that belong to features not yet in the runtime
// (chaincraft:dominant-gamepiece mechanic, winConditions). This test instead asserts the
// assembler's actual contract: config shape + all catalog pieces sitting in
// `game:unassigned`, declared inventories empty, properties at declared
// defaults.
// ---------------------------------------------------------------------------

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { load } from 'js-yaml';
import { validate } from '@chaincraft/gamedef/validator';
import { GameController } from '@chaincraft/runtime';
import {
  assembleConfig, assembleInitialState, assembleSession,
  buildExecutorRegistry, assembleEffectDefs, assembleActions,
  assembleFlow, assembleModule,
  UNASSIGNED_INVENTORY_ID,
} from '../index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadHighCardSpec() {
  const raw = load(
    readFileSync(
      join(__dirname, '../../../../gamedef/examples/high-card.yaml'),
      'utf-8',
    ),
  );
  const result = validate(raw);
  if (!result.valid) {
    throw new Error(`high-card.yaml failed validation: ${JSON.stringify(result.errors, null, 2)}`);
  }
  return result.spec;
}

describe('assembleConfig — High Card', () => {
  const spec = loadHighCardSpec();
  const config = assembleConfig(spec);

  it('assembles playerCount from metadata', () => {
    expect(config.playerCount).toEqual({ min: 2, max: 2 });
  });

  it('assembles inventories with scope/structure/visibility/accepts', () => {
    expect(config.inventories.deck).toEqual({
      structure: 'stack',
      scope: 'game',
      visibility: 'never',
      countVisibility: 'always',
      accepts: ['card'],
    });
    expect(config.inventories.hand).toEqual({
      structure: 'none',
      scope: 'player',
      visibility: 'owner',
      countVisibility: 'always',
      accepts: ['card'],
    });
    expect(config.inventories.table).toEqual({
      structure: 'none',
      scope: 'game',
      visibility: 'always',
      countVisibility: 'always',
      accepts: ['card'],
    });
    expect(config.inventories.discard).toEqual({
      structure: 'none',
      scope: 'game',
      visibility: 'always',
      countVisibility: 'always',
      accepts: ['card'],
    });
  });

  it('assembles gamepieceTypes with property configs', () => {
    expect(config.gamepieceTypes.card).toEqual({
      category: 'card',
      properties: {
        value: { mutable: false, min: 1, max: 6 },
      },
    });
  });

  it('assembles game properties (roundWinner only — no winner; that is a winConditions feature gap)', () => {
    expect(config.gameProperties).toEqual({
      roundWinner: { mutable: true },
    });
  });

  it('assembles player properties', () => {
    expect(config.playerProperties).toEqual({
      score: { mutable: true, min: 0, max: 3 },
    });
  });
});

describe('assembleInitialState — High Card', () => {
  const spec = loadHighCardSpec();
  const config = assembleConfig(spec);
  const players = ['alice', 'bob'];
  const state = assembleInitialState(spec, config, players);

  it('instantiates 6 cards with values 1-6, sequentially numbered', () => {
    const ids = Object.keys(state.gamepieces).sort();
    expect(ids).toEqual(['card1', 'card2', 'card3', 'card4', 'card5', 'card6']);
    for (let value = 1; value <= 6; value++) {
      const piece = state.gamepieces[`card${value}`];
      expect(piece).toEqual({
        typeId: 'card',
        ownerId: '',
        properties: { value },
        faceUp: false,
        exhausted: false,
        visibleTo: null,
      });
    }
  });

  it('places all pieces in game:unassigned, not the declared inventories', () => {
    const unassigned = state.gameInventories[UNASSIGNED_INVENTORY_ID];
    expect('pieceIds' in unassigned && unassigned.pieceIds.slice().sort()).toEqual(
      ['card1', 'card2', 'card3', 'card4', 'card5', 'card6'],
    );
  });

  it('initializes declared game inventories empty', () => {
    expect(state.gameInventories.deck).toEqual({ structure: 'stack', pieceIds: [] });
    expect(state.gameInventories.table).toEqual({ structure: 'none', pieceIds: [] });
    expect(state.gameInventories.discard).toEqual({ structure: 'none', pieceIds: [] });
  });

  it('initializes game properties at their declared defaults', () => {
    expect(state.gameProperties).toEqual({ roundWinner: '' });
  });

  it('initializes each player with default properties and empty hand', () => {
    for (const pid of players) {
      expect(state.players[pid].properties).toEqual({ score: 0 });
      expect(state.players[pid].inventories.hand).toEqual({ structure: 'none', pieceIds: [] });
    }
  });

  it('gives each player an independent hand inventory instance', () => {
    const aliceHand = state.players.alice.inventories.hand;
    const bobHand = state.players.bob.inventories.hand;
    expect(aliceHand).not.toBe(bobHand);
  });
});

describe('assembleSession — High Card', () => {
  const spec = loadHighCardSpec();

  it('produces a session with correct gameId/specId/players', () => {
    const { createSession } = assembleSession(spec, 'high-card');
    const session = createSession('g1', ['alice', 'bob']);
    expect(session.gameId).toBe('g1');
    expect(session.specId).toBe('high-card');
    expect(session.players).toEqual(['alice', 'bob']);
    expect(session.outbox).toEqual([]);
    expect(session._inventoryCache.size).toBe(0);
  });

  it('uses the fixed seed deterministically (seedSource: fixed)', () => {
    const { createSession } = assembleSession(spec, 'high-card');
    const s1 = createSession('g1', ['alice', 'bob']);
    const s2 = createSession('g2', ['alice', 'bob']); // different gameId, same fixed seed
    expect(s1.rng.nextFloat()).toBe(s2.rng.nextFloat());
  });

  it('config is shared (not re-derived) across createSession calls', () => {
    const factory = assembleSession(spec, 'high-card');
    const s1 = factory.createSession('g1', ['alice']);
    expect(s1.config).toBe(factory.config);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — Effects + Actions assembler
// ---------------------------------------------------------------------------

describe('buildExecutorRegistry — High Card', () => {
  const spec = loadHighCardSpec();
  // Build effectDefs from all assembler phases so flow-inline kinds are included
  const effectDefs = assembleEffectDefs(spec);
  const specId = 'high-card';
  assembleActions(spec, effectDefs);
  assembleFlow(spec, specId, effectDefs);
  const executors = buildExecutorRegistry(effectDefs);

  it('registers an executor for each distinct effect kind in effectDefs', () => {
    // Named effects use: move, shuffle, distribute, message, set-state
    const expectedKinds = ['move', 'shuffle', 'distribute', 'message', 'set-state'];
    for (const kind of expectedKinds) {
      expect(executors[kind]).toBeDefined();
      expect(executors[kind].kind).toBe('effect-executor');
    }
  });

  it('each executor has an execute function', () => {
    for (const reg of Object.values(executors)) {
      if (reg.kind === 'effect-executor') {
        expect(typeof reg.execute).toBe('function');
      }
    }
  });
});

describe('assembleEffectDefs — High Card', () => {
  const spec = loadHighCardSpec();
  const defs = assembleEffectDefs(spec);

  it('creates an entry for each named effect in the effects module', () => {
    // high-card.yaml defines: fillDeck, shuffleDeck, dealCards, announceStart,
    // awardTrick, announceTrick, clearTable, resetRoundWinner
    const expectedIds = [
      'fillDeck', 'shuffleDeck', 'dealCards', 'announceStart',
      'awardTrick', 'announceTrick', 'clearTable', 'resetRoundWinner',
    ];
    expect(Object.keys(defs).sort()).toEqual(expectedIds.sort());
  });

  it('strips the id field from each effect def', () => {
    for (const def of Object.values(defs)) {
      expect(def).not.toHaveProperty('id');
    }
  });

  it('preserves the kind on each def', () => {
    expect(defs.fillDeck.kind).toBe('move');
    expect(defs.shuffleDeck.kind).toBe('shuffle');
    expect(defs.dealCards.kind).toBe('distribute');
    expect(defs.announceStart.kind).toBe('message');
    expect(defs.awardTrick.kind).toBe('set-state');
    expect(defs.announceTrick.kind).toBe('message');
    expect(defs.clearTable.kind).toBe('move');
    expect(defs.resetRoundWinner.kind).toBe('set-state');
  });

  it('walks nested structures (fillDeck from/to)', () => {
    expect(defs.fillDeck).toEqual({
      kind: 'move',
      from: { inventory: 'game:unassigned', select: 'all', ofType: 'card' },
      to: { inventory: 'deck' },
    });
  });

  it('walks distribute effect with count and scope', () => {
    expect(defs.dealCards).toEqual({
      kind: 'distribute',
      from: { inventory: 'deck', select: 'top' },
      to: { inventory: 'hand' },
      count: 3,
      style: 'round-robin',
    });
  });

  it('walks set-state with delta value and stateRef target', () => {
    expect(defs.awardTrick).toEqual({
      kind: 'set-state',
      path: 'player.property.score',
      value: { delta: 1 },
      target: { kind: 'stateRef', path: 'game.property.roundWinner' },
    });
  });
});

describe('assembleActions — High Card', () => {
  const spec = loadHighCardSpec();
  const effectDefs: Record<string, Record<string, unknown>> = {};
  const actions = assembleActions(spec, effectDefs);

  it('creates a playCard action', () => {
    expect(actions.playCard).toBeDefined();
    expect(actions.playCard.id).toBe('playCard');
    expect(actions.playCard.label).toBe('Play a Card');
    expect(actions.playCard.description).toBe('Play one card from your hand to the table.');
  });

  it('maps the gamepiece-select input correctly', () => {
    const inputs = actions.playCard.inputs;
    expect(inputs).toHaveLength(1);
    expect(inputs[0].id).toBe('card');
    expect(inputs[0].label).toBe('Choose a card to play');
    expect(inputs[0].type).toEqual({
      kind: 'gamepiece-select',
      inventory: 'hand',
      ofType: 'card',
      fromPlayer: 'self',
    });
  });

  it('normalizes inline effects to { ref } entries', () => {
    const effects = actions.playCard.effects;
    expect(effects).toHaveLength(1);
    expect(effects[0]).toHaveProperty('ref');
  });

  it('adds inline action effects to the effectDefs accumulator', () => {
    const refId = (actions.playCard.effects[0] as { ref: string }).ref;
    expect(effectDefs[refId]).toBeDefined();
    expect(effectDefs[refId].kind).toBe('move');
    expect(effectDefs[refId]).toEqual({
      kind: 'move',
      from: { inventory: 'hand', select: { id: { param: 'card' } } },
      to: { inventory: 'table' },
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — Flow + assembleModule + e2e
// ---------------------------------------------------------------------------

describe('assembleFlow — High Card', () => {
  const spec = loadHighCardSpec();
  const effectDefs: Record<string, Record<string, unknown>> = {};
  const flow = assembleFlow(spec, 'high-card', effectDefs);

  it('produces a game root node with the specId as id', () => {
    expect(flow.kind).toBe('game');
    expect(flow.id).toBe('high-card');
  });

  it('game root has onEnter hooks as refs', () => {
    const onEnter = flow.hooks?.onEnter ?? [];
    expect(onEnter).toHaveLength(4);
    expect(onEnter[0]).toEqual({ ref: 'fillDeck' });
    expect(onEnter[1]).toEqual({ ref: 'shuffleDeck' });
    expect(onEnter[2]).toEqual({ ref: 'dealCards' });
    expect(onEnter[3]).toEqual({ ref: 'announceStart' });
  });

  it('has a loop child with count 3', () => {
    expect(flow.children).toHaveLength(1);
    const loop = flow.children[0];
    expect(loop.kind).toBe('loop');
    if (loop.kind === 'loop') {
      expect(loop.id).toBe('tricks');
      expect(loop.count).toBe(3);
    }
  });

  it('loop contains a round-robin turn', () => {
    const loop = flow.children[0];
    if (loop.kind !== 'loop') throw new Error('expected loop');
    const turn = loop.children[0];
    expect(turn.kind).toBe('turn');
    if (turn.kind === 'turn') {
      expect(turn.id).toBe('playTrick');
      expect(turn.ordering).toEqual({ kind: 'round-robin' });
      expect(turn.grammar).toEqual({ kind: 'action', ref: 'playCard' });
    }
  });

  it('turn onComplete hooks include chaincraft:dominant-gamepiece:resolve ref', () => {
    const loop = flow.children[0];
    if (loop.kind !== 'loop') throw new Error('expected loop');
    const turn = loop.children[0];
    if (turn.kind !== 'turn') throw new Error('expected turn');
    const onComplete = turn.hooks?.onComplete ?? [];
    expect(onComplete[0]).toEqual({ ref: 'chaincraft:dominant-gamepiece:resolve' });
    expect(onComplete[1]).toEqual({ ref: 'awardTrick' });
    expect(onComplete[4]).toEqual({ ref: 'resetRoundWinner' });
  });
});

describe('assembleModule — High Card', () => {
  const spec = loadHighCardSpec();
  const mod = assembleModule(spec, 'high-card');

  it('produces a CompiledGameModule with correct specId and metadata', () => {
    expect(mod.specId).toBe('high-card');
    expect(mod.metadata.name).toBe('High Card');
    expect(mod.metadata.playerCount).toEqual({ min: 2, max: 2 });
  });

  it('registers the dominant-gamepiece executor', () => {
    expect(mod.effects['chaincraft:dominant-gamepiece']).toBeDefined();
    expect(mod.effects['chaincraft:dominant-gamepiece'].kind).toBe('effect-executor');
  });

  it('effectDefs contains the dominant-gamepiece resolve ref', () => {
    expect(mod.effectDefs['chaincraft:dominant-gamepiece:resolve']).toBeDefined();
    expect(mod.effectDefs['chaincraft:dominant-gamepiece:resolve'].kind).toBe('chaincraft:dominant-gamepiece');
  });

  it('effectDefs contains all named effects from the spec', () => {
    const expectedIds = [
      'fillDeck', 'shuffleDeck', 'dealCards', 'announceStart',
      'awardTrick', 'announceTrick', 'clearTable', 'resetRoundWinner',
    ];
    for (const id of expectedIds) {
      expect(mod.effectDefs[id]).toBeDefined();
    }
  });

  it('actions map contains playCard', () => {
    expect(mod.actions.playCard).toBeDefined();
    expect(mod.actions.playCard.inputs).toHaveLength(1);
  });

  it('passes link/validate (no unresolved refs)', () => {
    // If assembleModule doesn't throw, link/validate passed
    expect(() => assembleModule(spec, 'high-card')).not.toThrow();
  });
});

describe('assembled High Card — e2e setup', () => {
  it('starts a game session and fires onEnter hooks (cards dealt)', async () => {
    const spec = loadHighCardSpec();
    const mod = assembleModule(spec, 'high-card');

    const messages: string[] = [];
    const controller = new GameController(mod, {
      events: {
        onMessage: (msg) => messages.push(msg.template),
      },
    });

    await controller.init('game1', ['alice', 'bob']);
    const state = controller.getState();

    // fillDeck + shuffleDeck + dealCards should have moved 3 cards to each hand
    const aliceHand = state.players.alice.inventories.hand;
    const bobHand = state.players.bob.inventories.hand;
    const aliceCount = 'pieceIds' in aliceHand ? aliceHand.pieceIds.length : 0;
    const bobCount = 'pieceIds' in bobHand ? bobHand.pieceIds.length : 0;

    expect(aliceCount).toBe(3);
    expect(bobCount).toBe(3);

    // announceStart message should have fired (onMessage receives the rendered text)
    expect(messages.length).toBeGreaterThan(0);
  });
});
