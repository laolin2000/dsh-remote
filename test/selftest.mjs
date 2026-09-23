#!/usr/bin/env node
// ============================================================================
// dsh-remote guard 自测：用「假 DSH 上游」把鉴权、角色、长期链接全部跑一遍。
// 全程在临时目录与临时端口上进行，不接触真实 DSH、不改任何真实配置。
//
//   node test/selftest.mjs
//
// 覆盖：未授权拒绝 → 配对码（一次性）→ 长期链接（默认不变 / 重置才换 / 可重复用）
//       → 只读设备读写边界 → WS 升级 → Origin 校验 → 控制面 owner-only
//       → 吊销即刻生效 → 审计留痕
// ============================================================================
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(SELF_DIR, "..", "guard", "guard.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "guard-selftest-"));
const UP_PORT = 34871;
const GUARD_PORT = 34872;

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
	if (ok) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}

// ---------------------------------------------------------------- 假上游
const upstreamSeen = [];
const upstream = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => { body += c; });
	req.on("end", () => {
		upstreamSeen.push({ method: req.method, url: req.url, host: req.headers.host, device: req.headers["x-dsh-remote-device"], role: req.headers["x-dsh-remote-role"], acceptEncoding: req.headers["accept-encoding"] });
		if (/^\/api\//.test(req.url)) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, upstream: true }));
			return;
		}
		// /compressed：模拟「本地中间层把页面压成 br/gzip」的真实情况。
		// 这正是线上踩到的坑：守卫遇到 content-encoding 就跳过注入 → 手机端面板与外观纠偏静默失效。
		if (req.url.startsWith("/compressed")) {
			const html = "<html><head></head><body><div id=root>FAKE-DSH-UI-COMPRESSED</div></body></html>";
			const enc = req.url.endsWith("gzip") ? "gzip" : "br";
			const body = enc === "gzip" ? zlib.gzipSync(html) : zlib.brotliCompressSync(html);
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": enc, "content-length": String(body.length) });
			res.end(body);
			return;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end("<html><head></head><body><div id=root>FAKE-DSH-UI</div></body></html>");
	});
});
upstream.on("upgrade", (req, socket) => {
	socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: dummy\r\n\r\n");
});
await new Promise((r) => upstream.listen(UP_PORT, "127.0.0.1", r));

// ---------------------------------------------------------------- 起 guard
const env = { ...process.env, DSH_REMOTE_DIR: TMP, DSH_HOME: TMP };
fs.writeFileSync(path.join(TMP, "guard.json"), JSON.stringify({
	port: GUARD_PORT, bind: "127.0.0.1", upstream: `http://127.0.0.1:${UP_PORT}`, superviseTunnel: false
}, null, 2));

const guard = spawn(process.execPath, [GUARD, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
const guardLog = [];
guard.stdout.on("data", (c) => guardLog.push(String(c)));
guard.stderr.on("data", (c) => guardLog.push(String(c)));
await new Promise((r) => setTimeout(r, 1200));

const BASE = `http://127.0.0.1:${GUARD_PORT}`;

async function call(pathname, { method = "GET", cookie, body, headers = {}, bearer, local = false } = {}) {
	const h = { ...headers };
	// 默认模拟「经隧道从公网来」：守卫靠这些头区分本机直连与公网请求
	if (!local && !Object.keys(h).some((k) => k.toLowerCase() === "x-forwarded-for")) h["x-forwarded-for"] = "203.0.113.7";
	if (cookie) h.cookie = cookie;
	if (bearer) h.authorization = `Bearer ${bearer}`;
	if (body !== undefined) h["content-type"] = "application/json";
	const res = await fetch(BASE + pathname, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
	const text = await res.text();
	return { status: res.status, text, setCookie: res.headers.get("set-cookie") || "", headers: res.headers };
}
function wsProbe(pathname, cookie) {
	return new Promise((resolve) => {
		const key = Buffer.from("0123456789abcdef").toString("base64");
		const lines = [`GET ${pathname} HTTP/1.1`, `Host: 127.0.0.1:${GUARD_PORT}`, "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13"];
		if (cookie) lines.push(`Cookie: ${cookie}`);
		lines.push("", "");
		const sock = net.connect(GUARD_PORT, "127.0.0.1", () => sock.write(lines.join("\r\n")));
		let buf = "";
		sock.on("data", (d) => { buf += String(d); if (buf.includes("\r\n\r\n")) { sock.destroy(); resolve(buf.split("\r\n")[0]); } });
		sock.on("error", () => resolve("ERROR"));
		setTimeout(() => { sock.destroy(); resolve("TIMEOUT"); }, 3000);
	});
}
function runCli(args) {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, [GUARD, ...args], { env, stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		p.stdout.on("data", (c) => { out += String(c); });
		p.on("close", () => resolve(out));
	});
}
async function pairingCode(role) {
	const out = await runCli(["pair", "--code", "--role", role, "--name", role === "owner" ? "手机" : "iPad"]);
	return (out.match(/([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/) || [])[1] || null;
}
async function linkToken(role) {
	const out = await runCli(["pair", "--role", role]);
	const urls = out.match(/https?:\/\/\S+\?t=[A-Za-z0-9_-]+/g) || [];
	return urls.length ? urls[urls.length - 1].split("t=")[1] : null;
}

const jar = {};

console.log(`\n临时目录：${TMP}\n上游：127.0.0.1:${UP_PORT}　守卫：127.0.0.1:${GUARD_PORT}\n`);
console.log("=== 1. 未授权一律拒绝（fail-closed）===");
{
	check("无 cookie 访问 / → 401", (await call("/")).status === 401);
	const page = await call("/");
	check("未授权看到的是配对页，不是 DSH 页面", page.text.includes("dsh-remote") && !page.text.includes("FAKE-DSH-UI"));
	check("无 cookie POST /api/session.list → 401", (await call("/api/session.list", { method: "POST", body: {} })).status === 401);
	check("伪造 cookie → 401", (await call("/", { cookie: "dsh_remote_sid=forged" })).status === 401);
	const h = await call("/__guard/health");
	check("健康检查无需鉴权 → 200 ok", h.status === 200 && h.text.trim() === "ok");
}

console.log("\n=== 2. 一次性配对码（临时给一台设备用）===");
{
	const ownerCode = await pairingCode("owner");
	const roCode = await pairingCode("readonly");
	check("能生成配对码", !!ownerCode && !!roCode, `${ownerCode} / ${roCode}`);
	check("错误配对码 → 403", (await call("/__guard/pair", { method: "POST", body: { code: "AAAA-BBBB-CCCC" } })).status === 403);
	const r = await call("/__guard/pair", { method: "POST", body: { code: ownerCode, name: "手机" } });
	const j = JSON.parse(r.text);
	check("正确配对码 → 200 且下发 cookie", r.status === 200 && /dsh_remote_sid=/.test(r.setCookie));
	check("配对返回 owner 角色", j.device?.role === "owner");
	jar.owner = r.setCookie.split(";")[0];
	jar.ownerToken = j.token;
	check("配对码一次性：再用 → 403", (await call("/__guard/pair", { method: "POST", body: { code: ownerCode } })).status === 403);

	const r2 = await call("/__guard/pair", { method: "POST", body: { code: roCode, name: "iPad" } });
	jar.readonly = r2.setCookie.split(";")[0];
	check("第二个设备拿到 readonly 角色", JSON.parse(r2.text).device?.role === "readonly");
}

console.log("\n=== 3. 只读设备：读得到、写不动（服务端强制）===");
{
	check("只读 POST session.list → 放行", (await call("/api/session.list", { method: "POST", cookie: jar.readonly, body: {} })).status === 200);
	check("只读 POST session.attachment → 放行（看图）", (await call("/api/session.attachment", { method: "POST", cookie: jar.readonly, body: {} })).status === 200);
	check("只读 POST session.prompt → 403（发指令被拦）", (await call("/api/session.prompt", { method: "POST", cookie: jar.readonly, body: {} })).status === 403);
	check("只读 POST session.cancel → 403", (await call("/api/session.cancel", { method: "POST", cookie: jar.readonly, body: {} })).status === 403);
	check("只读 POST /__job-action → 403（杀任务被拦）", (await call("/__job-action", { method: "POST", cookie: jar.readonly, body: { action: "stop" } })).status === 403);
	check("只读 POST /screen/touch → 403（触控注入被拦）", (await call("/screen/touch", { method: "POST", cookie: jar.readonly, body: {} })).status === 403);
	const page = await call("/", { cookie: jar.readonly });
	check("只读 GET / → 200（可浏览/看图）", page.status === 200 && page.text.includes("FAKE-DSH-UI"));
	check("只读调用未知新方法 → 403（默认拒绝）", (await call("/api/some.future.method", { method: "POST", cookie: jar.readonly, body: {} })).status === 403);
	check("只读访问面板控制面 → 403（防提权）", (await call("/__guard/link", { cookie: jar.readonly })).status === 403);
}

console.log("\n=== 4. owner 设备：能写、能看控制面 ===");
{
	check("owner POST session.prompt → 200", (await call("/api/session.prompt", { method: "POST", cookie: jar.owner, body: {} })).status === 200);
	check("owner POST /__job-action → 200", (await call("/__job-action", { method: "POST", cookie: jar.owner, body: {} })).status === 200);
	check("Bearer 设备令牌同样可用（供 App/CLI）", (await call("/api/session.list", { method: "POST", bearer: jar.ownerToken, body: {} })).status === 200);
	check("owner 看状态 → 200 且列出设备", (await call("/__guard/status", { cookie: jar.owner })).status === 200);
}

console.log("\n=== 5. 上游收到的头（Host 改写仍然生效）===");
{
	const last = upstreamSeen.at(-1) || {};
	check("上游看到 Host=127.0.0.1:<上游端口>", last.host === `127.0.0.1:${UP_PORT}`, `实际 ${last.host}`);
	check("网关标记转发到上游", !!last.device && !!last.role, JSON.stringify(last));
	check("同源 Origin 的写请求放行", (await call("/api/session.list", { method: "POST", cookie: jar.owner, body: {}, headers: { origin: `http://127.0.0.1:${GUARD_PORT}` } })).status === 200);
	check("跨站 Origin 的写请求 → 403（CSRF）", (await call("/api/session.prompt", { method: "POST", cookie: jar.owner, body: {}, headers: { origin: "https://evil.example.com" } })).status === 403);
}

console.log("\n=== 6. WebSocket 升级 ===");
{
	check("无 cookie 升级 → 401", (await wsProbe("/api/events.mux")).includes("401"));
	check("owner 升级 /api/events.mux → 101", (await wsProbe("/api/events.mux", jar.owner)).includes("101"));
	check("只读升级 /api/events.host → 101", (await wsProbe("/api/events.host", jar.readonly)).includes("101"));
	check("只读升级插件终端 WS → 403", (await wsProbe("/sidebar/ws/agent-terminals", jar.readonly)).includes("403"));
	check("owner 升级插件终端 WS → 101（owner 不被拦）", (await wsProbe("/sidebar/ws/agent-terminals", jar.owner)).includes("101"));
}

console.log("\n=== 7. 长期链接：默认不变、重置才换、可重复使用（对齐 ZCode 形态）===");
{
	const a = await call("/__guard/links", { cookie: jar.owner });
	const A = JSON.parse(a.text);
	check("面板能读到两条当前链接", a.status === 200 && !!A.owner?.url && !!A.readonly?.url, a.text.slice(0, 120));

	const b = await call("/__guard/links", { cookie: jar.owner });
	const B = JSON.parse(b.text);
	check("再读一次链接不变（长期有效）", A.owner.url === B.owner.url && A.readonly.url === B.readonly.url);

	const c = await call("/__guard/link", { cookie: jar.owner });
	check("读主链接不会改动它", JSON.parse(c.text).url === A.owner.url);
	check("读只读链接不会换掉主链接", (await call("/__guard/link?role=readonly", { cookie: jar.owner })).status === 200 && JSON.parse((await call("/__guard/links", { cookie: jar.owner })).text).owner.url === A.owner.url);

	const t1 = A.owner.url.split("t=")[1];
	const t2 = A.readonly.url.split("t=")[1];
	check("长期链接第一次使用 → 302", (await call("/?t=" + t1)).status === 302);
	check("同一链接可再次使用（不是一次性）", (await call("/?t=" + t1)).status === 302);
	const roUse = await call("/?t=" + t2);
	check("只读链接可用 → 302 且角色是只读", roUse.status === 302, "实际 " + roUse.status);
	const roCookie = roUse.setCookie.split(";")[0];
	check("只读链接换来的设备写被拦（403）", (await call("/api/session.prompt", { method: "POST", cookie: roCookie, body: {} })).status === 403);
	check("同一台设备反复开链接不会堆设备（按名字复用）", (await call("/?t=" + t1)).status === 302);

	const e = await call("/__guard/link?reset=1", { cookie: jar.owner });
	const E = JSON.parse(e.text);
	const F = JSON.parse((await call("/__guard/links", { cookie: jar.owner })).text);
	check("重置后主链接变了", !!E.url && E.url !== A.owner.url);
	check("重置后只读链接也换了（不留旧凭据）", F.readonly.url !== A.readonly.url);
	check("旧链接重置后立即失效 → 401", (await call("/?t=" + t1)).status === 401);
	check("重置不会踢掉已配对设备", (await call("/api/session.list", { method: "POST", cookie: jar.owner, body: {} })).status === 200);
}

console.log("\n=== 8. 吊销与状态 ===");
{
	const st = JSON.parse((await call("/__guard/status", { cookie: jar.owner })).text);
	check("owner 状态里列出设备（含刚配的两台 + 链接换来的）", (st.devices || []).length >= 2, JSON.stringify((st.devices || []).map((d) => d.name)));
	check("只读设备看状态 → 403", (await call("/__guard/status", { cookie: jar.readonly })).status === 403);
	const revoke = spawn(process.execPath, [GUARD, "revoke", "iPad"], { env, stdio: "ignore" });
	await new Promise((r) => revoke.on("close", r));
	check("吊销后原 cookie 立即失效 → 401", (await call("/api/session.list", { method: "POST", cookie: jar.readonly, body: {} })).status === 401);
	check("owner 不受影响 → 200", (await call("/api/session.list", { method: "POST", cookie: jar.owner, body: {} })).status === 200);
}

console.log("\n=== 9. 本机直连可信 + 公网仍须鉴权（关键区分）===");
{
	// 不带隧道头 = 本机直连（DSH 桌面页面靠这条兜底）→ 视为 owner
	const localStatus = await call("/__guard/status", { local: true });
	check("本机直连（无隧道头）→ 200，等同 owner", localStatus.status === 200, "实际 " + localStatus.status);
	check("本机直连设备名标为「本机(直连)」", localStatus.text.includes("本机"), localStatus.text.slice(0, 80));
	const localLinks = await call("/__guard/links", { local: true });
	check("本机直连能读到链接", localLinks.status === 200 && JSON.parse(localLinks.text).ok === true, "实际 " + localLinks.status);

	// 带隧道头但没有 cookie = 公网未授权 → 必须 401（否则就是泄漏）
	const remote = await call("/__guard/status");
	check("经隧道无 cookie 访问控制面 → 403（本机可信没有把公网放进来）", remote.status === 403, "实际 " + remote.status);
	const remotePage = await call("/");
	check("经隧道无 cookie 打开页面 → 401 配对页，不是 DSH", remotePage.status === 401 && !remotePage.text.includes("FAKE-DSH-UI"));

	// 伪造隧道头也不该被当成本机
	const spoof = await call("/__guard/links", { headers: { "cf-connecting-ip": "1.2.3.4" } });
	check("只加一个 Cf- 头也不能白拿 owner 权限 → 403", spoof.status === 403, "实际 " + spoof.status);

	// CORS：只对本机来源页面放开
	const cors = await call("/__guard/links", { local: true, headers: { origin: "http://127.0.0.1:50142" } });
	check("本机来源页面的跨源读 → 带 Access-Control-Allow-Origin", cors.headers.get("access-control-allow-origin") === "http://127.0.0.1:50142", JSON.stringify(cors.headers.get("access-control-allow-origin")));
	const corsRemote = await call("/", { headers: { origin: "https://evil.example.com" } });
	check("公网来源拿不到 CORS 放行", !corsRemote.headers.get("access-control-allow-origin"));
	const preflight = await call("/__guard/links", { method: "OPTIONS", headers: { origin: "http://127.0.0.1:50142" } });
	check("OPTIONS 预检 → 204", preflight.status === 204, "实际 " + preflight.status);
	// 预检响应也必须带 CORS 头，否则浏览器会拦下页面里的跨源 POST（重置/吊销的兜底路径）
	check("预检 204 带 Access-Control-Allow-Origin", preflight.headers.get("access-control-allow-origin") === "http://127.0.0.1:50142", JSON.stringify(preflight.headers.get("access-control-allow-origin")));
	check("预检 204 允许 POST 方法", (preflight.headers.get("access-control-allow-methods") || "").includes("POST"), String(preflight.headers.get("access-control-allow-methods")));
	check("预检 204 允许 content-type 头", (preflight.headers.get("access-control-allow-headers") || "").includes("content-type"), String(preflight.headers.get("access-control-allow-headers")));
	check("预检 204 带 allow-credentials（否则带 cookie 的跨源请求会被拦）", preflight.headers.get("access-control-allow-credentials") === "true", String(preflight.headers.get("access-control-allow-credentials")));
	const preflightRevoke = await call("/__guard/revoke", { method: "OPTIONS", headers: { origin: "http://127.0.0.1:50142", "access-control-request-method": "POST" } });
	check("撤销端点的预检同样带 CORS 头", preflightRevoke.headers.get("access-control-allow-origin") === "http://127.0.0.1:50142");
}

console.log("\n=== 10. 页面注入：面板脚本 + 启动期外观纠偏 ===");
{
	// 外观纠偏读的是 DSH 的 settings.yaml（自测里就在临时目录里造一份）
	fs.writeFileSync(path.join(TMP, "settings.yaml"), "ui-theme:\n  preference: dark\n  accent: default\n", "utf8");
	const page = await call("/", { cookie: jar.owner });
	check("owner 打开页面 → 200", page.status === 200 && page.text.includes("FAKE-DSH-UI"));
	check("注入了手机链接面板脚本", page.text.includes('<script src="/__guard/ui.js" defer></script>'));
	check("注入了启动期外观纠偏脚本", page.text.includes('id="__dsh_remote_appearance"'), page.text.slice(0, 120));
	check("外观纠偏钉住服务端偏好（dark）", page.text.includes('var P="dark"'));
	check("外观纠偏会在用户动手后停手（不跟用户抢设置）",
		page.text.includes("pointerdown") && page.text.includes("keydown") && page.text.includes("touchstart"));
	check("外观纠偏有超时兜底（8 秒）", page.text.includes("8000"));
	check("纠偏脚本在业务脚本之前（位于 <head> 内）",
		page.text.indexOf("__dsh_remote_appearance") < page.text.indexOf("FAKE-DSH-UI"));

	const uiJs = await call("/__guard/ui.js", { cookie: jar.owner });
	check("面板脚本本体可取（/__guard/ui.js → 200 JS）", uiJs.status === 200 && uiJs.headers.get("content-type").includes("javascript"), `${uiJs.status} ${uiJs.headers.get("content-type")}`);
	check("面板脚本里含只读开关与二维码按钮", uiJs.text.includes("只读") && uiJs.text.includes("二维码"));
	check("未授权取面板脚本 → 401", (await call("/__guard/ui.js")).status === 401);

	// 关掉注入开关后不应再注入（插件生效后可以这样避免两个按钮）
	const cfgFile = path.join(TMP, "guard.json");
	const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
	fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, injectPanel: false }, null, 2));
	await new Promise((r) => setTimeout(r, 1100));
	const page2 = await call("/", { cookie: jar.owner });
	check("injectPanel=false 时不再注入面板脚本", !page2.text.includes("/__guard/ui.js"));
	fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
	await new Promise((r) => setTimeout(r, 1100));
	check("恢复 injectPanel 后重新注入", (await call("/", { cookie: jar.owner })).text.includes("/__guard/ui.js"));
}

console.log("\n=== 10b. 上游把页面压缩了也要能注入（线上踩到的坑）===");
{
	// 真实链路：cloudflared → 守卫 → remote.mjs（会把 HTML 压成 br）→ DSH。
	// 早先守卫遇到 content-encoding 就跳过注入，导致手机端面板与外观纠偏在真实链路上静默失效。
	for (const [urlPath, enc] of [["/compressed", "br"], ["/compressed-gzip", "gzip"]]) {
		const page = await call(urlPath, { cookie: jar.owner });
		check(`上游返回 ${enc} 压缩页面时仍能解压并注入（${urlPath}）`,
			page.status === 200 && page.text.includes("/__guard/ui.js") && page.text.includes("FAKE-DSH-UI-COMPRESSED"), `${page.status} 长度 ${page.text.length}`);
		check(`注入后不再声称是压缩体（content-encoding 已去掉，${enc}）`, !page.headers.get("content-encoding"), String(page.headers.get("content-encoding")));
		check(`content-length 与实际字节数一致（${enc}）`, Number(page.headers.get("content-length")) === Buffer.byteLength(page.text, "utf8"));
		check(`外观纠偏也注入了（${enc}）`, page.text.includes("__dsh_remote_appearance"));
	}
	check("守卫给上游发的 accept-encoding 是 identity（本跳回环，压缩没收益还挡注入）",
		upstreamSeen.some((s) => s.acceptEncoding === "identity"), JSON.stringify(upstreamSeen.at(-1)));
}

console.log("\n=== 11. 二维码端点 ===");
{
	const qr = await call("/__guard/qr", { cookie: jar.owner });
	check("owner 取二维码 → 200 SVG", qr.status === 200 && qr.headers.get("content-type").includes("image/svg+xml"), `实际 ${qr.status} ${qr.headers.get("content-type")}`);
	check("SVG 结构完整（含静默区与路径）", qr.text.startsWith("<svg") && qr.text.includes("<path d=\"M") && qr.text.includes("viewBox="));
	const qrRo = await call("/__guard/qr?role=readonly", { cookie: jar.owner });
	check("只读链接的二维码与主链接不同", qrRo.status === 200 && qrRo.text !== qr.text);
	const qrScaled = await call("/__guard/qr?scale=3", { cookie: jar.owner });
	const vb = Number((qrScaled.text.match(/viewBox="0 0 (\d+)/) || [])[1] || 0);
	const w = Number((qrScaled.text.match(/width="(\d+)"/) || [])[1] || 0);
	check("二维码尺寸随 scale 变化（宽 = 模块数 × scale）", vb > 0 && w === vb * 3, `viewBox ${vb}, width ${w}`);
	check("只读设备取二维码 → 403（控制面）", (await call("/__guard/qr", { cookie: jar.readonly })).status === 403);
	const qrCli = await runCli(["qr", "--role", "owner"]);
	check("CLI `qr` 输出终端字符画", /[▀▄█]/.test(qrCli), qrCli.slice(0, 60));
	const qrCliSvg = await runCli(["qr", "--svg"]);
	check("CLI `qr --svg` 输出 SVG", qrCliSvg.trim().startsWith("<svg"), qrCliSvg.slice(0, 40));
	const pairQr = await runCli(["pair", "--role", "owner", "--qr"]);
	check("CLI `pair --qr` 同时给出链接与二维码", /[▀▄█]/.test(pairQr) && /\?t=/.test(pairQr));
}

console.log("\n=== 11. 重置端点（插件兜底路径用）===");
{
	const before = JSON.parse((await call("/__guard/links", { cookie: jar.owner })).text);
	const r = await call("/__guard/reset", { method: "POST", cookie: jar.owner, body: {} });
	const j = JSON.parse(r.text);
	check("POST /__guard/reset → 200", r.status === 200 && j.ok === true, `实际 ${r.status}`);
	check("重置后主链接换了", j.owner?.url && j.owner.url !== before.owner.url);
	check("重置后只读链接也换了", j.readonly?.url !== before.readonly.url);
	const after = JSON.parse((await call("/__guard/links", { cookie: jar.owner })).text);
	check("重置后的新链接确实生效（再读一致）", after.owner.url === j.owner.url);
	check("旧链接立即失效 → 401", (await call("/?t=" + before.owner.url.split("t=")[1])).status === 401);
	check("只读设备调重置 → 403（防提权）", (await call("/__guard/reset", { method: "POST", cookie: jar.readonly, body: {} })).status === 403);
	check("重置不会踢掉已配对设备", (await call("/api/session.list", { method: "POST", cookie: jar.owner, body: {} })).status === 200);
}

console.log("\n=== 12. 隧道意图（down 之后守护不该把它拉回来）===");
{
	const cfgFile = path.join(TMP, "guard.json");
	const readCfg = () => JSON.parse(fs.readFileSync(cfgFile, "utf8"));
	check("初始 superviseTunnel=false（自测默认不起隧道）", readCfg().superviseTunnel === false);
	await runCli(["tunnel", "down"]);
	check("`tunnel down` 把意图也关掉（superviseTunnel=false）", readCfg().superviseTunnel === false);
	const st = JSON.parse(await runCli(["tunnel", "status"]));
	check("`tunnel status` 报 desired=false 且 not alive", st.desired === false && st.alive === false, JSON.stringify(st));
	// 用一个不存在的隧道二进制：up 必须明确报错，而不是"等待域名超时"（曾经的坑：spawn 失败被吞成 unhandledRejection）
	const bad = path.join(TMP, "no-such-cloudflared.exe");
	const cfg = readCfg();
	cfg.cloudflared = bad;
	fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
	await new Promise((r) => setTimeout(r, 1200));       // 让服务按 mtime 重载
	const up = await runCli(["tunnel", "up"]);
	check("`tunnel up` 用不存在的二进制 → 明确报错退出", /找不到|失败|不能是/.test(up), up.slice(0, 120));
	await runCli(["tunnel", "down"]);                    // 收尾：确保保持关闭
	check("收尾后仍是关闭状态", readCfg().superviseTunnel === false);
}

console.log("\n=== 13. 审计日志 ===");
{
	const auditFile = path.join(TMP, "audit.jsonl");
	const lines = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
	const kinds = new Set(lines.map((l) => l.event + ":" + (l.reason || l.result || "")));
	check("审计有记录", lines.length > 0, `${lines.length} 行`);
	check("记下了只读被拒", [...kinds].some((k) => k.includes("readonly")), [...kinds].join(","));
	check("记下了未授权拒绝", [...kinds].some((k) => k.includes("unauthenticated")));
	check("记下了配对成功", [...kinds].some((k) => k.includes("pair:ok")));
	check("记下了链接兑换", [...kinds].some((k) => k.startsWith("link")));
	check("记下了重置链接", [...kinds].some((k) => k.includes("reset-link")));
}

// ---------------------------------------------------------------- 收尾
guard.kill();
upstream.close();
await new Promise((r) => setTimeout(r, 300));
console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
if (fail) console.log("（guard 日志尾部）\n" + guardLog.join("").split("\n").slice(-12).join("\n"));
if (process.env.KEEP_TMP === "1") console.log("临时目录保留：" + TMP);
else fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
