# dsh-remote

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的 Web 界面加一层**带设备鉴权的远程访问**：
手机点一条链接就能进 DSH，但**没配对过的设备连不上**，只读设备**发不出指令**。

> 状态：守卫 + 长期链接 + 角色强制 + 隧道监督 + DSH 界面插件均已实现并实测（自测 65 项断言全绿）。
> 剩余事项见文末路线图。

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

# 3) 把链接发到手机，点开即自动配对进入 DSH

# 4) 公网入口交给守卫托管（自动重启、域名写入 public-url.txt）
node guard/guard.mjs tunnel up
```

常用命令：

```bash
node guard/guard.mjs pair --reset        # 重置：换新链接，旧的立即作废（已配对设备不受影响）
node guard/guard.mjs pair --code         # 临时给一台设备一次性凭据（5 分钟、一次性）
node guard/guard.mjs devices             # 列出已授权设备
node guard/guard.mjs revoke <id|名字>     # 吊销设备（立即失效其所有会话）
node guard/guard.mjs status              # 监听 / 上游健康 / 隧道 / 设备数
node guard/guard.mjs tunnel up|down|status
```

### 链接形态（对齐 ZCode）

- **长期有效**：主设备链接与只读链接各一条，**只有 `--reset` 才换**；重置会让旧链接立刻失效，但已配对设备照常使用。
- **可重复使用**：链接不是一次性的；同一台设备反复打开只会刷新它自己的凭据，不会在设备列表里堆记录。
- **只读链接是读取当前值**：查看只读链接不会动主链接。
- 打开流程：服务端校验 token → 下发 30 天 cookie → **302 重定向把 token 从地址栏抹掉**；响应带 `Referrer-Policy: no-referrer`。
- **代价**：token 在 URL 里，会经过聊天软件、浏览器历史、截图。所以：作废要主动（`--reset`），
  给别人看用**只读链接**，临时借用一台设备用 `--code`（5 分钟一次性）。

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
- **域名可查**：`urlFile` 就是给 agent/skill 读的（本项目默认写到 `public-url.txt`），所以"域名变了不知道新链接"这件事从根上消失；
- **失败可见**：未授权返回**配对页**而不是空错误页；上游不可达时给出明确文案；所有拒绝进审计。

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

桌面端另有免装插件的取链接脚本：`bin/phone-link.cmd`（弹窗显示当前链接，`--reset` 重置，`--role readonly` 取只读链接）。

## 目录

```
guard/guard.mjs      守卫：鉴权、角色强制、长期链接、隧道监督（零第三方依赖，仅 Node 内置模块）
guard/ui.js          守卫注入到手机端页面里的控制面板
plugin/              DSH 界面插件（桌面端的「手机链接」面板 + 控制面路由）
bin/                 桌面快捷脚本（取链接 / 重置 / 复制到剪贴板）
test/selftest.mjs    自测：用假上游跑完整鉴权与角色矩阵（65 项断言，不碰真实 DSH）
docs/deploy/         Windows / macOS / Linux 常驻模板
```

## 路线图

- 配对二维码（手机扫码，省去复制粘贴）
- `guard.mjs doctor` 自检（上游可达性、隧道健康、端口占用一次查清）
- 审计查看页、按设备限速、只读设备的读方法白名单可配置
- 完成通知推送

## 许可

MIT
