import { Game, Player, Structures, UnitType } from "../game/Game";
import type { Cluster } from "../game/TrainStation";

/**
 * Recomputes a player's happiness and integration bonus (see HAPPINESS in
 * Config). Called by PlayerExecution every recomputeIntervalTicks.
 */
export function refreshHappiness(game: Game, player: Player): void {
  const config = game.config();
  player.setHappiness(
    config.happiness(
      player.totalUnitLevels(UnitType.Farm),
      player.unintegratedTiles(),
      player.numTilesOwned(),
    ),
  );
  player.setIntegrationBonus(integrationBonus(game, player));
}

function integrationBonus(game: Game, player: Player): number {
  const h = game.config().happinessConfig();
  const stations = game.railNetwork().stationManager();
  // Rail clusters -> how many of this player's completed cities they hold.
  const citiesIn = new Map<Cluster, number>();
  for (const city of player.units(UnitType.City)) {
    if (city.isUnderConstruction()) continue;
    const cluster = stations.findStation(city)?.getCluster();
    if (cluster) citiesIn.set(cluster, (citiesIn.get(cluster) ?? 0) + 1);
  }
  let bonus = 0;
  for (const unit of player.units()) {
    if (!Structures.has(unit.type()) || unit.isUnderConstruction()) continue;
    if (unit.type() === UnitType.Factory) {
      bonus += h.perFactoryLevel * unit.level();
      continue;
    }
    const cluster = stations.findStation(unit)?.getCluster();
    if (!cluster) continue;
    const self = unit.type() === UnitType.City ? 1 : 0;
    if ((citiesIn.get(cluster) ?? 0) > self) bonus += h.perConnectedStructure;
  }
  return Math.min(h.integrationBonusMax, bonus);
}
