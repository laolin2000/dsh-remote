#!/usr/bin/env node
// ============================================================================
// 隧道守护实测（用**真实 cloudflared**跑，约 1–2 分钟）：
//   1. `tunnel up` 能拿到公网域名，并写进 urlFile（供 agent/skill 报链接）；
//   2. 杀掉 cloudflared 后守护会按退避自动重启（自愈 = 「稳定连接」的服务端一半）；
//   3. `tunnel down` 之后**不会**被守护拉回来（曾经的 bug：只杀进程不关意图，
//      10 秒后原地复活；实测证据见 README 的「验证记录」）。
//
// 没有 cloudflared 时自动跳过（退出码 0），所以放进 CI 也不会红。
//   node test/tunnel.test.mjs
//   CLOUDFLARED=/path/to/cloudflared node test/tunnel.test.mjs   # 指定二进制
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(SELF_DIR, "..", "guard", "guard.mjs");

function findCloudflared() {
	const direct = process.env.CLOUDFLARED;
	if (direct && fs.existsSync(direct)) return direct;
	for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
		for (const name of ["cloudflared.exe", "cloudflared"]) {
			const c = path.join(dir, name);
			if (fs.existsSync(c)) return c;
		}
	}
	return null;
}
const CF = findCloudflared();
if (!CF) {
	console.log("⏭  跳过：这台机器上找不到 cloudflared（用 CLOUDFLARED=/path/to/cloudflared 指定）");
	process.exit(0);
}

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
	if (ok) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "guard-tunnel-"));
const UP_PORT = 34981, GUARD_PORT = 34982;
const upstream = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
await new Promise((r) => upstream.listen(UP_PORT, "127.0.0.1", r));

fs.writeFileSync(path.join(TMP, "guard.json"), JSON.stringify({
	port: GUARD_PORT, bind: "127.0.0.1", upstream: `http://127.0.0.1:${UP_PORT}`,
	superviseTunnel: true, cloudflared: CF,
	urlFile: path.join(TMP, "public-url.txt"), tunnelLog: path.join(TMP, "cloudflared.log")
}, null, 2));

const env = { ...process.env, DSH_REMOTE_DIR: TMP, DSH_HOME: TMP };
const guard = spawn(process.execPath, [GUARD, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
const glog = []; guard.stdout.on("data", (c) => glog.push(String(c))); guard.stderr.on("data", (c) => glog.push(String(c)));
const cli = (args) => new Promise((res) => { const p = spawn(process.execPath, [GUARD, ...args], { env }); let o = ""; p.stdout.on("data", (c) => o += c); p.stderr.on("data", (c) => o += c); p.on("close", (code) => res({ out: o, code })); });
const state = () => { try { return JSON.parse(fs.readFileSync(path.join(TMP, "tunnel.json"), "utf8")); } catch { return null; } };
const urlFile = () => { try { return fs.readFileSync(path.join(TMP, "public-url.txt"), "utf8").trim(); } catch { return ""; } };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const killTree = (pid) => { if (pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch { try { process.kill(pid); } catch {} } } };
async function waitFor(fn, seconds) { for (let i = 0; i < seconds; i++) { const v = fn(); if (v) return v; await sleep(1000); } return null; }

console.log(`\n临时目录：${TMP}\n隧道二进制：${CF}\n`);
await sleep(1500);

console.log("=== 1. tunnel up：拿到公网域名并写进 urlFile ===");
{
	const r = await cli(["tunnel", "up"]);
	const s = state();
	check("`tunnel up` 退出码 0 并打印入口", r.code === 0 && /trycloudflare/.test(r.out), r.out.trim().slice(0, 100));
	check("tunnel.json 记录 pid 且进程存活", !!s?.pid && alive(s.pid), JSON.stringify(s));
	check("urlFile 写入当前域名（agent/skill 靠它报链接）", /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(urlFile()), urlFile());
	check("域名与 tunnel.json 一致", s?.url === urlFile(), `${s?.url} vs ${urlFile()}`);
}

console.log("\n=== 2. 自愈：杀掉 cloudflared，守护应自动拉起（并更新域名）===");
{
	const before = state();
	killTree(before.pid);
	console.log(`  （已杀掉 PID ${before.pid}）`);
	const healed = await waitFor(() => { const s = state(); return s?.pid && s.pid !== before.pid && alive(s.pid) ? s : null; }, 45);
	check("守护在 45 秒内拉起了新进程", !!healed, JSON.stringify(state()));
	if (healed) {
		const domain = await waitFor(() => (/trycloudflare/.test(urlFile()) && urlFile() !== before.url ? urlFile() : null), 60);
		check("新域名写回 urlFile（域名会变，这是 Quick Tunnel 的已知取舍）", !!domain, `旧 ${before.url} / 新 ${urlFile()}`);
	}
}

console.log("\n=== 3. tunnel down：必须真的停下来（不被守护拉回）===");
{
	const r = await cli(["tunnel", "down"]);
	check("`tunnel down` 退出码 0", r.code === 0);
	const cfg = JSON.parse(fs.readFileSync(path.join(TMP, "guard.json"), "utf8"));
	check("意图也关掉（superviseTunnel=false）", cfg.superviseTunnel === false);
	check("进程已停止", !alive(state()?.pid));
	await sleep(24000);                                  // 守护每 10 秒一轮，留两轮以上
	check("等待 24 秒后仍未被拉回（曾经的 bug：12 秒后原地复活）", !alive(state()?.pid), JSON.stringify(state()));
	const st = JSON.parse((await cli(["tunnel", "status"])).out);
	check("`tunnel status` 报 desired=false", st.desired === false, JSON.stringify(st));
}

// ---------------------------------------------------------------- 收尾
killTree(state()?.pid);
guard.kill();
upstream.close();
await sleep(400);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
if (fail) console.log("（guard 日志尾部）\n" + glog.join("").split("\n").filter(Boolean).slice(-10).join("\n"));
process.exit(fail ? 1 : 0);
