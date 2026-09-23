# dsh-remote-panel — the "phone link" panel inside the DSH UI

[中文](README.md) | **English**

This plugin **builds the guard's phone-link capability into DSH's own UI**: the DSH window gains a
"phone link" button that opens the **current** links (main + read-only, both long-lived), with copy,
reset and device management.

## Why a plugin instead of injection

The guard can inject a script into the pages it proxies — but that path only covers traffic that goes
through the tunnel/guard, i.e. the phone. The **desktop DSH app talks to DSH's own port directly and never
passes through the guard**, so the only way to get an entry point into the desktop window is a DSH plugin.

## Install

**One command** (copies the package, appends the mount entry, updates the plugin-name list, backs up anything it touches):

```bash
node bin/install-plugin.mjs                  # into ~/.dsh/profiles/web-desktop
node bin/install-plugin.mjs --profile <dir>  # a specific profile
node bin/install-plugin.mjs --dry-run        # print the plan, change nothing
node bin/install-plugin.mjs --uninstall      # remove only what this installer added
```

After installing, **restart DSH** (the plugin tree is not hot-reloaded). The "手机链接" button then appears in
the bottom-right corner, above the EAC monitor button.

<details>
<summary>Manual install (what the script does)</summary>

```bash
# 1) copy this directory into the target profile's node_modules
cp -r plugin "~/.dsh/profiles/web-desktop/node_modules/dsh-remote-panel"

# 2) append to that profile's cordis.patch.yml (config is optional)
#    - insert:
#        - id: remote-panel
#          name: 'dsh-remote-panel'
#          config:
#            guardPath: '<path to your dsh-remote checkout>/guard/guard.mjs'

# 3) restart DSH (the plugin tree is not hot-reloaded)
```

**Note**: if `.dsh-builtin-plugins.json` maintains a list of plugin names, add `dsh-remote-panel` to it.

</details>

## Two hard requirements (learned the hard way — don't repeat them)

1. **`package.json` must export `"./package.json"`.**
   DSH's `dsh-client-modules` locates plugin metadata via `require.resolve('<package>/package.json')`.
   If the exports map doesn't allow `./package.json`, resolution throws `ERR_PACKAGE_PATH_NOT_EXPORTED`,
   and DSH **caches that failure as "not a client package" and never retries** — the symptom is
   `/plugins/<package>/client.js` returning 404 forever and nothing appearing in the UI.
2. **The client chunk format** (hand-written is fine; no bundler needed):

```js
window.__ModuleLoader__.load({
  id: "package-name",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    const React = require("react");
    const inject = ["slots"];
    function apply(ctx) { ctx.slots.register({ name: "shell.overlay" }, Component); }
    exports.apply = apply; exports.inject = inject;
    return module.exports;
  }
});
```

`shell.overlay` is the global overlay slot (the desktop pet uses it too). The component doesn't have to render
any DOM — our approach is to build the button/panel onto `document.body` inside a `useEffect`, which avoids
coupling to DSH's layout.

## The server half

`lib/index.js` mounts the control plane on DSH's own port via
`ctx.webServer.register({ kind: "prefix", path: "/dsh-remote", handler })`:

| Route | Purpose |
|---|---|
| `GET /dsh-remote/status` | guard status: entry, tunnel, devices, pending links, active sessions |
| `GET /dsh-remote/links` | read the two current long-lived links (mutates nothing) |
| `POST /dsh-remote/reset` | rotate the links (old ones die immediately) |
| `GET /dsh-remote/qr[?role=readonly]` | QR code (SVG) for the current link — point a phone camera at it |
| `GET /dsh-remote/link[?role=readonly][&reset=1]` | single link / rotate (legacy-compatible) |
| `GET /dsh-remote/devices` | device list |
| `POST /dsh-remote/revoke` | revoke a device |

`reset` and `qr` **really invoke the guard CLI** (`pair --reset` / `qr --svg`) from the plugin's server half; the
other endpoints read the guard's state files (`guard.json` / `tunnel.json` / `urlFile`) instead of parsing CLI output.

**Admission**: requests coming through the guard must carry `x-dsh-remote-role: owner`; direct loopback requests
must have a loopback `Host`. The guard also marks `/dsh-remote/*` owner-only — two gates, so a read-only device
can't mint itself an owner link.

**Fallback**: when the plugin's server half is an older build (new routes 404) or `guardPath` isn't configured, the
client talks to the local guard directly (`http://127.0.0.1:8443/__guard/*`, which the guard trusts as loopback) and
says so in the status line. Copy / QR / reset / revoke keep working even with a stale plugin.

## License

MIT
