#!/usr/bin/env node
// ============================================================================
// 一键安装器测试（bin/setup.mjs）：全程在临时 profile / 临时状态目录里跑，
// 不碰真实 DSH 与真实配置；自己起的守卫会在收尾时杀掉。
//   node test/setup.test.mjs
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(SELF_DIR, "..");
const SETUP = path.join(REPO, "bin", "setup.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "setup-test-"));
const PROFILE = path.join(BASE, "profiles", "web-desktop");
const STATE = path.join(BASE, "remote");
fs.mkdirSync(path.join(PROFILE, "node_modules"), { recursive: true });
fs.writeFileSync(path.join(PROFILE, "cordis.patch.yml"), "- insert:\r\n    - id: eac-monitor\r\n      name: 'dsh-eac-monitor'\r\n", "utf8");

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
	if (ok) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}
function run(args) {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, [SETUP, ...args], { env: { ...process.env, DSH_HOME: BASE, DSH_REMOTE_DIR: STATE }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		p.stdout.on("data", (c) => out += String(c));
		p.stderr.on("data", (c) => out += String(c));
		p.on("close", (code) => resolve({ code, out }));
	});
}
const report = (out) => { const m = out.match(/SETUP_OK (\{.*\})/); return m ? JSON.parse(m[1]) : null; };
const guardJson = path.join(STATE, "guard.json");
const pluginDir = path.join(PROFILE, "node_modules", "dsh-remote-panel");
const portFree = async (port) => { try { await fetch(`http://127.0.0.1:${port}/__guard/health`, { signal: AbortSignal.timeout(800) }); return false; } catch { return true; } };
async function killGuard(pid) { if (!pid) return; try { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { process.kill(pid); } catch {} } await new Promise((r) => setTimeout(r, 800)); }

// 用系统分配的空闲端口：避免与上一次跑的遗留实例冲突（踩过：崩溃的测试留下守卫占着固定端口）
const PORT = await new Promise((resolve) => {
	const srv = net.createServer();
	srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

console.log("\n=== 1. --dry-run：不落盘、不起进程 ===");
{
	const r = await run(["--profile", PROFILE, "--port", String(PORT), "--no-tunnel", "--dry-run"]);
	check("退出码 0", r.code === 0, r.out.slice(-200));
	check("打印了计划（含 profile 与端口）", /dry-run/.test(r.out) && r.out.includes(String(PORT)));
	check("没有安装插件", !fs.existsSync(pluginDir));
	check("没有写守卫配置", !fs.existsSync(guardJson));
	check("没有占用端口", await portFree(PORT));
	check("没有改 cordis.patch.yml", !/remote-panel/.test(fs.readFileSync(path.join(PROFILE, "cordis.patch.yml"), "utf8")));
}

console.log("\n=== 2. --no-guard：只装插件 ===");
{
	const r = await run(["--profile", PROFILE, "--no-guard"]);
	check("退出码 0", r.code === 0);
	check("插件已安装（lib/client.js 在）", fs.existsSync(path.join(pluginDir, "lib", "client.js")));
	check("挂载段已追加", /remote-panel/.test(fs.readFileSync(path.join(PROFILE, "cordis.patch.yml"), "utf8")));
	check("别人的配置没被动", fs.readFileSync(path.join(PROFILE, "cordis.patch.yml"), "utf8").includes("dsh-eac-monitor"));
	check("没有启动守卫（端口仍空）", await portFree(PORT));
	check("报告里 guard=skipped", report(r.out)?.guard === "skipped", JSON.stringify(report(r.out)));
	check("提示要重启 DSH", /重启一次 DSH/.test(r.out));
}

console.log("\n=== 3. 全流程（不起隧道，用本机端口）===");
{
	const r = await run(["--profile", PROFILE, "--port", String(PORT), "--upstream", "http://127.0.0.1:3081", "--no-tunnel"]);
	const rep = report(r.out);
	check("退出码 0", r.code === 0, r.out.slice(-300));
	check("守卫配置写入了端口与上游", fs.existsSync(guardJson) && JSON.parse(fs.readFileSync(guardJson, "utf8")).port === PORT);
	check("守卫起来了（健康检查 200）", !(await portFree(PORT)));
	check("报告里 tunnel=disabled", rep?.tunnel === "disabled", JSON.stringify(rep));
	check("报告里给出链接且端口正确", typeof rep?.ownerUrl === "string" && rep.ownerUrl.includes(`:${PORT}/?t=`), rep?.ownerUrl);
	check("走了 pair（输出里有主链接与只读链接）", /① 主设备/.test(r.out) && /② 只读设备/.test(r.out));
	check("--no-tunnel 会顺手关掉隧道守护（免得反复尝试拉起）", JSON.parse(fs.readFileSync(guardJson, "utf8")).superviseTunnel === false);
	check("打印了终端二维码", /[▀▄█]/.test(r.out));
	check("提示了本机入口的局限（非 https）", /本机\/局域网入口|公网/.test(r.out));
	check("报告里 guard 记录了 pid", /^pid \d+$/.test(String(rep?.guard)), String(rep?.guard));

	// 幂等：再跑一次不应重复起进程
	const r2 = await run(["--profile", PROFILE, "--port", String(PORT), "--no-tunnel"]);
	check("重复运行是幂等的（守卫已在跑）", report(r2.out)?.guard === "already-running", JSON.stringify(report(r2.out)));
	check("重复运行不重复追加挂载段", (fs.readFileSync(path.join(PROFILE, "cordis.patch.yml"), "utf8").match(/remote-panel/g) || []).length === 2, "id 与 name 各一处");

	// 收尾：杀掉自己起的守卫
	await killGuard(Number(String(rep.guard).replace("pid ", "")));
	check("收尾后端口已释放", await portFree(PORT));
}

console.log("\n=== 3b. cloudflared 发现顺序：环境变量 / 上次记住的路径 ===");
{
	// 用一个假文件即可：本用例不起隧道，只验证「被发现并记住」
	const fake = path.join(BASE, "fake-cloudflared.exe");
	fs.writeFileSync(fake, "not a real binary", "utf8");
	const r = await new Promise((resolve) => {
		const p = spawn(process.execPath, [SETUP, "--profile", PROFILE, "--port", String(PORT), "--no-tunnel"],
			{ env: { ...process.env, DSH_HOME: BASE, DSH_REMOTE_DIR: STATE, DSH_REMOTE_CLOUDFLARED: fake }, stdio: ["ignore", "pipe", "pipe"] });
		let out = ""; p.stdout.on("data", (c) => out += String(c)); p.stderr.on("data", (c) => out += String(c));
		p.on("close", (code) => resolve({ code, out }));
	});
	const cfg = JSON.parse(fs.readFileSync(guardJson, "utf8"));
	check("环境变量 DSH_REMOTE_CLOUDFLARED 指定的路径被采用并写进 guard.json", cfg.cloudflared === fake, cfg.cloudflared);
	const r2 = await run(["--profile", PROFILE, "--port", String(PORT), "--no-tunnel"]);
	check("再次运行时复用已记住的路径（无需再传参数）", r2.out.includes("fake-cloudflared.exe"), r2.out.split("\n").filter((l) => l.includes("cloudflared")).join(" | ").slice(0, 160));
	await killGuard(Number(String(report(r2.out)?.guard || "").replace("pid ", "")));
}

console.log("\n=== 4. 守卫引用的是仓库里的脚本（路径可移植）===");
{
	const cfg = JSON.parse(fs.readFileSync(guardJson, "utf8"));
	check("guardPath 未写进守卫配置（由插件侧配置持有）", !cfg.guardPath);
	const patch = fs.readFileSync(path.join(PROFILE, "cordis.patch.yml"), "utf8");
	check("插件挂载段里的 guardPath 指向本仓库的 guard.mjs", patch.includes("guardPath:") && patch.includes("/guard/guard.mjs"));
}

fs.rmSync(BASE, { recursive: true, force: true });
console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail ? 1 : 0);
