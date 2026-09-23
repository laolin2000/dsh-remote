#!/usr/bin/env node
// ============================================================================
// bin/install-plugin.mjs —— 把本仓库的 DSH 插件（dsh-remote-panel）装进某个 profile
//
// 装一个 DSH 客户端插件要做四件事，手工做容易漏（这个脚本就是把这四步固化）：
//   1. 把 plugin/ 拷进 <profile>/node_modules/dsh-remote-panel
//   2. 在 <profile>/cordis.patch.yml 末尾追加一段 insert（挂载插件，带 guardPath 配置）
//   3. 若 <profile>/.dsh-builtin-plugins.json 维护了插件名清单，把名字加进去
//   4. 提示重启 DSH（插件树不热重载；客户端包内容变了也要重启才会重算哈希）
//
// 用法：
//   node bin/install-plugin.mjs                        # 装到 ~/.dsh/profiles/web-desktop
//   node bin/install-plugin.mjs --profile <目录>        # 指定 profile
//   node bin/install-plugin.mjs --guard <guard.mjs>    # 指定守卫脚本路径（默认用本仓库里的）
//   node bin/install-plugin.mjs --uninstall            # 反向卸载（只动我们自己加的东西）
//   node bin/install-plugin.mjs --dry-run              # 只打印将要做什么
//
// 脚本会先备份被改动的文件（*.bak-<时间戳>），并且**只追加/删除自己那一段**，
// 不碰 profile 里别的插件配置。
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(SELF_DIR, "..");
const PLUGIN_ID = "remote-panel";
const PLUGIN_NAME = "dsh-remote-panel";

const argv = process.argv.slice(2);
const has = (n) => argv.includes("--" + n);
const flag = (n, d = "") => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };

const DRY = has("dry-run");
const UNINSTALL = has("uninstall");
const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const PROFILE = path.resolve(flag("profile", process.env.DSH_PROFILE || path.join(HOME, "profiles", "web-desktop")));
const PLUGIN_SRC = path.join(REPO, "plugin");
const PLUGIN_DST = path.join(PROFILE, "node_modules", PLUGIN_NAME);
const PATCH_FILE = path.join(PROFILE, "cordis.patch.yml");
const BUILTIN_FILE = path.join(PROFILE, ".dsh-builtin-plugins.json");
const GUARD = path.resolve(flag("guard", path.join(REPO, "guard", "guard.mjs")));

const say = (s) => console.log(s);
const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
function backup(file) {
	if (!fs.existsSync(file)) return "";
	const dst = `${file}.bak-${stamp()}`;
	if (!DRY) fs.copyFileSync(file, dst);
	return dst;
}
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

/** 我们那段 insert 的 YAML 文本（guardPath 用正斜杠，YAML 单引号里反斜杠是字面量容易踩坑）。 */
function blockText(eol) {
	const guardPath = GUARD.replace(/\\/g, "/");
	return ["- insert:", `    - id: ${PLUGIN_ID}`, `      name: '${PLUGIN_NAME}'`, "      config:", `        guardPath: '${guardPath}'`].join(eol);
}
/** 从 patch 文本里摘掉 id: remote-panel 的整段 insert（返回 [新文本, 是否删掉了]）。 */
function stripBlock(text) {
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() !== "- insert:") continue;
		// 该 insert 的条目行（缩进 4 空格）里是否有我们的 id
		if (!/^\s+-\s+id:\s*["']?remote-panel\b/.test(lines[i + 1] || "")) continue;
		let j = i + 1;
		while (j < lines.length && /^\s+\S/.test(lines[j])) j++;          // 吃掉整段
		lines.splice(i, j - i);
		while (i < lines.length && lines[i].trim() === "") lines.splice(i, 1);   // 顺手清掉空行
		return [lines.join(eolOf(text)), true];
	}
	return [text, false];
}
function addBuiltinName(name, eol) {
	if (!fs.existsSync(BUILTIN_FILE)) return "（没有 .dsh-builtin-plugins.json，跳过）";
	let data;
	try { data = JSON.parse(fs.readFileSync(BUILTIN_FILE, "utf8")); } catch { return "（该文件不是合法 JSON，跳过）"; }
	if (!Array.isArray(data.names)) return "（该文件没有 names 数组，跳过）";
	if (data.names.includes(name)) return "（名字已在清单里）";
	data.names.push(name);
	data.updatedAt = new Date().toISOString();
	const b = backup(BUILTIN_FILE);
	if (!DRY) fs.writeFileSync(BUILTIN_FILE, JSON.stringify(data, null, 2) + eol, "utf8");
	return `已写入清单${b ? `（备份 ${path.basename(b)}）` : ""}`;
}
function removeBuiltinName(name, eol) {
	if (!fs.existsSync(BUILTIN_FILE)) return "（没有该文件，跳过）";
	let data;
	try { data = JSON.parse(fs.readFileSync(BUILTIN_FILE, "utf8")); } catch { return "（不是合法 JSON，跳过）"; }
	if (!Array.isArray(data.names) || !data.names.includes(name)) return "（清单里没有这个名字）";
	data.names = data.names.filter((n) => n !== name);
	data.updatedAt = new Date().toISOString();
	const b = backup(BUILTIN_FILE);
	if (!DRY) fs.writeFileSync(BUILTIN_FILE, JSON.stringify(data, null, 2) + eol, "utf8");
	return `已从清单移除${b ? `（备份 ${path.basename(b)}）` : ""}`;
}

say(DRY ? "（dry-run：只打印，不落盘）" : "");
say(`profile : ${PROFILE}`);
say(`插件包  : ${PLUGIN_SRC}  →  ${PLUGIN_DST}`);
say(`守卫脚本: ${GUARD}`);

if (!fs.existsSync(PROFILE)) { console.error(`\n❌ profile 目录不存在：${PROFILE}\n   （用 --profile 指定，或先让 DSH 至少启动过一次）`); process.exit(1); }

if (UNINSTALL) {
	let changed = 0;
	if (fs.existsSync(PATCH_FILE)) {
		const before = fs.readFileSync(PATCH_FILE, "utf8");
		const [after, removed] = stripBlock(before);
		if (removed) {
			const b = backup(PATCH_FILE);
			if (!DRY) fs.writeFileSync(PATCH_FILE, after, "utf8");
			changed++;
			say(`\n✅ 已从 cordis.patch.yml 移除挂载段${b ? `（备份 ${path.basename(b)}）` : ""}`);
		} else say("\n· cordis.patch.yml 里没有我们的挂载段");
	}
	if (fs.existsSync(PLUGIN_DST)) {
		if (!DRY) fs.rmSync(PLUGIN_DST, { recursive: true, force: true });
		changed++;
		say("✅ 已删除插件包目录");
	} else say("· 插件包目录本来就不存在");
	say("✅ " + removeBuiltinName(PLUGIN_NAME, fs.existsSync(BUILTIN_FILE) ? eolOf(fs.readFileSync(BUILTIN_FILE, "utf8")) : "\n"));
	say(changed ? "\n卸载完成。重启一次 DSH 让它忘掉这个插件（运行中的进程仍记得已加载的插件）。" : "\n没有需要卸载的东西。");
	process.exit(0);
}

// ---------------------------------------------------------------- 安装
if (!fs.existsSync(path.join(PLUGIN_SRC, "package.json"))) { console.error(`\n❌ 找不到插件源：${PLUGIN_SRC}\n   （请在仓库根目录运行本脚本）`); process.exit(1); }
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_SRC, "package.json"), "utf8"));
if (!pkg.exports || !pkg.exports["./package.json"]) {
	console.error("\n❌ 插件 package.json 没有导出 './package.json' —— DSH 认不出它是客户端插件（会缓存为「不是客户端插件」且永不重试）。");
	process.exit(1);
}
if (!fs.existsSync(PATCH_FILE)) { console.error(`\n❌ 找不到 ${PATCH_FILE}（profile 里没有这个文件？）`); process.exit(1); }

// 1) 拷贝插件包
if (!DRY) {
	fs.rmSync(PLUGIN_DST, { recursive: true, force: true });          // 覆盖安装：先清掉旧的，避免留陈旧文件
	fs.cpSync(PLUGIN_SRC, PLUGIN_DST, { recursive: true });
}
const files = fs.existsSync(PLUGIN_DST) ? fs.readdirSync(path.join(PLUGIN_DST, "lib")) : fs.readdirSync(path.join(PLUGIN_SRC, "lib"));
say(`\n✅ 插件包已就位（lib/：${files.join(", ")}）`);

// 2) 挂载段
{
	const text = fs.readFileSync(PATCH_FILE, "utf8");
	const eol = eolOf(text);
	if (/^\s+-\s+id:\s*["']?remote-panel\b/m.test(text)) {
		say("· cordis.patch.yml 里已有挂载段（跳过；要改配置请手工编辑）");
	} else {
		const b = backup(PATCH_FILE);
		const next = text.replace(/\s*$/, "") + eol + blockText(eol) + eol;
		if (!DRY) fs.writeFileSync(PATCH_FILE, next, "utf8");
		say(`✅ 已在 cordis.patch.yml 末尾追加挂载段${b ? `（备份 ${path.basename(b)}）` : ""}`);
	}
}

// 3) 插件名清单（有些 profile 靠它认插件）
say("✅ " + addBuiltinName(PLUGIN_NAME, fs.existsSync(BUILTIN_FILE) ? eolOf(fs.readFileSync(BUILTIN_FILE, "utf8")) : "\n"));

say(`
下一步：
  1) 重启 DSH（插件树不热重载；不重启的话界面里不会出现「手机链接」）
  2) 启动守卫（手机链接的鉴权层）：
       node guard/guard.mjs serve        # 常驻；建议用 docs/deploy/ 里的模板做成开机自启
       node guard/guard.mjs pair --qr    # 打印当前手机链接 + 二维码
  3) 想确认装好了：重启后打开 DSH，右下角（EAC监控按钮上方）会出现「手机链接」按钮
  想卸载：node bin/install-plugin.mjs --uninstall`);
