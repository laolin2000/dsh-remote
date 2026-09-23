#!/usr/bin/env node
// ============================================================================
// bin/setup.mjs —— 一条命令把 dsh-remote 装好并跑起来
//
// 它把原来要手工做的五步串起来：
//   1. 装 DSH 界面插件（拷包 + 追加挂载段 + 更新插件名清单）—— 等价于 bin/install-plugin.mjs
//   2. 自动找 cloudflared 并把路径写进守卫配置（找不到就跳过公网入口，只给本机链接）
//   3. 自动判断上游：本机 3081 有中间层就用它，否则用 DSH 自己的端口（默认 50142）
//   4. 后台拉起守卫（detached，不占用你的终端）
//   5. 拉起隧道 + 打印当前手机链接与二维码
//
// 用法：
//   node bin/setup.mjs                    # 全自动：插件 + 守卫 + 隧道 + 链接/二维码
//   node bin/setup.mjs --dry-run          # 只打印计划
//   node bin/setup.mjs --no-tunnel        # 不要公网入口（只本机/局域网用）
//   node bin/setup.mjs --no-guard         # 只装插件（守卫稍后自己起）
//   node bin/setup.mjs --port 8443 --upstream http://127.0.0.1:50142
//   node bin/setup.mjs --profile <目录> --dsh-port 50142
//
// 幂等：可反复运行；已经在跑的东西不会被重复拉起。最后一行是给脚本读的 SETUP_OK {...}
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(SELF_DIR, "..");
const GUARD = path.join(REPO, "guard", "guard.mjs");

const argv = process.argv.slice(2);
const has = (n) => argv.includes("--" + n);
const flag = (n, d = "") => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };

const DRY = has("dry-run");
const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const CONF_DIR = process.env.DSH_REMOTE_DIR || path.join(HOME, "remote");
const PROFILE = path.resolve(flag("profile", process.env.DSH_PROFILE || path.join(HOME, "profiles", "web-desktop")));
const PORT = Number(flag("port", "8443"));
const DSH_PORT = Number(flag("dsh-port", "50142"));
const UPSTREAM_FLAG = flag("upstream", "");
const CLOUDFLARED_FLAG = flag("cloudflared", "");
const NO_TUNNEL = has("no-tunnel");
const NO_GUARD = has("no-guard");

const say = (s) => console.log(s);
const step = (n, s) => console.log(`\n[${n}] ${s}`);
function run(file, args, { silent = false } = {}) {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, [file, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		p.stdout.on("data", (c) => out += String(c));
		p.stderr.on("data", (c) => out += String(c));
		p.on("close", (code) => { if (!silent) process.stdout.write(out); resolve({ code, out }); });
	});
}
const confFile = () => path.join(CONF_DIR, "guard.json");
function readConf() { try { return JSON.parse(fs.readFileSync(confFile(), "utf8")); } catch { return {}; } }
async function probe(url, ms = 2500) {
	try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.status; } catch { return 0; }
}
function findCloudflared() {
	if (CLOUDFLARED_FLAG && fs.existsSync(CLOUDFLARED_FLAG)) return path.resolve(CLOUDFLARED_FLAG);
	const local = [path.join(REPO, "guard", "cloudflared.exe"), path.join(REPO, "guard", "cloudflared"), path.join(CONF_DIR, "cloudflared.exe")];
	for (const c of local) if (fs.existsSync(c)) return c;
	for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
		for (const name of ["cloudflared.exe", "cloudflared"]) {
			const c = path.join(dir, name);
			if (fs.existsSync(c)) return c;
		}
	}
	return "";
}
/** 后台拉起守卫：不占终端、父进程退出它也活着（Windows 用 windowsHide 不闪窗）。 */
function startGuardDetached(extraArgs) {
	if (DRY) return { pid: null, dry: true };
	const child = spawn(process.execPath, [GUARD, "serve", ...extraArgs], { detached: true, stdio: "ignore", windowsHide: true, cwd: REPO });
	child.unref();
	return { pid: child.pid };
}
const entryFromState = () => {
	const conf = readConf();
	let base = "";
	try { if (conf.urlFile && fs.existsSync(conf.urlFile)) base = fs.readFileSync(conf.urlFile, "utf8").trim(); } catch {}
	if (!base) { try { base = JSON.parse(fs.readFileSync(path.join(CONF_DIR, "tunnel.json"), "utf8")).url || ""; } catch {} }
	return base.replace(/\/+$/, "");
};

// ---------------------------------------------------------------- 计划
say("dsh-remote 一键安装");
say(`  仓库    : ${REPO}`);
say(`  profile : ${PROFILE}`);
say(`  守卫    : 127.0.0.1:${PORT}（状态目录 ${CONF_DIR}）`);
if (DRY) say("  （dry-run：只打印计划，不落盘、不起进程）");

// ---------------------------------------------------------------- 1. 插件
step(1, "安装 DSH 界面插件");
{
	const args = ["--profile", PROFILE];
	if (flag("guard")) args.push("--guard", flag("guard"));
	else args.push("--guard", GUARD);
	if (DRY) args.push("--dry-run");
	const r = await run(path.join(REPO, "bin", "install-plugin.mjs"), args);
	if (r.code !== 0) { console.error("\n❌ 插件安装失败，后面步骤不再继续。"); process.exit(1); }
}

const report = { plugin: DRY ? "dry-run" : "installed", guard: "skipped", tunnel: "skipped" };

if (NO_GUARD) {
	say("\n已跳过守卫（--no-guard）。之后手动起：node guard/guard.mjs serve");
} else {
	// ---------------------------------------------------------------- 2. 配置
	step(2, "确定上游与 cloudflared");
	const overrides = ["--port", String(PORT)];
	let upstream = UPSTREAM_FLAG;
	if (!upstream) {
		const hasMiddle = (await probe("http://127.0.0.1:3081/__health")) > 0;
		const dshAlive = (await probe(`http://127.0.0.1:${DSH_PORT}/`)) > 0;
		if (hasMiddle) { upstream = "http://127.0.0.1:3081"; say("  · 检测到本机中间层（3081）→ 上游用它"); }
		else if (dshAlive) { upstream = `http://127.0.0.1:${DSH_PORT}`; say(`  · 没有中间层，DSH 在 ${DSH_PORT} → 上游直接指 DSH`); }
		else { upstream = "http://127.0.0.1:3081"; say("  ⚠ 3081 与 DSH 端口都没探到服务；先按中间层默认值写入，起好后可用 `node guard/guard.mjs status` 复查"); }
	} else say(`  · 上游用指定值 ${upstream}`);
	overrides.push("--upstream", upstream);

	const cf = findCloudflared();
	if (cf) { overrides.push("--cloudflared", cf); say(`  · cloudflared: ${cf}`); }
	else say("  ⚠ 没找到 cloudflared → 只能给本机链接；public 入口稍后手动开（--cloudflared 指路径）");

	if (!DRY) await run(GUARD, ["print", ...overrides], { silent: true });   // print 会持久化覆盖项
	else say(`  （将要写入 ${confFile()}：${overrides.join(" ")}）`);

	// ---------------------------------------------------------------- 3. 守卫
	step(3, "启动守卫（后台常驻）");
	if ((await probe(`http://127.0.0.1:${PORT}/__guard/health`)) === 200) {
		report.guard = "already-running";
		say("  · 守卫已经在跑，跳过");
	} else {
		const { pid } = startGuardDetached(overrides);
		report.guard = DRY ? "dry-run" : `pid ${pid}`;
		say(DRY ? "  · （dry-run）将后台拉起守卫" : `  · 已后台启动守卫（PID ${pid}）；这个进程会一直活着，不占你的终端`);
		if (!DRY) {
			let ok = false;
			for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); if ((await probe(`http://127.0.0.1:${PORT}/__guard/health`)) === 200) { ok = true; break; } }
			say(ok ? "  · 健康检查通过" : "  ⚠ 10 秒内没起来，稍后看状态目录里的 guard.log");
			if (!ok) report.guard = "not-ready";
		}
	}

	// ---------------------------------------------------------------- 4. 隧道
	step(4, "公网入口（隧道）");
	if (NO_TUNNEL) { say("  · 按 --no-tunnel 跳过（手机只能在同一局域网/本机访问）"); report.tunnel = "disabled"; }
	else if (!cf) { say("  · 没有 cloudflared，跳过公网入口"); report.tunnel = "no-cloudflared"; }
	else {
		const r = await run(GUARD, ["tunnel", "up", "--cloudflared", cf]);
		report.tunnel = /trycloudflare/.test(r.out) ? "up" : "failed";
	}
}

// ---------------------------------------------------------------- 5. 链接
step(5, "当前手机链接与二维码");
let ownerUrl = "";
const entry = entryFromState() || `http://127.0.0.1:${PORT}`;
if (DRY) {
	say("  · （dry-run）将打印当前链接与终端二维码（会顺带生成链接，所以 dry-run 里跳过）");
} else {
	const r5 = await run(GUARD, ["pair", "--qr"]);
	ownerUrl = (r5.out.match(/https?:\/\/\S+\?t=[A-Za-z0-9_-]+/g) || [])[0] || "";
	if (!ownerUrl) say("  ⚠ 没取到链接，请检查守卫状态：node guard/guard.mjs status");
	else if (!/^https:/.test(entry)) say("  ⚠ 当前是本机/局域网入口，手机要用公网就得先起隧道（node guard/guard.mjs tunnel up）");
}

say(`
—— 还差一步（必须你来做）——
  重启一次 DSH：插件树不热重载。重启后右下角、EAC监控按钮上方会出现「手机链接」按钮。
  想开机自启守卫：见 docs/deploy/（Windows 计划任务 / macOS launchd / Linux systemd）。
  卸载：node bin/install-plugin.mjs --uninstall`);

console.log("\nSETUP_OK " + JSON.stringify({ entry, ownerUrl, profile: PROFILE, port: PORT, ...report }));
