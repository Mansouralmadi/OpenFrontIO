/**
 * Antimatter bomb blast radii, scaled with the map: outer = 0.18 *
 * sqrt(width * height) (World 2000x1000 -> 255, enough to cover Africa,
 * ~400x450 tiles, from its middle), floored at 150 so it always out-ranges
 * the hydrogen bomb (outer 100); inner = 80% of outer like the hydrogen bomb.
 * Standalone (no imports) so the renderer can share it.
 */
export function antimatterBombMagnitude(
  width: number,
  height: number,
): { inner: number; outer: number } {
  const outer = Math.max(150, Math.round(0.18 * Math.sqrt(width * height)));
  return { inner: Math.round(outer * 0.8), outer };
}
