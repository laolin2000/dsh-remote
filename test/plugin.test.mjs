#!/usr/bin/env node
// ============================================================================
// 插件服务端半边的测试（plugin/lib/index.js）
//
// 做法：真的把插件的 apply() 挂到一个假 ctx 上，再用假的 req/res 打它的路由。
// 守卫侧**不造假**：guardPath 指向真的 guard/guard.mjs，配置目录用临时目录，
// 所以 /reset、/qr 这类"调守卫"的路由是被真的验证过的（不是看代码猜）。
//
//   node test/plugin.test.mjs
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(SELF_DIR, "..");
const GUARD = path.join(REPO, "guard", "guard.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-test-"));

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
	if (ok) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}

// 插件在模块加载时读 DSH_HOME，所以必须先设环境变量再 import
process.env.DSH_HOME = TMP;
fs.mkdirSync(path.join(TMP, "remote"), { recursive: true });
const GUARD_CONF = path.join(TMP, "remote", "guard.json");
fs.writeFileSync(GUARD_CONF, JSON.stringify({
	port: 8443, bind: "127.0.0.1", upstream: "http://127.0.0.1:3081",
	superviseTunnel: false, injectPanel: true,
	urlFile: path.join(TMP, "remote", "public-url.txt"),
	links: {
		owner: { token: "OWNER_TOK_abcdefghijklmnop", role: "owner", name: "我的手机", createdAt: "2026-09-23T00:00:00Z" },
		readonly: { token: "RO_TOK_zyxwvutsrqponmlkji", role: "readonly", name: "只读设备", createdAt: "2026-09-23T00:00:00Z" }
	},
	devices: [{ id: "dev-1", name: "我的手机", role: "owner", lastSeenAt: null, createdAt: "2026-09-23T00:00:00Z" }],
	sessions: [{ id: "s1", deviceId: "dev-1", createdAt: Date.now(), expiresAt: Date.now() + 86400000 }],
	pairings: []
}, null, 2));
fs.writeFileSync(path.join(TMP, "remote", "public-url.txt"), "https://demo-entry.trycloudflare.com\n", "utf8");
fs.writeFileSync(path.join(TMP, "remote", "tunnel.json"), JSON.stringify({ pid: 4242, url: "https://demo-entry.trycloudflare.com", restarts: 3 }), "utf8");

const plugin = await import(pathToFileURL(path.join(REPO, "plugin", "lib", "index.js")).href);

/** 把插件挂到假 ctx 上，拿回它的 handler */
function mountHandler() {
	let handler = null;
	plugin.apply({ webServer: { register: (opts) => { handler = opts.handler; return () => {}; } } }, { guardPath: GUARD });
	return handler;
}
const handler = mountHandler();

/** 假 req/res */
function makeReq({ method = "GET", url = "/", headers = {}, body } = {}) {
	const listeners = {};
	const req = {
		method, url, headers,
		on(ev, fn) { listeners[ev] = fn; if (ev === "data" && body !== undefined) fn(Buffer.from(JSON.stringify(body))); if (ev === "end") fn(); return req; },
		destroy() {}
	};
	return req;
}
function makeRes() {
	const res = { statusCode: 0, headers: {}, body: "" };
	res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {}; return res; };
	res.end = (chunk) => { if (chunk) res.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); return res; };
	return res;
}
async function call(pathname, { method = "GET", role, host = "127.0.0.1:50142", body } = {}) {
	const headers = { host };
	if (role !== undefined) headers["x-dsh-remote-role"] = role;
	const res = makeRes();
	await handler(makeReq({ method, url: pathname, headers, body }), res);
	let json = null;
	try { json = JSON.parse(res.body); } catch { /* SVG 之类不是 JSON */ }
	return { status: res.statusCode, headers: res.headers, text: res.body, json };
}

console.log("\n=== 1. 控制面准入（两道闸的插件侧）===");
{
	check("本机直连（Host 回环）放行", (await call("/dsh-remote/status")).status === 200);
	check("经守卫来的 owner 放行", (await call("/dsh-remote/status", { role: "owner" })).status === 200);
	check("经守卫来的只读 → 403", (await call("/dsh-remote/status", { role: "readonly" })).status === 403);
	check("非回环 Host 且无角色头 → 403（公网直连不能碰控制面）",
		(await call("/dsh-remote/status", { host: "demo-entry.trycloudflare.com" })).status === 403);
	check("角色头是 owner 但 Host 非回环 → 仍放行（经守卫的正常路径）",
		(await call("/dsh-remote/status", { role: "owner", host: "demo-entry.trycloudflare.com" })).status === 200);
	check("未知路由 → 404", (await call("/dsh-remote/nope")).status === 404);
	const err = await call("/dsh-remote/status");
	check("403 时给出可读的错误（不是空响应）", (await call("/dsh-remote/status", { role: "readonly" })).json?.error?.includes("owner"));
}

console.log("\n=== 2. 读接口：状态 / 链接 / 设备 ===");
{
	const st = await call("/dsh-remote/status");
	check("状态含入口、隧道、设备、会话数", st.json?.entry === "https://demo-entry.trycloudflare.com" && st.json?.tunnel?.restarts === 3 && st.json?.devices?.length === 1 && st.json?.sessions === 1, JSON.stringify(st.json));
	check("状态里带上 guardPath（便于排查「没配 guardPath」）", typeof st.json?.guardPath === "string" && st.json.configured === true);

	const links = await call("/dsh-remote/links");
	check("读当前链接：owner 与 readonly 都在", links.json?.owner?.url?.includes("t=OWNER_TOK") && links.json?.readonly?.url?.includes("t=RO_TOK"), JSON.stringify(links.json));
	check("链接由 urlFile 的入口 + token 拼出", links.json.owner.url.startsWith("https://demo-entry.trycloudflare.com/?t="));
	check("标记为长期有效", links.json.owner.longLived === true);
	const again = await call("/dsh-remote/links");
	check("再读一次不变（纯读取，不改动）", again.json.owner.url === links.json.owner.url);

	const dev = await call("/dsh-remote/devices");
	check("设备列表可用", dev.json?.devices?.[0]?.name === "我的手机");
}

console.log("\n=== 3. 二维码路由（真调守卫 CLI）===");
{
	const qr = await call("/dsh-remote/qr");
	check("返回 SVG", qr.status === 200 && qr.headers["content-type"].includes("image/svg+xml") && qr.text.trim().startsWith("<svg"), `${qr.status} ${qr.headers["content-type"]} ${qr.text.slice(0, 40)}`);
	check("SVG 里有可扫的模块路径", qr.text.includes("<path d=\"M"));
	const qrRo = await call("/dsh-remote/qr?role=readonly");
	check("只读链接的二维码不同", qrRo.text !== qr.text && qrRo.text.startsWith("<svg"));
	const qrBlocked = await call("/dsh-remote/qr", { role: "readonly" });
	check("只读设备取二维码 → 403", qrBlocked.status === 403);
}

console.log("\n=== 4. 重置路由（真调守卫 CLI，改的是临时配置）===");
{
	const before = JSON.parse(fs.readFileSync(GUARD_CONF, "utf8"));
	const r = await call("/dsh-remote/reset", { method: "POST" });
	check("POST 重置 → 200 且返回新链接", r.status === 200 && r.json?.ok === true && r.json?.owner?.url, `${r.status} ${r.text.slice(0, 100)}`);
	const after = JSON.parse(fs.readFileSync(GUARD_CONF, "utf8"));
	check("守卫配置里的 token 真的换了", after.links.owner.token !== before.links.owner.token);
	check("只读 token 也换了", after.links.readonly.token !== before.links.readonly.token);
	check("返回的链接与配置一致", r.json.owner.url.endsWith(after.links.owner.token));
	check("Get 方法调重置 → 404（不走 GET 改状态）", (await call("/dsh-remote/reset", { method: "GET" })).status === 404);
	check("只读设备调重置 → 403", (await call("/dsh-remote/reset", { method: "POST", role: "readonly" })).status === 403);
}

console.log("\n=== 5. 吊销路由 ===");
{
	check("缺 id → 400", (await call("/dsh-remote/revoke", { method: "POST", body: {} })).status === 400);
	const r = await call("/dsh-remote/revoke", { method: "POST", body: { id: "dev-1" } });
	check("吊销已存在的设备 → 200", r.status === 200 && r.json?.ok === true, `${r.status} ${r.text.slice(0, 120)}`);
	check("只读设备调吊销 → 403", (await call("/dsh-remote/revoke", { method: "POST", role: "readonly", body: { id: "dev-1" } })).status === 403);
}

console.log("\n=== 6. 没配 guardPath 时的失败信息 ===");
{
	let h = null;
	plugin.apply({ webServer: { register: (o) => { h = o.handler; } } }, {});
	const res = makeRes();
	await h(makeReq({ method: "POST", url: "/dsh-remote/reset", headers: { host: "127.0.0.1:50142" } }), res);
	const j = JSON.parse(res.body);
	check("没配 guardPath → 500 且提示怎么配", res.statusCode === 500 && /guardPath/.test(j.error + (j.detail || "")), JSON.stringify(j).slice(0, 160));
	const res2 = makeRes();
	await h(makeReq({ method: "GET", url: "/dsh-remote/links", headers: { host: "127.0.0.1:50142" } }), res2);
	check("但读链接不依赖 guardPath（直接读状态文件）→ 200", res2.statusCode === 200, String(res2.statusCode));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail ? 1 : 0);
