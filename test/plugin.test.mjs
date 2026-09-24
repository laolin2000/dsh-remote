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
import net from "node:net";
import { spawn, execSync } from "node:child_process";
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
process.env.DSH_REMOTE_HEAL_SECONDS = "0";   // 测试里关掉自愈定时器，避免干扰
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
async function call(pathname, { method = "GET", role, host = "127.0.0.1:50142", body, device } = {}) {
	const headers = { host };
	if (role !== undefined) headers["x-dsh-remote-role"] = role;
	if (device !== undefined) headers["x-dsh-remote-device"] = encodeURIComponent(device);
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

	// whoami：面板顶部显示"我是谁、什么角色"（只读设备靠它才认得出自己）
	const me = await call("/dsh-remote/whoami");
	check("whoami 报出当前设备与角色（本机直连 → owner）", me.status === 200 && me.json?.role === "owner" && me.json?.readonly === false, JSON.stringify(me.json));
	check("whoami 带回设备名（本机直连标注为「本机(直连)」）", /本机/.test(String(me.json?.name)), String(me.json?.name));
	const meRemote = await call("/dsh-remote/whoami", { role: "owner", device: "我的手机", host: "demo-entry.trycloudflare.com" });
	check("经守卫来的 owner：whoami 报出设备名与 owner 角色", meRemote.json?.name === "我的手机" && meRemote.json?.role === "owner", JSON.stringify(meRemote.json));
	const meRo = await call("/dsh-remote/whoami", { role: "readonly", host: "demo-entry.trycloudflare.com" });
	check("只读设备取 whoami → 403（守卫那一道先拦下，防提权面变大）", meRo.status === 403, String(meRo.status));
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

console.log("\n=== 7. 没有公网入口时也不能给出一条没有域名的链接（回归用例）===");
{
	// 清掉 urlFile 与隧道状态：模拟"隧道还没起来"的真实情况
	const conf = JSON.parse(fs.readFileSync(GUARD_CONF, "utf8"));
	try { fs.rmSync(conf.urlFile || path.join(TMP, "remote", "public-url.txt"), { force: true }); } catch {}
	fs.writeFileSync(path.join(TMP, "remote", "tunnel.json"), JSON.stringify({ pid: null, url: null, startedAt: null, desired: true, restarts: 1 }), "utf8");
	const r = await call("/dsh-remote/links");
	const u = r.json?.owner?.url || "";
	check("链接带上了本机域名前缀（不再是 /?t=…）", /^https?:\/\/[^/]+\/\?t=[A-Za-z0-9_-]+$/.test(u), JSON.stringify(u));
	check("前缀是守卫的绑定地址与端口（127.0.0.1:8443）", u.startsWith("http://127.0.0.1:8443/?t="), u);
	check("标记 local=true，面板据此提示要先起隧道", r.json?.owner?.local === true && r.json?.local === true, JSON.stringify({ o: r.json?.owner?.local, l: r.json?.local }));
	check("只读那条同样是完整 URL", /^https?:\/\/[^/]+\/\?t=/.test(r.json?.readonly?.url || ""), r.json?.readonly?.url);
	// 有公网域名时应优先用它，且 local=false
	fs.writeFileSync(conf.urlFile, "https://demo-entry.trycloudflare.com\n", "utf8");
	const r2 = await call("/dsh-remote/links");
	check("有公网入口时用公网域名且 local=false", r2.json?.owner?.url.startsWith("https://demo-entry.trycloudflare.com/?t=") && r2.json?.owner?.local === false, JSON.stringify(r2.json?.owner));
}

console.log("\n=== 8. 链路自检与一键启动：/health 与 /start（真起一个守卫）===");
{
	// 指到一个空闲端口，绝不碰真实守卫（真实那个在 8443）
	const freePort = await new Promise((resolve) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
	});
	const conf = JSON.parse(fs.readFileSync(GUARD_CONF, "utf8"));
	conf.port = freePort;
	conf.bind = "127.0.0.1";
	conf.superviseTunnel = false;                 // 不在测试里去拉 cloudflared
	fs.writeFileSync(GUARD_CONF, JSON.stringify(conf, null, 2), "utf8");

	const h1 = await call("/dsh-remote/health");
	check("守卫没跑时 /health 报 guard=false", h1.json?.guard === false, JSON.stringify(h1.json));
	check("problems 明确指出守卫没运行", (h1.json?.problems || []).some((x) => /守卫/.test(x)), JSON.stringify(h1.json?.problems));
	check("体检未通过时提示里带上守卫端口", h1.json?.guardPort === freePort, String(h1.json?.guardPort));
	// 阶段检测：步骤要按链路顺序、每步带状态与说明
	const ids = (h1.json?.steps || []).map((x) => x.id);
	check("阶段检测按链路顺序给出全部环节",
		ids.join(",") === "dsh,upstream,guard,tunnel,public,links,devices", ids.join(","));
	check("每步都有 label/status/detail", (h1.json?.steps || []).every((x) => x.label && ["ok", "warn", "fail"].includes(x.status) && typeof x.detail === "string"));
	check("步骤名是给人看的（含中文环节名）", (h1.json?.steps || []).some((x) => /守卫（鉴权层）/.test(x.label)) && (h1.json?.steps || []).some((x) => /公网隧道/.test(x.label)), JSON.stringify((h1.json?.steps || []).map((x) => x.label)));
	check("守卫那一步被标为失败并带修法", (h1.json?.steps || []).find((x) => x.id === "guard")?.status === "fail" && !!(h1.json?.steps || []).find((x) => x.id === "guard")?.hint, JSON.stringify((h1.json?.steps || []).find((x) => x.id === "guard")));
	check("DSH 本体那一步恒为正常（面板就跑在它里面）", (h1.json?.steps || []).find((x) => x.id === "dsh")?.status === "ok");

	const s1 = await call("/dsh-remote/start", { method: "POST" });
	check("/start 真的把守卫拉起来了", s1.json?.guard?.started === true, JSON.stringify(s1.json?.guard));
	const h2 = await call("/dsh-remote/health");
	check("拉起后 /health 立即报 guard=true", h2.json?.guard === true);
	check("拉起后守卫那一步变为正常", (h2.json?.steps || []).find((x) => x.id === "guard")?.status === "ok", JSON.stringify((h2.json?.steps || []).find((x) => x.id === "guard")));
	check("/start 的返回里带体检结果（放在 health 键下，不与启动结果同名）", !!h2.json?.steps && !!s1.json?.health?.steps, JSON.stringify(Object.keys(s1.json || {})));
	check("隧道被显式关掉时不硬拉，并说明原因", /显式关掉|tunnel down/.test(s1.json?.tunnel?.error || ""), JSON.stringify(s1.json?.tunnel));
	const pid = s1.json?.guard?.pid;
	check("/start 返回了守卫 PID（便于排查）", Number.isInteger(pid) && pid > 0, String(pid));

	const s2 = await call("/dsh-remote/start", { method: "POST" });
	check("已在运行时 /start 是幂等的（started=false）", s2.json?.guard?.started === false, JSON.stringify(s2.json?.guard));

	// 杀掉它，再确认体检能重新发现问题（模拟"重启后守卫没了"）
	if (pid) { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 1500)); }
	check("守卫被停掉后 /health 又能报 guard=false", (await call("/dsh-remote/health")).json?.guard === false);
	const s3 = await call("/dsh-remote/start", { method: "POST" });
	check("再次 /start 仍能把它拉回来（可反复自愈）", s3.json?.guard?.started === true, JSON.stringify(s3.json?.guard));
	if (s3.json?.guard?.pid) spawn("taskkill", ["/PID", String(s3.json.guard.pid), "/T", "/F"], { stdio: "ignore" });
	await new Promise((r) => setTimeout(r, 800));
}

// 兜底清理：把测试期间可能残留的临时端口监听进程扫掉。
// 为什么要它：守卫是 detached 进程，只要有一条路径漏掉 pid（崩溃、提前 return），它就会一直留着
//（实测踩到：跑完测试在系统里攒了 5 个游离守卫）。只看测试用的临时端口段，不碰真实端口。
{
	let swept = 0;
	try {
		const out = execSync("netstat -ano", { encoding: "utf8" });
		for (const line of out.split("\n")) {
			if (!line.includes("LISTENING")) continue;
			const m = line.match(/:(\d+)\s+\S+\s+(\d+)\s*$/);
			if (!m) continue;
			const port = Number(m[1]);
			if (port < 49152 || port > 65535) continue;
			try { execSync(`taskkill /PID ${m[2]} /T /F`, { stdio: "ignore" }); swept++; } catch { /* 已退出 */ }
		}
	} catch { /* netstat 不可用就跳过 */ }
	if (swept) console.log(`\n（兜底清理：停掉了 ${swept} 个临时端口上的残留进程）`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail ? 1 : 0);
