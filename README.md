# 坦克回廊 | Tank Trouble

本地多人对战坦克小游戏，迷宫随机生成 + 子弹反弹 + 人机 AI。

Local multiplayer tank combat game with procedural maze generation, bullet ricochet, and AI opponent.

> **这个仓库是二创。** 上游是 [AbyssWhalen/tank-trouble](https://github.com/AbyssWhalen/tank-trouble)（MIT），
> 原项目版权归 AbyssWhalen 所有。本仓库在此基础上接入 Coopanion 桌宠：对局里发生值得说的
> 时刻会送给桌宠 Coo，由它在气泡里开口。改动部分同样以 MIT 发布。
>
> **This is a fork.** Upstream is [AbyssWhalen/tank-trouble](https://github.com/AbyssWhalen/tank-trouble)
> (MIT), copyright AbyssWhalen. Changes here wire the game into Coopanion's desktop pet, so the pet
> can talk during a match. The changes are MIT too.

---

## 游戏特色 | Features

- 🎮 **双人对战 + 人机 + 挑战闯关 + 波次生存** | PvP, PvE, single-player challenge campaign (8 levels) & endless wave survival
- 🗺️ **随机迷宫·三种风格轮换** | Procedural mazes in 3 styles (sparse grid / mirrored arena / rooms & corridors) × 3 size tiers
- 💥 **子弹反弹物理** | Realistic bullet ricochet off walls
- 🎁 **四种道具·菜单可自选组合** | 4 power-ups, individually toggleable:
  - 散射（扇形三连发） | Scatter shot
  - 护盾（挡一发即碎） | One-hit shield
  - 激光（瞬时射线沿墙反弹 + 预瞄虚线） | Bouncing laser with aim preview
  - 地雷（独立道具键布雷，布防后隐形） | Stealth mines on a dedicated key
- 🧱 **可破坏地形** | Destructible terrain: bullets erode inner walls shot by shot, mines blast them instantly (menu-toggleable)
- 🤖 **三档难度 AI** | AI with Easy/Normal/Hard difficulty levels
  - 智能躲弹 + 拦截预判射击 | Adaptive dodging + predictive aim
  - 近战反打决策 | Close-combat counter-attack logic
  - 识别对手道具调整策略、绕雷寻路、边打边布雷 | Reads opponent power-ups, avoids mines, drops mines while fighting
  - 躲对手激光预瞄线（全程弹道含反弹段，绕线走位） | Evades the opponent's laser aim-line (full path incl. bounces)
  - 困难档:跳弹吊射、反弹激光狙 | Hard: bank shots & ricochet laser snipes
- ⌨️ **键位自定义** | Rebindable controls (persisted locally)
- 🖥️ **F11 全屏** | Fullscreen toggle with state memory
- ✨ **手感特效** | Screen shake, muzzle flash, bullet trails & explosions
- 🔊 **程序合成音效·零素材文件** | Procedurally synthesized SFX (Web Audio, zero asset files), mute toggle persisted
- 🎯 **局胜制·先到 5 分赢下整场** | First to 5 rounds wins the match
- ♾️ **波次生存·一条命打到底** | Endless wave survival: one life, waves of AI that grow in count & skill, forced supply drop between waves, arena remapped (and sized up) every 5 waves — your bullet holes and mines carry over inside a chapter; personal best persisted
- ⏱️ **开场倒计时 + 击杀慢动作 + 战绩统计** | Round countdown, kill slow-mo & persistent stats
- 📟 **HUD 武器状态指示** | On-HUD weapon & shield badges with ammo counts
- 📐 **自适应窗口** | Responsive viewport scaling

---

## 按键操作 | Controls

默认键位如下，可在菜单左下角 ⚙ 设置面板的「键位设置」里自定义（重启后保留）。

Default bindings below — rebind them via ⚙ Settings → 键位设置 at the bottom-left of the menu (persisted across restarts).

### 玩家 1 | Player 1
- **移动** | Move: `W` `A` `S` `D`
- **开炮** | Fire: `Space`
- **放道具** | Deploy (mines): `E`

### 玩家 2 | Player 2
- **移动** | Move: `↑` `←` `↓` `→`
- **开炮** | Fire: `Enter`
- **放道具** | Deploy (mines): `右Shift | Right Shift`

### 通用 | Common
- **暂停 / 返回菜单** | Pause / back to menu: `Esc`
- **结算时立即开下一局** | Next round instantly (on round-over): `R`
- **全屏** | Fullscreen: `F11`

---

## 下载与安装 | Download & Installation

### Windows 用户 | For Windows Users

前往 [Releases](https://github.com/AbyssWhalen/tank-trouble/releases) 页面下载最新版 `.exe` 安装包，双击运行即可。

Go to the [Releases](https://github.com/AbyssWhalen/tank-trouble/releases) page, download the latest `.exe` installer, and run it.

### 从源码运行 | Run from Source

需要 Node.js 18+ 和 npm。

Requires Node.js 18+ and npm.

```bash
# 克隆仓库 | Clone repository
git clone https://github.com/AbyssWhalen/tank-trouble.git
cd tank-trouble

# 安装依赖 | Install dependencies
npm install

# 启动游戏 | Launch game
npm start
```

---

## 开发 | Development

```bash
# 开发模式启动（没有 watcher，改完源码重启窗口生效）| Dev mode (no watcher; restart the window to pick up source changes)
npm start

# 打包 Windows 安装包 | Build Windows installer
npm run dist
```

### 项目结构 | Project Structure

```
tank-trouble/
├── src/              # 游戏逻辑模块 | Game logic modules
│   ├── main.js       # 主循环 + 状态机 | Main loop & state machine
│   ├── ui.js         # 菜单/HUD/浮层 | Menus, HUD & overlays
│   ├── ai.js         # AI 控制器 | AI controller
│   ├── levels.js     # 挑战关卡表 | Challenge campaign levels
│   ├── waves.js      # 波次曲线 | Endless wave curve
│   ├── maze.js       # 迷宫生成 | Maze generation
│   ├── tank.js       # 坦克物理 | Tank physics
│   ├── bullet.js     # 子弹 + 反弹 | Bullet & ricochet
│   ├── laser.js      # 激光射线 | Bouncing laser
│   ├── powerup.js    # 道具刷新 | Power-up spawning
│   ├── mine.js       # 地雷 | Mines
│   ├── audio.js      # 程序合成音效 | Procedural SFX (Web Audio)
│   ├── stats.js      # 战绩统计 | Match stats persistence
│   ├── settings.js   # 设置持久化 | Settings persistence
│   ├── collision.js  # 碰撞检测 | Collision detection
│   └── effects.js    # 视觉特效 | Visual effects
├── scripts/          # 冒烟测试 + AI 对打/关卡/波次跑分 | Smoke tests, AI arena, level & wave scorers (npm run smoke / arena)
├── electron/         # Electron 主进程 | Electron main process
└── index.html        # 渲染进程入口 | Renderer entry
```

---

## 技术栈 | Tech Stack

- **渲染引擎** | Rendering: HTML5 Canvas + Vanilla JavaScript (ES Modules)
- **桌面框架** | Desktop: Electron
- **打包工具** | Build: electron-builder

零运行时依赖，纯前端实现。

Zero runtime dependencies, pure frontend implementation.

---

## 开发日志 | Development Log

- **阶段 0-4**：坦克移动、迷宫生成、子弹反弹、双人对战
- **阶段 5**：回合制计分 + 三档地图自适应缩放
- **阶段 6**：人机模式 + AI（BFS 寻路、八向躲弹、拦截预判、近战反打）+ 爆炸特效
- **阶段 7**：Windows 安装包打包
- **阶段 8**：道具系统（散射 / 护盾）+ AI 识别对手道具 + 暂停功能
- **阶段 9**：界面层重构 + 键位自定义（本地持久化）+ F11 全屏
- **阶段 10**：护盾改「挡一发即碎」+ 屏幕震动 / 炮口火光 / 子弹拖尾
- **阶段 11**：新道具穿墙弹 & 地雷 + AI 避雷 / 布雷
- **阶段 12**：独立道具键 + 激光射线（预瞄虚线）替换穿墙弹 + 隐形地雷 + 道具自选组合 + 冒烟测试
- **阶段 13**：AI 强度打磨——捡道具决策修正、激光精确运用、困难档跳弹吊射，headless 对战验证调参
- **阶段 14**：AI 激光预瞄线防守——消费全程弹道（含反弹段）绕线走位、压线即避；AI 对打竞技场收进仓库（npm run arena）
- **阶段 15**：程序合成音效系统（Web Audio 零素材，12 类事件音 + 菜单静音开关持久化）+ v0.2.0 发布
- **阶段 16**：HUD 武器/护盾徽章（剩余次数 + 到期闪烁）+ 局胜制（先到 5 分整场结算，可再来一场）
- **阶段 17**：可破坏内墙——地雷爆炸炸碎波及圈内墙（外墙不破），地形随战斗演变；菜单「地形」开关
- **阶段 18**：子弹磨墙——内墙带耐久，子弹逐发侵蚀（墙渐淡示血量）归零碎掉；破坏从此每回合可见
- **阶段 19**：主菜单瘦身——难度/道具/地形/音效与键位入口全部收进 ⚙ 设置浮层，首屏只留模式选择
- **阶段 20**：表现层打磨——开场 3-2-1-GO 倒计时（冻结双方，修 AI 抢先手）+ 击杀慢动作 + 战绩统计（命中率/最爱武器/连胜，本地持久化）
- **阶段 21**：地图生成器三风格——稀疏格栅 / 180° 对称竞技场（绝对公平）/ 房间走廊（BSP），每回合随机轮换
- **阶段 22**：AI 行为大修——修复隔墙对撞死锁（半径感知导航）、十余项决策 bug；hard 档学会磨墙开路；卡住次数降一个数量级
- **阶段 23**：挑战关卡模式——单人闯关 8 关（1v2 车轮战/激光狙击/限时歼灭/生存），顺序解锁，进度持久化
- **阶段 24**：无尽波次生存——一条命打无限波，配额/同屏双层调度（同屏最多 3 敌），AI 难度随波次从简单滑向困难，每波强制补给，每 5 波换图升档（第 11 波起上 large 大图），破洞与雷阵在章节内跨波保留，历史最高（波次/击杀）持久化

---

## 许可 | License

MIT License

---

## 致谢 | Credits

灵感来源于经典 Flash 游戏 [Tank Trouble](https://tanktrouble.com/)。

Inspired by the classic Flash game [Tank Trouble](https://tanktrouble.com/).

上游代码与素材由 [AbyssWhalen](https://github.com/AbyssWhalen) 原创，见
[AbyssWhalen/tank-trouble](https://github.com/AbyssWhalen/tank-trouble)。本仓库只在其上做二创。

Upstream code and assets are original work by [AbyssWhalen](https://github.com/AbyssWhalen);
see [AbyssWhalen/tank-trouble](https://github.com/AbyssWhalen/tank-trouble). This repository
only adds to it.
