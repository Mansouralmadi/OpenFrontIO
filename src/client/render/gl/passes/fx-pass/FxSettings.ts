/**
 * Pure (no WebGL) helpers that turn the `settings.fx` slice into per-spawn
 * FX parameters. Kept out of the passes so they can be unit-tested.
 */

import {
  UT_ANTIMATTER_BOMB,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV_WARHEAD,
} from "../../../types";
import type { RenderSettings } from "../../RenderSettings";

/**
 * Visual explosion radius (shockwave / debris scatter — not the gameplay
 * damage radius) for a detonating unit type, or undefined for non-nukes.
 */
export function nukeExplosionRadius(
  fx: RenderSettings["fx"],
  unitType: string,
): number | undefined {
  switch (unitType) {
    case UT_ATOM_BOMB:
      return fx.nukeRadiusAtom;
    case UT_HYDROGEN_BOMB:
      return fx.nukeRadiusHydro;
    case UT_ANTIMATTER_BOMB:
      // Blast is ~2.5x the hydrogen bomb's on World (outer 255 vs 100).
      return fx.nukeRadiusHydro * 2.5;
    case UT_MIRV_WARHEAD:
      return fx.nukeRadiusMirv;
    default:
      return undefined;
  }
}
