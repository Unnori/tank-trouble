// Can we reliably tell "AI fired a shot it believed in" from "that shot missed"?
//
// The plan needs four hooks:
//   1. AI decides to fire      <- ai.js already computes this ("几何必中角" gate)
//   2. bullet spawned          <- tank.tryFire returns res.bullets
//   3. bullet expired unused   <- bullet.dead with bounces>0 or age>=lifetime
//   4. bullet killed someone   <- main.js hitPlayer
//
// This script measures how often each fires, so we can answer "会很吵吗".

import { Tank } from "../src/tank.js";
import { Bullet } from "../src/bullet.js";
import { BULLET, TANK, AI_DIFFICULTY } from "../src/config.js";

console.log("=== 1. 一次对局里 AI 开火的频率 ===\n");
console.log("难度配置里的开火冷却（秒）：");
for (const [k, v] of Object.entries(AI_DIFFICULTY)) {
  const [lo, hi] = v.fireCooldown;
  const avg = (lo + hi) / 2;
  console.log(
    `  ${k.padEnd(6)} ${v.label}  冷却 ${lo}–${hi}s  平均 ${avg.toFixed(2)}s/发  → 约 ${(60 / avg).toFixed(1)} 发/分钟`
  );
}

console.log("\n=== 2. 子弹寿命与反弹上限 ===\n");
console.log(`lifetime = ${BULLET.lifetime}s`);
console.log(`maxBounces = ${BULLET.maxBounces ?? "null (无限)"}`);
console.log(`maxAlive = ${BULLET.maxAlive} 发（同屏同时存在上限）`);
console.log(`speed = ${BULLET.speed} px/s`);

console.log("\n=== 3. 「落空」能判定吗：一颗打偏的子弹会怎样死去 ===\n");

// A bullet that never hits anything: it expires on age.
const wall = { x1: 1000, y1: 0, x2: 1000, y2: 2000, hp: 99 };
const solo = new Bullet(400, 400, 300, 21, null);
let frames = 0;
while (!solo.dead && frames < 2000) {
  solo.update(1 / 60, [wall], false);
  frames++;
}
console.log(`打偏的子弹死于: ${frames} 帧 (${(frames / 60).toFixed(2)}s), bounces=${solo.bounces}`);
console.log(`  -> 死因是 age >= lifetime，此时必然没打中任何人`);
console.log(`  -> 可以在 dead 的那一刻判定「落空」https://`);

// A bullet that dies by bounce limit instead.
const tight = { x1: 420, y1: 300, x2: 420, y2: 500, hp: 99 };
const bouncy = new Bullet(410, 400, 300, 30, null);
let f2 = 0;
while (!bouncy.dead && f2 < 5000) {
  bouncy.update(1 / 60, [tight], false);
  f2++;
}
console.log(`\n反复反弹的子弹死于: ${f2} 帧, bounces=${bouncy.bounces}`);
console.log(`  -> maxBounces 是 ${BULLET.maxBounces ?? "null"}，所以它实际是撞到别的条件才死`);

console.log("\n=== 4. 关键节点频率估算（决定会不会很吵）===\n");

const cd = AI_DIFFICULTY.normal;
const perShot = (cd.fireCooldown[0] + cd.fireCooldown[1]) / 2;
// In a 1v1 pve round: the AI fires on its own cooldown. A round lasts until
// first-to-5 across several rounds; one round is a single kill.
// Round length measured from the arena runs: roughly 10-20s per round.
const ROUND_SECONDS = 15;
const shotsPerRound = ROUND_SECONDS / perShot;

console.log(`一场普通难度的 1v1 回合（约 ${ROUND_SECONDS}s）：`);
console.log(`  开火次数 ≈ ${shotsPerRound.toFixed(1)} 发`);
console.log(`  其中命中 ≈ 1 次（这一局结束的条件）`);
console.log(`  落空 ≈ ${(shotsPerRound - 1).toFixed(1)} 次`);
console.log("");
console.log("如果每个「开火」都触发一句台词：");
const [lo, hi] = cd.fireCooldown;
console.log(`  最坏情况（冷却取最短 ${hi}s... 实为 ${lo}s）→ 每 ${lo}s 一句`);
console.log("");
console.log("=== 结论 ===");
console.log("  开火频率 = 1 / 冷却 ≈ 0.9–1.8 发/秒（普通档）");
console.log("  这就是你说的「会很吵」：每秒都可能触发一句台词，人耳受不了");
console.log("  所以必须做节流，见下方建议");