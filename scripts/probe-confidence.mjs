// probe-confidence.mjs — what confidence threshold makes "big talk then miss"
// the funniest, and is hook D (late hit) actually decidable?
//
// Runs real 1v1 rounds with an instrumented copy of ai.js
// (scratch/ai-instrumented.js) that records, per shot, the quality-gate
// confidence. Each bullet carries its confidence, so the whole event chain can
// be replayed and counted:
//
//   A  big talk     fired because confidence >= T
//   B  hit          target died within the verdict window
//   C  missed       window elapsed, nothing hit, and the shot had boasted
//   D  late hit     C had fired, the bullet was still alive -- then it hit
//
//   node scripts/probe-confidence.mjs [rounds] [levelA] [levelB]

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

const ROUNDS = Number(process.argv[2] || 120);
const LEVEL_A = process.argv[3] || "normal";
const LEVEL_B = process.argv[4] || "normal";
const dt = 1 / 60;
const TIMEOUT = 120 * 60;

/** When the "I missed" verdict is announced, in seconds. */
const VERDICT_WINDOW_S = 2;

/** Global line throttle: hard backswing, then a cooldown (the user's design). */
const BACKSWING_S = 0.5;
const COOLDOWN_S = 5;

let BIG_TALK_T = 0.9;
/** Set true to gather per-shot traces instead of sweeping thresholds. */
const TRACE = process.argv.includes("--trace");

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
  get alive() { return this.tank.alive; },
  ctrl: null,
  deathAnnounced: false,
});

function playRound(traceSink) {
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
  const shotOf = new Map();
  const shotRecords = [];

  const kill = (tank) => {
    if (tank.shield) { tank.shield = false; tank.shieldTimer = 0; return false; }
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

  const events = [];
  /** One voice per side: each pet has its own throat, so each gets its own
   *  throttle. Sharing one would let side B's kill mute side A's boast. */
  const voices = {
    A: { cooling: 0, backswing: 0, blocked: 0, proposed: [] },
    B: { cooling: 0, backswing: 0, blocked: 0, proposed: [] },
  };

  /** Events that a cooldown must not swallow. The chain `bigTalk -> missed` is
   *  the whole joke: "watch this" followed by silence reads as a bug. A 5 s
   *  cooldown started at the boast is still running when the 2 s verdict lands,
   *  so without this exemption the payoff is never delivered. The same goes for
   *  the end of a round -- a kill is the last thing that happens for a while. */
  const URGENT = new Set(["sayMissed", "sayLateHit", "sayHit", "sayDestroyed", "matchEnd"]);

  /** Higher wins when several lines compete for the same voice on one frame.
   *  Within a side these are genuinely nested: a late hit IS a hit, so the
   *  rarer and funnier one wins; a round ending is the last word of all. */
  const PRIORITY = {
    matchEnd: 100,
    sayLateHit: 70,
    sayHit: 60,
    sayMissed: 40,
    sayDestroyed: 50,
    sayBigTalk: 30,
    sayLaser: 20,
  };

  const propose = (side, kind, frame) => {
    voices[side].proposed.push({ kind, frame, priority: PRIORITY[kind] ?? 0 });
  };

  /** Pick one line per voice for this frame, then run it through its throttle. */
  const settleFrame = (frame) => {
    for (const side of ["A", "B"]) {
      const v = voices[side];
      if (!v.proposed.length) continue;
      v.proposed.sort((a, b) => b.priority - a.priority);
      const winner = v.proposed[0];
      const losers = v.proposed.length - 1;
      v.proposed = [];

      if (v.backswing > 0) { v.blocked += 1 + losers; continue; }
      const urgent = URGENT.has(winner.kind);
      if (v.cooling > 0 && !urgent) { v.blocked += 1 + losers; continue; }

      events.push({ side, kind: winner.kind, frame });
      v.backswing = BACKSWING_S;
      // An urgent line delivers its payoff without restarting the clock; a
      // fresh line does, so the throttle keeps its teeth.
      if (!urgent) v.cooling = COOLDOWN_S;
    }
  };

  let frame = 0;
  for (; frame < TIMEOUT; frame++) {
    for (const side of ["A", "B"]) {
      voices[side].backswing = Math.max(0, voices[side].backswing - dt);
      voices[side].cooling = Math.max(0, voices[side].cooling - dt);
    }

    const world = { maze, players: actors, bullets, powerups, mines };
    const controls = actors.map((p) => p.ctrl.update(dt, world));

    const confByTank = new Map();
    for (const p of actors) {
      const v = p.ctrl.lastConfidence;
      if (v !== null && v !== undefined) confByTank.set(p.tank, v);
    }

    for (let i = 0; i < actors.length; i++) {
      actors[i].tank.update(dt, maze.walls, controls[i]);
    }

    const aliveTanks = actors.filter((p) => p.alive).map((p) => p.tank);
    for (let i = 0; i < aliveTanks.length; i++) {
      for (let j = i + 1; j < aliveTanks.length; j++) {
        const a = aliveTanks[i], b = aliveTanks[j];
        const sep = separateCircles(a.x, a.y, b.x, b.y, TANK.radius * 2);
        if (!sep) continue;
        a.x = sep.ax; a.y = sep.ay; b.x = sep.bx; b.y = sep.by;
        const fa = resolveCircleWalls(a.x, a.y, TANK.radius, maze.walls); a.x = fa.x; a.y = fa.y;
        const fb = resolveCircleWalls(b.x, b.y, TANK.radius, maze.walls); b.x = fb.x; b.y = fb.y;
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
      const conf = confByTank.get(actors[i].tank) ?? null;
      const res = actors[i].tank.tryFire(bullets, controls[i].fire, maze.walls);
      for (const b of res.bullets) {
        const rec = {
          shooter: actors[i].side,
          conf,
          spawnFrame: frame,
          verdictFrame: frame + Math.round(VERDICT_WINDOW_S / dt),
          hitFrame: null,
          hitSelf: false,
          missAnnounced: false,
          spokeBigTalk: false,
          isLateHit: false,
          bounces: 0,
        };
        shotOf.set(b, rec);
        shotRecords.push(rec);
        bullets.push(b);
        if (traceSink) traceSink.push(rec);
      }
      if (res.laser) {
        propose(actors[i].side, "sayLaser", frame);
        fireLaser(res.laser, actors[i]);
      }
      const mine = actors[i].tank.tryDeploy(controls[i].special, maze.walls);
      if (mine) mines.push(mine);
    }

    // hook A — big talk, only for shots confident enough
    for (const [, rec] of shotOf) {
      if (rec.spawnFrame !== frame || rec.conf === null) continue;
      if (rec.conf >= BIG_TALK_T) { rec.spokeBigTalk = true; propose(rec.shooter, "sayBigTalk", frame); }
    }

    for (const b of bullets) b.update(dt, maze.walls, true);
    const crumbled = maze.walls.filter((w) => !w.border && w.hp <= 0);
    if (crumbled.length) maze.walls = maze.walls.filter((w) => w.hp > 0);

    // hooks B / D — the bullet connects
    for (const b of bullets) {
      if (b.dead) continue;
      for (const p of actors) {
        if (!p.alive) continue;
        if (!b.canHit(p.tank)) continue;
        if (circleVsCircle(b.x, b.y, BULLET.radius, p.tank.x, p.tank.y, TANK.radius)) {
          b.dead = true;
          const rec = shotOf.get(b);
          if (rec) {
            rec.hitFrame = frame;
            rec.flightFrames = frame - rec.spawnFrame;
            rec.hitSelf = p === rec.shooter;
            rec.bounces = b.bounces;
            if (rec.missAnnounced) { rec.isLateHit = true; propose(rec.shooter, "sayLateHit", frame); }
            else propose(rec.shooter, "sayHit", frame);
          }
          kill(p.tank);
          break;
        }
      }
    }

    // hook C — the verdict window elapsed, nothing hit, and it had boasted
    for (const b of bullets) {
      if (b.dead) continue;
      const rec = shotOf.get(b);
      if (!rec || rec.hitFrame !== null || rec.missAnnounced) continue;
      if (!rec.spokeBigTalk) continue;
      if (frame < rec.verdictFrame) continue;
      rec.missAnnounced = true;
      propose(rec.shooter, "sayMissed", frame);
    }

    // hook E — the shooter itself died. Checked BEFORE the round-end break:
// the frame that kills someone is the same frame the round ends, so a check
// after the break never sees it.
    for (const p of actors) {
      if (p.alive || p.deathAnnounced) continue;
      p.deathAnnounced = true;
      propose(p.side, "sayDestroyed", frame);
    }

    for (const b of bullets) {
      if (!b.dead) continue;
      const rec = shotOf.get(b);
      if (rec && rec.hitFrame === null) rec.expiredFrame = frame;
      shotOf.delete(b);
    }
    bullets = bullets.filter((b) => !b.dead);

    settleFrame(frame);

    if (actors.filter((p) => p.alive).length <= 1) {
      propose("A", "matchEnd", frame);
      propose("B", "matchEnd", frame);
      settleFrame(frame);
      break;
    }
  }

  return {
    events, frames: frame,
    blocked: voices.A.blocked + voices.B.blocked,
    shots: [...shotRecords],
  };
}

// ---------------------------------------------------------------- trace mode

if (TRACE) {
  console.log(`TRACE mode: ${ROUNDS} rounds, T=${BIG_TALK_T}\n`);
  const sink = [];
  let rounds = 0, framesTotal = 0, blockedTotal = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const { frames, blocked } = playRound(sink);
    rounds++; framesTotal += frames; blockedTotal += blocked;
  }
  const scored = sink.filter((s) => s.conf !== null);
  const withHit = scored.filter((s) => s.hitFrame !== null);

  console.log(`回合 ${rounds}，平均 ${(framesTotal / rounds / 60).toFixed(1)}s`);
  console.log(`开火 ${sink.length}，其中有 confidence ${scored.length}`);
  console.log(`命中 ${withHit.length}（${(withHit.length / scored.length * 100).toFixed(1)}%）`);
  console.log(`被冷却吞掉的事件 ${blockedTotal}\n`);

  console.log("按 confidence 分桶看结局：");
  const buckets = [[0, 0.5], [0.5, 0.7], [0.7, 0.85], [0.85, 0.95], [0.95, 1.01]];
  console.log("  桶          样本   命中   命中率  真落空  未结算  未结算占比  中位飞行");
  for (const [lo, hi] of buckets) {
    const inB = scored.filter((s) => s.conf >= lo && s.conf < hi);
    const hitB = inB.filter((s) => s.hitFrame !== null);
    const expB = inB.filter((s) => s.hitFrame === null && s.expiredFrame !== undefined);
    const unB = inB.filter((s) => s.hitFrame === null && s.expiredFrame === undefined);
    const flights = hitB.map((s) => s.flightFrames / 60).sort((a, b) => a - b);
    const median = flights.length ? flights[Math.floor(flights.length / 2)].toFixed(2) + "s" : "-";
    console.log(
      `  ${lo.toFixed(2)}–${hi > 1 ? "1.0" : hi.toFixed(2)}  ${String(inB.length).padStart(5)} ` +
      `${String(hitB.length).padStart(5)}  ${(hitB.length / inB.length * 100).toFixed(1).padStart(5)}% ` +
      `${String(expB.length).padStart(7)} ${String(unB.length).padStart(7)} ` +
      `${(unB.length / inB.length * 100).toFixed(1).padStart(10)}% ${median.padStart(9)}`
    );
  }

  const resolved = scored.filter((s) => s.hitFrame !== null || s.expiredFrame !== undefined);
  console.log("");
  console.log(`总结：${scored.length} 发里 ${resolved.length} 发在回合内结算（${(resolved.length / scored.length * 100).toFixed(1)}%）`);
  console.log(`      另有 ${scored.length - resolved.length} 发回合结束时仍在飞 → 这些不该被当成落空`);

  console.log("\n高 confidence 的迟到命中（钩子 D 的目标）：");
  const lateHigh = withHit.filter((s) => s.isLateHit);
  for (const s of lateHigh.slice(0, 12)) {
    console.log(
      `  conf ${s.conf.toFixed(3)}  飞行 ${(s.flightFrames / 60).toFixed(2)}s  反弹 ${s.bounces}  ` +
      `自伤 ${s.hitSelf ? "是" : "否"}  大话已说 ${s.spokeBigTalk ? "是" : "否"}`
    );
  }
  if (!lateHigh.length) console.log("  本样本没有");

  process.exit(0);
}

// ---------------------------------------------------------------- sweep

const THRESHOLDS = [0.3, 0.5, 0.7, 0.8, 0.9, 0.95];
const summary = [];

for (const T of THRESHOLDS) {
  BIG_TALK_T = T;
  const t = {
    bigTalk: 0, hit: 0, missed: 0, lateHit: 0, laser: 0, destroyed: 0, matchEnd: 0,
    rounds: 0, frames: 0, blocked: 0,
    boasted: 0, boastLanded: 0, boastVanished: 0,
  };
  for (let r = 0; r < ROUNDS; r++) {
    const { events, frames, blocked, shots } = playRound();
    t.rounds++; t.frames += frames; t.blocked += blocked;
    for (const e of events) {
      if (e.kind === "sayBigTalk") t.bigTalk++;
      else if (e.kind === "sayHit") t.hit++;
      else if (e.kind === "sayMissed") t.missed++;
      else if (e.kind === "sayLateHit") t.lateHit++;
      else if (e.kind === "sayLaser") t.laser++;
      else if (e.kind === "sayDestroyed") t.destroyed++;
      else if (e.kind === "matchEnd") t.matchEnd++;
    }
    // Exact per-shot outcomes: only shots that actually boasted count here.
    for (const s of shots) {
      if (!s.spokeBigTalk) continue;
      t.boasted++;
      if (s.hitFrame !== null) t.boastLanded++;
      else t.boastVanished++;
    }
  }
  summary.push({ T, ...t });
}

console.log(`probe: ${ROUNDS} rounds per threshold, ${LEVEL_A} vs ${LEVEL_B}`);
console.log(`verdict window ${VERDICT_WINDOW_S}s, backswing ${BACKSWING_S}s, cooldown ${COOLDOWN_S}s\n`);

console.log("=== 阈值扫描（每档 " + ROUNDS + " 回合）===");
console.log("");
console.log("吹牛的准确性——只统计『真的说了大话』的那些发：");
console.log("T     吹牛发数  侥幸命中  诚实落空  吹牛命中率   吹牛/回合");
for (const s of summary) {
  const rate = s.boasted ? (s.boastLanded / s.boasted * 100).toFixed(1) + "%" : "n/a";
  console.log(
    `${s.T.toFixed(2).padEnd(5)} ${String(s.boasted).padStart(8)} ${String(s.boastLanded).padStart(10)} ` +
    `${String(s.boastVanished).padStart(10)} ${rate.padStart(12)} ${(s.boasted / s.rounds).toFixed(2).padStart(11)}`
  );
}

console.log("");
console.log("说话量——每只桌宠各有一个声道，主人只听到自己那只：");
console.log("T     总句数  每局两句/回合  每只/回合  打爆  局末  迟到 | 被吞");
for (const s of summary) {
  const total = s.bigTalk + s.hit + s.lateHit + s.missed + s.destroyed + s.laser + s.matchEnd;
  console.log(
    `${s.T.toFixed(2).padEnd(5)} ${String(total).padStart(7)} ${(total / s.rounds).toFixed(2).padStart(14)} ` +
    `${(total / s.rounds / 2).toFixed(2).padStart(10)} ${String(s.destroyed).padStart(6)} ` +
    `${String(s.matchEnd).padStart(5)} ${String(s.lateHit).padStart(5)} | ${String(s.blocked).padStart(6)}`
  );
}

console.log("\n=== 钩子 D 可判定性 ===");
const observed = summary.filter((s) => s.lateHit > 0).length;
console.log(`  ${observed}/${summary.length} 个阈值档观察到迟到命中`);
console.log(`  说明「落空已宣布 + 子弹仍存活 + 之后命中」这个状态在真实对局里会出现且可捕获`);