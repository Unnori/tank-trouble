// ============================================================
// ai.js — AI 控制器（阶段 6 基础 AI）
// 接口与 input 对齐：每帧 update(dt, world) 返回与 readControls
// 同构的控制指令 { turn, move, fire }，Tank/主循环对人机无感知。
//
// 三层逻辑（取向是"街机陪练"，会追人、会开枪、能被打死）：
//   躲弹 —— 对场上全部子弹相对运动外推，8 个候选航向打"安全分"
//           （沿该向开车未来离任何子弹的最近距离），朝墙重罚、取最高分；
//           航向锁定 dodgeCommit 秒防抖动；屁股更朝逃生方向时直接倒车。
//           躲弹灵敏度（预判窗/安全余量）随难度变化，简单档不躲
//   反打 —— 攻防决策：贴脸+有视线+枪已就绪时反打优先于躲弹（中断闪避
//           转炮开火），枪没就绪才专心躲——"打一发→游走→再打"的近战节奏
//   寻路 —— 有视线直接朝敌人本体走；没视线 BFS 走格子图
//           （maze.cells 自带四面墙开关，天然邻接表），定期重算
//   移动 —— 朝目标转向（取最短旋转方向），大致对准才前进（边转边走）；
//           持续想动却没挪窝 → 判卡住，倒车+随机转向脱困
//   开火 —— 三道门：节奏冷却（随机化防狙神，近战圈倍速流逝）、弹药预算
//           （远距守纪律/近战放开到 maxAlive-1）、命中质量（窗口=几何必中角
//           ×难度技巧系数，对「拦截点」评估——持续估计敌速度解拦截方程，
//           打"你将到的位置"；打横移目标当前位置是计算出的必失，会忍住）
// 上述为阶段 6 基座；阶段 11-14 陆续叠加：避雷/布雷、捡道具决策、拦截预判、
// 跳弹吊射（hard）、激光 hitscan 精确开火、敌方激光预瞄线全路径躲避——
// 各机制的细节见对应代码段注释与 CLAUDE.md 模块职责。
// ============================================================

import { AI, AI_DIFFICULTY, CELL_SIZE, TANK, BULLET, POWERUP } from "../src/config.js";
import { segmentVsSegment, segmentVsSegmentParam, closestPointOnSegment } from "../src/collision.js";
import { castLaserPath } from "../src/laser.js";
import { DIRS } from "../src/maze.js";

// [min, max] 区间取随机数（AI 开火节奏抖动用）
function randRange([min, max]) {
  return min + Math.random() * (max - min);
}

// 角度差归一化到 [-π, π]，保证转向永远取最短旋转方向
function normalizeAngle(a) {
  return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

// 世界坐标 → 所在格（夹回地图内，防止贴墙浮点误差越界）
function cellOf(tank, maze) {
  const c = Math.max(0, Math.min(maze.cols - 1, Math.floor(tank.x / CELL_SIZE)));
  const r = Math.max(0, Math.min(maze.rows - 1, Math.floor(tank.y / CELL_SIZE)));
  return { c, r };
}

// 格 → 格中心世界坐标
function cellCenter(cell) {
  return { x: (cell.c + 0.5) * CELL_SIZE, y: (cell.r + 0.5) * CELL_SIZE };
}

// 自己中心到敌人中心的连线是否不被任何墙挡。
// ⚠️ 这是零宽射线——只适合【射击判定】（子弹 r=3 近似成立）。
// 【导航判定】必须用 hasClearPath：墙自由端附近有 ~车身半径宽的
// 「射线通、车身不通」泄漏带，用错会导致 AI 顶墙硬挤（隔墙对撞根因）。
function hasLineOfSight(self, enemy, walls) {
  return !segmentHitsWalls(self.x, self.y, enemy.x, enemy.y, walls);
}

// 半径感知的通行判定（导航用）：中心线 + 垂直方向 ±r 的两条平行线，
// 三线全通才认为车身能沿直线开过去。墙体破坏把连续墙打成墙桩后，
// 自由端泄漏带暴涨，导航必须走这个版本。导出供冒烟测试。
export function hasClearPath(x1, y1, x2, y2, walls, r = TANK.radius) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return true;
  const nx = (-dy / len) * r, ny = (dx / len) * r;
  return !segmentHitsWalls(x1, y1, x2, y2, walls)
    && !segmentHitsWalls(x1 + nx, y1 + ny, x2 + nx, y2 + ny, walls)
    && !segmentHitsWalls(x1 - nx, y1 - ny, x2 - nx, y2 - ny, walls);
}

// 线段是否撞到任意墙（视线检测 / 闪避探路共用）
function segmentHitsWalls(x1, y1, x2, y2, walls) {
  for (const w of walls) {
    if (segmentVsSegment(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2)) {
      return true;
    }
  }
  return false;
}

// 直线路径是否擦过任何危险圈（hazard = {x, y, r}，地雷警戒圈 / 激光线采样圈）。
// 擦圈就别走这条直线——移动层的避障检查（躲弹罚分 / 直追改道共用）。
function lineNearHazard(x1, y1, x2, y2, hazards) {
  for (const h of hazards) {
    const cp = closestPointOnSegment(h.x, h.y, x1, y1, x2, y2);
    if (Math.hypot(h.x - cp.x, h.y - cp.y) < h.r) return true;
  }
  return false;
}

// 点到折线（顶点数组）的最短距离——敌方激光预瞄线的压线判定用。
// 导出供冒烟测试直接验证几何。
export function distToPolyline(x, y, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const cp = closestPointOnSegment(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    best = Math.min(best, Math.hypot(x - cp.x, y - cp.y));
  }
  return best;
}

// 线段是否撞到 except 以外的任意墙（跳弹解的遮挡检查用——反弹点就在
// except 墙上，不排除会自交误判）
function segmentHitsWallsExcept(x1, y1, x2, y2, walls, except) {
  for (const w of walls) {
    if (w === except) continue;
    if (segmentVsSegment(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2)) return true;
  }
  return false;
}

// 一次反弹的吊射解（镜像法）：把目标点关于每堵墙的直线镜像，自己→镜像点
// 与该墙段的交点即反弹点 H；若「自己→H」与「H→目标」两段都无其他墙遮挡，
// 朝 H 开火的子弹恰好一次反弹命中目标。多解取总路程最短。
// 遮挡检查用中心线近似（忽略弹半径 3px，开火容差 hitSlack 盖得住）。
// 返回 { angle, dist } 或 null。导出供冒烟测试直接验证几何。
export function findBounceShot(sx, sy, tx, ty, walls) {
  let best = null;
  for (const w of walls) {
    const wx = w.x2 - w.x1;
    const wy = w.y2 - w.y1;
    const len = Math.hypot(wx, wy);
    if (len < 1e-6) continue;
    const nx = -wy / len;
    const ny = wx / len;
    // 目标与自己必须在墙同侧（异侧的"反弹路径"物理上是穿墙，不成立）
    const dT = (tx - w.x1) * nx + (ty - w.y1) * ny;
    const dS = (sx - w.x1) * nx + (sy - w.y1) * ny;
    if (dT * dS <= 0 || Math.abs(dT) < 1) continue;
    // 目标点关于墙直线的镜像
    const mx = tx - 2 * dT * nx;
    const my = ty - 2 * dT * ny;
    // 自己→镜像点 与墙段求交，交点即反弹点
    const t = segmentVsSegmentParam(sx, sy, mx, my, w.x1, w.y1, w.x2, w.y2);
    if (t === null) continue;
    const hx = sx + (mx - sx) * t;
    const hy = sy + (my - sy) * t;
    // 两段遮挡检查
    if (segmentHitsWallsExcept(sx, sy, hx, hy, walls, w)) continue;
    if (segmentHitsWallsExcept(hx, hy, tx, ty, walls, w)) continue;
    const dist = Math.hypot(hx - sx, hy - sy) + Math.hypot(tx - hx, ty - hy);
    if (!best || dist < best.dist) {
      best = { angle: Math.atan2(hy - sy, hx - sx), dist };
    }
  }
  return best;
}

// 朝指定航向操舵：取最短旋转对齐；航向更靠车尾时倒车贴合（车尾当车头），
// 省掉慢吞吞的 180° 转身——躲弹时这省出的就是命。
function steerToHeading(self, heading) {
  let diff = normalizeAngle(heading - self.angle);
  let move = 1;
  if (Math.abs(diff) > Math.PI / 2) {
    diff = normalizeAngle(diff - Math.PI); // 反向对齐
    move = -1;
  }
  const turn = Math.abs(diff) > 0.05 ? Math.sign(diff) : 0;
  return { turn, move };
}

// 选闪避航向：8 个等分候选航向逐一打"安全分"——按该航向以坦克速度开车，
// 未来 horizon 秒内离场上任何子弹的最近距离（相对运动闭式解，全弹幕一起算，
// 不是只躲最急那颗）。朝墙的航向重罚（朝墙里闪等于站桩挨打），取最高分。
// hazards（可选）：地雷等静态危险圈，探测线扫过同样重罚——躲子弹别躲进雷里。
// 这就是"在一堆子弹里找正确路线"：横穿、斜退、借位都可能是最优解。
// 导出供冒烟测试直接验证选路正确性。
export function pickDodgeHeading(self, bullets, walls, horizon, hazards = []) {
  let bestHeading = 0;
  let bestScore = -Infinity;

  for (let k = 0; k < 8; k++) {
    const heading = (k * Math.PI) / 4;
    const ux = Math.cos(heading) * TANK.moveSpeed;
    const uy = Math.sin(heading) * TANK.moveSpeed;

    // 安全分 = 沿该航向行驶时，与所有子弹未来最近距离的最小值
    let score = Infinity;
    for (const b of bullets) {
      if (b.dead) continue;
      const rx = b.x - self.x;          // 子弹相对自己的位置
      const ry = b.y - self.y;
      const wx = b.vx - ux;             // 子弹相对自己的速度
      const wy = b.vy - uy;
      const w2 = wx * wx + wy * wy;
      // 相对距离最小的时刻，夹到 [0, horizon]（过去不算，太远的未来不赌）
      let t = w2 > 1e-9 ? -(rx * wx + ry * wy) / w2 : 0;
      t = Math.max(0, Math.min(horizon, t));
      score = Math.min(score, Math.hypot(rx + wx * t, ry + wy * t));
    }

    // 探测线终点（朝墙罚 / 扫雷罚共用）
    const tx = self.x + Math.cos(heading) * AI.dodgeClearance;
    const ty = self.y + Math.sin(heading) * AI.dodgeClearance;

    // 朝墙航向重罚：罚值足够大，只有八方皆堵才会选到朝墙的（那就蹭墙滑）。
    // 半径感知（中心线 + ±车身半径平行线）——零宽射线擦墙沿 8px 判"通"，
    // 车身(r=16)实际过不去，闪避会原地打转
    if (!hasClearPath(self.x, self.y, tx, ty, walls)) {
      score -= AI.dodgeWallPenalty;
    }
    // 扫过雷圈同罚：闪进雷区比挨子弹还亏
    if (hazards.length && lineNearHazard(self.x, self.y, tx, ty, hazards)) {
      score -= AI.dodgeWallPenalty;
    }

    if (score > bestScore) {
      bestScore = score;
      bestHeading = heading;
    }
  }
  return bestHeading;
}

// BFS 网格最短路：返回从 from 的下一格到 to 的格子序列（不含 from）。
// 同格或不可达返回 []。迷宫生成时已保证全连通，不可达只是兜底。
// blocked（可选）：禁行格 Set（"c,r" 键，目前是有雷的格）——绕开走；
// 目标格被禁会判不可达，上层拿到 [] 走直怼兜底（有直线避雷检查兜着）。
//
// **导出的是这条纯栅格最短路，不含任何 AI 决策**（目标格由调用方给）。
// 出口开在这里是为了让 `scripts/arena.mjs` 的 `--holdseek` 寻点层复用同一份寻路，
// 而不是在 harness 里抄第二份 BFS——同一个理由让 arena 用真实 `Tank` 类。
export function findPath(maze, from, to, blocked) {
  if (from.c === to.c && from.r === to.r) return [];

  const { cols, rows, cells } = maze;
  const prev = Array.from({ length: rows }, () => new Array(cols).fill(null));
  prev[from.r][from.c] = from; // 自指标记"已访问"，回溯时作终止哨兵
  const queue = [from];

  for (let head = 0; head < queue.length; head++) {
    const { c, r } = queue[head];
    if (c === to.c && r === to.r) break;
    for (const d of DIRS) {
      const nc = c + d.dc;
      const nr = r + d.dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      if (prev[nr][nc]) continue;          // 已访问
      if (cells[r][c][d.wall]) continue;   // 这面有墙，过不去
      if (blocked && blocked.has(`${nc},${nr}`)) continue; // 格里有雷，绕开
      prev[nr][nc] = { c, r };
      queue.push({ c: nc, r: nr });
    }
  }

  if (!prev[to.r][to.c]) return []; // 不可达（理论上不会发生）

  // 从终点回溯到起点，反转得到 from→to 的途经格序列
  const path = [];
  let cur = to;
  while (!(cur.c === from.c && cur.r === from.r)) {
    path.push(cur);
    cur = prev[cur.r][cur.c];
  }
  return path.reverse();
}

// 拦截时刻：敌人相对位置 (rx,ry)、速度 (vex,vey)，子弹速度 vb，
// 解 |r + ve·t| = vb·t → (ve²−vb²)t² + 2(r·ve)t + r² = 0，取最小正根。
// 本游戏 vb(180) > 坦克极速(120)，方程恒有唯一正根；返回 null 仅是数值兜底。
// 导出供冒烟测试直接验证解算正确性。
export function interceptTime(rx, ry, vex, vey, vb) {
  const a = vex * vex + vey * vey - vb * vb;
  const b = 2 * (rx * vex + ry * vey);
  const c = rx * rx + ry * ry;
  if (Math.abs(a) < 1e-9) {
    return b < -1e-9 ? -c / b : null; // 弹速与敌速相同的退化情形
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = Infinity;
  for (const root of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (root > 0 && root < t) t = root;
  }
  return Number.isFinite(t) ? t : null;
}

export class AiController {
  // player: 本 AI 操控的 Player（从中取自己的坦克）
  // level:  难度档位 key（AI_DIFFICULTY 的 easy/normal/hard），决定瞄准/节奏/反应
  constructor(player, level = "normal") {
    this.player = player;
    this.cfg = AI_DIFFICULTY[level] || AI_DIFFICULTY.normal; // 容错兜底普通档

    this.path = [];          // 待走的格子序列，[0] 是下一个路点
    this.pathGoalCell = null; // 当前路径的终点格（追敌/捡道具切换时变了就强制重算）
    this.replanTimer = 0;    // 归零触发 BFS 重算（敌我都在动，路径很快过期）
    this.fireTimer = randRange(this.cfg.fireCooldown); // 开局先压一拍，不秒开枪

    // ==== 仪表（本副本专有，原 src/ai.js 没有这些字段）====
    // 每次通过质量门开火时记一条，供「说大话」的 confidence 阈值研究使用。
    this.shotLog = [];
    // 本帧质量门算出的把握度；未开火时为 null。main.js 消费 controls.fire 时
    // 可以把它带到子弹上，子弹再带回命中结果。
    this.lastConfidence = null;
    this.lastEffTol = null;
    this.lastAimErr = null;
    // 质量门的来源，用于区分「直线必中」『跳弹解』『打墙开路』
    this.lastFireReason = null;

    // 闪避机动：航向选定后锁 dodgeCommit 秒（防抖），锁定期内一条道闪到底
    this.dodgeTimer = 0;     // >0 表示正在执行闪避机动
    this.dodgeHeading = 0;   // 锁定的逃生航向（弧度）

    // 敌速度估计（拦截预判用）：逐帧差分 + 指数平滑
    this.lastEnemyX = null;  // null = 尚无上一帧位置
    this.lastEnemyY = null;
    this.enemyVx = 0;
    this.enemyVy = 0;

    // 卡住检测：从"开始想动"处锚定位置，持续想动却没挪窝就脱困
    this.movingTime = 0;     // 连续处于"想前进"状态的时长
    this.anchorX = 0;
    this.anchorY = 0;
    this.unstickTimer = 0;   // >0 表示正在脱困机动
    this.unstickTurn = 1;    // 脱困时的转向（随机定一边，避免左右横跳）

    // 布雷决策节流（special 位无边沿概念，防连帧连丢）
    this.mineDropTimer = 0;

    // 避战游走目标缓存（逐帧随机会抖，缓存 1.5s 一换）
    this.wanderGoal = null;
    this.wanderTimer = 0;

    // 跳弹吊射（hard 专属）：反弹解缓存 + 0.25s 重算节流
    this.bounceShot = null;
    this.bounceTimer = 0;

    // 敌方激光预瞄线路径（每帧重算；null = 敌人没持激光或本档不感知）。
    // 挂在实例上是为了让 pickPowerupTarget 能过滤"落在线上的饵"。
    this.enemyLaserPath = null;
  }

  // 每帧调用。world = { maze, players, bullets, powerups, mines }。
  // 返回 { turn, move, fire, special }，与 input.readControls 同构。
  update(dt, world) {
    const self = this.player.tank;
    const idle = { turn: 0, move: 0, fire: false, special: false };
    // 仪表：每帧清空，这样「本帧是否开了火、把握度多少」不会读到上一帧的残留。
    this.lastConfidence = null;
    this.lastEffTol = null;
    this.lastAimErr = null;
    this.lastFireReason = null;
    if (!self.alive) return idle;

    // 目标：场上另一个存活玩家（1v1 就一个；没有则待机）
    const enemyPlayer = world.players.find((p) => p !== this.player && p.alive);
    if (!enemyPlayer) return idle;
    const enemy = enemyPlayer.tank;
    const enemyDist = Math.hypot(enemy.x - self.x, enemy.y - self.y);

    // —— 敌人道具状态识别 + 自己道具状态：决定整体策略 ——
    const enemyHasShield = enemy.shield;              // 敌人有无敌护盾
    const enemyShieldExpiring = enemy.shieldTimer < 1.5; // 护盾快到期（<1.5s 闪烁）
    const enemyHasScatter = enemy.scatterShots > 0;   // 敌人有散射弹（火力密集）
    const enemyHasLaser = enemy.laserShots > 0;       // 敌人有激光（瞬时射线，躲无可躲）
    const enemyHasMine = enemy.mineCharges > 0;       // 敌人持雷（近身可能被丢雷拦路）

    const selfHasShield = self.shield;                // 自己有护盾
    const selfShieldExpiring = self.shieldTimer < 1.5; // 自己护盾快到期

    // 策略决策：
    //   自己有护盾（且未快到期）→ 狂暴模式：直接冲锋、不躲弹、放开火力、不捡道具（时间宝贵）
    //   敌人有护盾（且未快到期）→ 避战模式：不贴脸反打、优先捡道具/游走——
    //     开火不禁（护盾挡一发即碎，远距点破它的盾是赚的），只是不上去换命
    //   敌人有散射/激光/地雷 → 防守模式：加强躲避、减少激进追击
    //     （散射=火力密集；激光=瞬时射线躲无可躲，别停在它预瞄线上；持雷=近身被丢雷）
    const berserkMode = selfHasShield && !selfShieldExpiring;  // 狂暴：利用无敌冲锋
    const avoidMode = enemyHasShield && !enemyShieldExpiring; // 避战：等护盾消失
    const defensiveMode = enemyHasScatter || enemyHasLaser || enemyHasMine; // 防守：应对强化火力

    // —— 场上地雷 → 移动层障碍（躲弹罚分 / BFS 绕格 / 直追改道三处共用）——
    // 布防期的雷也一并避（马上就警戒了，没必要精确到帧）；雷不认人，
    // 自己丢的同样在列——丢完雷靠这套逻辑自动绕开，不会回头踩自己的雷。
    // 避让半径按爆炸波及圈算（别人踩雷自己也在圈内会陪葬），不是触发圈
    const mineClear = POWERUP.mine.blastRadius + TANK.radius * 0.5;
    const mineHazards = (world.mines || []).map((m) => ({ x: m.x, y: m.y, r: mineClear }));
    // BFS 按格心距禁行：68px 爆炸圈 > 48px 半格，所以一颗雷常常同时威胁
    // 相邻格，floor(x/CELL) 只禁雷所在那一格会漏掉 57.6% 的雷位——改为
    // 半径感知扩容（实测平均禁行格 2.03→2.74，即多禁的都是真在圈内的格）。
    // mineBlockedCore 只含雷自己那一格 = 扩容前的旧集合，留作寻路的中间降级
    // 档（见 findPath 调用处：扩容会让「算不出路」的比例 +3.4pp，而最终降级
    // 是**完全无视雷**，没有中间档时那 3.4pp 比扩容前更差）。
    const mineBlocked = mineHazards.length ? new Set() : null;
    const mineBlockedCore = mineHazards.length ? new Set() : null;
    if (mineBlocked) {
      for (const h of mineHazards) {
        const cx = Math.floor(h.x / CELL_SIZE);
        const cy = Math.floor(h.y / CELL_SIZE);
        mineBlockedCore.add(`${cx},${cy}`);
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const cellCenterX = (cx + dx + 0.5) * CELL_SIZE;
            const cellCenterY = (cy + dy + 0.5) * CELL_SIZE;
            const dist = Math.hypot(cellCenterX - h.x, cellCenterY - h.y);
            if (dist <= mineClear) mineBlocked.add(`${cx + dx},${cy + dy}`);
          }
        }
      }
    }

    // —— 敌方激光预瞄线 → 全路径静态危险带 ——
    // 激光是瞬时 hitscan：线上任何点被击中的延迟只是对手的反应时间，与离炮口
    // 远近无关。所以不能只靠"虚拟弹速×预判窗"的投影语义感知它——那样 10 格长
    // 的杀伤线只有炮口前 600×dodgeHorizon 像素被当回事（normal 仅 2.5 格），
    // 实测 AI 会大摇大摆开进线里送死。改为直接消费与预瞄虚线同源的
    // castLaserPath 全路径（含反弹段。信息对称：这条线人类玩家屏幕上全程
    // 可见，AI 读同一份几何不算开挂）：
    //   ① 沿线采样成危险圈，与地雷共用移动层三件套（躲弹罚分/直追改道/BFS 绕格）
    //   ② 车身压线（含反弹段）→ 直接触发闪避机动横移下线（见躲弹段）
    //   ③ 压线时禁用贴脸反打（见 counterAttack）——朝架好的枪口冲锋是自杀
    // 近炮口 laserMuzzleExempt 格内的采样不进寻路封锁/直追改道：交战终归要
    // 接近持枪人，封死其所在格会让 BFS 判不可达退化成直怼，反而更危险。
    // easy 档 dodgeHorizon=0 整套跳过（不躲弹的档位保持好欺负，是设计）。
    let laserPath = null;
    const laserHazards = [];    // 全部采样：躲弹罚分 / 压线判定 / 道具过滤用
    const laserFarHazards = []; // 炮口豁免圈外的采样：直追改道 / BFS 封格用
    if (enemyHasLaser && this.cfg.dodgeHorizon > 0) {
      // 出膛点传 walls：与对手实际发射、与屏幕上那条预瞄虚线同源。
      // 不传的话对手贴墙时 AI 会去躲一条穿墙的假线（而真线是反弹的）
      const em = enemy.muzzlePoint(world.maze.walls);
      laserPath = castLaserPath(em.x, em.y, em.angle, world.maze.walls);
      const exempt = CELL_SIZE * AI.laserMuzzleExempt;
      for (let i = 0; i < laserPath.length - 1; i++) {
        const ax = laserPath[i].x, ay = laserPath[i].y;
        const dx = laserPath[i + 1].x - ax, dy = laserPath[i + 1].y - ay;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / AI.laserHazardStep));
        for (let s = 0; s <= steps; s++) {
          const h = { x: ax + (dx * s) / steps, y: ay + (dy * s) / steps, r: AI.laserHazardRadius };
          laserHazards.push(h);
          if (Math.hypot(h.x - enemy.x, h.y - enemy.y) > exempt) laserFarHazards.push(h);
        }
      }
    }
    this.enemyLaserPath = laserPath;
    // 车身是否已压在杀伤线上（半径 + 难度安全余量，hard 余量大反应更早）
    const onLaserLine = laserPath !== null &&
      distToPolyline(self.x, self.y, laserPath) < TANK.radius + BULLET.radius + this.cfg.dodgeMargin;

    // 移动层障碍合流：躲弹罚分看全部激光采样（贴炮口的线一样致命），
    // 直追改道/BFS 封格只看豁免圈外的（理由见上）
    const moveHazards = mineHazards.concat(laserHazards);
    const chaseHazards = mineHazards.concat(laserFarHazards);
    let blockedCells = mineBlocked;
    let blockedCellsCore = mineBlockedCore; // 中间降级档：雷只禁自己那一格
    if (laserFarHazards.length) {
      blockedCells = new Set(blockedCells ?? []);
      blockedCellsCore = new Set(blockedCellsCore ?? []);
      for (const h of laserFarHazards) {
        const key = `${Math.floor(h.x / CELL_SIZE)},${Math.floor(h.y / CELL_SIZE)}`;
        blockedCells.add(key);
        blockedCellsCore.add(key); // 激光线两档都禁：它不是「圈」而是线，无扩容可退
      }
    }

    // 开火冷却流逝：近战圈/狂暴模式按倍速燃烧（快速连发）
    // 避战模式不加速（不急着开火）
    const cooldownBoost = avoidMode ? 1
      : (berserkMode || enemyDist < AI.closeCombatRange ? AI.closeCooldownBoost : 1);
    this.fireTimer -= dt * cooldownBoost;
    this.replanTimer -= dt;
    this.bounceTimer -= dt;

    // —— 0) 态势感知 + 攻防决策（脱困也要让位给反打，所以最先算）——
    const los = hasLineOfSight(self, enemy, world.maze.walls);

    // 敌速度估计：逐帧差分 + 指数平滑（差分太抖，平滑后约半拍收敛，
    // 对方急转弯时旧速度残留几帧——这恰好是"人类预判也会被晃"的合理误差）
    if (this.lastEnemyX !== null && dt > 0) {
      const a = AI.leadSmooth;
      this.enemyVx += ((enemy.x - this.lastEnemyX) / dt - this.enemyVx) * a;
      this.enemyVy += ((enemy.y - this.lastEnemyY) / dt - this.enemyVy) * a;
    }
    this.lastEnemyX = enemy.x;
    this.lastEnemyY = enemy.y;

    // 拦截预判：解出子弹与敌人同时到达的拦截点，按难度 leadFactor 打折——
    // 瞄准/开火全部对拦截点进行。打高速横移目标的"当前位置"是计算出的必失，
    // 质量门会因此把这发省下来；对拦截点开的每一炮都是"算出来会中"的。
    let aimX = enemy.x;
    let aimY = enemy.y;
    if (this.cfg.leadFactor > 0) {
      const ti = interceptTime(
        enemy.x - self.x, enemy.y - self.y,
        this.enemyVx, this.enemyVy, BULLET.speed
      );
      if (ti !== null && ti < 2) { // 2 秒外的拦截解没有战术意义
        aimX = enemy.x + this.enemyVx * ti * this.cfg.leadFactor;
        aimY = enemy.y + this.enemyVy * ti * this.cfg.leadFactor;
      }
    }
    // 持激光时瞄准语义不同：激光是瞬时 hitscan，不需要提前量——打的就是
    // "现在"的位置；拦截点是为 180px/s 慢弹算的，拿来瞄激光反而必偏。
    if (self.laserShots > 0) {
      aimX = enemy.x;
      aimY = enemy.y;
    }
    const aimDist = Math.hypot(aimX - self.x, aimY - self.y);
    const aimErr = normalizeAngle(
      Math.atan2(aimY - self.y, aimX - self.x) - self.angle
    );
    // 弹药上限随交战距离：远距守预算纪律（防乱泼弹），近战放开到 maxAlive-1——
    // 既能持续还手不被"弹全在外面飞十秒"饿死，又永远留一发膛内余量
    // 等下一个必中窗口，不会一梭子清仓后干瞪眼
    const ammoCap = enemyDist < AI.closeCombatRange
      ? BULLET.maxAlive - 1
      : this.cfg.ammoBudget;
    let myShots = 0;
    for (const b of world.bullets) {
      // 散射弹不计入自留弹预算——它本就绕开 maxAlive 限流，计入会让 AI
      // 打完一轮散射（+3 发在场）后 gunReady 骤降变消极，与道具意图相反
      if (!b.dead && b.owner === self && b.kind !== "scatter") myShots++;
    }
    // 节奏门与弹药门拆开：激光是 hitscan，不产生实体弹也不占 maxAlive
    // （tank.js 的限流对持激光者整段跳过），所以「自留弹预算」那套立论
    // （远距守纪律防乱泼弹 + 留一发膛内余量等下个必中窗口）对它一条都不成立。
    // 焊在一起会让「场上自弹占满预算」时连那唯一一发必中激光都拒开。
    // 普通弹三条分支照旧用 gunReady，定义逐字不变。
    const rhythmReady = this.fireTimer <= 0;
    const gunReady = rhythmReady && myShots < ammoCap;

    // 近战反打：贴脸 + 车身可达 + 枪已就绪 → 压倒一切转炮开火。
    // 可达门用 hasClearPath 而非零宽 los：closeCombatRange(130) > CELL_SIZE(96)，
    // 隔一堵墙的敌人恒在距离内——零宽射线在墙自由端有泄漏带，会让 AI 判
    // "能打到"却物理过不去，顶着墙无限推（隔墙对撞根因）。车身过不去就
    // 老老实实走 BFS 绕路，那边照样能开火（射击判定仍用零宽 los）。
    // 特殊情况：
    //   - 狂暴模式（自己有护盾）：放宽反打距离到中距，主动进攻
    //   - 避战模式（敌人有护盾未到期）：禁用反打——打了也白打
    const bodyPathClear = los && hasClearPath(self.x, self.y, enemy.x, enemy.y, world.maze.walls);
    const counterAttackRange = berserkMode ? AI.closeCombatRange * 1.5 : AI.closeCombatRange;
    const counterAttack = !avoidMode && bodyPathClear && gunReady && enemyDist < counterAttackRange
      && !onLaserLine; // 压在敌方激光预瞄线上时不反打——先横移下线，再谈交火

    // 交战压制：敌人就在眼前（有视线且 <2.5 格）时不做捡道具决策——
    // 当面转身跑去捡东西等于把侧背卖给对方，打完或甩开视线再说。
    // 避战模式除外（敌有盾，躲着捡本就是正确策略）。
    const engaged = los && enemyDist < CELL_SIZE * 2.5;

    // —— 1) 脱困机动：倒车 + 定向转，做完为止不被抢占 ——
    // 曾允许反打抢占（「贴脸被顶住该开炮不该掉头」），实测是隔墙对撞
    // 死锁的一环：顶墙触发脱困 → 反打立刻抢占 → 回去继续顶墙。
    // 真贴脸对撞时敌我 bodyPathClear 成立、卡住检测有 0.6s 窗口，
    // 脱困 0.45s 做完再反打只慢半拍，换来的是永不死锁。
    if (this.unstickTimer > 0) {
      this.unstickTimer -= dt;
      return { turn: this.unstickTurn, move: -1, fire: false, special: false };
    }

    // —— 2) 躲弹：选定逃生航向后锁 dodgeCommit 秒 ——
    // 不锁的话脱靶向量随双方移动逐帧翻面，AI 会左右抽搐；
    // 锁定期内威胁消失也把机动做完（半途折返等于没躲）。
    // 狂暴模式（自己有护盾）：完全不躲弹，直接冲锋（无敌状态）
    // 对手持激光：把预瞄线的每一段都注入为一颗高速虚拟子弹，与真实弹一起喂给
    // 威胁检测/闪避评分——按段注入让反弹段同样被感知；路径来自真实几何投射，
    // 隔墙的段就是真实杀伤线，不存在旧版直线外推的穿墙误报，故不再需要 los 门。
    // 虚拟弹在这里的主要价值是给闪避评分提供"哪个航向在远离线"的梯度；
    // 压线的即时警报由下方 laserDanger 兜底（不受虚拟弹时间窗限制）。
    // 注：曾试过把敌人普通炮口射线也注入（"看炮口预动"），arena 实测是毒药——
    // 追击中炮口互指是常态，会让 AI 陷入永久闪避不开火，已回滚。激光预瞄不同：
    // 它只在敌人真的持激光时存在，且预瞄线暴露的是即将发生的瞬时必杀。
    let threatBullets = world.bullets;
    if (laserPath) {
      const virtual = [];
      for (let i = 0; i < laserPath.length - 1; i++) {
        const dx = laserPath[i + 1].x - laserPath[i].x;
        const dy = laserPath[i + 1].y - laserPath[i].y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        virtual.push({
          x: laserPath[i].x,
          y: laserPath[i].y,
          vx: (dx / len) * AI.laserVirtualSpeed,
          vy: (dy / len) * AI.laserVirtualSpeed,
          dead: false,
        });
      }
      threatBullets = threatBullets.concat(virtual);
    }

    let turn, move;
    this.dodgeTimer -= dt;
    // 狂暴（有盾）才中断闪避——盾能吃伤害，冲锋是赚的。
    // counterAttack 不再中断：近战圈内 gunReady 以 0.05~0.28s 周期翻转
    // （closeCooldownBoost 4 倍速），高频清零会把 dodgeCommit 防抖完全击穿，
    // 闪避永远做不完半个（贴脸抽搐的根源）。锁定期走完再反打。
    if (berserkMode) this.dodgeTimer = 0;
    const threat = !counterAttack && !berserkMode && this.cfg.dodgeHorizon > 0
      ? this.findThreat(self, threatBullets)
      : null;
    // 压线即险，不等虚拟弹的时间窗——hitscan 从"对准"到"击中"只隔对手的
    // 反应时间，与离炮口距离无关。狂暴（有盾）例外：盾能吃下这发激光，冲锋是赚的
    const laserDanger = onLaserLine && !counterAttack && !berserkMode;
    if ((threat || laserDanger) && this.dodgeTimer <= 0) {
      this.dodgeHeading = pickDodgeHeading(
        self, threatBullets, world.maze.walls, this.cfg.dodgeHorizon, moveHazards
      );
      this.dodgeTimer = AI.dodgeCommit;
    }
    if (this.dodgeTimer > 0) {
      ({ turn, move } = steerToHeading(self, this.dodgeHeading));
      this.path = [];        // 闪避破坏走位，旧路径作废，威胁解除后重算
      this.movingTime = 0;   // 闪避不计入卡住检测（被弹幕压在墙角不算卡）
      this.bounceShot = null; // 闪避期间跳弹解不再刷新，作废防陈旧解泄漏到开火
    } else {
      // —— 3) 追击 / 捡道具 / 战术撤退：根据自己和敌人的道具状态选策略 ——

      let powerupTarget = null;
      let goal, goalLos;

      if (berserkMode) {
        // 狂暴模式（自己有护盾）：5 秒无敌，直接冲锋不捡道具（时间宝贵）
        goal = enemy;
        goalLos = los;
      } else if (avoidMode) {
        // 避战模式（敌人有护盾）：优先捡道具提升实力，没道具就保持安全距离游走
        powerupTarget = this.pickPowerupTarget(self, world.powerups, world, true); // 放宽限制
        if (powerupTarget) {
          goal = powerupTarget;
          goalLos = !segmentHitsWalls(self.x, self.y, goal.x, goal.y, world.maze.walls);
        } else {
          // 没道具可捡：保持距离游走（不主动靠近送死，也不硬后撤撞墙）
          // 策略：距离 <4 格时远离（BFS 到对面），距离够远时原地游走等护盾消失
          if (enemyDist < CELL_SIZE * 4) {
            // 太近：沿「敌→我」方向外推 3 格拉开距离。
            // 旧算法取敌人格的地图镜像格——敌人在中心格时镜像=敌人自己那格，
            // 避战模式反而 BFS 直冲无敌坦克；对称地图上镜像格还是拓扑等价点。
            const fleeLen = CELL_SIZE * 3;
            const fdx = self.x - enemy.x, fdy = self.y - enemy.y;
            const fLen = Math.hypot(fdx, fdy) || 1;
            const fleeCell = cellOf({
              x: self.x + (fdx / fLen) * fleeLen,
              y: self.y + (fdy / fLen) * fleeLen,
            }, world.maze); // cellOf 自带 clamp 图内
            goal = cellCenter(fleeCell);
            goalLos = false; // 用 BFS 绕路，不撞墙
          } else {
            // 距离够远：小幅游走别傻站着——目标缓存 1.5s 再换
            // （逐帧随机目标会让 BFS 频繁重算、原地抖成帕金森）。
            // 已走到目标附近也立刻重抽——否则同格 BFS 返回空路径，
            // target 落在脚下，方向噪声让 turn 随机翻转原地抖到计时器到期
            this.wanderTimer -= dt;
            const wanderArrived = this.wanderGoal &&
              Math.hypot(this.wanderGoal.x - self.x, this.wanderGoal.y - self.y) < CELL_SIZE * 0.4;
            if (!this.wanderGoal || this.wanderTimer <= 0 || wanderArrived) {
              const randomAngle = Math.random() * Math.PI * 2;
              const wc = cellOf({
                x: self.x + Math.cos(randomAngle) * CELL_SIZE * 1.5,
                y: self.y + Math.sin(randomAngle) * CELL_SIZE * 1.5,
              }, world.maze); // clamp 图内，防目标落图外被系统性拉向边缘
              this.wanderGoal = cellCenter(wc);
              this.wanderTimer = 1.5;
            }
            goal = this.wanderGoal;
            goalLos = false; // 用 BFS 绕墙
          }
        }
      } else if (defensiveMode && enemyDist < CELL_SIZE * 3.5) {
        // 防守模式 + 距离太近（<3.5 格）：优先捡道具提升火力（交战压制时不捡），
        // 没道具才考虑拉距离
        powerupTarget = !engaged
          ? this.pickPowerupTarget(self, world.powerups, world, false)
          : null;
        if (powerupTarget) {
          goal = powerupTarget;
          goalLos = !segmentHitsWalls(self.x, self.y, goal.x, goal.y, world.maze.walls);
        } else {
          // 太近且没道具：正常追击但保持谨慎（靠减少开火 + 加强躲避来防守）
          goal = enemy;
          goalLos = los;
        }
      } else {
        // 正常模式：优先级 反打贴脸 > 交战压制 > 道具 > 追敌
        powerupTarget = (!counterAttack && !engaged)
          ? this.pickPowerupTarget(self, world.powerups, world, false)
          : null;
        goal = powerupTarget || enemy;
        goalLos = powerupTarget
          ? !segmentHitsWalls(self.x, self.y, goal.x, goal.y, world.maze.walls)
          : los;
      }

      // 直追前的避障检查：直线路径擦过雷的警戒圈或敌方激光线（豁免圈外）
      // → 放弃直追改走 BFS 绕格（blocked 已把雷格/线格排除）。躲弹机动
      // 不受此限（保命优先，pickDodgeHeading 自己会对扫障航向罚分）。
      if (goalLos && chaseHazards.length &&
          lineNearHazard(self.x, self.y, goal.x, goal.y, chaseHazards)) {
        goalLos = false;
      }

      // 近战不需要特殊机动：必中角近大远小，贴脸时开火窗口极宽，
      // 边追边连续还手就是最强进攻；撞上对方有坦克碰撞顶着，无碍
      let target;
      if (goalLos) {
        // 有视线：一律朝目标本体开车。追敌也不再用拦截点当驾驶目标——
        // 拦截点是给炮口的（hard 提前量可达 2 格，常在墙后），拿来开车
        // 会朝墙后空点怼（隔墙对撞帮凶之一）；瞄准仍用 aimX/aimY（见开火段）。
        target = { x: goal.x, y: goal.y };
        this.path = [];          // 直追时旧路径作废
        this.pathGoalCell = null;
      } else {
        const goalCell = cellOf(goal, world.maze);
        // 目标格变了（追敌↔捡道具切换，或敌人/道具换格）→ 强制重算，别拿旧路径跑错地方
        const goalChanged = !this.pathGoalCell
          || this.pathGoalCell.c !== goalCell.c || this.pathGoalCell.r !== goalCell.r;
        if (this.replanTimer <= 0 || this.path.length === 0 || goalChanged) {
          this.replanTimer = this.cfg.replanInterval;
          this.path = findPath(world.maze, cellOf(self, world.maze), goalCell, blockedCells);
          // 带禁行格算不出路 ≠ 物理不可达——rooms 风格门少，一颗雷封住门格
          // 就割断连通。三档降级：全爆炸圈 → 只禁雷所在格 → 完全无视雷。
          // 中间档是必需的而不是锦上添花：半径扩容让「算不出路」+3.4pp，
          // 而最后一档完全无视雷，没有中间档时那 3.4pp 反而比扩容前更差
          // （扩容前它至少还绕开雷自己那一格）。有了这一档，新行为在
          // **任何**局面都不弱于扩容前。
          if (this.path.length === 0 && blockedCells) {
            if (blockedCellsCore && blockedCellsCore.size < blockedCells.size) {
              this.path = findPath(world.maze, cellOf(self, world.maze), goalCell, blockedCellsCore);
            }
            if (this.path.length === 0) {
              this.path = findPath(world.maze, cellOf(self, world.maze), goalCell, null);
            }
          }
          this.pathGoalCell = goalCell;
        }
        // 走到路点格中心附近就弹出，奔向下一个（while：一帧可能跨过多个）。
        // 「已进入路点格」也算到达——切内角时可能不经过格心，只按距离判会
        // 让路点永不弹出，车头被掰回身后原地折返抖动
        const selfCell = cellOf(self, world.maze);
        while (this.path.length > 0) {
          const wp = cellCenter(this.path[0]);
          const inCell = this.path[0].c === selfCell.c && this.path[0].r === selfCell.r;
          if (!inCell && Math.hypot(wp.x - self.x, wp.y - self.y) > CELL_SIZE * 0.3) break;
          this.path.shift();
        }
        // 路径走完/不可达兜底：直接朝目标本体怼（撞墙滑动 + 卡住脱困能兜住）
        target = this.path.length > 0 ? cellCenter(this.path[0]) : goal;
      }

      // —— 4) 转向 + 前进：取最短旋转方向，大致对准才走 ——
      const desired = Math.atan2(target.y - self.y, target.x - self.x);
      const diff = normalizeAngle(desired - self.angle);
      turn = Math.abs(diff) > 0.05 ? Math.sign(diff) : 0; // 小死区防抖
      move = Math.abs(diff) < AI.moveAngleGate ? 1 : 0;

      // —— 4.5) 阵地射击（hard 专属）：无视线但存在一次反弹的吊射解时，
      // 停车转炮对齐反弹角——隔着墙把跳弹送到敌人脸上（原版高手核心技能）。
      // 只在 gunReady 且不追道具时进入；打完 fireTimer 重置自然退回追击；
      // 躲弹/反打优先级天然更高（本段在躲弹 else 分支内）。
      // 解 0.25s 节流重算（敌动了解跟着变），最长缓存同样 0.25s。
      if (this.cfg.bounceAim && !los && gunReady && !powerupTarget) {
        if (this.bounceTimer <= 0) {
          this.bounceShot = findBounceShot(self.x, self.y, aimX, aimY, world.maze.walls);
          this.bounceTimer = 0.25;
        }
        if (this.bounceShot && this.bounceShot.dist < CELL_SIZE * 8) {
          const bDiff = normalizeAngle(this.bounceShot.angle - self.angle);
          turn = Math.abs(bDiff) > 0.03 ? Math.sign(bDiff) : 0;
          move = 0; // 站定吊射，炮口即武器
        }
      } else {
        // 不再维护的解立刻作废——与 560 行闪避期的处理一致，防陈旧解泄漏
        this.bounceShot = null;
      }

      // —— 4) 卡住检测：连续想动 stuckWindow 秒却没挪出 stuckMinDist → 脱困 ——
      // 计时不再被 counterAttack 高频清零（那会让顶墙死锁数学上无法触发脱困），
      // 但触发时区分卡在哪：被【敌车】顶住（贴脸且车身通路无墙）是交战常态，
      // 顶着打就是最优解不该掉头；被【墙】卡住（bodyPathClear 为假）才倒车脱困。
      if (move !== 0) {
        if (this.movingTime === 0) {
          this.anchorX = self.x; // 刚开始想动，锚定起点
          this.anchorY = self.y;
        }
        this.movingTime += dt;
        if (this.movingTime >= AI.stuckWindow) {
          const moved = Math.hypot(self.x - this.anchorX, self.y - this.anchorY);
          const clinch = bodyPathClear && enemyDist < TANK.radius * 3; // 贴脸互顶
          if (moved < AI.stuckMinDist && !clinch) {
            this.unstickTimer = AI.unstickTime;
            this.unstickTurn = Math.random() < 0.5 ? -1 : 1;
            this.path = []; // 卡住说明旧路径不可信，脱困后重算
          }
          this.movingTime = 0; // 无论卡没卡，重开一个检测窗
        }
      } else {
        this.movingTime = 0; // 原地转向不算"想动"，不计入卡住
      }
    }

    // —— 5) 开火：像人一样打——三道门全过才扣扳机 ——
    //   ① 节奏门 + ② 弹药门：已并入 gunReady（冷却就绪 + 自留弹未达上限）
    //   ③ 质量门：开火窗口 = 几何必中角 × 难度 aimSkill，全部对拦截点评估。
    //      必中角随距离近大远小；瞄的是预判落点，所以每发都是"算出来会中"
    //   特殊情况：
    //     - 狂暴模式（自己有护盾）：放宽窗口 1.5 倍，激进开火
    //     - 避战模式（敌人有护盾）：照常开火——盾挡一发即碎，先点破它的盾
    //     - 防守模式（敌人有散射）：缩小窗口 40%，更谨慎
    let fire = false;
    if (self.laserShots > 0 && rhythmReady) {
      // 持激光：hitscan 几何精确判定替代拦截点/质量门——投射当前炮口路径，
      // 扫到敌圆（判定半径收紧到 0.9 倍防擦边浪费）才开，每一发都是必中。
      // easy/normal 只认首段（直线激光）；hard（bounceAim）认全路径——
      // 会转着炮口找角度用反弹激光隔墙烧人。
      // 只受节奏门约束（见 gunReady 处注释）；出膛点传 walls 与实际发射同源，
      // 否则贴墙时 AI 会按穿墙路径判「扫到了」而实弹已被钳成反弹路径。
      const m = self.muzzlePoint(world.maze.walls);
      const path = castLaserPath(m.x, m.y, m.angle, world.maze.walls,
        this.cfg.bounceAim ? {} : { maxBounces: 0 });
      const hitR = TANK.radius * 0.9;
      for (let i = 0; i < path.length - 1; i++) {
        const cp = closestPointOnSegment(
          enemy.x, enemy.y, path[i].x, path[i].y, path[i + 1].x, path[i + 1].y
        );
        if (Math.hypot(enemy.x - cp.x, enemy.y - cp.y) < hitR) {
          fire = true;
          // 仪表：激光是 hitscan 几何判定，扫到就算必中，把握度记 1。
          this.lastConfidence = 1;
          this.lastFireReason = "laser";
          this.shotLog.push({ t: "laser", conf: 1, aimDist: Math.hypot(enemy.x - self.x, enemy.y - self.y) });
          this.fireTimer = randRange(this.cfg.fireCooldown);
          break;
        }
      }
    } else if (los && gunReady) {
      const hitTol = Math.atan2((TANK.radius + BULLET.radius) * AI.hitSlack, aimDist);
      let skillMod = this.cfg.aimSkill;
      if (berserkMode) skillMod *= 1.5;         // 狂暴：放宽窗口，多打
      else if (defensiveMode) skillMod *= 0.6;  // 防守：缩小窗口，更谨慎
      const effTol = hitTol * skillMod;
      if (Math.abs(aimErr) < effTol) {
        fire = true;
        // 仪表：把握度 = 偏角离窗口边界有多远。0 表示刚好压线，1 表示炮口正对。
        const conf = 1 - Math.abs(aimErr) / effTol;
        this.lastConfidence = conf;
        this.lastEffTol = effTol;
        this.lastAimErr = aimErr;
        this.lastFireReason = "line";
        this.shotLog.push({ t: "line", conf, aimErr, effTol, aimDist });
        this.fireTimer = randRange(this.cfg.fireCooldown);
      }
    } else if (this.cfg.bounceAim && !los && gunReady && this.bounceShot) {
      // 跳弹开火：炮口对齐缓存的反弹解即射。容差按总路程算必中角
      //（反弹不损速，等效直线路程）× aimSkill，再乘 0.9 略收紧防浪费。
      const bs = this.bounceShot;
      const tol = Math.atan2((TANK.radius + BULLET.radius) * AI.hitSlack, bs.dist)
        * this.cfg.aimSkill * 0.9;
      if (Math.abs(normalizeAngle(bs.angle - self.angle)) < tol) {
        fire = true;
        // 仪表：跳弹解的把握度同样按「离窗口边界多远」算。
        const conf = 1 - Math.abs(normalizeAngle(bs.angle - self.angle)) / tol;
        this.lastConfidence = conf;
        this.lastFireReason = "bounce";
        this.shotLog.push({ t: "bounce", conf, aimDist: bs.dist });
        this.fireTimer = randRange(this.cfg.fireCooldown);
      }
    } else if (this.cfg.bounceAim && !los && gunReady && !this.bounceShot) {
      // 打墙开路（hard 专属，阶段 22）：无视线、无跳弹解、炮口正对残血内墙
      // （hp≤2，一两发就穿）且墙背后≈敌人方向 → 开火磨墙。玩家能磨墙偷袭，
      // hard 也该会——利用可破坏地形与玩家同权。语义门槛收紧：只有已经
      // 朝向敌人（炮口↔敌方向 <30°）时才打，避免乱枪打墙浪费弹药预算。
      if (Math.abs(aimErr) < Math.PI / 6) {
        // 出膛点传 walls：不钳位时贴着墙的炮口已在墙背面，扫描会跳过
        // 「正顶着的那堵墙」去找下一堵，于是最该磨的墙反而磨不到
        const m = self.muzzlePoint(world.maze.walls);
        const reach = CELL_SIZE * 2; // 只磨脸前两格内的墙（远墙磨不划算）
        const ex2 = m.x + Math.cos(self.angle) * reach;
        const ey2 = m.y + Math.sin(self.angle) * reach;
        for (const w of world.maze.walls) {
          if (w.border || w.hp === undefined || w.hp > 2) continue;
          if (segmentVsSegment(m.x, m.y, ex2, ey2, w.x1, w.y1, w.x2, w.y2)) {
            fire = true;
            // 仪表：磨墙开路不是「想打人」，把握度记 0 —— 它不该触发「说大话」。
            this.lastConfidence = 0;
            this.lastFireReason = "wallbreak";
            this.shotLog.push({ t: "wallbreak", conf: 0 });
            this.fireTimer = randRange(this.cfg.fireCooldown);
            break;
          }
        }
      }
    }

    // —— 6) 部署道具（special 位，与开火完全解耦）——
    // 丢雷的三种时机（任一满足即丢）：
    //   a) 敌在身后半平面且 <2.5 格：逃跑丢雷拦追兵——雷落车尾，正对追击路线
    //   b) 敌贴脸 <1.2 格：混战赌命——自己有避雷逻辑会绕开，对面未必记得住
    //   c) 持雷快超时（<1.5s）：再不丢就作废，丢出去至少封一块地
    // AI 指令没有"边沿触发"概念，用 mineDropTimer 节流防连帧连丢
    // （tryDeploy 侧另有 0.25s 部署冷却兜底）。
    let special = false;
    this.mineDropTimer -= dt;
    if (self.mineCharges > 0 && this.mineDropTimer <= 0) {
      const enemyBehind = Math.abs(normalizeAngle(
        Math.atan2(enemy.y - self.y, enemy.x - self.x) - self.angle
      )) > Math.PI / 2;
      if (
        (enemyBehind && enemyDist < CELL_SIZE * 2.5) ||
        enemyDist < CELL_SIZE * 1.2 ||
        self.mineHoldTimer < 1.5
      ) {
        special = true;
        this.mineDropTimer = 1.0;
      }
    }

    return { turn, move, fire, special };
  }

  // 预判最先命中自己的子弹：对每颗活子弹按当前速度直线外推（忽略未来反弹，
  // 子弹反弹后速度变了下一帧自然重判），求最近逼近时刻 t 与脱靶向量——
  // t 落在 (0, dodgeHorizon] 且脱靶距离小于安全半径才算威胁。
  // 误报（实际会先撞墙拐走的子弹）只是让 AI 多躲一下，无伤大雅。
  // 自己刚打出去的子弹在远离，t<0 天然不触发。
  findThreat(self, bullets) {
    const danger = TANK.radius + BULLET.radius + this.cfg.dodgeMargin;
    let best = null;
    for (const b of bullets) {
      if (b.dead) continue;
      const v2 = b.vx * b.vx + b.vy * b.vy;
      if (v2 === 0) continue;
      // 最近逼近时刻：把"子弹→自己"的相对位置投影到弹速方向
      const t = ((self.x - b.x) * b.vx + (self.y - b.y) * b.vy) / v2;
      if (t <= 0 || t > this.cfg.dodgeHorizon) continue; // 正在远离 / 还太远
      const mx = self.x - (b.x + b.vx * t); // 逼近点指向自己的"脱靶向量"
      const my = self.y - (b.y + b.vy * t);
      if (mx * mx + my * my >= danger * danger) continue; // 擦不到，不用理
      if (!best || t < best.t) best = { b, t, mx, my };   // 盯最急的那颗
    }
    return best;
  }

  // 选一个值得去捡的道具：在感知范围内、对自己有用、且安全可达的道具里挑一个。
  // 返回 {x,y,type} 或 null（没有合适的 → 上层照常追敌）。
  //
  // 多层过滤防"送死捡道具"：
  //   ① 有用性：已有护盾/散射有库存 → 不捡对应类型
  //   ② 范围：超出 powerupRange → 不看（按难度 0/4/7 格：简单不捡、普通保守、困难激进）
  //   ③ 安全性（按难度分级）：
  //      - 简单档：完全不主动捡（powerupRange=0 天然跳过）
  //      - 普通档：保守——必须「附近无弹幕威胁 且 敌人远或无视线」才捡，否则放弃
  //      - 困难档：激进——会权衡收益，盾/散射值得冒一定风险；但弹幕逼脸时仍放弃
  //   ④ 选最近：多个候选时就近，顺路不绕远
  //
  // relaxed: 避战模式放宽限制（敌人有护盾时 AI 需要道具提升实力，安全检查更宽松）
  pickPowerupTarget(self, powerups, world, relaxed = false) {
    if (!powerups || powerups.length === 0) return null;
    const range = this.cfg.powerupRange * CELL_SIZE;
    if (range <= 0) return null; // 简单档 powerupRange=0，天然不捡

    // 找敌人（用于安全评估与机会成本权衡）
    const enemyPlayer = world.players.find((p) => p !== this.player && p.alive);
    if (!enemyPlayer) return null; // 敌人已死，不用抢道具了
    const enemy = enemyPlayer.tank;
    const enemyDist = Math.hypot(enemy.x - self.x, enemy.y - self.y);
    const enemyLos = !segmentHitsWalls(self.x, self.y, enemy.x, enemy.y, world.maze.walls);

    let best = null;
    let bestDist = Infinity;

    for (const p of powerups) {
      if (p.taken) continue;

      // ① 有用性：盾在身上不重复捡；散射/激光/地雷有库存就先用掉再说
      if (p.type === "shield" && self.shield) continue;
      if (p.type === "scatter" && self.scatterShots > 0) continue;
      if (p.type === "laser" && self.laserShots > 0) continue;
      if (p.type === "mine" && self.mineCharges > 0) continue;

      const d = Math.hypot(p.x - self.x, p.y - self.y);
      if (d > range) continue; // ② 超出感知范围

      // ⑥ 线上的饵不吃：道具落在敌方激光预瞄线的杀伤带上，去捡 = 主动压线
      // 挨枪。等对手转开炮口（线每帧重算）这个道具自然解禁。
      if (this.enemyLaserPath &&
          distToPolyline(p.x, p.y, this.enemyLaserPath) < POWERUP.radius + AI.laserHazardRadius) {
        continue;
      }

      // ⑤ 机会成本：与敌对峙中（有视线）时，道具必须明显更近（< 敌距×0.8）
      // 才值得转身去拿——去捡的路上背身挨打，捡回来的收益盖不住亏损
      if (!relaxed && enemyLos && d > enemyDist * 0.8) continue;

      // ③ 安全性评估（按难度分级，relaxed 时放宽）
      if (!this.isPowerupSafe(self, p, enemy, world, relaxed)) continue;

      if (d < bestDist) { // ④ 取最近
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  // 判断去捡道具 pw 是否安全（普通档保守、困难档激进）
  // relaxed: 避战模式放宽限制（敌人有护盾，AI 需要道具提升实力，安全检查更宽松）
  isPowerupSafe(self, pw, enemy, world, relaxed = false) {
    const cfg = this.cfg;

    // 困难档：激进策略——只要弹幕不是逼到脸上就敢冲（盾/散射收益大）
    // （档位判定用 bounceAim 特征位而非 label 文案——label 是 UI 显示词，改文案不该改行为）
    if (cfg.bounceAim) {
      // 道具方向有逼近的子弹 且 <1 秒内会命中 → 太危险，放弃
      const threat = this.findThreat(self, world.bullets);
      if (threat && threat.t < 1.0) {
        // 检查威胁方向是否与道具方向夹角 <60°（冲向道具会撞子弹）
        // 威胁方向 = 自己指向子弹当前位置（threat.mx/my 是脱靶向量不是坐标，不能当点用）
        const toThreat = Math.atan2(threat.b.y - self.y, threat.b.x - self.x);
        const toPowerup = Math.atan2(pw.y - self.y, pw.x - self.x);
        let diff = Math.abs(toThreat - toPowerup);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        if (diff < Math.PI / 3) return false; // 夹角 <60°，冲过去会撞子弹
      }
      return true; // 其他情况都敢冲
    }

    // 普通档：保守策略——必须两条都满足才捡（relaxed 时放宽）
    //   A. 附近无弹幕威胁（1.5 秒内不会被子弹命中）
    //   B. 敌人无法拦截（距离远 >6 格 OR 无视线守株待兔）
    // relaxed 模式（避战时）：只要没有迫在眉睫的弹幕威胁（<0.8 秒）就敢捡，忽略敌人距离
    // 注意：这里声明的 1.5s/0.8s 时间窗实际受 findThreat 的 dodgeHorizon 钳位
    // （normal 0.4s、hard 1.1s），所以 normal 档的真实感知窗是 min(1.5, 0.4)=0.4s
    const threat = this.findThreat(self, world.bullets);
    const threatLimit = relaxed ? 0.8 : 1.5;
    if (threat && threat.t < threatLimit) return false; // A 不满足：附近有弹幕

    if (!relaxed) {
      const distToEnemy = Math.hypot(enemy.x - pw.x, enemy.y - pw.y);
      const hasLos = !segmentHitsWalls(enemy.x, enemy.y, pw.x, pw.y, world.maze.walls);
      if (distToEnemy < CELL_SIZE * 6 && hasLos) return false; // B 不满足：敌人近且有视线能守株待兔
      // C. 敌人贴着自己（<3 格）也放弃——即使它看不到道具，掉头就会被咬尾
      if (Math.hypot(enemy.x - self.x, enemy.y - self.y) < CELL_SIZE * 3) return false;
    }

    return true; // 都满足，安全
  }
}
