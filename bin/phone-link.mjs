#!/usr/bin/env node
// ============================================================================
// phone-link —— 桌面端「显示当前手机链接」的小工具（供桌面快捷方式调用）
//
// 形态对齐 ZCode：链接长期有效，**默认只是把它显示出来**，不换链接。
//   node bin/phone-link.mjs               显示并复制当前主链接（不动它）
//   node bin/phone-link.mjs --reset       重置：换新链接（旧的立即作废）并显示
//   node bin/phone-link.mjs --role readonly   显示并复制当前只读链接
// ============================================================================
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(SELF_DIR, "..", "guard", "guard.mjs");
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh");
const LAST_FILE = path.join(HOME, "remote", "last-link.txt");

const argv = process.argv.slice(2);
const reset = argv.includes("--reset");
const role = argv.includes("--role") ? argv[argv.indexOf("--role") + 1] : "owner";

function run(args) {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, [GUARD, ...args], { windowsHide: true });
		let out = "";
		p.stdout.on("data", (c) => { out += String(c); });
		p.stderr.on("data", (c) => { out += String(c); });
		p.on("close", (code) => resolve({ code, out }));
	});
}
function clipboard(text) {
	return new Promise((resolve) => {
		try {
			const p = spawn("clip.exe", { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
			p.stdin.end(Buffer.from(text, "utf8"));
			p.on("close", () => resolve(true));
			p.on("error", () => resolve(false));
		} catch { resolve(false); }
	});
}
function popup(title, message) {
	const t = title.replace(/'/g, "''"), m = message.replace(/'/g, "''");
	spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command",
		`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${m}','${t}') | Out-Null`],
		{ windowsHide: true, detached: true }).unref();
}

// 显示当前链接 = guard pair --role X（不带 --reset 就不会换）；要重置才加 --reset
const args = ["pair", "--role", role === "readonly" ? "readonly" : "owner"];
if (reset && role !== "readonly") args.push("--reset");
const { code, out } = await run(args);
const url = (out.match(/https?:\/\/\S+\?t=[A-Za-z0-9_-]+/g) || []).pop() || "";

if (!url) {
	popup("DSH 手机链接 · 失败", "没能取到链接。\n\n请先在终端运行：\nnode guard/guard.mjs status\n\n输出：\n" + out.slice(-400));
	process.exit(1);
}

try {
	fs.mkdirSync(path.dirname(LAST_FILE), { recursive: true });
	fs.writeFileSync(LAST_FILE, url + "\n", "utf8");
} catch { /* 写不进去不影响主流程 */ }

const copied = await clipboard(url);
const roleText = role === "readonly" ? "只读（能看会话与图片，写入被拦）" : "主设备（可发指令 / 看图 / 审批）";
popup(
	reset ? "DSH 手机链接 · 已重置" : "DSH 手机链接 · 当前有效",
	`${roleText}\n\n${url}\n\n` +
	(copied ? "已复制到剪贴板。" : "（复制剪贴板失败，请手动选中上面的链接）") +
	(reset
		? "\n\n旧链接已作废：需要在手机上重新打开这条新链接。"
		: "\n\n链接长期有效，改之前一直是这一条。要换新的请用桌面上的「重置」图标。")
);
console.log(url);
