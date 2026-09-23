#!/usr/bin/env node
// ============================================================================
// 安装器测试（bin/install-plugin.mjs）：全程在**临时 profile** 里跑，不碰真实 DSH。
//   node test/install.test.mjs
// 覆盖：拷贝插件包、追加挂载段、幂等、不动别人的配置、插件名清单、卸载回退。
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(SELF_DIR, "..");
const INSTALLER = path.join(REPO, "bin", "install-plugin.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "install-test-"));
const PROFILE = path.join(TMP, "profiles", "web-desktop");
fs.mkdirSync(path.join(PROFILE, "node_modules"), { recursive: true });

const PATCH = path.join(PROFILE, "cordis.patch.yml");
const BUILTIN = path.join(PROFILE, ".dsh-builtin-plugins.json");
// 别人的配置：用 CRLF，且结尾没有多余空行，检验我们不会破坏它们
const OTHER = [
	"- insert:",
	"    - id: balance",
	"      name: '@deepseek-ai/dsh-balance'",
	"- insert:",
	"    - id: eac-monitor",
	"      name: 'dsh-eac-monitor'"
].join("\r\n") + "\r\n";
fs.writeFileSync(PATCH, OTHER, "utf8");
fs.writeFileSync(BUILTIN, JSON.stringify({ names: ["@deepseek-ai/dsh-balance", "dsh-eac-monitor"], updatedAt: "2026-01-01T00:00:00.000Z" }, null, 2), "utf8");

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
	if (ok) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}
function run(args) {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, [INSTALLER, "--profile", PROFILE, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		p.stdout.on("data", (c) => out += String(c));
		p.stderr.on("data", (c) => out += String(c));
		p.on("close", (code) => resolve({ code, out }));
	});
}
const patchText = () => fs.readFileSync(PATCH, "utf8");
const builtin = () => JSON.parse(fs.readFileSync(BUILTIN, "utf8"));
const pluginDir = path.join(PROFILE, "node_modules", "dsh-remote-panel");

console.log("\n=== 1. 安装 ===");
{
	const r = await run([]);
	check("退出码 0", r.code === 0, r.out.slice(-300));
	check("插件包已拷入 profile", fs.existsSync(path.join(pluginDir, "lib", "client.js")) && fs.existsSync(path.join(pluginDir, "package.json")));
	check("客户端与服务端两半都在", fs.existsSync(path.join(pluginDir, "lib", "index.js")) && fs.existsSync(path.join(pluginDir, "lib", "client.js")));
	check("挂载段已追加（含 guardPath）", /-\s+id:\s*remote-panel/.test(patchText()) && patchText().includes("guardPath:"), patchText().slice(-200));
	check("挂载段只出现一次（id 与 name 各一处）", (patchText().match(/id:\s*remote-panel/g) || []).length === 1);
	check("别人的配置原样保留", patchText().includes("dsh-balance") && patchText().includes("dsh-eac-monitor"));
	check("原有 CRLF 换行没被改成 LF", !/(?<!\r)\n/.test(patchText().replace(/\r\n/g, "")) || patchText().includes("\r\n"), JSON.stringify(patchText().slice(-90)));
	check("改动前留了备份", fs.readdirSync(PROFILE).some((f) => f.startsWith("cordis.patch.yml.bak-")));
	check("插件名写进清单", builtin().names.includes("dsh-remote-panel"), JSON.stringify(builtin().names));
	check("清单里别的名字没被动", builtin().names.includes("dsh-eac-monitor") && builtin().names.includes("@deepseek-ai/dsh-balance"));
	check("清单也留了备份", fs.readdirSync(PROFILE).some((f) => f.startsWith(".dsh-builtin-plugins.json.bak-")));
	check("提示了要重启 DSH", /重启 DSH/.test(r.out));
}

console.log("\n=== 2. 重复安装是幂等的 ===");
{
	const before = patchText();
	const r = await run([]);
	check("再装一次退出码 0", r.code === 0);
	check("挂载段仍然只有一处", (patchText().match(/id:\s*remote-panel/g) || []).length === 1);
	check("配置文件没有重复追加", patchText() === before);
	check("提示已存在（不会重复写）", /已有挂载段/.test(r.out), r.out.slice(-200));
	check("清单里也没重复", (builtin().names.filter((n) => n === "dsh-remote-panel")).length === 1);
}

console.log("\n=== 3. 卸载 ==");
{
	const r = await run(["--uninstall"]);
	check("退出码 0", r.code === 0);
	check("插件包目录已删除", !fs.existsSync(pluginDir));
	check("挂载段已移除", !/remote-panel/.test(patchText()), patchText().slice(-200));
	check("别人的配置完好无损", patchText().includes("dsh-balance") && patchText().includes("dsh-eac-monitor"));
	check("清单里的名字已移除", !builtin().names.includes("dsh-remote-panel"));
	check("清单里别的名字还在", builtin().names.includes("dsh-eac-monitor"));
	check("提示要重启 DSH", /重启一次 DSH/.test(r.out));
}

console.log("\n=== 4. 卸载后再装回来（可反复）===");
{
	await run([]);
	check("重新安装成功", fs.existsSync(path.join(pluginDir, "lib", "client.js")) && (patchText().match(/id:\s*remote-panel/g) || []).length === 1);
	check("没有残留的重复段", (patchText().match(/- insert:/g) || []).length === 3, String((patchText().match(/- insert:/g) || []).length));
}

console.log("\n=== 5. 参数与错误路径 ===");
{
	const r1 = await run(["--dry-run"]);
	check("--dry-run 不落盘也能给出计划", r1.code === 0 && /dry-run/.test(r1.out));
	const bad = await new Promise((res) => {
		const p = spawn(process.execPath, [INSTALLER, "--profile", path.join(TMP, "不存在")], { stdio: ["ignore", "pipe", "pipe"] });
		let out = ""; p.stdout.on("data", (c) => out += c); p.stderr.on("data", (c) => out += c);
		p.on("close", (code) => res({ code, out }));
	});
	check("profile 不存在时明确报错退出 1", bad.code === 1 && /profile 目录不存在/.test(bad.out), bad.out.slice(0, 120));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail ? 1 : 0);
