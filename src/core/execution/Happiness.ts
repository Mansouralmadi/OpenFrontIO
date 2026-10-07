import { Game, Player, Structures, Unit, UnitType } from "../game/Game";
import type { Cluster } from "../game/TrainStation";

/**
 * Recomputes a player's happiness and integration bonus (see HAPPINESS in
 * Config). Called by PlayerExecution every recomputeIntervalTicks.
 */
export function refreshHappiness(game: Game, player: Player): void {
  const config = game.config();
  const h = config.happinessConfig();
  const connected = cityConnection(game, player);
  // Rail-linked farm levels weigh connectedFarmWeight each.
  let farmLevels = player.totalUnitLevels(UnitType.Farm);
  for (const farm of player.units(UnitType.Farm)) {
    if (connected(farm))
      farmLevels += (h.connectedFarmWeight - 1) * farm.level();
  }
  player.setHappiness(
    config.happiness(
      farmLevels,
      player.unintegratedTiles(),
      player.numTilesOwned(),
      game.ticksSinceStart(),
    ),
  );
  player.setIntegrationBonus(integrationBonus(game, player, connected));
}

/**
 * Whether a completed structure's rail cluster holds another of the owner's
 * completed cities.
 */
function cityConnection(game: Game, player: Player): (unit: Unit) => boolean {
  const stations = game.railNetwork().stationManager();
  // Rail clusters -> how many of this player's completed cities they hold.
  const citiesIn = new Map<Cluster, number>();
  for (const city of player.units(UnitType.City)) {
    if (city.isUnderConstruction()) continue;
    const cluster = stations.findStation(city)?.getCluster();
    if (cluster) citiesIn.set(cluster, (citiesIn.get(cluster) ?? 0) + 1);
  }
  return (unit) => {
    if (unit.isUnderConstruction()) return false;
    const cluster = stations.findStation(unit)?.getCluster();
    if (!cluster) return false;
    const self = unit.type() === UnitType.City ? 1 : 0;
    return (citiesIn.get(cluster) ?? 0) > self;
  };
}

function integrationBonus(
  game: Game,
  player: Player,
  connected: (unit: Unit) => boolean,
): number {
  const h = game.config().happinessConfig();
  let bonus = 0;
  for (const unit of player.units()) {
    if (!Structures.has(unit.type()) || unit.isUnderConstruction()) continue;
    if (unit.type() === UnitType.Factory) {
      bonus += h.perFactoryLevel * unit.level();
      continue;
    }
    if (connected(unit)) bonus += h.perConnectedStructure;
  }
  return Math.min(h.integrationBonusMax, bonus);
}
