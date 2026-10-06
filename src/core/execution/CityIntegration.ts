import { Game, Player, Unit, UnitType } from "../game/Game";

// Packed (dx, dy, dx² + dy², whole distance) quads covering a disk, nearest first. Ties go
// by dy then dx so every client integrates the same tiles in the same order.
let spiral: Int32Array | null = null;
let spiralRadius = -1;

function spiralOffsets(radius: number): Int32Array {
  if (spiral !== null && spiralRadius === radius) return spiral;
  const r2 = radius * radius;
  const cells: [number, number, number, number][] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) {
        let d = 0;
        while ((d + 1) * (d + 1) <= d2) d++;
        cells.push([dx, dy, d2, d]);
      }
    }
  }
  cells.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  spiral = Int32Array.from(cells.flat());
  spiralRadius = radius;
  return spiral;
}

/**
 * Tall economy: each built city integrates its owner's unintegrated land
 * around it, nearest first, so integration spreads outward from cities and
 * land close to one integrates fastest: every tile costs budget growing with
 * its distance (Config.cityIntegrationCost), and detached land costs
 * detachedIntegrationCost times that. Each city works in a burst every
 * cityIntegrationIntervalTicks (staggered by unit id) to keep scans cheap.
 */
export function integrateNearCities(game: Game, player: Player): void {
  const config = game.config();
  const interval = config.cityIntegrationIntervalTicks();
  const offsets = spiralOffsets(config.cityIntegrationMaxRadius());
  const smallID = player.smallID();
  const detachedCost = config.detachedIntegrationCost();
  const ticks = game.ticks();
  for (const city of player.units(UnitType.City)) {
    if (player.unintegratedTiles() === 0) return;
    if (city.isUnderConstruction()) continue;
    if ((ticks + city.id()) % interval !== 0) continue;
    const level = city.level();
    const r = config.cityIntegrationRadius(level);
    const r2 = r * r;
    let budget = config.cityIntegrationPerTick(level) * interval;
    const cx = game.x(city.tile());
    const cy = game.y(city.tile());
    for (let i = 0; i < offsets.length && budget > 0; i += 4) {
      if (offsets[i + 2] > r2) break;
      const x = cx + offsets[i];
      const y = cy + offsets[i + 1];
      if (!game.isValidCoord(x, y)) continue;
      const tile = game.ref(x, y);
      if (game.ownerID(tile) !== smallID || !game.isUnintegrated(tile)) {
        continue;
      }
      let cost = config.cityIntegrationCost(offsets[i + 3]);
      if (game.isDetached(tile)) cost *= detachedCost;
      // Costs grow outward, so the rest of the ring can wait for next burst.
      if (cost > budget) break;
      player.integrateTile(tile);
      budget -= cost;
    }
  }
}

/**
 * A city just built or upgraded integrates all of its owner's land within its
 * radius at once, detached land included: building a city is the quick way to
 * settle newly taken land.
 */
export function integrateAroundCity(game: Game, city: Unit): void {
  const player = city.owner();
  if (player.unintegratedTiles() === 0) return;
  const config = game.config();
  const offsets = spiralOffsets(config.cityIntegrationMaxRadius());
  const r = config.cityIntegrationRadius(city.level());
  const r2 = r * r;
  const smallID = player.smallID();
  const cx = game.x(city.tile());
  const cy = game.y(city.tile());
  for (let i = 0; i < offsets.length; i += 4) {
    if (offsets[i + 2] > r2) break;
    const x = cx + offsets[i];
    const y = cy + offsets[i + 1];
    if (!game.isValidCoord(x, y)) continue;
    const tile = game.ref(x, y);
    if (game.ownerID(tile) === smallID && game.isUnintegrated(tile)) {
      player.integrateTile(tile);
    }
  }
}
