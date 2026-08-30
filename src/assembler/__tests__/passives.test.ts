// ---------------------------------------------------------------------------
// Passives integration test — lifesteal and thorns (board-battler spec).
//
// Strategy: compile the spec, create a session, manually place the passive
// carrier in the enabledIn inventory, then drive a single executor call.
// Only the relevant passive carrier is placed on the field per test so
// passive chains don't interfere with each other's assertions.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { load } from "js-yaml";
import { validate } from "@chaincraft/gamedef/validator";
import { executeSetState, executeUpdate } from "@chaincraft/runtime";
import type { GameSession, BagInventoryData } from "@chaincraft/runtime";
import { assembleModule } from "../index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadSpec(filename: string) {
  const raw = load(
    readFileSync(
      join(__dirname, "../../../../gamedef/examples/", filename),
      "utf-8",
    ),
  );
  const result = validate(raw);
  if (!result.valid) {
    throw new Error(
      `${filename} failed validation: ${JSON.stringify(result.errors, null, 2)}`,
    );
  }
  return result.spec;
}

function life(session: GameSession, playerId: string): number {
  return Number(session.state.players[playerId].properties["life"] ?? 0);
}

/** Move a piece from game:unassigned to a player's field inventory. */
function placeOnField(
  session: GameSession,
  pieceId: string,
  playerId: string,
): void {
  const unassigned = session.state.gameInventories[
    "game:unassigned"
  ] as BagInventoryData;
  unassigned.pieceIds = unassigned.pieceIds.filter((id) => id !== pieceId);
  session.state.gamepieces[pieceId].ownerId = playerId;
  (
    session.state.players[playerId].inventories["field"] as BagInventoryData
  ).pieceIds.push(pieceId);
}

// ---------------------------------------------------------------------------

describe("Passives — lifesteal and thorns (board-battler)", () => {
  const PLAYERS = ["alice", "bob"];

  let session: GameSession;

  beforeEach(() => {
    const spec = loadSpec("board-battler.yaml");
    const mod = assembleModule(spec, "board-battler");
    session = mod.createSession("passive-test", PLAYERS);
  });

  // -------------------------------------------------------------------------

  it("lifesteal: when the holder deals damage, the holder heals +2", async () => {
    // bloodHunter carries lifesteal; enabledIn: [field]
    placeOnField(session, "bloodHunter", "alice");
    // Start alice below max so the +2 heal is observable
    session.state.players["alice"].properties["life"] = 20;

    const aliceBefore = life(session, "alice"); // 20
    const bobBefore = life(session, "bob"); // 30

    // Alice attacks Bob: decrease Bob's life, actorId = alice → lifesteal fires
    await executeSetState(session, {
      actorId: "alice",
      effectDef: {
        kind: "set-state",
        path: "player.property.life",
        value: { delta: -5 },
        target: { kind: "all-other" },
      },
      actionInputs: {},
    });

    expect(life(session, "bob")).toBe(bobBefore - 5); // damage landed
    expect(life(session, "alice")).toBe(aliceBefore + 2); // lifesteal healed +2
  });

  // -------------------------------------------------------------------------

  it("thorns: when the holder is targeted, the attacker takes 2 damage", async () => {
    // thornBeast carries thorns; enabledIn: [field]
    placeOnField(session, "thornBeast", "bob");

    const aliceBefore = life(session, "alice"); // 30

    // Alice attacks thornBeast's defense; actorId = alice → thorns fires, damages alice
    await executeUpdate(session, {
      actorId: "alice",
      effectDef: {
        kind: "update",
        pieces: {
          player: { param: "defenderOwner" },
          inventory: "field",
          select: { id: { param: "defender" } },
        },
        property: "defense",
        value: { delta: -2 },
      },
      actionInputs: {
        defenderOwner: "bob",
        defender: "thornBeast",
      },
    });

    expect(life(session, "alice")).toBe(aliceBefore - 2); // thorns dealt 2 to the attacker
  });
});
