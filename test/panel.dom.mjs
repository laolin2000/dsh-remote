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
function makeFetch({ ownerVisible = true, calls = [], health = null, healthFails = false } = {}) {
	return async function fetchStub(url, options = {}) {
		const method = (options.method || "GET").toUpperCase();
		const full = String(url);
		const p = full.replace(/^https?:\/\/[^/]+/, "");
		calls.push({ method, path: p, body: options.body });
		const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v, text: async () => JSON.stringify(v) });
		const raw = (text, ctype = "text/plain", status = 200) => ({ ok: status < 400, status, json: async () => { throw new Error("not json"); }, text: async () => text, headers: { get: () => ctype } });
		// 守卫注入版（/__guard/*）
		if (p.startsWith("/__guard/")) {
			// whoami 是**任何**已配对设备都能问的：只读设备靠它才认得出自己的身份
			if (p.startsWith("/__guard/whoami")) {
				return ownerVisible
					? json({ ok: true, name: "我的手机", role: "owner", via: "cookie", readonly: false })
					: json({ ok: true, name: "只读设备", role: "readonly", via: "cookie", readonly: true });
			}
			if (!ownerVisible) return { ok: false, status: 403, json: async () => null, text: async () => "" };
			if (p.startsWith("/__guard/status")) return json({ ok: true, viewer: "我的手机", sessions: 2, tunnel: { url: "https://demo-entry.trycloudflare.com", restarts: 1 } });
			if (p.startsWith("/__guard/links")) return json({ ok: true, owner: { url: OWNER_LINK, createdAt: "2026-09-23T00:00:00Z" }, readonly: { url: RO_LINK, createdAt: "2026-09-23T00:00:00Z" } });
			if (p.startsWith("/__guard/devices")) return json({ ok: true, devices: [QUIET_DEVICE, RO_DEVICE] });
			if (p.startsWith("/__guard/qr")) return raw(SVG, "image/svg+xml");
			if (p.startsWith("/__guard/doctor")) return json({
				ok: true, entry: "https://demo-entry.trycloudflare.com",
				steps: [
					{ id: "upstream", label: "上游（DSH / 中间层）", status: "ok", detail: "http://127.0.0.1:3081 → HTTP 200", hint: "" },
					{ id: "guard", label: "守卫（鉴权层）", status: "ok", detail: "监听 127.0.0.1:8443", hint: "" },
					{ id: "tunnel", label: "公网隧道（cloudflared）", status: "fail", detail: "隧道进程不在", hint: "点「启动 / 修复」" },
					{ id: "public", label: "公网可达性", status: "warn", detail: "当前只有本机入口", hint: "把隧道拉起来" },
					{ id: "links", label: "手机链接", status: "ok", detail: "主链接与只读链接都已生成", hint: "" },
					{ id: "devices", label: "已授权设备", status: "ok", detail: "1 台设备 · 1 个在线会话", hint: "" }
				]
			});
			if (p.startsWith("/__guard/reset")) return json({ ok: true, owner: { url: OWNER_LINK + "NEW", createdAt: "2026-09-23T01:00:00Z" }, readonly: { url: RO_LINK + "NEW" } });
			if (p.startsWith("/__guard/revoke")) return json({ ok: true });
			return json({ ok: false }, 404);
		}
		// 插件版（/dsh-remote/*）
		if (p.startsWith("/dsh-remote/")) {
			if (p.startsWith("/dsh-remote/status")) return json({ ok: true, guardPath: "x", tunnel: {}, sessions: 1 });
			if (p.startsWith("/dsh-remote/health")) {
				if (healthFails) return json({ ok: false }, 404);
				const baseSteps = [
					{ id: "dsh", label: "DSH 本体（面板宿主）", status: "ok", detail: "插件运行中 · 本机端口 127.0.0.1:50142", hint: "" },
					{ id: "upstream", label: "上游（DSH / 本机中间层）", status: "ok", detail: "http://127.0.0.1:3081 → HTTP 200", hint: "" },
					{ id: "guard", label: "守卫（鉴权层）", status: "ok", detail: "http://127.0.0.1:8443 响应正常", hint: "" },
					{ id: "tunnel", label: "公网隧道（cloudflared）", status: "ok", detail: "进程 PID 123 存活 · 域名 https://demo-entry.trycloudflare.com", hint: "" },
					{ id: "public", label: "公网可达性", status: "ok", detail: "https://demo-entry.trycloudflare.com → HTTP 200（手机能连上）", hint: "" },
					{ id: "links", label: "手机链接", status: "ok", detail: "主链接与只读链接都已生成", hint: "" },
					{ id: "devices", label: "已授权设备", status: "ok", detail: "1 台设备 · 1 个在线会话", hint: "" }
				];
				const merged = health ? baseSteps.map((st) => (health.steps || []).find((x) => x.id === st.id) || st) : baseSteps;
				return json({ ok: true, guard: true, guardPort: 8443, upstream: "http://127.0.0.1:3081", tunnel: { alive: true, url: "https://demo-entry.trycloudflare.com", desired: true }, cloudflared: "x", problems: [], steps: merged, ...(health || {}) });
			}
			if (p.startsWith("/dsh-remote/start")) return json({ ok: true, guard: { ok: true, started: true }, tunnel: { ok: true, started: false } });
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
function setupDom({ scriptPath, ownerVisible = true, clipboardOk = true, health = null, healthFails = false, calls: givenCalls = null } = {}) {
	const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "http://127.0.0.1:50142/", runScripts: "outside-only" });
	const w = dom.window;
	const calls = givenCalls || [];
	w.fetch = makeFetch({ ownerVisible, calls, health, healthFails });
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

	// 手机端也有逐环节体检（在关闭之前检查）
	await tick(); await tick();
	check("手机端面板也有「连接体检（逐环节）」", (layer(w).textContent || "").includes("连接体检（逐环节）"), (layer(w).textContent || "").slice(0, 200));
	const panA = layer(w).textContent || "";
	check("手机端逐环节列出上游/守卫/隧道/公网/链接/设备", ["上游（DSH / 中间层）", "守卫（鉴权层）", "公网隧道（cloudflared）", "公网可达性", "手机链接", "已授权设备"].every((x) => panA.includes(x)), panA.slice(0, 300));
	check("手机端也标出失败项与修法", /失败/.test(panA) && /↳/.test(panA), panA.slice(0, 300));
	check("手机端摘要给出合计", /6 项 · 正常 4 · 注意 1 · 失败 1/.test(panA), panA.slice(0, 200));

	// 关闭：遮罩与面板必须一起消失（用户报的 bug）
	const closeBtn = findByText(w, "关闭");
	closeBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick();
	check("关闭后整个浮层（含遮罩）被移除", !layer(w) && !w.document.getElementById("__dsh_remote_panel"));
	check("关闭后页面上没有残留的遮罩层", !w.document.querySelector("div[style*='rgba(0, 0, 0, 0.45)']"));
}

console.log("\n=== B. 只读设备：不开控制面板，但要能一眼看出自己是只读 ===");
{
	const { w } = setupDom({ scriptPath: path.join(SELF_DIR, "..", "guard", "ui.js"), ownerVisible: false });
	await tick(); await tick();
	check("只读设备（控制面 403）不出现控制面板按钮", !btn(w));
	const badge = () => w.document.getElementById("__dsh_remote_ro_badge");
	check("只读设备出现身份徽章（否则界面上看不出任何差别）", !!badge());
	check("徽章文案写明是只读", !!badge() && badge().textContent.includes("只读"), badge() && badge().textContent);
	badge().dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick();
	const text = (w.document.getElementById("__dsh_remote_panel") || {}).textContent || "";
	check("点开徽章写明当前设备与角色", text.includes("只读设备") && text.includes("只读权限"), text.slice(0, 60));
	check("点开徽章说明写入是被服务端拦下的", text.includes("403"), text.slice(0, 120));
	check("只读设备没有读到控制面数据（没有链接框）", !text.includes(OWNER_LINK));
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

console.log("\n=== E. 按钮位置：与「EAC监控」排成一列（用户指定的位置）===");
{
	// 场景 1：页面上有 EAC 监控按钮 → 应贴在它正上方、同一列（相同的 right）
	const { w } = setupDom({ scriptPath: path.join(SELF_DIR, "..", "guard", "ui.js") });
	const eac = w.document.createElement("div");
	eac.setAttribute("style", "position:fixed;right:14px;bottom:14px;padding:6px 12px;border-radius:999px");
	eac.textContent = "EAC监控";
	w.document.body.appendChild(eac);
	// jsdom 不做布局：手动给 EAC 按钮一个真实浏览器里的矩形（right = 1024-14, top = 768-14-27）
	eac.getBoundingClientRect = () => ({ right: 1010, top: 727, left: 950, bottom: 754, width: 60, height: 27, x: 950, y: 727 });
	await tick(); await tick();
	const b = btn(w);
	check("按钮存在", !!b);
	check("与 EAC 按钮同一列（right 相同）", b.style.right === "14px", b.style.right);
	check("位于 EAC 按钮正上方（bottom = EAC 顶边 + 8px 间距）", b.style.bottom === "49px", b.style.bottom);

	// 场景 2：页面上没有 EAC 按钮 → 用缺省位置（右下角、大约 EAC 按钮上方）
	const { w: w2 } = setupDom({ scriptPath: path.join(SELF_DIR, "..", "guard", "ui.js") });
	await tick(); await tick(); await tick();
	const b2 = btn(w2);
	check("没有 EAC 按钮时也在右侧（缺省 right:14px）", b2.style.right === "14px", b2.style.right);
	check("缺省 bottom 是 56px（EAC 按钮的缺省高度之上）", b2.style.bottom === "56px", b2.style.bottom);

	// 场景 3：插件版同样对齐
	const { w: w3 } = setupDom({ scriptPath: path.join(SELF_DIR, "..", "plugin", "lib", "client.js") });
	const eac3 = w3.document.createElement("div");
	eac3.setAttribute("style", "position:fixed;right:14px;bottom:14px");
	eac3.textContent = "EAC 监控";
	w3.document.body.appendChild(eac3);
	eac3.getBoundingClientRect = () => ({ right: 1010, top: 727, left: 950, bottom: 754, width: 60, height: 27, x: 950, y: 727 });
	const mod3 = w3.__slots["dsh-remote-panel"];
	const reg3 = [];
	mod3.apply({ slots: { register: (o, c) => { reg3.push({ opts: o, comp: c }); return () => {}; } } });
	reg3[0].comp();
	await tick(); await tick();
	const b3 = btn(w3);
	check("插件版同样与 EAC 同列（right 相同，容忍空格写法）", b3 && b3.style.right === "14px", b3 && b3.style.right);
	check("插件版同样在其正上方", b3 && b3.style.bottom === "49px", b3 && b3.style.bottom);
}

console.log("\n=== F. 两个按钮大小与颜色统一（与 EAC 监控同一套样式）===");
{
	// 断言依据：dsh-eac-monitor 的 .em-quick / .em-dot / .em-quickText 的实际样式值
	const { w } = setupDom({ scriptPath: path.join(SELF_DIR, "..", "guard", "ui.js") });
	await tick(); await tick();
	const b = btn(w);
	const raw = () => b.getAttribute("style") || "";
	check("内边距与 EAC 一致（6px 12px）", b.style.padding === "6px 12px", b.style.padding);
	check("圆角一致（999px 胶囊）", b.style.borderRadius === "999px", b.style.borderRadius);
	// jsdom 会把 color-mix 这类新语法丢掉，所以背景/描边比对原始 style 属性
	check("背景用同一主题变量（bg-layer-2）", raw().includes("--dsw-alias-bg-layer-2"), raw().slice(0, 120));
	check("描边用同一主题变量（border-l1）", raw().includes("--dsw-alias-border-l1"), raw().slice(0, 120));
	check("阴影一致", b.style.boxShadow === "0 4px 14px rgba(0,0,0,.35)", b.style.boxShadow);
	check("字号一致（11px）", raw().includes("font:11px/1"), raw().slice(0, 120));
	const dot = b.children[0], text = b.children[1];
	const dotRaw = dot.getAttribute("style") || "";
	check("状态点与 EAC 的 .em-dot 同规格同色（8px，#22c55e）",
		dotRaw.includes("width:8px") && dotRaw.includes("height:8px") && dotRaw.includes("#22c55e"), dotRaw);
	check("文字颜色与 .em-quickText 一致（label-secondary 变量）", text.getAttribute("style").includes("--dsw-alias-label-secondary"), text.getAttribute("style"));
	// 悬停描边变成主题蓝（EAC 的 :hover 行为）
	b.dispatchEvent(new w.MouseEvent("mouseenter", { bubbles: false }));
	check("悬停时描边与 EAC 一致（business-primary）", b.style.borderColor.includes("--dsw-alias-state-business-primary"), b.style.borderColor);
	b.dispatchEvent(new w.MouseEvent("mouseleave", { bubbles: false }));
	check("移开后描边还原", b.style.borderColor.includes("--dsw-alias-border-l1"), b.style.borderColor);

	// 插件版同样断言
	const { w: w4 } = setupDom({ scriptPath: path.join(SELF_DIR, "..", "plugin", "lib", "client.js") });
	const mod4 = w4.__slots["dsh-remote-panel"];
	const reg4 = [];
	mod4.apply({ slots: { register: (o, c) => { reg4.push({ o, c }); return () => {}; } } });
	reg4[0].c();
	await tick(); await tick();
	const b4 = btn(w4);
	const raw4 = b4.getAttribute("style") || "";
	check("插件版同样统一（内边距/背景/字号）",
		raw4.includes("padding:6px 12px") && raw4.includes("--dsw-alias-bg-layer-2") && raw4.includes("font:11px/1"),
		raw4.slice(0, 120));
}

console.log("\n=== G. 运行状态与「一键修复」 ===");
{
	// 场景 1：一切正常 → 状态行报 ✓，不需要修复按钮
	const { w } = setupDom({ scriptPath: path.join(SELF_DIR, "..", "plugin", "lib", "client.js") });
	const mod = w.__slots["dsh-remote-panel"];
	const reg = [];
	mod.apply({ slots: { register: (o, c) => { reg.push({ o, c }); return () => {}; } } });
	reg[0].c();
	await tick(); await tick(); await tick(); await tick();
	btn(w).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
	await tick(); await tick(); await tick(); await tick();
	const pan = layer(w).textContent || "";
	check("面板里有「运行状态」一栏", pan.includes("运行状态"));
	check("正常时逐环节全部标为正常", /逐环节体检：7 项 · 正常 7/.test(pan), pan.slice(0, 160));
	check("正常时也逐条列出守卫与隧道", /守卫（鉴权层）/.test(pan) && /公网隧道（cloudflared）/.test(pan), pan.slice(0, 220));
	check("逐环节列表把每个环节都列出来了（7 项）", (pan.match(/DSH 本体|上游（DSH|守卫（鉴权层）|公网隧道|公网可达性|手机链接|已授权设备/g) || []).length >= 7, pan.slice(0, 300));
	check("每步都标了状态（正常）", /正常/.test(pan) && /公网可达性/.test(pan));
	check("摘要行给出合计", /逐环节体检：7 项 · 正常 7/.test(pan), pan.slice(0, 160));
	const fixBtn = [...w.document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("启动 / 修复"));
	check("正常时修复按钮是隐藏的", !!fixBtn && (fixBtn.getAttribute("style") || "").includes("display:none"), fixBtn && fixBtn.getAttribute("style"));

	// 场景 2：守卫掉了 → 状态行说明问题、修复按钮出现；点它发出 /start
	const calls = [];
	const { w: w2 } = setupDom({
		scriptPath: path.join(SELF_DIR, "..", "plugin", "lib", "client.js"), calls,
		health: {
			guard: false, problems: ["守卫（鉴权层）：http://127.0.0.1:8443 没有响应"],
			tunnel: { alive: false, url: "", desired: true },
			steps: [
				{ id: "guard", label: "守卫（鉴权层）", status: "fail", detail: "http://127.0.0.1:8443 没有响应（手机链接、二维码都靠它）", hint: "点下面的「启动 / 修复」" },
				{ id: "tunnel", label: "公网隧道（cloudflared）", status: "fail", detail: "隧道进程不在", hint: "点「启动 / 修复」" }
			]
		}
	});
	const mod2 = w2.__slots["dsh-remote-panel"];
	const reg2 = [];
	mod2.apply({ slots: { register: (o, c) => { reg2.push({ o, c }); return () => {}; } } });
	reg2[0].c();
	await tick(); await tick(); await tick(); await tick();
	btn(w2).dispatchEvent(new w2.MouseEvent("click", { bubbles: true }));
	await tick(); await tick(); await tick(); await tick();
	const pan2 = layer(w2).textContent || "";
	check("守卫掉了时逐环节里标为失败并给出原因", /守卫（鉴权层）/.test(pan2) && /没有响应/.test(pan2) && /失败/.test(pan2), pan2.slice(0, 240));
	check("失败项带修法提示（↳）", /↳/.test(pan2), pan2.slice(0, 300));
	check("摘要行统计失败数", /失败 2/.test(pan2), pan2.slice(0, 160));
	const fix2 = [...w2.document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("启动 / 修复"));
	check("有问题时修复按钮可见", !!fix2 && !(fix2.getAttribute("style") || "").includes("display:none"), fix2 && fix2.getAttribute("style"));
	fix2.dispatchEvent(new w2.MouseEvent("click", { bubbles: true }));
	await tick(); await tick(); await tick(); await tick();
	check("点修复会 POST /dsh-remote/start", calls.some((c) => c.path.startsWith("/dsh-remote/start") && c.method === "POST"), JSON.stringify(calls.map((c) => c.method + " " + c.path)));

	// 场景 3：插件服务端半边是旧版（/health 404）→ 提示重启 DSH，而不是静默
	const { w: w3 } = setupDom({ scriptPath: path.join(SELF_DIR, "..", "plugin", "lib", "client.js"), healthFails: true });
	const mod3 = w3.__slots["dsh-remote-panel"];
	const reg3 = [];
	mod3.apply({ slots: { register: (o, c) => { reg3.push({ o, c }); return () => {}; } } });
	reg3[0].c();
	await tick(); await tick(); await tick();
	btn(w3).dispatchEvent(new w3.MouseEvent("click", { bubbles: true }));
	await tick(); await tick(); await tick(); await tick();
	check("旧版服务端半边时提示「重启一次 DSH」", /重启一次 DSH/.test(layer(w3).textContent || ""), (layer(w3).textContent || "").slice(0, 200));
}

console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail ? 1 : 0);
