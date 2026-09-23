// Pixel sprites drawn with plain Views; "#" is a lit cell. Keeps the pixel look without an icon dependency.
export const GRID_SPRITE = [
  "#.#.#",
  ".....",
  "#.#.#",
  ".....",
  "#.#.#",
] as const;

export const SPARK_SPRITE = [
  "...#...",
  "...#..#",
  "..###..",
  "#######",
  "..###..",
  "#..#...",
  "...#...",
] as const;

export const SEND_SPRITE = [
  "#......",
  "###....",
  ".####..",
  "..#####",
  ".####..",
  "###....",
  "#......",
] as const;

export function spriteSize(rows: readonly string[]): { width: number; height: number } {
  const width = rows[0]?.length ?? 0;
  if (rows.some((row) => row.length !== width)) throw new Error("ragged sprite");
  return { width, height: rows.length };
}
