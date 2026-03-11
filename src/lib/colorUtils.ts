/**
 * Lift (brighten) an RGB color towards white by a factor (0–1).
 * liftColor([100, 0, 50], 0.5) → [178, 128, 153]
 */
export function liftColor(
  color: [number, number, number],
  factor: number,
): [number, number, number] {
  return [
    Math.round(color[0] + (255 - color[0]) * factor),
    Math.round(color[1] + (255 - color[1]) * factor),
    Math.round(color[2] + (255 - color[2]) * factor),
  ];
}
