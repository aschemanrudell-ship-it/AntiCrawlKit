# AntiCrawlKit

[English](README.md) | **简体中文**

站点开始反击了：页面认定你是机器人、丢给你一张滑块、或者干脆回你 `429`。AntiCrawlKit 是四个本地命令，把"猜"换成"测" —— 到底是**哪几个**信号露了你、这段混淆 JS 在**干什么**、缺口在**哪一列**、**多快**会被限流。

没有网络服务，没有遥测，**零运行时依赖**。全部在本机用 Node 自带的 `WebSocket`、`fetch`、`node:zlib`、`node:vm` 跑。

| 我遇到的情况 | 用哪个命令 | 拿回来什么 |
|---|---|---|
| 页面认定我是机器人 | `fingerprint` | 命中的规则（如 `headless-ua`）、0–100 评分、每条规则的修法 |
| 这个文件藏了什么 | `detect`、`deobf` | 识别出的手法 + 指标，以及还原后的可读代码 |
| 滑块怎么都拖不过去 | `slider`、`track` | 缺口列号与宽度，以及带真实时间节奏的拖动轨迹 |
| 一直吃 429 | `rate` | 按主机自适应的速率：被限就降，连续成功就升 |

## 它到底能干什么 —— 下面是真跑出来的输出，不是示意图

### 1. 审计一个页面：我是哪个信号露的？

把工具指向你**自己**带调试端口启动的 Chrome（`--remote-debugging-port`）。它通过 CDP 附加，在页内采集约 40 个信号，用 25 条规则打分。

```console
$ node src/cli.mjs fingerprint --expect-timezone Asia/Shanghai
target      about:blank
url         about:blank
verdict     obviously-automated
likelihood  52/100
counts      critical=1 warn=2 info=0

[critical] headless-ua - UA advertises HeadlessChrome
         fix: Launch with a real UI (headless: false) or set a full desktop UA
              via Network.setUserAgentOverride plus matching client hints.
[warn] canvas-unstable - Canvas fingerprint is not stable between two draws
         fix: Expected only when the page injects canvas noise. If you did not
              opt into noise, something is rewriting toDataURL.
[warn] missing-device-memory - navigator.deviceMemory is missing on a Chrome UA
         fix: deviceMemory is present on real Chrome (8 by default). Restore it
              in an init script if a stealth patch deleted it.
```

这是对 `Chrome/156.0.8078.73 --headless=new` 的真实运行结果。换成有头窗口，通常会落到 `plausibly-human` —— 两次运行之间的差异，正好就是你要修的东西。`--json` 会吐出完整快照，方便改动前后对比。

### 2. 读懂混淆 JS：这个文件到底在干什么？

```console
$ node src/cli.mjs detect demo/obfuscated.js
verdict   obfuscated (score 22/100)
size      374 bytes, 7 lines, longest line 130
literals  6 strings, 0 eval, 0 Function()

[high] string-array - String-array obfuscation (_0x… identifiers)
         string table `_0x1f2a` with index access

next steps:
  - run `anticrawl deobf <file>` to inline the string array (decoder wrappers included)
```

然后把它还原 —— 包括**解码包装函数**，这是大多数工具漏掉的部分：

```console
$ node src/cli.mjs deobf demo/obfuscated.js
in   obfuscated (22)
out  obfuscated (22)

stages:
  string-array-inline  {"arrays":1,"references":4,"decoded":4,
                        "decoders":[{"name":"_0x9c","array":"_0x1f2a","offset":0}],
                        "rotated":[],"pruned":[]}
  strip-debugger  {"removed":1}
  pretty  {"lines":22}
--- output ---
console.log("hello"+"world");
console["log"]("spam");
```

`_0x9c(i)` 这层包装函数被换成了它的值，`debugger` 陷阱变成普通注释，轮转 IIFE 还留着 —— 你可以继续看，也可以 `--prune` 掉。

### 3. 滑块验证码：缺口在哪？

喂它一张背景图 PNG。不用浏览器，不联网 —— 纯像素运算。

```console
$ node src/cli.mjs slider demo/bg.png
method   edges
position x=120 width=29
score    290.888
image    360x180

candidates:
  x=120 w=29 score=290.888
  x=120 w=30 score=290.7014
  x=119 w=30 score=290.544
```

那张合成图的真值是 `x=120, w=30` —— 列号正确，宽度差 1 px，这就是文档里写的"硬台阶边缘 ±1 px"。接着生成轨迹：

```console
$ node src/cli.mjs track --distance 137 --seed 42
{ "distance": 137, "durationMs": 457, "moves": 52, "overshoot": 1,
  "wallClockMs": 460, "points": [ { "x": 1, "y": -2, "dt": 7 }, … ] }
```

`points` 是 `{dx, dy, dt}`，直接用 `Input.dispatchMouseEvent` 回放；轨迹含过冲与回落，不是到点即停。

### 4. 控速：多快会被限流？

```console
$ node src/cli.mjs rate
bucket: rate=2/s burst=2 (fake clock, jitter off for readability)
  take #1: waited 0ms, clock=0ms
  take #3: waited 500ms, clock=500ms

adaptive host limiter:
  start rate 2/s (ceiling 2, recoverAfter 3)
  HTTP 200 -> hold     2.00/s
  HTTP 429 -> decrease 1.00/s
  HTTP 429 -> decrease 0.50/s
```

`429/503/403/412/420` 减半；`401/404/410` 只保持不动（请求本身错了，不是被限流）；连续成功后再逐步爬升。

## 五分钟跑通

```bash
git clone https://github.com/aschemanrudell-ship-it/AntiCrawlKit.git
cd AntiCrawlKit
node --version              # 必须 >= 22
node src/cli.mjs doctor     # 6 项能力自检
node --test                 # 100 个离线测试，约 0.5 秒
```

先试不需要联网的两半：

```bash
node src/cli.mjs detect demo/obfuscated.js      # 样本用了哪些手法
node src/cli.mjs deobf  demo/obfuscated.js      # 还原出来的代码
```

再试需要你自己浏览器的那个 —— 工具不会替你启动 Chrome：

```bash
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-profile
node src/cli.mjs fingerprint                    # 默认连 127.0.0.1:9222
```

看 findings，只修真正成立的那几条，重跑，用 `--json` 对比。这个循环就是全部用法。

## 当作 Agent 技能用

`skill/SKILL.md` 是一份写好的技能定义（YAML front matter + 四套 workflow + 规则），让编码 Agent 直接用这套工具，而不是每次从零手搓。里面写清了命令、执行顺序和坑（±1 px、`--rotate` 会执行代码、不要只修单个信号）。

技能加载后 Agent 拿到什么：

- **触发条件** —— 声明了 `whenToUse`：反爬信号、指纹泄漏、混淆 JS、滑块验证码、429/403 限流。普通无对抗的抓取不该加载它。
- **Workflow A** —— 起带调试端口的 Chrome，跑 `fingerprint`，读 verdict → `remediation[]`，附带"信号 → 修法"对照表。
- **Workflow B** —— 固定的流水线顺序（`packer-unpack` → `string-array-inline` → `strip-debugger` → `pretty`），以及 `decoded: 0` 意味着什么。
- **Workflow C** —— 用 CDP 截 PNG，`slider` → `travelDistance` → `generateTrack` → `toCdpEvents` → `Input.dispatchMouseEvent`。
- **Workflow D** —— 把 `HostLimiter.observe()` 接进 fetch 循环。

装到 Agent 会去找的位置：

```bash
# DeepSeek Harness / dsh（DSH_HOME 默认 ~/.dsh）
mkdir -p "$DSH_HOME/skills/anticrawl-kit"
cp skill/SKILL.md "$DSH_HOME/skills/anticrawl-kit/SKILL.md"

# Claude Code（项目内或 ~/.claude/skills/）
mkdir -p .claude/skills/anticrawl-kit
cp skill/SKILL.md .claude/skills/anticrawl-kit/SKILL.md
```

`name:` 字段（`anticrawl-kit`）就是技能 id。装完之后，跟 Agent 说"看看这个站为什么觉得我是机器人"，它会加载技能、用正确的参数跑 `fingerprint`，而不是自己现写一个 puppeteer 脚本。

如果你的环境不支持技能，直接把 `skill/SKILL.md` 整篇贴进对话当提示词用 —— 它是按可独立使用写的。

## 技术栈

- Node.js **>= 22**（纯 ESM，测试用 `node --test`）。
- 零运行时依赖。`package.json` 故意不写 `dependencies`。
- 实时页面操作走 CDP（Chrome DevTools Protocol），复用全局 `WebSocket`。

## 目录结构

```text
AntiCrawlKit/
+- src/
|  +- index.js              # 库入口：导出清单 + 帮助文本
|  +- cli.mjs               # `anticrawl <command>`；也含 `selftest`
|  +- lib/cdp.mjs           # 极简 CDP 客户端（列目标、附加、evaluate）
|  +- fingerprint/
|  |  +- probe.mjs          # 页内快照采集器（注入用的源码字符串）
|  |  +- audit.mjs          # 25 条规则 -> verdict + findings + 修复建议
|  +- webcrack/
|  |  +- detect.mjs         # 手法识别 + 指标 + 下一步建议
|  |  +- strings.mjs        # 字符串表、解码包装函数、轮转、编码块
|  |  +- pretty.mjs         # 重缩进、去 debugger、收尾整理
|  |  +- deobfuscate.mjs    # packer -> 字符串 -> 去 debugger -> 美化 流水线
|  +- slider/
|  |  +- png.mjs            # 无依赖 PNG 解码器（zlib inflate）
|  |  +- detect.mjs         # 列边缘能量找缺口 + NCC 模板匹配
|  |  +- track.mjs          # 拟人指针轨迹 + CDP 事件转换
|  |  +- solve.mjs          # CDP 截图 -> 解码 -> 找缺口 -> 拖动
|  +- rate/bucket.mjs       # TokenBucket、HostLimiter（AIMD）、退避
+- tests/                   # node --test，完全离线
+- demo/                    # 一个真实的 obfuscator.io 风格样本，用来试命令
+- docs/                    # 架构、验证记录、交接
\- skill/SKILL.md           # 面向 Agent 的封装（复制进 DSH 技能目录）
```

## 安装

除了 Node 什么都不用装：

```bash
node --version        # 必须 >= 22
npm run doctor        # 校验 WebSocket、fetch、zlib、vm、PNG 解码器
```

可选装成全局命令：

```bash
npm link              # 之后可直接 `anticrawl --help`
```

## 用法

```bash
# 1. 自己带调试端口启动 Chrome，然后审计它。
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-profile
npm run cli -- fingerprint --json
npm run cli -- fingerprint --expect-timezone Asia/Shanghai --webrtc

# 2. 这个文件到底藏了什么？
npm run cli -- detect suspicious.js
npm run cli -- deobf suspicious.js --out clean.js
npm run cli -- deobf suspicious.js --rotate --prune --json

# 3. 滑块缺口，离线，从已保存的截图算。
npm run cli -- slider bg.png                      # 只找缺口
npm run cli -- slider bg.png --piece piece.png    # 模板匹配

# 4. 输出一条拖动轨迹 JSON（喂给 Input.dispatchMouseEvent）。
npm run cli -- track --distance 137 --seed 42

# 5. 用假时钟验证限流器。
npm run cli -- rate
```

## 作为库调用

```js
import { auditPage } from './src/fingerprint/audit.mjs';
import { deobfuscate } from './src/webcrack/deobfuscate.mjs';
import { decodePng } from './src/slider/png.mjs';
import { detectGap, travelDistance } from './src/slider/detect.mjs';
import { HostLimiter, backoffDelay } from './src/rate/bucket.mjs';

const audit = await auditPage('http://127.0.0.1:9222', { expectTimezone: 'Asia/Shanghai' });
// -> { verdict, headlessLikelihood, counts, findings[], remediation[] }

const { code, report } = deobfuscate(source, { rotate: true, prune: true });
// -> report.before / report.after / report.stages / report.warnings

const limiter = new HostLimiter({ ratePerSec: 2 });
await limiter.acquire('https://example.test/list');
limiter.observe('https://example.test/list', { status: 429 }); // -> 速率减半
```

## 验证命令

```bash
npm test      # 100 个测试，全离线，约 0.5 秒
npm run selftest   # 11 项跨子系统端到端自检
npm run doctor     # 6 项运行时能力检查
verify-ai-project -Path 'D:\AIProjects\DeepSeek Harness\AntiCrawlKit'
```

最近一次记录见 [docs/VERIFY-RESULTS.md](docs/VERIFY-RESULTS.md)。

## 状态

- **v0.1.0 —— 四件工具均可用。** 在 Node v24.19.0 / Windows 11 上：测试 100/100、自检 11/11、doctor 6/6 全通过。
- `fingerprint`：25 条规则（critical 10 / warn 12 / info 3），给出打分结论（`plausibly-human` → `obviously-automated`），逐条附修复建议。
- `webcrack`：p.a.c.k.e.r 解包、字符串表内联（**含解码包装函数** `function _0xd(i){i=i-0x1;return T[i]}`）、可选在隔离 `vm` 中重放轮转、去 debugger、重缩进。
- `slider`：无依赖 PNG 解码（位深 1-16，颜色类型 0/2/3/4/6）、列边缘能量找缺口、NCC 模板匹配、带过冲回落的拟人轨迹、CDP 事件转换。
- `rate`：带抖动的令牌桶、按主机 AIMD 限流（遇 429/503/403/412/420 减半，连续成功后逐步恢复）、全抖动指数退避。

## 已知限制

这些是真实边界，不是包装成功能的 TODO：

1. **`fingerprint` 需要外部浏览器。** 工具不会自己启动 Chrome。没有 CDP 端点就报连接错误 —— 这是设计。
2. **滑块检测在硬台阶边缘有 ±1 px 误差**（相邻两列得分完全相同）。真实滑块能容忍几个像素，不要指望 `detectGap` 给亚像素精度。
3. **滑块图片只吃 PNG。** 不解析 JPEG/WebP，请用 `Page.captureScreenshot {format:'png'}`。隔行（Adam7）PNG 会被明确拒绝，而不是静默解错。
4. **`webcrack` 是启发式，不是 AST。** 不做控制流平坦化还原，不做 JSFuck/Aaencode 的**解码**（只识别），不做死代码消除。目标是 obfuscator.io 那一族。
5. **字符串内联只做单层。** 支持字面量索引（`T[0x1]`）和一层解码包装函数。嵌套解码（`f(g(i))`）、算术索引（`T[i-0x1+k]`）不动 —— 会给警告，绝不静默给错结果。
6. **`--rotate` 会执行轮转 IIFE**（在带超时的 `node:vm` 里）。那仍然是执行：只对你愿意运行的文件用。
7. **`rate` 状态在内存里。** 重启进程即忘记各主机速率。没有代理池，没有持久化。
8. **不做指纹伪装。** 这是审计工具：它告诉你哪里漏了，不替你改浏览器。

## 下一步

- 对着真实 CDP 目标跑通 `slider solve` 端到端（目前只测了纯函数）。
- 所有命令都支持 `--json`（现在只有 `fingerprint`、`deobf`、`detect`、`track`）。
- `webcrack` 支持嵌套解码（两遍内联）。
- 在现有识别的基础上补 JSFuck/Aaencode/JSJiami 解码器。
- 可选的 `types/index.d.ts`。
- `fingerprint` 对比模式：把两次快照（有头 vs 无头）合成一张"变了什么"的表。

## 交接说明

- 先读 `..\AGENTS.md`（Agent 规则）和 `..\..\AGENTS.md`（区域规则）。
- 变更登记到 `..\PROJECTS.md` 与 `..\..\PROJECT_INDEX.md`。
- 不要提交密钥或真实用户数据；占位符保持 `<PLACEHOLDER>` 形式。
- 动任何模块前先读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 每个模块都有明确契约，测试就是契约的编码。
- `work/` 是临时目录且已 git 忽略；`npm test` 不需要它。
- `skill/` 是对 Agent 暴露的接口。改了 CLI 参数或模块导出，记得同步 `skill/SKILL.md`。
