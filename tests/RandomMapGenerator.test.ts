import { GameMapSize, GameMapType } from "../src/core/game/Game";
import { GameMapLoader } from "../src/core/game/GameMapLoader";
import {
  generateRandomMap,
  RANDOM_MAP_STYLES,
  RandomMapParams,
} from "../src/core/game/RandomMapGenerator";
import { loadTerrainMap } from "../src/core/game/TerrainMapLoader";

const params = (p: Partial<RandomMapParams> = {}): RandomMapParams => ({
  seed: 42,
  landPercent: 40,
  style: "continents",
  size: "small",
  mountains: 50,
  rivers: 50,
  ...p,
});

const landTiles = (bin: Uint8Array) => bin.filter((b) => b & 0x80).length;

describe("RandomMapGenerator", () => {
  it("is deterministic for the same params", { timeout: 30_000 }, () => {
    const a = generateRandomMap(params());
    const b = generateRandomMap(params());
    expect(a.mapBin).toEqual(b.mapBin);
    expect(a.map4xBin).toEqual(b.map4xBin);
    expect(a.manifest).toEqual(b.manifest);
  });

  it("changes with the seed", () => {
    const a = generateRandomMap(params({ seed: 1 }));
    const b = generateRandomMap(params({ seed: 2 }));
    expect(a.mapBin).not.toEqual(b.mapBin);
  });

  it.each(RANDOM_MAP_STYLES)("%s hits the land target", (style) => {
    for (const landPercent of [20, 60]) {
      const g = generateRandomMap(params({ style, landPercent }));
      const { width, height, num_land_tiles } = g.manifest.map;
      // Rivers, lakes and island cleanup shift it a little off target.
      const pct = (100 * num_land_tiles) / (width * height);
      expect(Math.abs(pct - landPercent)).toBeLessThan(2.5);
    }
  });

  it("writes consistent bins and manifest", () => {
    const g = generateRandomMap(params());
    for (const [meta, bin] of [
      [g.manifest.map, g.mapBin],
      [g.manifest.map4x, g.map4xBin],
      [g.manifest.map16x, g.map16xBin],
    ] as const) {
      expect(bin.length).toBe(meta.width * meta.height);
      expect(landTiles(bin)).toBe(meta.num_land_tiles);
    }
    expect(g.manifest.map4x.width).toBe(g.manifest.map.width / 2);
    expect(g.manifest.nations.length).toBe(10);
  });

  it("carves rivers and lakes when wet, none when dry", () => {
    // Shoreline land tiles grow with every river bank and lake shore.
    const shores = (rivers: number) =>
      generateRandomMap(params({ rivers })).mapBin.filter(
        (b) => (b & 0xc0) === 0xc0,
      ).length;
    const dry = shores(0);
    expect(shores(50)).toBeGreaterThan(dry * 1.3);
    expect(shores(100)).toBeGreaterThan(shores(50));
  });

  it("has mountains only when asked", () => {
    const peaks = (m: number) =>
      generateRandomMap(params({ mountains: m })).mapBin.filter(
        (b) => b & 0x80 && (b & 31) >= 20,
      ).length;
    expect(peaks(0)).toBe(0);
    expect(peaks(100)).toBeGreaterThan(peaks(30));
  });

  it("loads through loadTerrainMap without touching the file loader", async () => {
    const loader: GameMapLoader = {
      getMapData: () => {
        throw new Error("file loader should not be used");
      },
    };
    const p = params({ seed: 7 });
    const data = await loadTerrainMap(
      GameMapType.Generated,
      GameMapSize.Normal,
      loader,
      false,
      true,
      p,
    );
    expect(data.gameMap.width()).toBe(1400);
    expect(data.miniGameMap.width()).toBe(700);
    expect(data.gameMap.numLandTiles()).toBe(
      generateRandomMap(p).manifest.map.num_land_tiles,
    );
    expect(data.nations.length).toBe(10);
  });
});
