# dsh-remote

[English](README.en.md) | **中文**

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的 Web 界面加一层**带设备鉴权的远程访问**：
手机点一条链接就能进 DSH，但**没配对过的设备连不上**，只读设备**发不出指令**。

> 状态：守卫 + 长期链接 + 角色强制 + 隧道监督 + 二维码 + DSH 界面插件均已实现并实测。
> 测试合计 **245 项断言**：守卫 111 / 二维码 46 / 面板（真实 DOM）33 / 插件路由 29 / 桌面工具 15 / 隧道实测 11，
> 全绿。逐条验证记录见文末「验证记录」。

---

## 为什么需要它

三条都是 DSH 的既有行为，不是我们的假设：

| 事实 | 出处 |
|---|---|
| DSH **拒绝**把界面开放到网络：`dsh --host 0.0.0.0` 直接报错，理由是 "would expose remote code execution to the network"；`@deepseek-ai/dsh-host-webserver` 明确**不提供 TLS、认证或来源策略** | DSH 官方错误文案与包文档 |
| DSH 的 `/api` 是一整套**能操作本机 agent** 的 RPC：`session.prompt` 能让 agent 跑命令、`workspace.delete` 能删会话、`session.cancel` 能中止任务 | 读 `@deepseek-ai/dsh-host-apiproxy` 的路由表 |
| DSH 的 `/api` 有一道**可信来源 fence**：`Host` 必须是回环或在可信名单里，`Origin` 必须同源 | `@deepseek-ai/dsh-client-connection` 的 `isTrustedApiRequest` |

所以：**直接暴露 = 把整台电脑的控制权交出去**；而想远程用，就必须自己补上"鉴权"这一层，并且**不能改 DSH 本身**（它的安全立场是刻意的）。

## 它做什么

```
手机 / 平板 / 另一台电脑
        │  https（隧道或局域网）
        ▼
   ┌─────────────┐   没有配对 → 401 + 配对页（不泄漏 DSH 任何内容）
   │   guard     │   只读设备 → 写请求一律 403（服务端按方法名强制）
   │  (本项目)   │   配对设备 → 透传 + 改写 Host/Origin/Referer
   └──────┬──────┘
          │  http://127.0.0.1:<本地隧道服务端口>
          ▼
   ┌─────────────┐
   │ 本地隧道层   │  例：remote.mjs（页面注入 / 附件瘦身 / 本地端点）
   └──────┬──────┘
          ▼
   ┌─────────────┐
   │  DSH Web GUI│  127.0.0.1:<webPort>（只绑回环）
   └─────────────┘
```

**关键设计**：守卫是**最外层**，DSH 与中间层完全不知情——所以任何 DSH 版本、任何本地反代都能直接放在它后面。

## 快速开始

```bash
# 1) 启动守卫（默认 127.0.0.1:8443 → 上游 127.0.0.1:3081）
node guard/guard.mjs serve

# 2) 查看当前手机链接（主设备 + 只读各一条，长期有效）
node guard/guard.mjs pair
#   要脚本友好就用 --role：最后一行是裸链接
node guard/guard.mjs pair --role owner
node guard/guard.mjs pair --role readonly
#   要在终端里直接打一张可扫的二维码（手机相机扫屏幕即进，不用复制粘贴）
node guard/guard.mjs pair --qr
node guard/guard.mjs qr --role readonly        # 只出二维码
node guard/guard.mjs qr --svg > 手机链接.svg    # 存成图片（面板里也是这张）

# 3) 把链接发到手机，或让手机相机扫终端/面板上的二维码

# 4) 公网入口交给守卫托管（自动重启、域名写入 public-url.txt）
node guard/guard.mjs tunnel up
```

常用命令：

```bash
node guard/guard.mjs pair --reset        # 重置：换新链接，旧的立即作废（已配对设备不受影响）
node guard/guard.mjs pair --code         # 临时给一台设备一次性凭据（5 分钟、一次性）
node guard/guard.mjs qr [--role X] [--svg]  # 打印/输出当前链接的二维码
node guard/guard.mjs devices             # 列出已授权设备
node guard/guard.mjs revoke <id|名字>     # 吊销设备（立即失效其所有会话）
node guard/guard.mjs status              # 监听 / 上游健康 / 隧道 / 设备数
node guard/guard.mjs tunnel up|down|status   # down 会同时关掉「自动重启」的意图
```

### 链接形态（对齐 ZCode）

- **长期有效**：主设备链接与只读链接各一条，**只有 `--reset` 才换**；重置会让旧链接立刻失效，但已配对设备照常使用。
- **可重复使用**：链接不是一次性的；同一台设备反复打开只会刷新它自己的凭据，不会在设备列表里堆记录。
- **只读链接是读取当前值**：查看只读链接不会动主链接。
- 打开流程：服务端校验 token → 下发 30 天 cookie → **302 重定向把 token 从地址栏抹掉**；响应带 `Referrer-Policy: no-referrer`。
- **扫码进入**：`pair --qr` 在终端打二维码、面板里点「二维码」在屏幕上显示、插件面板同理；
  二维码由内置编码器生成（`guard/qr.mjs`，零依赖），逐模块与参考实现比对过（见「验证记录」）。
- **代价**：token 在 URL 里，会经过聊天软件、浏览器历史、截图。所以：作废要主动（`--reset`），
  给别人看用**只读链接**，临时借用一台设备用 `--code`（5 分钟一次性）。
- **一条链接 = 一个「席位」**：链接换来的是**同一个设备记录**（按名字+角色复用），
  所以把只读链接发给多人，他们共用一条设备记录 —— 吊销它会一起掉线。要给每个人独立席位就用 `--code`。

配置：`$DSH_HOME/remote/guard.json`（默认 `~/.dsh/remote/guard.json`；当前两条链接的 token 明文存在这里，因为面板要随时显示它）。
审计：`$DSH_HOME/remote/audit.jsonl`（append-only JSONL）。日志：`guard.log`。

## 鉴权模型

- **配对**：电脑上 `pair` 生成一次性码（5 分钟、用过即失效、错误尝试超限即作废）→ 手机填码换**设备**。
- **会话**：配对成功下发 `HttpOnly; SameSite=Lax` 的会话 cookie（https 下自动带 `Secure`）；服务端只存**令牌哈希**，令牌明文只在配对那一次返回。
- **角色**：
  - `owner` —— 发指令、看图、审批、下载，全权；
  - `readonly` —— 可浏览会话、看图片、订阅事件流；**写操作在服务端被拒**（默认拒绝：只有一份"读语义方法"白名单，其余非 GET 一律 403，新方法不会被漏放）。
- **CSRF**：`SameSite=Lax` + `Origin` 校验双重防护。
- **可吊销**：`revoke` 立即删除设备及其全部会话，无需重启服务。

## 稳定连接

- **隧道监督**：守卫每 10 秒检查隧道进程，掉了按退避（2s→60s）重启，并把新域名写进 `urlFile`；
  实测：杀掉 cloudflared 后 **6 秒**内自动拉起新隧道（域名会变，见下）；
- **想要 / 不想要是显式意图**：`tunnel up` 打开、`tunnel down` 关掉（同时关掉自动重启的意图，不会偷偷复活）；
- **域名可查**：`urlFile` 就是给 agent/skill 读的（本项目默认写到 `public-url.txt`），所以"域名变了不知道新链接"这件事从根上消失；
- **失败可见**：未授权返回**配对页**而不是空错误页；上游不可达、隧道二进制不存在/不可执行时给出明确文案；所有拒绝进审计。

## 部署

| 平台 | 做法 |
|---|---|
| Windows | 计划任务 / 启动目录快捷方式（`Start-Process -WindowStyle Hidden`） |
| macOS | `launchd` 用户级 plist（`KeepAlive=true`） |
| Linux | `systemd --user` unit（`Restart=always`） |

> 模板见 [`docs/deploy/`](docs/deploy/)（Windows 计划任务 / macOS launchd / Linux systemd --user）。核心只有一句：**保持 `guard.mjs serve` 常驻**。

## 威胁模型（请读完再用）

**它保护什么**：没有配对过的设备看不到、也改不了 DSH 的任何东西；只读设备改不了任何东西。

**它不保护什么**：

1. **配对成功的 owner 设备 = 你的电脑**。DSH 的 agent 以你的身份执行命令，这是设计使然，不是缺陷；
2. **只读 ≠ 限制 agent**：它限制的是"谁能下指令"，不是"agent 能做什么"；
3. **隧道本身是别人家的服务**（如 Cloudflare Quick Tunnel），可用性与 ToS 不在本项目控制内；
4. **会话 cookie 存在浏览器里**，手机丢失/被解锁就等于设备被授权——请用 `revoke`；
5. **明文 HTTP 下 cookie 会裸奔**：对外请务必走 https 隧道（本项目的 `Secure` 标记只在 https 下生效）。

**默认即安全**：默认只绑 `127.0.0.1`；没有配对过设备时除了配对页与健康检查一律拒绝（fail-closed）。

## 一个必须知道的坑（本机迁移时踩到的）

如果你的**旧隧道脚本**直接把隧道指向中间层端口（例如 `--url http://127.0.0.1:3081`），
那么**它绕过了守卫**——公网又是裸奔的。正确做法：隧道指向守卫端口（默认 8443），
即用 `guard tunnel up`，或把旧脚本的目标端口改成 8443。

## 在 DSH 界面里看到它

守卫能往**走守卫的页面**（手机端）注入面板，但桌面 DSH 直连自己的端口、不经过守卫，
所以桌面入口是一个独立的 DSH 插件：[`plugin/`](plugin/) —— 见其 README（含两个踩坑硬要求：
`exports["./package.json"]` 必须放行、客户端 chunk 用 `window.__ModuleLoader__.load` 手写）。

一条命令装好（自动拷包、追加挂载段、更新插件名清单，改前先备份；**装完必须重启 DSH**）：

```bash
node bin/install-plugin.mjs                # 或 npm run install-plugin
node bin/install-plugin.mjs --uninstall    # 反向卸载，只删自己加的
node bin/install-plugin.mjs --dry-run      # 只看计划
```

装好后按钮出现在**右下角、EAC监控按钮的正上方**，与它同列同款。

桌面端另有免装插件的取链接脚本：`bin/phone-link.cmd`
（弹窗显示当前链接；`--reset` 重置、`--role readonly` 取只读链接、`--qr` 把二维码用看图程序打开、`--quiet` 只打印不弹窗）。

面板本身长这样：**一条当前链接 + 四个按钮**（复制 / 二维码 / 只读 / 重置）+ 已授权设备列表（可逐个吊销）。
「复制」有明确反馈（按钮变「已复制 ✓」+ 状态行带时间），复制被浏览器拦下时如实提示手动选中。

## 目录

```
guard/guard.mjs      守卫：鉴权、角色强制、长期链接、二维码、隧道监督（零第三方依赖，仅 Node 内置模块）
guard/qr.mjs         内置二维码编码器（字节模式 / 版本 1–10 / L-M-Q-H / 自动择优掩码，零依赖）
guard/ui.js          守卫注入到手机端页面里的控制面板
plugin/              DSH 界面插件（桌面端的「手机链接」面板 + 控制面路由）
bin/                 桌面快捷脚本（取链接 / 重置 / 二维码 / 复制到剪贴板）
test/                测试：selftest(111) qr(46) panel.dom(33) plugin(29) bin(15) tunnel(11)
docs/deploy/         Windows / macOS / Linux 常驻模板
```

跑测试：

```bash
npm test              # 守卫 + 二维码 + 插件 + 桌面工具（不需要任何第三方依赖）
npm run test:panel    # 面板真实 DOM 行为（需先 npm i --no-save jsdom）
npm run test:tunnel   # 真实 cloudflared 的隧道自愈/关闭实测（约 1–2 分钟，没有则跳过）
```

## 验证记录（每条功能都实测过）

写这个项目的过程中，实测抓出并修掉了下面这些**真问题**（都不是"看代码觉得对"）：

| 功能 | 实测发现的问题 | 修法 |
|---|---|---|
| `tunnel down` | 只杀进程、不关「想要隧道」的意图 → 守护 10 秒后又把它拉回来（实测 12 秒复活） | `down` 同时写 `superviseTunnel=false` |
| 跨源预检 | OPTIONS 的 204 不带 CORS 头 → 浏览器拦下页面里的跨源 POST（面板的兜底重置/吊销会失败） | `withLocalCors` 对所有 `writeHead` 调用都合并 CORS 头 |
| 插件兜底重置 | 客户端直连守卫时没有对应端点（`/__guard/reset` 404） | 新增 `POST /__guard/reset`，并把 `/dsh-remote/reset`、`/dsh-remote/qr` 加进兜底映射 |
| 隧道启动失败 | `spawn` 失败只留一条 `unhandledRejection`，`tunnel up` 却报「等待域名超时」；`.cmd/.bat` 包装脚本会被 Node 直接拒绝 | 接住 `error` 事件、提前退出等待、把真实原因打出来（含 `.cmd` 专门提示） |
| 面板「只读」按钮 | 点开后再也收不起来（切换条件写错，用户报过） | 改成真正的开/关切换，并加进 DOM 回归用例 |
| 桌面工具 `--reset --role readonly` | `--reset` 被静默忽略 | 透传 `--reset`，并加进 bin 测试 |
| 二维码编码器（自研） | ① 格式信息格子没在放数据前标成功能区 → 码流出现空洞，**扫码器直接解不出**；② 2 号掩码把「列」写成了「行」；③ N4 评分公式与标准不同 → 自动择优选错掩码 | 三处都修，然后用参考实现做**逐模块**比对：1332 个组合（文本 × 版本 × 纠错级 × 掩码）全部一致，并用 jsqr 端到端解码验证 |

验证工具与结论：

- **守卫**：`test/selftest.mjs`（102 项）—— fail-closed、配对码、长期链接语义、只读边界、owner 控制面、
  WS 白名单、Origin/CSRF、本机直连可信与公网不可信、页面注入与外观纠偏、二维码端点、重置端点、隧道意图、审计。
- **二维码**：`test/qr.test.mjs`（46 项）—— 6 组黄金矩阵逐模块比对 + 3 组 RS 纠错向量 + 生成多项式 +
  结构断言；黄金向量由 npm 的 `qrcode` 生成（仅在开发机上用来生成向量，**不是运行时依赖**）。
- **面板**：`test/panel.dom.mjs`（33 项）—— 用 jsdom 真挂面板并点一遍：复制反馈、只读开关、
  二维码内联、重置走 POST、吊销、关闭后遮罩一并移除、剪贴板被拒时如实报错、插件槽位注册与去重。
- **插件路由**：`test/plugin.test.mjs`（29 项）—— 真挂 handler，`reset`/`qr` 真调守卫 CLI，准入两道闸。
- **桌面工具**：`test/bin.test.mjs`（15 项）—— 临时 DSH_HOME，验证默认不换链接、`--reset` 语义、二维码落盘。
- **隧道**：`test/tunnel.test.mjs`（11 项）—— 真实 cloudflared：拿到域名并写 urlFile、杀掉后 6–45 秒自愈、
  `down` 后 24 秒不被拉回。

## 路线图

- 命名隧道 / 固定域名（Quick Tunnel 的域名每次重启都会变，是当前最大的体验缺口）
- `guard.mjs doctor` 自检（上游可达性、隧道健康、端口占用一次查清）
- 审计查看页、按设备限速、只读设备的读方法白名单可配置
- 完成通知推送

## 许可

MIT
