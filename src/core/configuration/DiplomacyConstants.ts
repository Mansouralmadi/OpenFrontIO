// OpenFront Iron diplomacy tuning, in one place. Alliances are meant to be a
// big decision: slots are scarce and betrayal follows a player for the rest
// of the game.

/** Default alliance length. Host custom durations still win. */
export const DEFAULT_ALLIANCE_DURATION_MINUTES = 5;

/** Traitor debuff length after breaking an alliance (was 30 seconds). */
export const TRAITOR_DURATION_TICKS = 60 * 10;

/** Max simultaneous alliances per player (was unlimited). */
export const MAX_ALLIANCES = 3;

/** Relation every nation loses toward a player each time they betray. */
export const BETRAYAL_RELATION_PENALTY = 50;
/** Nations refuse all alliances from players with this many betrayals. */
export const BETRAYALS_NATIONS_REFUSE = 2;
// Below that, each betrayal halves the chance a nation even considers an
// alliance (1 betrayal = 50%).

// Power politics, measured in land. Small nations seek protection from a
// much bigger neighbor; great powers of similar size see each other as rivals
// and rarely ally.
/** A partner with this many times a nation's land is a protector worth allying. */
export const PROTECTOR_LAND_FACTOR = 2;
/** Players owning at least this share of all land are great powers. */
export const GREAT_POWER_LAND_SHARE_PERCENT = 8;
/** Great powers within this land ratio of each other are rivals. */
export const RIVAL_LAND_FACTOR = 1.5;
/** 1-in-N chance a nation allies with a rival great power, and only if Friendly. */
export const RIVAL_ALLIANCE_ODDS = 5;

// The FFA leader (not a bot) owning at least this share of the land and this
// many times the runner-up's land is "dominant": nations bordering it focus
// attacks on it (it can still find allies).
export const DOMINANT_LAND_SHARE_PERCENT = 22;
export const DOMINANT_LEAD_FACTOR = 1.5;

// Allied nations join their allies' wars against non-bot players when they
// can reach the enemy, hold their reserve troops and fight no war of their own.

export type Reputation = "trusted" | "unreliable" | "traitor";

export function reputationOf(betrayals: number): Reputation {
  if (betrayals >= BETRAYALS_NATIONS_REFUSE) return "traitor";
  return betrayals > 0 ? "unreliable" : "trusted";
}

/** Why an alliance request can't be sent, for the reasons the UI explains. */
export type AllianceRequestBlocker = "slots_self" | "slots_other";
