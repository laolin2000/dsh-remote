# dsh-remote-panel —— DSH 界面里的「手机链接」面板

[English](README.en.md) | **中文**

把 dsh-remote 守卫的手机链接能力**镶进 DSH 自己的界面**：DSH 窗口里多一个「手机链接」按钮，
点开就能看到**当前**手机链接（主 / 只读两条，长期有效）、复制、重置与设备管理。

## 为什么用插件而不是注入

dsh-remote 守卫能往它代理出去的页面里注脚本（那条路只覆盖走隧道/守卫的访问，也就是手机端）。
但**电脑上的 DSH 桌面程序直连 DSH 自己的端口、不经过守卫**，所以要在桌面窗口里看到入口，
只能做成 DSH 自己的插件。

## 安装

**推荐：一条命令**（自动拷包、追加挂载段、更新插件名清单、改动前备份）：

```bash
node bin/install-plugin.mjs                 # 装到 ~/.dsh/profiles/web-desktop
node bin/install-plugin.mjs --profile <目录> # 指定 profile
node bin/install-plugin.mjs --dry-run       # 只看计划，不落盘
node bin/install-plugin.mjs --uninstall     # 反向卸载（只删自己加的，不碰别人的配置）
```

装完**必须重启 DSH**（插件树不热重载），右下角（EAC监控按钮上方）就会出现「手机链接」按钮。

<details>
<summary>手工安装（等价于上面脚本做的事）</summary>

```bash
# 1) 把本目录拷进目标 profile 的 node_modules
cp -r plugin "~/.dsh/profiles/web-desktop/node_modules/dsh-remote-panel"

# 2) 在 profile 的 cordis.patch.yml 末尾挂上（可带配置）
#    - insert:
#        - id: remote-panel
#          name: 'dsh-remote-panel'
#          config:
#            guardPath: '<你的 dsh-remote 仓库>/guard/guard.mjs'

# 3) 重启 DSH（插件树不热重载：改 patch 或包内容都必须重启）
```

**注意**：`.dsh-builtin-plugins.json` 里如果维护了一份插件名清单，需要把 `dsh-remote-panel` 加进去。

</details>

## 两个硬性要求（踩过的坑，别再踩）

1. **`package.json` 的 `exports` 必须导出 `"./package.json"`**。
   DSH 的 `dsh-client-modules` 用 `require.resolve('<包名>/package.json')` 找插件元数据；
   Node 的 exports 映射如果没放行 `./package.json`，解析会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，
   而 DSH 会把这个失败**缓存成"不是客户端插件"且永不重试** —— 表现就是
   `/plugins/<包名>/client.js` 永远 404、界面里什么都不出现。
2. **客户端 chunk 的写法**（手写即可，不需要打包器）：

```js
window.__ModuleLoader__.load({
  id: "包名",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    const React = require("react");
    const inject = ["slots"];
    function apply(ctx) { ctx.slots.register({ name: "shell.overlay" }, 组件); }
    exports.apply = apply; exports.inject = inject;
    return module.exports;
  }
});
```

`shell.overlay` 是全局浮层槽位（桌宠也用它）。组件本身可以不渲染任何 DOM —— 我们的做法是
在 `useEffect` 里把按钮/面板建到 `document.body` 上，避免和 DSH 的布局耦合。

## 服务端半边

`lib/index.js` 用 `ctx.webServer.register({ kind: "prefix", path: "/dsh-remote", handler })`
在 DSH 自己的端口上挂控制面路由：

| 路由 | 作用 |
|---|---|
| `GET /dsh-remote/status` | 守卫状态：入口、隧道、设备、待用链接、活跃会话 |
| `GET /dsh-remote/links` | 读取当前两条长期链接（不改动） |
| `POST /dsh-remote/reset` | 重置链接（旧的立即作废） |
| `GET /dsh-remote/qr[?role=readonly]` | 当前链接的二维码（SVG，手机相机直接扫） |
| `GET /dsh-remote/link[?role=readonly][&reset=1]` | 单条链接 / 重置（兼容） |
| `GET /dsh-remote/devices` | 设备列表 |
| `POST /dsh-remote/revoke` | 吊销设备 |
| `GET /dsh-remote/health` | 逐段体检：守卫 / 隧道 / 上游，以及"哪一段没起来" |
| `POST /dsh-remote/start` | 把没起来的环节拉起来（守卫 → 隧道）；幂等，已经好的不会被重启 |

`reset` 与 `qr` 由插件的服务端半边**真调守卫 CLI**（`pair --reset` / `qr --svg`）实现；
其余接口直接读守卫的状态文件（`guard.json` / `tunnel.json` / `urlFile`），不解析 CLI 输出。

**准入**：经守卫来的请求必须带 `x-dsh-remote-role: owner`；本机直连要求 `Host` 是回环。
守卫侧也把 `/dsh-remote/*` 列为 owner-only —— 两道闸，防止只读设备给自己签 owner 链接。

**自愈**：DSH 起动 5 秒后、以及之后每 60 秒（`DSH_REMOTE_HEAL_SECONDS` 可调，设 0 关闭），
插件会检查守卫是否在运行；不在就把它拉回来。**这是"重启之后手机和网页都用不了"的根治办法** ——
守卫是普通后台进程，机器/DSH 重启它不会自己回来，而 DSH 是常驻程序，由它内置的插件看管最可靠。
面板里也有「运行状态」一栏（守卫 ✓ / 隧道 ✓ + 一键「启动 / 修复」）。

**兜底**：插件服务端半边是旧版（新路由 404）或没配 `guardPath` 时，客户端会直连本机守卫
（`http://127.0.0.1:8443/__guard/*`，本机直连被守卫视为可信），并在状态行标注「已直连守卫」。
所以即使插件没更新，面板里的复制/二维码/重置/吊销依然可用。

## 许可

MIT
