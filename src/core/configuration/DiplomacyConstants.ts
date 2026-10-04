// OpenFront Iron diplomacy tuning, in one place. Alliances are meant to be a
// big decision: they cost gold, slots are scarce, they last longer, and
// betrayal follows a player for the rest of the game.

/** Default alliance length (was 5 minutes). Host custom durations still win. */
export const DEFAULT_ALLIANCE_DURATION_MINUTES = 10;

/** Traitor debuff length after breaking an alliance (was 30 seconds). */
export const TRAITOR_DURATION_TICKS = 120 * 10;

/** Max simultaneous alliances per player (was unlimited). */
export const MAX_ALLIANCES = 3;

// Alliance price, paid by every human party when the alliance forms, whether
// they asked or accepted. Checked when sending, charged on acceptance: in
// effect an escrow refunded in full on rejection or expiry, without holding
// any escrow state. Nations and tribes ally for free: charging them only
// stalled their economy, and slots + reputation already restrain them.
// cost = max(FLOOR, INCOME_TICKS of passive gold income + GOLD_PER_TILE * tiles)
export const ALLIANCE_COST_FLOOR = 50_000n;
/** One minute of the requester's passive gold income. */
export const ALLIANCE_COST_INCOME_TICKS = 60n * 10n;
export const ALLIANCE_COST_GOLD_PER_TILE = 2n;

/** Relation every nation loses toward a player each time they betray. */
export const BETRAYAL_RELATION_PENALTY = 50;
/** Nations refuse all alliances from players with this many betrayals. */
export const BETRAYALS_NATIONS_REFUSE = 2;
// Below that, each betrayal halves the chance a nation even considers an
// alliance (1 betrayal = 50%).

// Anti-snowball coalition: the FFA leader (not a bot) owning at least this
// share of the land and this many times the runner-up's land is "dominant".
// Nations then refuse it, walk out of alliances with it (not a betrayal),
// ally with each other readily and focus attacks on it.
export const DOMINANT_LAND_SHARE_PERCENT = 22;
export const DOMINANT_LEAD_FACTOR = 1.5;
/** 1-in-N chance per nation decision tick to leave an alliance with it. */
export const DOMINANT_ALLY_ABANDON_ODDS = 20;

export type Reputation = "trusted" | "unreliable" | "traitor";

export function reputationOf(betrayals: number): Reputation {
  if (betrayals >= BETRAYALS_NATIONS_REFUSE) return "traitor";
  return betrayals > 0 ? "unreliable" : "trusted";
}

/** Why an alliance request can't be sent, for the reasons the UI explains. */
export type AllianceRequestBlocker = "slots_self" | "slots_other" | "gold";
