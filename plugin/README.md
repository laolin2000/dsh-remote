# dsh-remote-panel —— DSH 界面里的「手机链接」面板

[English](README.en.md) | **中文**

把 dsh-remote 守卫的手机链接能力**镶进 DSH 自己的界面**：DSH 窗口里多一个「手机链接」按钮，
点开就能看到**当前**手机链接（主 / 只读两条，长期有效）、复制、重置与设备管理。

## 为什么用插件而不是注入

dsh-remote 守卫能往它代理出去的页面里注脚本（那条路只覆盖走隧道/守卫的访问，也就是手机端）。
但**电脑上的 DSH 桌面程序直连 DSH 自己的端口、不经过守卫**，所以要在桌面窗口里看到入口，
只能做成 DSH 自己的插件。

## 安装

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
| `GET /dsh-remote/link[?role=readonly][&reset=1]` | 单条链接 / 重置（兼容） |
| `GET /dsh-remote/devices` | 设备列表 |
| `POST /dsh-remote/revoke` | 吊销设备 |

**准入**：经守卫来的请求必须带 `x-dsh-remote-role: owner`；本机直连要求 `Host` 是回环。
守卫侧也把 `/dsh-remote/*` 列为 owner-only —— 两道闸，防止只读设备给自己签 owner 链接。

## 许可

MIT
