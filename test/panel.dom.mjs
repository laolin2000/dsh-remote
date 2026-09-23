#!/usr/bin/env node
// ============================================================================
// 面板行为测试（真实 DOM，用 jsdom）：守卫注入版 guard/ui.js 与插件版 plugin/lib/client.js
//
// 为什么要这一层：用户报过的两个 bug 都只在这一层暴露 ——
//   ① 关闭面板后遮罩没被移除（页面变暗、点不动）；
//   ② 「只读」按钮点开后收不起来（切换逻辑写错）。
// 光靠服务端自测抓不到它们，所以这里用 jsdom 把面板真正挂起来、点一遍。
//
// 依赖：jsdom 只是**开发期**依赖（运行时依然零依赖）。没装就跳过，退出码 0：
//   npm i --no-save jsdom          # 或：npm i -D jsdom
//   node test/panel.dom.mjs
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
let JSDOM;
try {
	({ JSDOM } = require_("jsdom"));
} catch {
	try {
		// 允许用 NODE_PATH / 显式路径指定 jsdom（CI 里常常装在别处）
		const guess = process.env.JSDOM_PATH || path.join(process.env.TEMP || "/tmp", "qrref", "node_modules", "jsdom");
		({ JSDOM } = require_(guess));
	} catch {
		console.log("⏭  跳过：没有安装 jsdom（开发期依赖）。安装：npm i --no-save jsdom");
		process.exit(0);
	}
}

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
	if (ok) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 30));

// ---------------------------------------------------------------- 假后端
const OWNER_LINK = "https://demo-entry.trycloudflare.com/?t=OWNERTOKEN_1234567890";
const RO_LINK = "https://demo-entry.trycloudflare.com/?t=READONLYTOKEN_0987654321";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>';
const QUIET_DEVICE = { id: "dev-1", name: "我的手机", role: "owner", lastSeenAt: new Date().toISOString() };
const RO_DEVICE = { id: "dev-2", name: "只读设备", role: "readonly", lastSeenAt: null };

/** 造一个假 fetch：按路径给出响应，并记录调用（方法、路径、body）。 */
function makeFetch({ ownerVisible = true, calls = [] } = {}) {
	return async function fetchStub(url, options = {}) {
		const method = (options.method || "GET").toUpperCase();
		const full = String(url);
		const p = full.replace(/^https?:\/\/[^/]+/, "");
		calls.push({ method, path: p, body: options.body });
		const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v, text: async () => JSON.stringify(v) });
		const raw = (text, ctype = "text/plain", status = 200) => ({ ok: status < 400, status, json: async () => { throw new Error("not json"); }, text: async () => text, headers: { get: () => ctype } });
		// 守卫注入版（/__guard/*）
		if (p.startsWith("/__guard/")) {
			if (!ownerVisible) return { ok: false, status: 403, json: async () => null, text: async () => "" };
			if (p.startsWith("/__guard/status")) return json({ ok: true, viewer: "我的手机", sessions: 2, tunnel: { url: "https://demo-entry.trycloudflare.com", restarts: 1 } });
			if (p.startsWith("/__guard/links")) return json({ ok: true, owner: { url: OWNER_LINK, createdAt: "2026-09-23T00:00:00Z" }, readonly: { url: RO_LINK, createdAt: "2026-09-23T00:00:00Z" } });
			if (p.startsWith("/__guard/devices")) return json({ ok: true, devices: [QUIET_DEVICE, RO_DEVICE] });
			if (p.startsWith("/__guard/qr")) return raw(SVG, "image/svg+xml");
			if (p.startsWith("/__guard/reset")) return json({ ok: true, owner: { url: OWNER_LINK + "NEW", createdAt: "2026-09-23T01:00:00Z" }, readonly: { url: RO_LINK + "NEW" } });
			if (p.startsWith("/__guard/revoke")) return json({ ok: true });
			return json({ ok: false }, 404);
		}
		// 插件版（/dsh-remote/*）
		if (p.startsWith("/dsh-remote/")) {
			if (p.startsWith("/dsh-remote/status")) return json({ ok: true, guardPath: "x", tunnel: {}, sessions: 1 });
			if (p.startsWith("/dsh-remote/links")) return json({ ok: true, owner: { url: OWNER_LINK, createdAt: "2026-09-23T00:00:00Z" }, readonly: { url: RO_LINK } });
			if (p.startsWith("/dsh-remote/devices")) return json({ ok: true, devices: [QUIET_DEVICE] });
			if (p.startsWith("/dsh-remote/qr")) return raw(SVG, "image/svg+xml");
			if (p.startsWith("/dsh-remote/reset")) return json({ ok: true, owner: { url: OWNER_LINK + "NEW" }, readonly: { url: RO_LINK + "NEW" } });
			if (p.startsWith("/dsh-remote/revoke")) return json({ ok: true });
			return json({ ok: false }, 404);
		}
		if (full.startsWith("http://127.0.0.1:8443/__guard/")) return json({ ok: true, owner: { url: OWNER_LINK } });   // 直连守卫兜底
		return json({ ok: false }, 404);
	};
}

/** 造一个装了面板脚本的 jsdom 环境。 */
function setupDom({ scriptPath, ownerVisible = true, clipboardOk = true } = {}) {
	const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "http://127.0.0.1:50142/", runScripts: "outside-only" });
	const w = dom.window;
	const calls = [];
	w.fetch = makeFetch({ ownerVisible, calls });
	w.confirm = () => true;
	const copied = [];
	w.navigator.clipboard = { writeText: async (t) => { if (!clipboardOk) throw new Error("denied"); copied.push(t); } };
	w.__slots = {};
	w.__ModuleLoader__ = {
		load({ id, factory }) {
			const fakeReact = {
				useEffect: (fn) => fn(),
				createElement: (type, props, ...children) => ({ type, props, children })
			};
			const fakeRequire = (name) => (name === "react" ? fakeReact : {});
			const mod = factory(fakeRequire);
			w.__slots[id] = mod;
		}
	};
	w.eval(fs.readFileSync(scriptPath, "utf8"));
	return { dom, w, calls, copied };
}
const btn = (w) => w.document.getElementById("__dsh_remote_button");
const layer = (w) => w.document.getElementById("__dsh_remote_layer");
const texts = (w) => [...w.document.querySelectorAll("button,div")].map((e) => e.textContent || "");
const findByText = (w, t) => [...w.document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === t);

// ---------------------------------------------------------------- 守卫注入版
console.log("\n=== A. 守卫注入版 guard/ui.js ===");
{
	const { w, calls, copied } = setupDom({ scriptPath: path.join(SELF_DIR, "..", "guard", "ui.js") });
	await tick(); await tick();
	check("owner 设备上出现「手机链接」按钮", !!btn(w));
	check("按钮文案是「手机链接」", (btn(w).textContent || "").includes("手机链接"));

	btn(w).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick(); await tick(); await tick();
	check("点开后出现浮层容器", !!layer(w));
	check("浮层里显示当前链接", (layer(w).textContent || "").includes(OWNER_LINK), (layer(w).textContent || "").slice(0, 80));
	check("读到状态行（链接创建于…长期有效）", (layer(w).textContent || "").includes("长期有效"));
	check("设备列表渲染出两台设备", (layer(w).textContent || "").includes("我的手机") && (layer(w).textContent || "").includes("只读设备"));

	const copyBtn = findByText(w, "复制");
	copyBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick(); await tick();
	check("「复制」把链接写进剪贴板", copied.includes(OWNER_LINK), JSON.stringify(copied));
	check("复制成功有明确反馈（按钮变「已复制 ✓」）", (copyBtn.textContent || "").includes("已复制"), copyBtn.textContent);
	check("状态行给出时间戳", (layer(w).textContent || "").match(/已复制主链接到剪贴板 · \d/) !== null);

	// 只读：开 → 关（回归用例：旧实现点开后收不起来）
	const roBtn = findByText(w, "只读");
	roBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick(); await tick();
	check("点「只读」展开只读链接并可复制", copied.includes(RO_LINK), JSON.stringify(copied));
	check("展开后按钮变「收起只读」", (roBtn.textContent || "").includes("收起"), roBtn.textContent);
	roBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick();
	check("再点一次能收起（旧实现收不起来）", (roBtn.textContent || "").trim() === "只读", roBtn.textContent);

	// 二维码
	const qrBtn = findByText(w, "二维码");
	qrBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick(); await tick(); await tick();
	check("「二维码」拉取 SVG 并内联进面板", (layer(w).innerHTML || "").includes("<svg"), (layer(w).innerHTML || "").slice(0, 120));
	check("二维码请求走了 /__guard/qr", calls.some((c) => c.path.startsWith("/__guard/qr")), JSON.stringify(calls.map((c) => c.path)));

	// 重置：必须用 POST
	const resetBtn = findByText(w, "重置");
	resetBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick(); await tick(); await tick();
	const resetCall = calls.find((c) => c.path.startsWith("/__guard/reset"));
	check("「重置」用 POST 调 /__guard/reset", !!resetCall && resetCall.method === "POST", JSON.stringify(resetCall));

	// 吊销
	const revokeBtn = [...w.document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "吊销");
	revokeBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick(); await tick();
	check("「吊销」发出 revoke 请求", calls.some((c) => c.path.startsWith("/__guard/revoke")));

	// 关闭：遮罩与面板必须一起消失（用户报的 bug）
	const closeBtn = findByText(w, "关闭");
	closeBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick();
	check("关闭后整个浮层（含遮罩）被移除", !layer(w) && !w.document.getElementById("__dsh_remote_panel"));
	check("关闭后页面上没有残留的遮罩层", !w.document.querySelector("div[style*='rgba(0, 0, 0, 0.45)']"));
}

console.log("\n=== B. 只读设备上不渲染面板 ===");
{
	const { w } = setupDom({ scriptPath: path.join(SELF_DIR, "..", "guard", "ui.js"), ownerVisible: false });
	await tick(); await tick();
	check("只读设备（控制面 403）不出现按钮", !btn(w));
}

console.log("\n=== C. 插件版 plugin/lib/client.js ===");
{
	const { w, calls, copied } = setupDom({ scriptPath: path.join(SELF_DIR, "..", "plugin", "lib", "client.js") });
	const mod = w.__slots["dsh-remote-panel"];
	check("客户端 chunk 通过 __ModuleLoader__ 导出 apply/inject", !!mod && typeof mod.apply === "function" && Array.isArray(mod.inject));
	check("inject 声明了 slots", (mod.inject || []).includes("slots"));

	// 用假 ctx 注册槽位（组件挂载即建按钮）
	const registered = [];
	const fakeCtx = { slots: { register: (opts, comp) => { registered.push({ opts, comp }); return () => {}; } } };
	mod.apply(fakeCtx);
	check("注册了两个槽位（浮层按钮 + 设置页条目）", registered.length === 2, JSON.stringify(registered.map((r) => r.opts.name)));
	check("浮层槽位带 id（漏了会报 list slot requires options.id）", registered.every((r) => r.opts.id === "dsh-remote-panel"));
	check("浮层槽位是 shell.overlay", registered[0].opts.name === "shell.overlay");
	check("设置项槽位是 settings.general.item", registered[1].opts.name === "settings.general.item");
	registered[0].comp();          // 模拟 React 渲染这个函数组件（触发它的 useEffect → 挂按钮）
	await tick();
	check("挂载后出现按钮", !!btn(w), String(btn(w)));

	btn(w).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick(); await tick(); await tick();
	check("面板显示当前链接（走插件路由）", (layer(w)?.textContent || "").includes(OWNER_LINK));
	check("插件版请求走 /dsh-remote/*", calls.some((c) => c.path.startsWith("/dsh-remote/links")), JSON.stringify(calls.map((c) => c.path)));
	const resetBtn = findByText(w, "重置");
	resetBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick(); await tick(); await tick();
	check("插件版重置用 POST /dsh-remote/reset", calls.some((c) => c.path.startsWith("/dsh-remote/reset") && c.method === "POST"), JSON.stringify(calls.filter((c) => c.path.includes("reset"))));
	const qrBtn = findByText(w, "二维码");
	qrBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick(); await tick(); await tick();
	check("插件版二维码按钮能拉到 SVG", (layer(w)?.innerHTML || "").includes("<svg"), (layer(w)?.innerHTML || "").slice(0, 100));
	const closeBtn = findByText(w, "关闭") || findByText(w, "收起");
	closeBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick();
	check("插件版关闭后浮层被移除", !layer(w));
	// 去重：守卫注入版与本插件不会同时挂两个按钮
	btn(w).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick();
	check("同一页面只有一个「手机链接」按钮（去重生效）", w.document.querySelectorAll("#__dsh_remote_button").length === 1);
}

console.log("\n=== D. 剪贴板被拒时如实报错 ===");
{
	const { w } = setupDom({ scriptPath: path.join(SELF_DIR, "..", "guard", "ui.js"), clipboardOk: false });
	await tick(); await tick();
	btn(w).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick(); await tick(); await tick();
	const copyBtn = findByText(w, "复制");
	copyBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick(); await tick();
	check("自动复制失败时提示手动选中，而不是假装成功", (layer(w).textContent || "").includes("手动") || (layer(w).textContent || "").includes("拦下"), (layer(w).textContent || "").slice(0, 120));
}

console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail ? 1 : 0);
