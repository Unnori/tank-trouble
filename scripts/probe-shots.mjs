// probe-shot-times.mjs — how long does a shot take to land?
//
// This decides whether a 2-second "I missed" verdict is honest or just early.
// Round setup mirrors scripts/arena.mjs (same corners(), same maze tiers, same
// verdict) so the numbers describe the real game; the only addition is a
// record per shot.
//
//   node scripts/probe-shots.mjs [rounds] [levelA] [levelB]

import { generateMaze } from "../src/maze.js";
import { Tank } from "../src/tank.js";
import { PowerupSpawner } from "../src/powerup.js";
import { castLaserPath } from "../src/laser.js";
import { AiController } from "../src/ai.js";
import {
  circleVsCircle, separateCircles, resolveCircleWalls, closestPointOnSegment,
} from "../src/collision.js";
import {
  CELL_SIZE, TANK, BULLET, POWERUP, MAZE_TIERS, TIER_POOL_BY_MODE, STYLE_POOL_BY_MODE,
} from "../src/config.js";

const ROUNDS = Number(process.argv[2] || 80);
const LEVEL_A = process.argv[3] || "normal";
const LEVEL_B = process.argv[4] || "normal";
const dt = 1 / 60;
const TIMEOUT = 120 * 60;

function corners(cols, rows) {
  const half = CELL_SIZE / 2;
  return {
    tl: { x: half, y: half, a: 0 },
    tr: { x: (cols - 1) * CELL_SIZE + half, y: half, a: Math.PI },
    bl: { x: half, y: (rows - 1) * CELL_SIZE + half, a: 0 },
    br: { x: (cols - 1) * CELL_SIZE + half, y: (rows - 1) * CELL_SIZE + half, a: Math.PI },
  };
}

const mkActor = (side, spot) => ({
  side,
  tank: new Tank(spot.x, spot.y, spot.a, side === "A" ? "#e05a5a" : "#5a8de0"),
  // Derived from the tank, exactly as arena.mjs does — a separate boolean goes
  // stale the moment kill() touches the tank, and the round then never ends.
  get alive() { return this.tank.alive; },
  ctrl: null,
});

function playRound() {
  const pool = TIER_POOL_BY_MODE.pve;
  const tier = pool[Math.floor(Math.random() * pool.length)];
  const { cols, rows } = MAZE_TIERS[tier];
  const styles = STYLE_POOL_BY_MODE.pve;
  const style = styles[Math.floor(Math.random() * styles.length)];
  const maze = generateMaze(cols, rows, style);
  const c = corners(cols, rows);

  const actors = [mkActor("A", c.tl), mkActor("B", c.br)];
  actors[0].ctrl = new AiController(actors[0], LEVEL_A);
  actors[1].ctrl = new AiController(actors[1], LEVEL_B);

  let bullets = [];
  let powerups = [];
  let mines = [];
  const spawner = new PowerupSpawner(POWERUP.types);

  let shotSeq = 0;
  const shots = [];
  const pending = new Map();

  const kill = (tank) => {
    if (tank.shield) {
      tank.shield = false;
      tank.shieldTimer = 0;
      return false;
    }
    tank.alive = false;
    return true;
  };

  const fireLaser = (origin, shooter) => {
    const pts = castLaserPath(origin.x, origin.y, origin.angle, maze.walls);
    for (let i = 0; i < pts.length - 1; i++) {
      let hit = null;
      const a = pts[i], b = pts[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      for (const p of actors) {
        if (!p.alive) continue;
        if (i === 0 && shooter && p === shooter) continue;
        const cp = closestPointOnSegment(p.tank.x, p.tank.y, a.x, a.y, b.x, b.y);
        if (Math.hypot(p.tank.x - cp.x, p.tank.y - cp.y) > TANK.radius) continue;
        const t = Math.hypot(cp.x - a.x, cp.y - a.y) / segLen;
        if (!hit || t < hit.t) hit = { p, t };
      }
      if (hit) { kill(hit.p.tank); return; }
    }
  };

  let frame = 0;
  for (; frame < TIMEOUT; frame++) {
    const world = { maze, players: actors, bullets, powerups, mines };
    const controls = actors.map((p) => p.ctrl.update(dt, world));

    for (let i = 0; i < actors.length; i++) {
      actors[i].tank.update(dt, maze.walls, controls[i]);
    }

    const aliveTanks = actors.filter((p) => p.alive).map((p) => p.tank);
    for (let i = 0; i < aliveTanks.length; i++) {
      for (let j = i + 1; j < aliveTanks.length; j++) {
        const a = aliveTanks[i], b = aliveTanks[j];
        const sep = separateCircles(a.x, a.y, b.x, b.y, TANK.radius * 2);
        if (!sep) continue;
        a.x = sep.ax; a.y = sep.ay;
        b.x = sep.bx; b.y = sep.by;
        const fa = resolveCircleWalls(a.x, a.y, TANK.radius, maze.walls);
        a.x = fa.x; a.y = fa.y;
        const fb = resolveCircleWalls(b.x, b.y, TANK.radius, maze.walls);
        b.x = fb.x; b.y = fb.y;
      }
    }

    spawner.update(dt, maze, powerups, aliveTanks, mines);
    for (const p of actors) {
      if (!p.alive) continue;
      for (const pw of powerups) {
        if (pw.taken) continue;
        if (circleVsCircle(p.tank.x, p.tank.y, TANK.radius, pw.x, pw.y, POWERUP.radius)) {
          p.tank.applyPowerup(pw.type);
          pw.taken = true;
          break;
        }
      }
    }
    powerups = powerups.filter((pw) => !pw.taken);

    for (const m of mines) m.update(dt);
    for (const m of mines) {
      if (m.exploded || !m.armed) continue;
      const tripped = actors.some(
        (p) => p.alive && Math.hypot(p.tank.x - m.x, p.tank.y - m.y) < POWERUP.mine.triggerRadius
      );
      if (!tripped) continue;
      m.exploded = true;
      for (const p of actors) {
        if (!p.alive) continue;
        if (Math.hypot(p.tank.x - m.x, p.tank.y - m.y) < POWERUP.mine.blastRadius) kill(p.tank);
      }
    }
    mines = mines.filter((m) => !m.exploded);

    for (let i = 0; i < actors.length; i++) {
      if (!actors[i].alive) continue;
      const res = actors[i].tank.tryFire(bullets, controls[i].fire, maze.walls);
      for (const b of res.bullets) {
        const rec = { seq: shotSeq++, shooter: actors[i], spawnFrame: frame, kind: "bullet" };
        shots.push(rec);
        pending.set(b, rec);
        bullets.push(b);
      }
      if (res.laser) {
        shots.push({ seq: shotSeq++, shooter: actors[i], spawnFrame: frame, kind: "laser" });
        fireLaser(res.laser, actors[i]);
      }
      const mine = actors[i].tank.tryDeploy(controls[i].special, maze.walls);
      if (mine) mines.push(mine);
    }

    for (const b of bullets) b.update(dt, maze.walls, true);
    const crumbled = maze.walls.filter((w) => !w.border && w.hp <= 0);
    if (crumbled.length) maze.walls = maze.walls.filter((w) => w.hp > 0);

    for (const b of bullets) {
      if (b.dead) continue;
      for (const p of actors) {
        if (!p.alive) continue;
        if (!b.canHit(p.tank)) continue;
        if (circleVsCircle(b.x, b.y, BULLET.radius, p.tank.x, p.tank.y, TANK.radius)) {
          b.dead = true;
          const rec = pending.get(b);
          if (rec) {
            rec.hitFrame = frame;
            rec.flightFrames = frame - rec.spawnFrame;
            rec.hitSelf = p === rec.shooter;
          }
          kill(p.tank);
          break;
        }
      }
    }

    for (const b of bullets) {
      if (!b.dead) continue;
      const rec = pending.get(b);
      if (rec && rec.hitFrame === undefined) {
        rec.missFrame = frame;
        rec.flightFrames = frame - rec.spawnFrame;
        rec.bounces = b.bounces;
      }
      pending.delete(b);
    }
    bullets = bullets.filter((b) => !b.dead);

    if (actors.filter((p) => p.alive).length <= 1) break;
  }

  return { shots, frames: frame };
}

console.log(`running ${ROUNDS} 1v1 rounds (${LEVEL_A} vs ${LEVEL_B})...\n`);

const allShots = [];
let roundCount = 0;
let totalFrames = 0;

for (let i = 0; i < ROUNDS; i++) {
  const { shots, frames } = playRound();
  allShots.push(...shots);
  roundCount++;
  totalFrames += frames;
}

const fired = allShots.filter((s) => s.kind === "bullet");
const hits = fired.filter((s) => s.hitFrame !== undefined);
const misses = fired.filter((s) => s.missFrame !== undefined);

console.log("=== totals ===");
console.log(`rounds          ${roundCount}`);
console.log(`avg round       ${(totalFrames / roundCount / 60).toFixed(1)}s`);
console.log(`shots           ${fired.length} (${(fired.length / roundCount).toFixed(1)} per round)`);
console.log(`hits            ${hits.length} (${(hits.length / fired.length * 100).toFixed(1)}%)`);
console.log(`misses          ${misses.length} (${(misses.length / fired.length * 100).toFixed(1)}%)`);

console.log("\n=== flight time of a HIT ===");
const flightSecs = hits.map((s) => s.flightFrames / 60).sort((a, b) => a - b);
if (flightSecs.length) {
  const q = (p) => flightSecs[Math.min(flightSecs.length - 1, Math.floor(flightSecs.length * p))];
  console.log(`  fastest   ${flightSecs[0].toFixed(2)}s`);
  console.log(`  median    ${q(0.5).toFixed(2)}s`);
  console.log(`  p90       ${q(0.9).toFixed(2)}s`);
  console.log(`  p95       ${q(0.95).toFixed(2)}s`);
  console.log(`  slowest   ${flightSecs[flightSecs.length - 1].toFixed(2)}s`);
  for (const w of [1, 2, 3, 5]) {
    const within = flightSecs.filter((s) => s <= w).length;
    console.log(`  <=${w}s: ${(within / flightSecs.length * 100).toFixed(1)}%  (missed ${flightSecs.length - within})`);
  }
}

console.log("\n=== how long a MISSED bullet lives ===");
const missSecs = misses.map((s) => s.flightFrames / 60).sort((a, b) => a - b);
if (missSecs.length) {
  const q = (p) => missSecs[Math.min(missSecs.length - 1, Math.floor(missSecs.length * p))];
  console.log(`  median    ${q(0.5).toFixed(2)}s`);
  console.log(`  p90       ${q(0.9).toFixed(2)}s`);
  const bounced = misses.filter((s) => (s.bounces ?? 0) > 0).length;
  console.log(`  bounced   ${bounced} (${(bounced / misses.length * 100).toFixed(1)}%)`);
}

console.log("\n=== verdict ===");
if (flightSecs.length) {
  for (const w of [2, 3]) {
    const leak = flightSecs.filter((s) => s > w).length;
    console.log(
      `${w}s window misses ${leak} shots (${(leak / flightSecs.length * 100).toFixed(2)}% of hits)` +
      (leak ? " -> needs the late-hit hook" : " -> practically never leaks")
    );
  }
}