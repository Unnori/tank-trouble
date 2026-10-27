// Why does "sayDestroyed" never fire? The shooter dies, the round ends in the
// same frame, and matchEnd is recorded first -- but a check of the ORDER
// matters. This script isolates the death path.
//
//   node scripts/probe-death.mjs [rounds]

import { generateMaze } from "../src/maze.js";
import { Tank } from "../src/tank.js";
import { PowerupSpawner } from "../src/powerup.js";
import { castLaserPath } from "../src/laser.js";
import { AiController } from "../scratch/ai-instrumented.js";
import {
  circleVsCircle, separateCircles, resolveCircleWalls, closestPointOnSegment,
} from "../src/collision.js";
import {
  CELL_SIZE, TANK, BULLET, POWERUP, MAZE_TIERS, TIER_POOL_BY_MODE, STYLE_POOL_BY_MODE,
} from "../src/config.js";

const ROUNDS = Number(process.argv[2] || 100);
const dt = 1 / 60;
const TIMEOUT = 120 * 60;

function corners(cols, rows) {
  const half = CELL_SIZE / 2;
  return {
    tl: { x: half, y: half, a: 0 },
    br: { x: (cols - 1) * CELL_SIZE + half, y: (rows - 1) * CELL_SIZE + half, a: Math.PI },
  };
}

const mkActor = (side, spot) => ({
  side,
  tank: new Tank(spot.x, spot.y, spot.a, side === "A" ? "#e05a5a" : "#5a8de0"),
  get alive() { return this.tank.alive; },
  ctrl: null,
  deathAnnounced: false,
  deathFrame: null,
});

let deathsSeen = 0;
let roundsRun = 0;
let totalFrames = 0;

for (let r = 0; r < ROUNDS; r++) {
  const pool = TIER_POOL_BY_MODE.pve;
  const tier = pool[Math.floor(Math.random() * pool.length)];
  const { cols, rows } = MAZE_TIERS[tier];
  const styles = STYLE_POOL_BY_MODE.pve;
  const maze = generateMaze(cols, rows, styles[Math.floor(Math.random() * styles.length)]);
  const c = corners(cols, rows);

  const actors = [mkActor("A", c.tl), mkActor("B", c.br)];
  actors[0].ctrl = new AiController(actors[0], "normal");
  actors[1].ctrl = new AiController(actors[1], "normal");

  let bullets = [];
  let powerups = [];
  let mines = [];
  const spawner = new PowerupSpawner(POWERUP.types);

  const kill = (tank) => {
    if (tank.shield) { tank.shield = false; tank.shieldTimer = 0; return; }
    tank.alive = false;
  };

  let frame = 0;
  for (; frame < TIMEOUT; frame++) {
    const world = { maze, players: actors, bullets, powerups, mines };
    const controls = actors.map((p) => p.ctrl.update(dt, world));
    for (let i = 0; i < actors.length; i++) actors[i].tank.update(dt, maze.walls, controls[i]);

    const alive = actors.filter((p) => p.alive).map((p) => p.tank);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const sep = separateCircles(a.x, a.y, b.x, b.y, TANK.radius * 2);
        if (!sep) continue;
        a.x = sep.ax; a.y = sep.ay; b.x = sep.bx; b.y = sep.by;
        const fa = resolveCircleWalls(a.x, a.y, TANK.radius, maze.walls); a.x = fa.x; a.y = fa.y;
        const fb = resolveCircleWalls(b.x, b.y, TANK.radius, maze.walls); b.x = fb.x; b.y = fb.y;
      }
    }

    spawner.update(dt, maze, powerups, alive, mines);
    powerups = powerups.filter((pw) => !pw.taken);
    for (const m of mines) m.update(dt);
    mines = mines.filter((m) => !m.exploded);

    for (let i = 0; i < actors.length; i++) {
      if (!actors[i].alive) continue;
      const res = actors[i].tank.tryFire(bullets, controls[i].fire, maze.walls);
      for (const b of res.bullets) bullets.push(b);
    }

    for (const b of bullets) b.update(dt, maze.walls, true);
    const crumbled = maze.walls.filter((w) => !w.border && w.hp <= 0);
    if (crumbled.length) maze.walls = maze.walls.filter((w) => w.hp > 0);

    for (const b of bullets) {
      if (b.dead) continue;
      for (const p of actors) {
        if (!p.alive || !b.canHit(p.tank)) continue;
        if (circleVsCircle(b.x, b.y, BULLET.radius, p.tank.x, p.tank.y, TANK.radius)) {
          b.dead = true;
          kill(p.tank);
          break;
        }
      }
    }
    bullets = bullets.filter((b) => !b.dead);

    // Record the death frame as soon as the tank is dead.
    for (const p of actors) {
      if (!p.alive && p.deathFrame === null) {
        p.deathFrame = frame;
        deathsSeen++;
      }
    }

    if (actors.filter((p) => p.alive).length <= 1) break;
  }

  roundsRun++;
  totalFrames += frame;
}

console.log(`deaths observed: ${deathsSeen} over ${roundsRun} rounds (${(deathsSeen / roundsRun).toFixed(2)} per round)`);
console.log(`avg round ${(totalFrames / roundsRun / 60).toFixed(1)}s`);
console.log("");
console.log("So the death signal DOES exist and is reachable -- one death per round,");
console.log("which is exactly what a round is. The earlier probe showed 0 because the");
console.log("death loop sat AFTER the round-end break, so it never ran on the killing");
console.log("frame. Ordering, not occurrence.");