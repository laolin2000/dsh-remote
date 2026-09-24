#!/usr/bin/env node
// ============================================================================
// 文档审计：README / 插件文档 与代码、仓库实际状态是否一致。
//
//   node test/docaudit.mjs
//
// 为什么要有这一层：这个仓库的门面就是文档 —— "怎么装、有哪些命令、只读能干什么"
// 全靠它。文档漂移（写了不存在的命令、计数过期、把本机私有信息抄进去）不会让任何
// 功能测试变红，但会实实在在坑到照着做的人。实测踩到的：克隆命令里带着本机代理端口、
// 插件描述还写着早已改掉的"一次性 token"、目录段的测试计数停在旧值。
//
// 覆盖：
//   ① 内部链接 / 文档提到的仓库路径 / 文档里的命令都真实存在
//   ② package.json 的脚本、版本一致、插件 exports 契约
//   ③ 密钥与本机私有信息不泄漏（真域名、真 token、PAT、本机用户路径）
//   ④ 守卫端点、插件路由、CLI 子命令 ⇄ 文档的交叉引用（双向）
//   ⑤ 中英 README 结构对齐（章节数、语言切换链接）
//   ⑥ 测试计数自洽（合计 = 各项之和）
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SELF_DIR, "..");
process.chdir(ROOT);

let pass = 0; const problems = [];
const check = (name, ok, detail = "") => {
	if (ok) { pass++; console.log(`  ✅ ${name}`); }
	else { problems.push(`${name}${detail ? "  " + detail : ""}`); console.log(`  ❌ ${name}  ${detail}`); }
};

const tracked = execSync("git ls-files", { encoding: "utf8" }).trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const mds = tracked.filter((f) => f.endsWith(".md"));
const zh = fs.readFileSync("README.md", "utf8");
const en = fs.readFileSync("README.en.md", "utf8");
const pzh = fs.readFileSync("plugin/README.md", "utf8");
const pen = fs.readFileSync("plugin/README.en.md", "utf8");
const docs = zh + en + pzh + pen;

console.log("\n=== 1. 内部链接与文档里提到的路径/命令 ===");
{
	let checked = 0, bad = [];
	for (const f of mds) {
		const src = fs.readFileSync(f, "utf8");
		const dir = path.dirname(f);
		for (const m of src.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
			const target = m[1].split("#")[0].trim();
			if (!target || /^(https?:|mailto:)/.test(target)) continue;
			checked++;
			if (!fs.existsSync(path.resolve(ROOT, dir, decodeURIComponent(target)))) bad.push(`${f} → ${target}`);
		}
		for (const re of [/`((?:bin|guard|plugin|docs|test)\/[A-Za-z0-9._\-/]+)`/g, /`(node\s+[A-Za-z0-9._\-/]+\.mjs)`/g]) {
			for (const m of src.matchAll(re)) {
				const p = m[1].replace(/^node\s+/, "");
				checked++;
				if (!fs.existsSync(path.resolve(ROOT, p))) bad.push(`${f} → ${p}`);
			}
		}
	}
	check(`文档里的 ${checked} 条内部链接/路径都存在`, bad.length === 0, bad.join(" | "));
}

console.log("\n=== 2. 脚本、版本与插件契约 ===");
{
	const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
	const missing = [];
	for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
		const m = cmd.match(/node\s+(\S+\.mjs)/);
		if (m && !fs.existsSync(path.resolve(ROOT, m[1]))) missing.push(`${name} → ${m[1]}`);
	}
	check("package.json 的每个脚本都指向存在的文件", missing.length === 0, missing.join(" | "));
	const pluginPkg = JSON.parse(fs.readFileSync("plugin/package.json", "utf8"));
	check("插件包版本与主包一致", pluginPkg.version === pkg.version, `${pluginPkg.version} vs ${pkg.version}`);
	check("插件 exports 导出 ./package.json（DSH 硬要求）", pluginPkg.exports?.["./package.json"] === "./package.json");
	check("插件声明了 dsh.client（否则不会有界面）", Boolean(pluginPkg.dsh?.client));
	for (const p of Object.values(pluginPkg.exports || {})) {
		const f = typeof p === "string" ? p : p?.default;
		if (f) check(`exports 指向的文件存在：${f}`, fs.existsSync(path.join("plugin", f)), f);
	}
}

console.log("\n=== 3. 不泄漏运行态凭据与本机私有信息 ===");
{
	// 一条通用规则：仓库里不该出现**真实**的用户目录 / 工具目录 / 代理端口。
	// 占位符（<你> / %USERPROFILE% / $HOME / you / xxx 之类）是文档正常用法，不算泄漏。
	const PLACEHOLDER = /^(<[^>]*>|%[^%]*%|\$\{?[^}]*\}?|~|you|yourname|username|user|name|xxx+|\u4f60|\u4f60\u7684?)$/i;
	const generic = {
		"GitHub PAT": /ghp_[A-Za-z0-9]{20,}/,
		"写死的本机代理": /http\.proxy=https?:\/\/127\.0\.0\.1:\d+/i,
		"本机工具目录": /[A-Za-z]:[\\/]toolresources/i,
	};
	const hits = [];
	const files = tracked.map((f) => ({ f, lines: fs.readFileSync(f, "utf8").split(/\r?\n/) }));
	for (const { f, lines } of files) {
		lines.forEach((line, i) => {
			for (const [label, re] of Object.entries(generic)) if (re.test(line)) hits.push(`${label} @ ${f}:${i + 1}`);
			for (const m of line.matchAll(/[A-Za-z]:[\\/]Users[\\/]([^\\/\s"'`]+)/g)) {
				if (!PLACEHOLDER.test(m[1])) hits.push(`真实用户目录（${m[1]}）@ ${f}:${i + 1}`);
			}
		});
	}
	check("仓库里没有真实用户目录 / PAT / 写死的代理端口", hits.length === 0, hits.join(" | "));

	// 第二条规则：**这台机器上真实在用的**域名与 token 不能出现在仓库里。
	// 值从运行态读（不是写死在脚本里，否则脚本自己就成了泄漏源）。
	const stateDir = process.env.DSH_REMOTE_DIR || path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh"), "remote");
	const live = [];
	try {
		const conf = JSON.parse(fs.readFileSync(path.join(stateDir, "guard.json"), "utf8"));
		for (const [name, l] of Object.entries(conf.links || {})) if (l?.token) live.push(`真实${name} token`, String(l.token).slice(0, 12));
	} catch { /* 没有运行态就跳过这条 */ }
	try {
		const url = fs.readFileSync(path.join(stateDir, "public-url.txt"), "utf8").trim();
		const host = new URL(url).hostname;
		if (host && !/^(127\.0\.0\.1|localhost)$/.test(host)) live.push("真实隧道域名", host);
	} catch { /* 同上 */ }
	if (live.length) {
		const leak = [];
		for (const { f, lines } of files) {
			lines.forEach((line, i) => {
				for (let k = 0; k < live.length; k += 2) if (line.includes(live[k + 1])) leak.push(`${live[k]} @ ${f}:${i + 1}`);
			});
		}
		check(`仓库里没有本机真实在用的域名/token（核对 ${live.length / 2} 个值）`, leak.length === 0, leak.join(" | "));
	} else {
		check("运行态不存在，跳过「真实值」比对（通用规则已检查）", true);
	}
}

console.log("\n=== 4. 代码 ⇄ 文档 的交叉引用 ===");
{
	const guard = fs.readFileSync("guard/guard.mjs", "utf8");
	const idx = fs.readFileSync("plugin/lib/index.js", "utf8");
	const routes = [...new Set([...idx.matchAll(/pathname === "(\/dsh-remote\/[a-z]+)"/g)].map((m) => m[1]))].sort();
	const endpoints = [...new Set([...guard.matchAll(/urlPath === "(\/__guard\/[a-z.]+)"/g)].map((m) => m[1]))].sort();
	const cli = ["serve", "pair", "qr", "link", "print", "devices", "revoke", "status", "tunnel", "doctor", "diag"];

	const undocumentedRoutes = routes.filter((r) => !pzh.includes(r) || !pen.includes(r));
	check(`插件 ${routes.length} 条路由在中英插件文档里都有说明`, undocumentedRoutes.length === 0, undocumentedRoutes.join(" "));
	const tableRoutes = [...new Set([...pzh.matchAll(/`(?:GET|POST) (\/dsh-remote\/[a-z]+)/g)].map((m) => m[1]))].sort();
	const phantom = tableRoutes.filter((r) => !routes.includes(r));
	check("插件文档没有写出代码里不存在的路由", phantom.length === 0, phantom.join(" "));
	const undocumentedEndpoints = endpoints.filter((e) => !zh.includes(e));
	check(`守卫 ${endpoints.length} 个端点都有文档`, undocumentedEndpoints.length === 0, undocumentedEndpoints.join(" "));
	const undocumentedCli = cli.filter((c) => !new RegExp(`\\b${c}\\b`).test(docs));
	check(`守卫 ${cli.length} 个 CLI 子命令都有文档`, undocumentedCli.length === 0, undocumentedCli.join(" "));
}

console.log("\n=== 5. 中英文档结构对齐 ===");
{
	check("中英 README 的 ## 章节数一致",
		[...zh.matchAll(/^## /gm)].length === [...en.matchAll(/^## /gm)].length,
		`${[...zh.matchAll(/^## /gm)].length} vs ${[...en.matchAll(/^## /gm)].length}`);
	check("中文 README 顶部有 English 切换", /\[English\]\(README\.en\.md\)/.test(zh));
	check("英文 README 顶部有中文切换", /\[中文\]\(README\.md\)/.test(en));
	check("插件中文 README 有英文切换", /\[English\]\(README\.en\.md\)/.test(pzh));
	check("插件英文 README 有中文切换", /\[中文\]\(README\.md\)/.test(pen));
	check("README 里的测试计数行存在且可解析", /测试合计 \*\*\d+ 项断言\*\*：/.test(zh));
}

console.log("\n=== 6. 测试计数自洽 ===");
{
	const m = zh.match(/测试合计 \*\*(\d+) 项断言\*\*：(.+)/);
	const total = Number(m?.[1] || 0);
	const parts = [...(m?.[2] || "").matchAll(/([^\d]+?)\s*(\d+)/g)].map((x) => Number(x[2]));
	const sum = parts.reduce((a, b) => a + b, 0);
	check(`README 宣称合计 ${total} 项 = 各项之和 ${sum}`, total === sum && total > 0, parts.join("+"));
	const layout = zh.match(/test\/\s+测试：(.+)/);
	const layoutParts = [...(layout?.[1] || "").matchAll(/([a-z.]+)\((\d+)\)/g)].map((x) => Number(x[2]));
	check("目录段的各套件计数与合计口径一致（相加 = 合计）",
		layoutParts.length > 0 && layoutParts.reduce((a, b) => a + b, 0) === total,
		`${layoutParts.join("+")} vs ${total}`);
}

console.log(`\n================ 文档审计：${pass} 通过 / ${problems.length} 失败 ================`);
process.exit(problems.length ? 1 : 0);
