# AntiCrawlKit

[English](README.md) | **简体中文**

浏览器自动化里“站点开始反击”那半边，需要四件本地工具：

| 工具 | 它回答的问题 |
|---|---|
| `fingerprint` | 这个页面凭什么认定我是机器人？ |
| `webcrack` | 这个文件对自己做了什么手脚，能不能还原？ |
| `slider` | 缺口在哪，怎么拖得像人？ |
| `rate` | 多快会被限流，被限了怎么退？ |

全部在本机跑。无网络服务、无遥测、**零运行时依赖** —— 只用 Node 自带的 `WebSocket`、`fetch`、`node:zlib` 和 `node:vm`。

```bash
git clone https://github.com/aschemanrudell-ship-it/AntiCrawlKit.git
cd AntiCrawlKit
node --version          # 需要 >= 22
node src/cli.mjs doctor # 6 项能力自检
node --test             # 100 个离线测试
```

## 目标

把爬虫与浏览器自动化里的“猜”换成“测”：审计活页面上的自动化痕迹、还原对你做指纹的 JS、离线解图片拖动验证码、用自适应限流控制请求节奏。重点不是**伪装**成人，而是**知道**自己哪几个信号不像人，从源头修掉（有头窗口、真 GPU、诚实的 UA）。

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
- `fingerprint` 对比模式：把两次快照（有头 vs 无头）合成一张“变了什么”的表。

## 交接说明

- 先读 `..\AGENTS.md`（Agent 规则）和 `..\..\AGENTS.md`（区域规则）。
- 变更登记到 `..\PROJECTS.md` 与 `..\..\PROJECT_INDEX.md`。
- 不要提交密钥或真实用户数据；占位符保持 `<PLACEHOLDER>` 形式。
- 动任何模块前先读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 每个模块都有明确契约，测试就是契约的编码。
- `work/` 是临时目录且已 git 忽略；`npm test` 不需要它。
- `skill/` 是对 Agent 暴露的接口。改了 CLI 参数或模块导出，记得同步 `skill/SKILL.md`。
