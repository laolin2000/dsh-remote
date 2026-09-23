#!/usr/bin/env node
// ============================================================================
// 桌面小工具 bin/phone-link.mjs 的行为测试
//
// 全程在**临时 DSH_HOME** 里跑（绝不动真实链接 —— 它连着用户的手机），
// 用 --quiet 抑制弹窗，因此不会在屏幕上闪窗口。
//   node test/bin.test.mjs
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(SELF_DIR, "..");
const BIN = path.join(REPO, "bin", "phone-link.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bin-test-"));
const CONF = path.join(TMP, "remote", "guard.json");

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
	if (ok) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}
fs.mkdirSync(path.join(TMP, "remote"), { recursive: true });
fs.writeFileSync(CONF, JSON.stringify({ port: 8443, bind: "127.0.0.1", upstream: "http://127.0.0.1:3081", superviseTunnel: false }, null, 2), "utf8");

const env = { ...process.env, DSH_HOME: TMP, DSH_REMOTE_DIR: path.join(TMP, "remote"), DSH_REMOTE_NO_POPUP: "1" };
function run(args) {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, [BIN, ...args, "--quiet"], { env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		p.stdout.on("data", (c) => out += String(c));
		p.stderr.on("data", (c) => out += String(c));
		p.on("close", (code) => resolve({ code, out }));
	});
}
const tokenOf = (text) => (text.match(/\?t=([A-Za-z0-9_-]+)/) || [])[1] || "";
const cfg = () => JSON.parse(fs.readFileSync(CONF, "utf8"));
const lastFile = () => { try { return fs.readFileSync(path.join(TMP, "remote", "last-link.txt"), "utf8").trim(); } catch { return ""; } };

console.log("\n=== 1. 默认：只显示当前主链接，不换链接（长期有效）===");
{
	const r1 = await run([]);
	check("退出码 0 且打印链接", r1.code === 0 && /\?t=/.test(r1.out), r1.out.slice(0, 100));
	const t1 = tokenOf(r1.out);
	check("链接写进 last-link.txt（供其它工具读）", lastFile().includes(t1), lastFile());
	const r2 = await run([]);
	check("再跑一次链接不变（默认不改动）", tokenOf(r2.out) === t1, `${t1} → ${tokenOf(r2.out)}`);
	check("主链接的角色是 owner（配置里 owner 那条）", cfg().links.owner.token === t1);
}

console.log("\n=== 2. --role readonly 取只读链接 ===");
{
	const r = await run(["--role", "readonly"]);
	check("打印的是只读链接", tokenOf(r.out) === cfg().links.readonly.token, `${tokenOf(r.out)} vs ${cfg().links.readonly.token}`);
	check("与主链接不同", tokenOf(r.out) !== cfg().links.owner.token);
}

console.log("\n=== 3. --reset：换新链接，旧的立即作废 ===");
{
	const before = cfg().links.owner.token;
	const r = await run(["--reset"]);
	check("打印的是新链接", tokenOf(r.out) !== before && tokenOf(r.out) === cfg().links.owner.token, `${before} → ${tokenOf(r.out)}`);
	check("旧链接的 token 不再存在于配置里", JSON.stringify(cfg().links) !== undefined && cfg().links.owner.token !== before);
}

console.log("\n=== 4. --reset --role readonly 也要生效（曾经被静默忽略）===");
{
	const before = cfg().links.readonly.token;
	const ownerBefore = cfg().links.owner.token;
	const r = await run(["--reset", "--role", "readonly"]);
	check("只读 token 换了", cfg().links.readonly.token !== before, `${before} → ${cfg().links.readonly.token}`);
	check("打印的正是新的只读链接", tokenOf(r.out) === cfg().links.readonly.token);
	check("主链接不受影响（只重置只读）", cfg().links.owner.token === ownerBefore);
}

console.log("\n=== 5. --qr：写出可扫的 SVG ===");
{
	const r = await run(["--qr"]);
	const svgFile = path.join(TMP, "remote", "last-qr.svg");
	const svg = fs.existsSync(svgFile) ? fs.readFileSync(svgFile, "utf8") : "";
	check("退出码 0", r.code === 0);
	check("写出了 last-qr.svg 且是合法 SVG", svg.trim().startsWith("<svg") && svg.includes("<path d=\"M"), svg.slice(0, 60));
	check("二维码内容是当前链接（尺寸随内容变化）", svg.includes("viewBox="));
	check("提示里说明了二维码文件位置", r.out.includes("last-qr.svg"), r.out.slice(-200));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail ? 1 : 0);
