/**
 * LED dot-matrix artwork for the Taiwan-style pedestrian signal:
 * top panel = red standing man (don't walk), bottom panel = animated green walker.
 */

const WALK_A = [
  '.....##.....',
  '.....##.....',
  '............',
  '....###.....',
  '...#####....',
  '..#.####....',
  '.#..###.#...',
  '....###..#..',
  '....####....',
  '....#..#....',
  '...#....#...',
  '...#.....#..',
  '..#......#..',
  '..#.......#.',
  '.#........#.',
  '##.........#',
];

const WALK_B = [
  '.....##.....',
  '.....##.....',
  '............',
  '....###.....',
  '....####....',
  '...#.###....',
  '...#.###....',
  '....####....',
  '....###.....',
  '....#.#.....',
  '....#..#....',
  '....#..#....',
  '...#...#....',
  '...#...#....',
  '...#....#...',
  '..##....##..',
];

const STAND = [
  '.....##.....',
  '.....##.....',
  '............',
  '....####....',
  '...######...',
  '...######...',
  '...#.##.#...',
  '...#.##.#...',
  '...#.##.#...',
  '.....##.....',
  '....#..#....',
  '....#..#....',
  '....#..#....',
  '....#..#....',
  '....#..#....',
  '...##..##...',
];

const BG = '#0b0b0c';

function dots(g: CanvasRenderingContext2D, rows: string[], ox: number, oy: number, cell: number, color: string): void {
  g.fillStyle = color;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] !== '#') continue;
      g.beginPath();
      g.arc(ox + (c + 0.5) * cell, oy + (r + 0.5) * cell, cell * 0.38, 0, Math.PI * 2);
      g.fill();
    }
  }
}

function figure(g: CanvasRenderingContext2D, n: number, rows: string[], color: string): void {
  g.fillStyle = BG;
  g.fillRect(0, 0, n, n);
  const cell = n / 18;
  dots(g, rows, (n - 12 * cell) / 2, (n - 16 * cell) / 2, cell, color);
}

/** Top panel: red standing man while don't-walk, dark while walking. */
export function drawTop(g: CanvasRenderingContext2D, n: number, walk: boolean): void {
  if (walk) {
    g.fillStyle = BG;
    g.fillRect(0, 0, n, n);
    return;
  }
  figure(g, n, STAND, '#ff3a2a');
}

/** Bottom panel: green walking man (frame 0 / 1) while green, dark otherwise. */
export function drawBottom(g: CanvasRenderingContext2D, n: number, walk: boolean, frame: number): void {
  if (!walk) {
    g.fillStyle = BG;
    g.fillRect(0, 0, n, n);
    return;
  }
  figure(g, n, frame % 2 === 0 ? WALK_A : WALK_B, '#2dffb0');
}
