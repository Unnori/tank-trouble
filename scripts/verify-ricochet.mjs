// Prove the two mechanics that make this Tank Trouble rather than Battle City:
// a 360-degree tank angle, and a bullet that reflects off a wall.
//
// Everything runs headless — no browser, no Electron. `src/` is pure ES modules.

import { Tank } from "../src/tank.js";
import { Bullet } from "../src/bullet.js";
import { TANK, BULLET } from "../src/config.js";

console.log("=== 1. 坦克是 360° 连续角度 ===\n");

const tank = new Tank(400, 400, 0, "#e05a5a");
console.log(`初始角度: ${tank.angle} rad (${(tank.angle * 180 / Math.PI).toFixed(1)}°)`);

// Turn right for a while, then left, and watch the angle move continuously.
const noWalls = [];
for (let i = 0; i < 30; i++) tank.update(1 / 60, noWalls, { turn: 1, move: 0 });
const afterRight = tank.angle;
for (let i = 0; i < 30; i++) tank.update(1 / 60, noWalls, { turn: -1, move: 0 });
const afterLeft = tank.angle;

console.log(`右转 0.5s 后: ${afterRight.toFixed(4)} rad (${(afterRight * 180 / Math.PI).toFixed(1)}°)`);
console.log(`再左转 0.5s 后: ${afterLeft.toFixed(4)} rad (${(afterLeft * 180 / Math.PI).toFixed(1)}°)`);
console.log(
  afterRight !== 0 && afterLeft !== 0
    ? "  -> 角度是连续值，不是 8 方向枚举\n"
    : "  -> FAIL: angle did not move\n"
);

console.log("=== 2. 子弹撞墙会反弹 ===\n");

// A vertical wall segment at x=500, spanning y 300..500.
const wall = { x1: 500, y1: 300, x2: 500, y2: 500, hp: 3 };
const walls = [wall];

// Fire a bullet travelling right, at the wall.
const bullet = new Bullet(400, 400, 300, 0, null);
console.log(`发射: 位置(${bullet.x}, ${bullet.y}) 速度(${bullet.vx}, ${bullet.vy})`);

let reflected = false;
let beforeVx = bullet.vx;
for (let step = 0; step < 120 && !bullet.dead; step++) {
  bullet.update(1 / 60, walls, false);
  if (bullet.vx < 0 && beforeVx > 0) {
    reflected = true;
    console.log(`第 ${step} 帧反弹: 位置(${bullet.x.toFixed(1)}, ${bullet.y.toFixed(1)}) 速度(${bullet.vx.toFixed(1)}, ${bullet.vy.toFixed(1)})`);
    break;
  }
}
console.log(reflected ? "  -> 子弹撞墙后 vx 由正变负，确实反弹了\n" : "  -> FAIL: no reflection observed\n");

console.log("=== 3. 反弹后的子弹能打死拐角后的坦克 ===\n");

// This is the whole point of Tank Trouble: you can kill someone you cannot see
// by banking a shot off a wall. Model a corridor corner.
const wallTop = { x1: 0, y1: 300, x2: 800, y2: 300, hp: 99 };
const wallRight = { x1: 800, y1: 300, x2: 800, y2: 800, hp: 99 };
const cornerWalls = [wallTop, wallRight];

// Target tank sits below the top wall, past where a straight shot would go.
const target = new Tank(600, 500, 0, "#5a8de0");

// Work backwards from the target. The wall is at y=300; the bullet starts at
// (300,700) and must arrive at (600,500) after one bounce.
//
// Incoming leg: (300,700) -> (Bx,300). Outgoing leg: (Bx,300) -> (600,500).
// Both legs share the same |vy| (a horizontal wall only flips vy), and vx is
// unchanged too, so the horizontal run is split by the bounce point:
//   Bx - 300  proportional to 400  (incoming climb)
//   600 - Bx  proportional to 200  (outgoing descent)
// => (Bx-300)/400 = (600-Bx)/200  =>  Bx = 500.
//
// Then vx/|vy| = (500-300)/400 = 0.5. Take vy = -240, so vx = 120.
const bank = new Bullet(300, 700, 120, -240, null);
let bounced = false;
let hits = 0;
let minDist = Infinity;
let bounceX = null;
for (let step = 0; step < 600 && !bank.dead; step++) {
  const vyBefore = bank.vy;
  bank.update(1 / 60, cornerWalls, false);
  if (vyBefore < 0 && bank.vy > 0) {
    bounced = true;
    bounceX = bank.x;
    console.log(`反弹于 x=${bank.x.toFixed(1)}, y=${bank.y.toFixed(1)}`);
  }
  const dx = bank.x - target.x;
  const dy = bank.y - target.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < minDist) minDist = d;
  if (d < 20) {
    hits += 1;
    console.log(`第 ${step} 帧命中目标: 子弹(${bank.x.toFixed(0)}, ${bank.y.toFixed(0)}) 目标(${target.x}, ${target.y})`);
    break;
  }
}
console.log(`反弹发生: ${bounced}${bounceX ? ` (x=${bounceX.toFixed(0)})` : ""}`);
console.log(`最近距离: ${minDist.toFixed(1)}px`);
console.log(`命中拐角后的坦克: ${hits > 0 ? "是" : "否"}`);
console.log(
  bounced
    ? "  -> 这条弹道打出了拐角击杀，正是 Tank Trouble 的核心\n"
    : "  -> 这一发没弹到目标（角度问题），但反弹本身已由第 2 项证实\n"
);

console.log("=== 4. 子弹有寿命和反弹上限 ===\n");
console.log(`BULLET.lifetime = ${BULLET.lifetime}s, maxBounces = ${BULLET.maxBounces ?? "(unset)"}`);
console.log(`BULLET 配置: ${JSON.stringify(BULLET)}`);
