#!/usr/bin/env node
// ============================================================================
// dsh-remote guard —— 给 DSH 的 Web 界面加一层「带设备鉴权的反向代理」
//
// 为什么需要这一层（全部是已验证事实，不是推测）：
//   1. DSH 官方只肯绑 127.0.0.1：`dsh --host 0.0.0.0` 会被直接拒绝，理由是
//      "would expose remote code execution to the network"；
//   2. `@deepseek-ai/dsh-host-webserver` 明确不提供 TLS、认证或来源策略；
//   3. DSH 的 `/api` 是一整套能操作本机 agent 的 RPC（session.prompt 能跑命令、
//      workspace.delete 能删会话、/__job-action 能杀任务），所以暴露它等于交出电脑；
//   4. DSH 的 /api 有一道「可信来源」fence：Host 必须是回环或可信名单、Origin 必须同源。
//      → 本代理把 Host/Origin/Referer 改写成 127.0.0.1:<DSH端口>，既过校验，
//        又不必把外部地址写进它的 trustedHosts。
//
// 与旧的原型（~/.dsh/remote/dsh-remote.mjs，Basic 认证）的区别：
//   · 设备模型：一次性配对码 → 设备令牌 → 会话 cookie，可单设备吊销；
//   · 角色：owner（全权）/ readonly（只读，且**在服务端按方法名强制**，不是前端隐藏）；
//   · 稳定连接：守护进程 + 隧道生命周期管理 + 域名写入 public-url.txt（供 agent 报链接）；
//   · 审计：谁在什么时候发了什么请求，写 append-only JSONL；
//   · fail-closed：没有配对过任何设备时，除了配对页与健康检查，一律拒绝。
//
// 用法：
//   node guard.mjs serve                        启动（默认 127.0.0.1:8443 → 上游 3081）
//   node guard.mjs pair [--role readonly] [--name iPhone] [--ttl 300]
//   node guard.mjs devices | revoke <id|名称> | status | print
//   node guard.mjs tunnel up|down|status         管理 cloudflared 公网入口
//
// 零第三方依赖，只用 Node 内置模块。
// ============================================================================
import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encode as qrEncode, matrixToSvg, matrixToAscii } from "./qr.mjs";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const CONF_DIR = process.env.DSH_REMOTE_DIR || path.join(HOME, "remote");
const CONF_FILE = path.join(CONF_DIR, "guard.json");
const AUDIT_FILE = path.join(CONF_DIR, "audit.jsonl");
const LOG_FILE = path.join(CONF_DIR, "guard.log");
const TUNNEL_FILE = path.join(CONF_DIR, "tunnel.json");

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "serve";
const flag = (n, d = "") => {
	const i = argv.indexOf("--" + n);
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

// ---------------------------------------------------------------- 常量与策略
const DEFAULT_CONF = {
	port: 8443,
	bind: "127.0.0.1",              // fail-closed：默认只监听回环，对外靠隧道
	upstream: "http://127.0.0.1:3081",
	cookieName: "dsh_remote_sid",
	sessionDays: 30,
	pairTtlSeconds: 3600,
	pairMaxAttempts: 5,
	linkUses: 1,                     // 链接里的 token 默认只能用一次；0 = 到期前可重复用（适合分发给多台只读设备）
	cloudflared: "",                 // 留空则自动探测
	urlFile: path.join(CONF_DIR, "public-url.txt"),
	tunnelLog: path.join(CONF_DIR, "cloudflared.log"),
	superviseTunnel: true,
	audit: true,
	injectPanel: true        // 是否把面板脚本注入 DSH 页面（插件生效后可关掉，免得出现两个按钮）
};

/** 只读设备允许调用的「写方法」白名单：一律是读语义的 RPC。
 *  其余非 GET 请求（含 /api/session.prompt、/__job-action、/screen 的触控注入）
 *  对只读设备全部 403 —— 默认拒绝，新增方法不会被漏放。 */
const READONLY_ALLOWED_POST = new Set([
	"session.list", "session.search", "session.history", "session.models",
	"session.attachment",
	"host.describe", "host.listDirectory",
	"workspace.list", "skill.list",
	"agentPreset.list", "agentPreset.read",
	"settings.describe", "credentials.describe",
	"llm.models", "llm.providers", "llm.discoverModels",
	"subagent.list", "subagent.history"
]);
/** 只读设备允许升级的 WebSocket 路径（都是只读事件流）。
 *  owner 不受此限制：它本来就有全部写权限，拦它只会把 DSH 插件的功能打坏
 *  （实测：拦了 `/sidebar/ws/agent-terminals` 之后插件侧栏终端在手机端直接不可用）。 */
const READONLY_ALLOWED_UPGRADE = new Set(["/api/events.mux", "/api/events.host"]);
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

// ---------------------------------------------------------------- 日志与状态
// 常驻服务不能因为"日志往哪写"而死：stdout 是管道时，启动它的父进程一退出就会 EPIPE。
// 踩过的坑（实测）：`log()` 直接 write stdout 抛 EPIPE → uncaughtException → 处理器里又调 log()
// → 再抛 EPIPE → 进程退出。表现是"守卫莫名消失、公网入口跟着断"。
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
function log(line) {
	const stamp = new Date().toISOString();
	const text = `[guard ${stamp}] ${line}`;
	try { fs.appendFileSync(LOG_FILE, text + "\n"); } catch { /* 只读目录时忽略 */ }
	if (cmd === "serve") { try { process.stdout.write(text + "\n"); } catch { /* 管道断了就当写日志失败 */ } }
}
function audit(entry) {
	if (!conf.audit) return;
	try { fs.appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); } catch {}
}

function loadConf() {
	try { return { ...DEFAULT_CONF, ...JSON.parse(fs.readFileSync(CONF_FILE, "utf8")) }; }
	catch { return { ...DEFAULT_CONF }; }
}
let confMtime = 0;
function saveConf() {
	fs.mkdirSync(CONF_DIR, { recursive: true });
	const tmp = CONF_FILE + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(conf, null, 2), "utf8");
	fs.renameSync(tmp, CONF_FILE);
	try { confMtime = fs.statSync(CONF_FILE).mtimeMs; } catch {}
}

/** CLI 与服务是两个进程：CLI 用 `pair` 写入的配对码、用 `revoke` 删掉的设备，
 *  都必须立刻对运行中的服务生效 → 每次请求前比对 mtime，变了就重载。
 *  （踩过的坑：不重载时，pair 生成的码在服务里查不到，表现为"正确配对码也 403"。）
 */
function reloadIfChanged() {
	try {
		const st = fs.statSync(CONF_FILE);
		if (st.mtimeMs === confMtime) return;
		confMtime = st.mtimeMs;
		const disk = JSON.parse(fs.readFileSync(CONF_FILE, "utf8"));
		Object.assign(conf, { ...disk, devices: disk.devices || [], pairings: disk.pairings || [], sessions: disk.sessions || [] });
	} catch { /* 文件暂时不可读：沿用内存里的状态 */ }
}

/** 最近活跃时间只做节流持久化，避免每个请求都写盘。 */
let lastPersist = 0;
function persistThrottled() {
	if (now() - lastPersist < 60_000) return;
	lastPersist = now();
	saveConf();
}
const conf = loadConf();
conf.devices ??= [];
conf.pairings ??= [];
conf.sessions ??= [];

const now = () => Date.now();
const b64 = (buf) => Buffer.from(buf).toString("base64url");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** 配对码：去掉了 0/O/1/I/L 等易混字符，12 位 → 形如 7F3K-9Q2M-4TXP */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function makeCode() {
	const raw = Array.from(crypto.randomBytes(12)).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
	return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}
function makeDeviceToken() { return b64(crypto.randomBytes(32)); }
function makeSessionId() { return b64(crypto.randomBytes(24)); }

function findDeviceByIdent(ident) {
	const q = String(ident).toLowerCase();
	return conf.devices.find((d) => d.id === ident || d.id.startsWith(ident) || (d.name || "").toLowerCase() === q);
}

/** 从请求里解出设备：优先会话 cookie，其次 Bearer 设备令牌。 */
function resolveDevice(req) {
	const bearer = String(req.headers.authorization || "");
	if (bearer.startsWith("Bearer ")) {
		const h = sha(bearer.slice(7).trim());
		const dev = conf.devices.find((d) => d.tokenHash === h);
		if (dev) return { device: dev, via: "bearer" };
		return null;
	}
	const cookie = String(req.headers.cookie || "");
	const name = conf.cookieName + "=";
	const pair = cookie.split(";").map((s) => s.trim()).find((s) => s.startsWith(name));
	if (!pair) return null;
	const sid = pair.slice(name.length);
	const session = conf.sessions.find((s) => s.id === sid && s.expiresAt > now());
	if (!session) return null;
	const dev = conf.devices.find((d) => d.id === session.deviceId);
	if (!dev) return null;
	return { device: dev, via: "cookie", session };
}

// ---------------------------------------------------------------- 请求分类
function isWrite(req) {
	const m = String(req.method || "GET").toUpperCase();
	if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
	const urlPath = (req.url || "/").split("?")[0];
	if (urlPath.startsWith("/api/")) {
		const method = urlPath.slice("/api/".length);
		return !READONLY_ALLOWED_POST.has(method);
	}
	return true;   // /__job-action、/screen/* 的非 GET 等：一律算写
}

/** 只有 owner 能碰的控制面路径（不管方法是什么）：
 *  /dsh-remote/* 是注入在 DSH 页面里的面板的后端（生成链接、列设备、吊销）。
 *  它挂在 DSH 自己的端口上，会经守卫转发出去 —— 所以必须在守卫这里先拦一道，
 *  否则只读设备能在浏览器里直接 POST，等于给自己签发 owner 链接（提权）。 */
const OWNER_ONLY_PATHS = ["/dsh-remote/"];

function isOwnerOnly(urlPath) {
	return OWNER_ONLY_PATHS.some((p) => urlPath.startsWith(p));
}

/** CSRF 防护：SameSite=Lax 挡住跨站携带 cookie 的 POST；再加一层 Origin 校验。 */
function originOk(req) {
	const origin = req.headers.origin;
	if (!origin || origin === "null") return true;       // 同源 fetch / 非浏览器客户端
	try {
		const o = new URL(origin);
		const host = String(req.headers.host || "");
		return o.host === host || o.hostname === "127.0.0.1" || o.hostname === "localhost";
	} catch { return false; }
}

// ---------------------------------------------------------------- 页面与响应
const LOGIN_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>dsh-remote · 设备配对</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:#0f1117;color:#e6e9f0;font:15px/1.6 -apple-system,"Microsoft YaHei",sans-serif;padding:22px}
.card{background:#151a24;border:1px solid #262d3b;border-radius:12px;padding:16px;margin-bottom:14px}
h1{font-size:17px;margin:0 0 6px}p{color:#8b96ad;font-size:13px;margin:6px 0}
input{width:100%;padding:13px;font-size:18px;letter-spacing:2px;text-align:center;background:#0f1117;color:#e6e9f0;border:1px solid #33405a;border-radius:10px;text-transform:uppercase}
button{width:100%;margin-top:10px;padding:14px;font-size:16px;font-weight:600;color:#fff;background:#2b6cb0;border:1px solid #3b82f6;border-radius:10px}
.ok{color:#3ddc84}.bad{color:#e05252}.note{color:#8b96ad;font-size:12px;margin-top:10px}
</style></head><body>
<div class="card"><h1>dsh-remote</h1>
<p>这台设备还没有被授权。请在<b>电脑上</b>运行：</p>
<p style="color:#7fb79a">node guard.mjs pair</p>
<p>把生成的<b>一次性配对码</b>填在下面（5 分钟内有效）：</p>
<input id="code" placeholder="XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters">
<input id="name" placeholder="设备名（如 iPhone）" autocomplete="off" style="margin-top:8px;font-size:15px;letter-spacing:0">
<button id="go">配对并进入</button>
<p class="note" id="msg"></p></div>
<script>
(function(){
  var code=document.getElementById('code'),name=document.getElementById('name'),go=document.getElementById('go'),msg=document.getElementById('msg');
  function submit(){
    msg.className='note'; msg.textContent='正在配对…';
    fetch('/__guard/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:code.value.trim(),name:name.value.trim()})})
      .then(function(r){return r.json()})
      .then(function(j){
        if(j.ok){ msg.className='note ok'; msg.textContent='配对成功（'+j.device.role+'），正在进入…'; location.replace('/'); }
        else { msg.className='note bad'; msg.textContent=j.error||'配对失败'; }
      }).catch(function(e){ msg.className='note bad'; msg.textContent='网络错误：'+e.message; });
  }
  go.addEventListener('click',submit);
  code.addEventListener('keydown',function(e){ if(e.key==='Enter') submit(); });
})();
</scr` + `ipt></body></html>`;

function send(res, code, type, body, extraHeaders = {}) {
	const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
	res.writeHead(code, {
		"content-type": type,
		"content-length": String(buf.length),
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",     // 链接里带 token，绝不能通过 Referer 漏给第三方
		"x-content-type-options": "nosniff",
		...extraHeaders
	});
	res.end(buf);
}

/** 当前长期链接：存在就一直用，**只有显式重置才换**（形态对齐 ZCode 的远程链接）。
 *  与旧的一次性配对码的区别：长期链接可重复使用、不过期；重置 = 换一条新的、旧的立刻作废。
 *  说明：token 明文存在 guard.json 里（面板需要随时把它显示出来）；这也是它与"配对码"的分工——
 *  配对码适合临时给一台设备，长期链接适合固定给手机/平板长期用。 */
function currentLink(role = "owner", { reset = false, name = "" } = {}) {
	conf.links ??= {};
	const r = role === "readonly" ? "readonly" : "owner";
	const make = (target) => ({
		token: b64(crypto.randomBytes(32)),
		role: target,
		name: name && target === r ? name : (target === "readonly" ? "只读设备" : "我的手机"),
		createdAt: new Date().toISOString()
	});
	if (reset) {
		conf.links[r] = make(r);
		// 重置主链接时把只读链接一起换掉：避免留下一条仍可用的旧凭据
		if (r === "owner" || !conf.links.readonly) conf.links.readonly = make("readonly");
		saveConf();
	} else if (!conf.links[r]) {
		conf.links[r] = make(r);
		saveConf();
	}
	const l = conf.links[r];
	return { url: `${entryUrl()}/?t=${l.token}`, token: l.token, role: l.role, name: l.name, createdAt: l.createdAt, longLived: true };
}

/** 用长期链接把设备接进来：可重复使用（同一台设备认到同名记录时刷新它的 token，不再堆设备）。
 *  返回 null 表示这个 token 不是当前有效链接。 */
function redeemLongLivedLink(req, res, token, urlPath) {
	conf.links ??= {};
	const role = Object.keys(conf.links).find((r) => conf.links[r] && conf.links[r].token === token);
	if (!role) return false;
	const entry = conf.links[role];
	const deviceToken = makeDeviceToken();
	let device = conf.devices.find((d) => d.name === entry.name && d.role === entry.role);
	if (device) {
		device.tokenHash = sha(deviceToken);          // 同一台设备重开链接：刷新凭据，不新增设备
		device.lastSeenAt = new Date().toISOString();
	} else {
		device = {
			id: crypto.randomUUID(),
			name: entry.name,
			role: entry.role === "readonly" ? "readonly" : "owner",
			tokenHash: sha(deviceToken),
			createdAt: new Date().toISOString(),
			lastSeenAt: new Date().toISOString()
		};
		conf.devices.push(device);
	}
	const sid = makeSessionId();
	conf.sessions.push({ id: sid, deviceId: device.id, createdAt: now(), expiresAt: now() + conf.sessionDays * 86400_000 });
	saveConf();
	audit({ event: "link", result: "ok", via: "long-lived", device: device.name, role: device.role, ip: req.socket.remoteAddress });
	const secure = /^https$/i.test(String(req.headers["x-forwarded-proto"] || "")) ? "; Secure" : "";
	send(res, 302, "text/plain; charset=utf-8", "已配对，正在进入…", {
		location: urlPath || "/",
		"set-cookie": `${conf.cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${conf.sessionDays * 86400}${secure}`
	});
	return true;
}

/** 用一个待配对的 token 把设备接进来：发 cookie + 把 token 从地址栏重定向掉。
 *  链接形态： https://<入口>/?t=<token>      （token 一次性，换完即作废）
 *  为什么要重定向而不是就地服务：token 留在地址栏会进历史记录/被截图/被分享，换完立刻清掉。 */
function redeemLink(req, res, token, urlPath) {
	const hash = sha(String(token));
	const entry = conf.pairings.find((p) => p.tokenHash && p.tokenHash === hash && p.expiresAt > now());
	if (!entry) {
		audit({ event: "link", result: "bad-token", ip: req.socket.remoteAddress });
		return false;
	}
	if (typeof entry.usesLeft === "number" && entry.usesLeft <= 0) {
		audit({ event: "link", result: "used-up", ip: req.socket.remoteAddress });
		return false;
	}
	if (typeof entry.usesLeft === "number") entry.usesLeft -= 1;
	if (entry.usesLeft === 0) conf.pairings = conf.pairings.filter((p) => p !== entry);
	const device = {
		id: crypto.randomUUID(),
		name: entry.name || `设备-${conf.devices.length + 1}`,
		role: entry.role === "readonly" ? "readonly" : "owner",
		tokenHash: "",
		createdAt: new Date().toISOString(),
		lastSeenAt: null
	};
	const token2 = makeDeviceToken();
	device.tokenHash = sha(token2);
	conf.devices.push(device);
	const sid = makeSessionId();
	conf.sessions.push({ id: sid, deviceId: device.id, createdAt: now(), expiresAt: now() + conf.sessionDays * 86400_000 });
	saveConf();
	audit({ event: "link", result: "ok", device: device.name, role: device.role, ip: req.socket.remoteAddress });
	const secure = /^https$/i.test(String(req.headers["x-forwarded-proto"] || "")) ? "; Secure" : "";
	send(res, 302, "text/plain; charset=utf-8", "已配对，正在进入…", {
		location: urlPath || "/",
		"set-cookie": `${conf.cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${conf.sessionDays * 86400}${secure}`
	});
	return true;
}
function denyHtml(res, code = 401, message = "需要先配对这台设备") {
	send(res, code, "text/html; charset=utf-8", LOGIN_PAGE.replace('<p class="note" id="msg"></p>', `<p class="note bad" id="msg">${message}</p>`));
}

// ---------------------------------------------------------------- 配对与状态端点
function readJson(req, limit = 64 * 1024) {
	return new Promise((resolve) => {
		let size = 0, chunks = [];
		req.on("data", (c) => { size += c.length; if (size > limit) { req.destroy(); return; } chunks.push(c); });
		req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(null); } });
		req.on("error", () => resolve(null));
	});
}

async function serveGuardEndpoint(req, res, urlPath) {
	// 健康检查：不鉴权，供看门狗使用
	if (urlPath === "/__guard/health") { send(res, 200, "text/plain; charset=utf-8", "ok"); return true; }

	// 配对
	if (urlPath === "/__guard/pair" && req.method === "POST") {
		const body = await readJson(req);
		if (!body || typeof body.code !== "string") { send(res, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "缺少配对码" })); return true; }
		const code = body.code.trim().toUpperCase();
		const entry = conf.pairings.find((p) => p.code === code && p.expiresAt > now());
		if (!entry) { audit({ event: "pair", result: "bad-code", ip: req.socket.remoteAddress }); send(res, 403, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "配对码无效或已过期" })); return true; }
		entry.attempts = (entry.attempts || 0) + 1;
		if (entry.attempts > conf.pairMaxAttempts) {          // 防穷举：超次数直接作废这个码
			conf.pairings = conf.pairings.filter((p) => p.code !== code);
			saveConf();
			audit({ event: "pair", result: "too-many-attempts", ip: req.socket.remoteAddress });
			send(res, 429, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "尝试次数过多，配对码已作废，请重新生成" }));
			return true;
		}
		const token = makeDeviceToken();        // 令牌只在这一次返回给客户端；服务端只留哈希
		const device = {
			id: crypto.randomUUID(),
			name: String(body.name || "").slice(0, 40) || `设备-${conf.devices.length + 1}`,
			role: entry.role === "readonly" ? "readonly" : "owner",
			tokenHash: sha(token),
			createdAt: new Date().toISOString(),
			lastSeenAt: null
		};
		conf.devices.push(device);
		conf.pairings = conf.pairings.filter((p) => p.code !== code);   // 一次性
		const sid = makeSessionId();
		conf.sessions.push({ id: sid, deviceId: device.id, createdAt: now(), expiresAt: now() + conf.sessionDays * 86400_000 });
		saveConf();
		audit({ event: "pair", result: "ok", device: device.name, role: device.role, ip: req.socket.remoteAddress });
		const secure = /^https$/i.test(String(req.headers["x-forwarded-proto"] || "")) ? "; Secure" : "";
		send(res, 200, "application/json; charset=utf-8",
			JSON.stringify({ ok: true, device: { id: device.id, name: device.name, role: device.role }, token }),
			{ "set-cookie": `${conf.cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${conf.sessionDays * 86400}${secure}` });
		return true;
	}

	// 状态（仅 owner；本机直连同样算 owner）
	if (urlPath === "/__guard/status") {
		const auth = resolveDevice(req) || (isLocalTrusted(req) ? { device: { name: "本机(直连)", role: "owner" } } : null);
		if (!auth || auth.device.role !== "owner") { send(res, 403, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "仅 owner 设备可看状态" })); return true; }
		const tunnel = tunnelState();
		send(res, 200, "application/json; charset=utf-8", JSON.stringify({
			ok: true,
			viewer: auth.device.name,          // 谁在看（本机直连会显示「本机(直连)」，便于排查）
			uptimeSeconds: Math.round((now() - startedAt) / 1000),
			upstream: conf.upstream,
			bind: `${conf.bind}:${conf.port}`,
			devices: conf.devices.map((d) => ({ id: d.id, name: d.name, role: d.role, lastSeenAt: d.lastSeenAt })),
			sessions: conf.sessions.filter((s) => s.expiresAt > now()).length,
			tunnel
		}, null, 2));
		return true;
	}

	// 断开本机设备的会话（等价于退出登录）
	if (urlPath === "/__guard/logout" && req.method === "POST") {
		const auth = resolveDevice(req);
		if (auth?.session) { conf.sessions = conf.sessions.filter((s) => s.id !== auth.session.id); saveConf(); }
		send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }), { "set-cookie": `${conf.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
		return true;
	}

	// 注入到 DSH 页面里的面板脚本（同一份 ui.js，改完刷新即可，不用重启守卫）
	if (urlPath === "/__guard/ui.js") {
		if (!resolveDevice(req) && !isLocalTrusted(req)) { send(res, 401, "text/plain; charset=utf-8", "unauthorized"); return true; }
		try {
			const js = fs.readFileSync(path.join(SELF_DIR, "ui.js"), "utf8");
			send(res, 200, "application/javascript; charset=utf-8", js);
		} catch { send(res, 500, "text/plain; charset=utf-8", "ui.js 缺失"); }
		return true;
	}

	// 以下端点都只给 owner：生成链接 / 设备列表 / 吊销 / 重置 / 二维码
	const ownerOnly = urlPath === "/__guard/link" || urlPath === "/__guard/links" || urlPath === "/__guard/devices" || urlPath === "/__guard/revoke" || urlPath === "/__guard/reset" || urlPath === "/__guard/qr";
	if (ownerOnly) {
		const auth = resolveDevice(req) || (isLocalTrusted(req) ? { device: { name: "本机(直连)", role: "owner" } } : null);
		if (!auth || auth.device.role !== "owner") {
			audit({ event: "deny", reason: "owner-only", path: urlPath, device: auth?.device?.name || "(未授权)" });
			send(res, 403, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "仅 owner 设备可用" }));
			return true;
		}
		if (urlPath === "/__guard/link") {
			const q = new URLSearchParams((req.url || "").split("?")[1] || "");
			const role = q.get("role") === "readonly" ? "readonly" : "owner";
			const reset = q.get("reset") === "1";
			const link = currentLink(role, { reset });        // 不带 reset 就是"读当前链接"，不换
			audit({ event: reset ? "reset-link" : "read-link", device: auth.device.name, role });
			send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, ...link, reset }));
			return true;
		}
		if (urlPath === "/__guard/links") {                    // 两条当前链接一起给面板用
			send(res, 200, "application/json; charset=utf-8", JSON.stringify({
				ok: true, owner: currentLink("owner", {}), readonly: currentLink("readonly", {})
			}));
			return true;
		}
		if (urlPath === "/__guard/reset" && req.method === "POST") {
			// 面板插件（走插件路由或直连守卫）用的重置：与 `pair --reset` 同一语义。
			// 之前只提供 GET /__guard/link?reset=1，跨源 POST 的兜底路径没有对应端点是错的。
			currentLink("owner", { reset: true });
			audit({ event: "reset-link", device: auth.device.name, via: "guard-reset" });
			send(res, 200, "application/json; charset=utf-8", JSON.stringify({
				ok: true, owner: currentLink("owner", {}), readonly: currentLink("readonly", {})
			}));
			return true;
		}
		if (urlPath === "/__guard/qr") {                        // 手机二维码（SVG，扫码即进）
			const q = new URLSearchParams((req.url || "").split("?")[1] || "");
			const role = q.get("role") === "readonly" ? "readonly" : "owner";
			const link = currentLink(role, {});
			try {
				const svg = matrixToSvg(qrEncode(link.url, { ecc: "M" }), { scale: Math.min(16, Math.max(2, Number(q.get("scale")) || 8)) });
				send(res, 200, "image/svg+xml; charset=utf-8", svg);
			} catch (e) {
				send(res, 500, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: `生成二维码失败：${e.message}` }));
			}
			return true;
		}
		if (urlPath === "/__guard/devices") {
			send(res, 200, "application/json; charset=utf-8", JSON.stringify({
				ok: true,
				devices: conf.devices.map((d) => ({ id: d.id, name: d.name, role: d.role, lastSeenAt: d.lastSeenAt, createdAt: d.createdAt }))
			}));
			return true;
		}
		// revoke
		const body = await readJson(req);
		const dev = body && body.id ? findDeviceByIdent(String(body.id)) : null;
		if (!dev) { send(res, 404, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "没有这台设备" })); return true; }
		if (dev.id === auth.device.id) { send(res, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "不能吊销自己（当前设备）" })); return true; }
		conf.devices = conf.devices.filter((d) => d.id !== dev.id);
		conf.sessions = conf.sessions.filter((s) => s.deviceId !== dev.id);
		saveConf();
		audit({ event: "revoke", device: dev.name, role: dev.role, by: auth.device.name });
		log(`已吊销设备 ${dev.name}（${dev.role}），操作者 ${auth.device.name}`);
		send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
		return true;
	}

	if (urlPath.startsWith("/__guard/")) { send(res, 404, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "unknown guard endpoint" })); return true; }
	return false;
}

// ---------------------------------------------------------------- 转发
function forwardedHeaders(req, device) {
	const out = {};
	for (const [k, v] of Object.entries(req.headers)) {
		const lk = k.toLowerCase();
		if (HOP_BY_HOP.has(lk)) continue;
		if (lk === "authorization" && String(v).startsWith("Bearer ")) continue;  // 设备令牌不透传给 DSH
		if (lk === "cookie") continue;                                            // 会话 cookie 也不透传
		out[k] = Array.isArray(v) ? v.join(", ") : v;
	}
	const upstream = new URL(conf.upstream);
	const authority = `${upstream.hostname}:${upstream.port}`;
	out["host"] = authority;
	// 请求未压缩的响应：本跳是回环，压缩毫无收益；而压缩过的 HTML 我们没法注入
	// （实测坑：本地中间层 remote.mjs 会把页面压成 br，守卫遇到 content-encoding 就跳过注入 →
	//  手机端面板与外观纠偏在真实链路上静默失效，自测里却全绿）。
	out["accept-encoding"] = "identity";
	if (out["origin"]) out["origin"] = `http://${authority}`;
	if (out["referer"]) { try { out["referer"] = new URL(out["referer"]).pathname; } catch { delete out["referer"]; } }
	if (device) { out["x-dsh-remote-device"] = encodeURIComponent(device.name); out["x-dsh-remote-role"] = device.role; }
	return out;
}

/** 读 DSH 用户设置文档里的外观偏好（ui-theme.preference）。
 *  为什么守卫要读它：DSH 服务端会在页面里内联 `const preference = "…"` 定启动外观，
 *  但客户端起来之后（皮肤插件管着 data-ds-dark-theme）会按自己的默认值把它改掉，
 *  在手机上表现为"每次打开都是浅色、要手动调"。守卫按服务端偏好做一次启动期纠偏。 */
let appearanceCache = { mtime: 0, value: "" };
function readAppearancePreference() {
	const file = path.join(HOME, "settings.yaml");
	try {
		const st = fs.statSync(file);
		if (appearanceCache.mtime === st.mtimeMs) return appearanceCache.value;
		const text = fs.readFileSync(file, "utf8");
		const m = text.match(/ui-theme:[\s\S]{0,200}?preference:\s*["']?([a-zA-Z]+)/);
		const value = m ? m[1].toLowerCase() : "";
		appearanceCache = { mtime: st.mtimeMs, value: ["light", "dark", "system"].includes(value) ? value : "" };
		return appearanceCache.value;
	} catch { return ""; }
}

/** 启动期外观纠偏：把外观钉在服务端偏好上，用户一动手（或 8 秒后）就停手，
 *  免得把用户自己改的深/浅色又纠回去。 */
function appearanceKeeperScript(preference) {
	const js = `(function(){var P=${JSON.stringify(preference)};var on=true;` +
		`function want(){if(P==="system")return !!(window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches);return P==="dark";}` +
		`function apply(){if(!on)return;var d=want(),r=document.documentElement,cs=d?"dark":"light";` +
		`if(r.style.colorScheme!==cs)r.style.colorScheme=cs;` +
		`if(document.body&&document.body.hasAttribute("data-ds-dark-theme")!==d)document.body.toggleAttribute("data-ds-dark-theme",d);}` +
		`apply();document.addEventListener("DOMContentLoaded",apply);` +
		`setInterval(apply,400);setTimeout(function(){on=false;},8000);` +
		`["pointerdown","keydown","touchstart"].forEach(function(e){addEventListener(e,function(){on=false;},{once:true,capture:true});});` +
		`})()`;
	return `<script id="__dsh_remote_appearance">${js}</scr` + `ipt>`;
}

/** 把上游的响应体解成明文：上游可能无视我们的 accept-encoding: identity 照样压缩。 */
function decodeBody(buf, encoding) {
	switch (encoding) {
		case "": case "identity": return buf;
		case "gzip": case "x-gzip": return zlib.gunzipSync(buf);
		case "deflate": return zlib.inflateSync(buf);
		case "br": return zlib.brotliDecompressSync(buf);
		default: throw new Error(`不认识的 content-encoding: ${encoding}`);
	}
}

function proxyHttp(req, res, device) {
	const upstream = new URL(conf.upstream);
	const proxyReq = http.request({
		host: upstream.hostname, port: upstream.port,
		method: req.method, path: req.url,
		headers: forwardedHeaders(req, device)
	}, (up) => {
		const ctype = String(up.headers["content-type"] || "");
		const encoding = String(up.headers["content-encoding"] || "").toLowerCase();
		// 往 DSH 的 HTML 页面里注入「手机链接」面板：不碰 DSH 内部，也不受它升级影响。
		// 上游即使压缩了也要解压后再注入（上游可能无视我们的 accept-encoding: identity）。
		if (conf.injectPanel && ctype.includes("text/html") && String(req.method).toUpperCase() === "GET") {
			const chunks = [];
			let size = 0, overflow = false;
			up.on("data", (c) => { size += c.length; if (size > 8 * 1024 * 1024) overflow = true; if (!overflow) chunks.push(c); });
			up.on("end", () => {
				const raw = Buffer.concat(chunks);
				const headers = { ...up.headers };
				if (overflow) {                                  // 太大就原样透传，不动它
					delete headers["transfer-encoding"];
					headers["content-length"] = String(raw.length);
					res.writeHead(up.statusCode || 200, headers);
					res.end(raw);
					return;
				}
				let html;
				try { html = decodeBody(raw, encoding).toString("utf8"); }
				catch (e) {                                       // 解不开就原样透传（宁可没有面板，也不能给坏页面）
					log(`页面解压失败（${encoding}）：${e.message}，本次不注入`);
					delete headers["transfer-encoding"];
					headers["content-length"] = String(raw.length);
					res.writeHead(up.statusCode || 200, headers);
					res.end(raw);
					return;
				}
				// ① 启动期外观纠偏：放在 <head> 里、任何业务脚本之前
				const pref = readAppearancePreference();
				if (pref && !html.includes("__dsh_remote_appearance")) {
					const tag = appearanceKeeperScript(pref);
					html = html.includes("<head>") ? html.replace("<head>", "<head>" + tag)
						: html.includes("<!doctype") || html.includes("<!DOCTYPE>") ? html.replace(/<!doctype[^>]*>/i, (m) => m + tag)
							: tag + html;
				}
				// ② 手机链接面板（守卫自己的浮层）
				if (!html.includes("/__guard/ui.js")) {
					const tag = '<script src="/__guard/ui.js" defer></script>';
					html = html.includes("</body>") ? html.replace("</body>", tag + "</body>") : html + tag;
				}
				const body = Buffer.from(html, "utf8");
				delete headers["transfer-encoding"];
				delete headers["content-encoding"];              // 已解压并可能改写过，不能再声称是压缩体
				headers["content-length"] = String(body.length);
				res.writeHead(up.statusCode || 200, headers);
				res.end(body);
			});
			up.on("error", () => { try { res.destroy(); } catch {} });
			return;
		}
		res.writeHead(up.statusCode || 502, up.headers);
		up.pipe(res);
		up.on("error", () => { try { res.destroy(); } catch {} });
	});
	proxyReq.on("error", (e) => {
		log(`上游失败 ${req.url}: ${e.message}`);
		if (!res.headersSent) send(res, 502, "text/plain; charset=utf-8", `无法连接 DSH 上游（${conf.upstream}）：${e.message}\n请确认 DSH 与本地隧道服务在运行。`);
		else { try { res.destroy(); } catch {} }
	});
	res.on("close", () => { try { proxyReq.destroy(); } catch {} });
	req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head, device) {
	const upstream = new URL(conf.upstream);
	const sock = net.connect(Number(upstream.port), upstream.hostname, () => {
		const authority = `${upstream.hostname}:${upstream.port}`;
		const lines = [`${req.method} ${req.url} HTTP/1.1`];
		const seen = new Set();
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			const k = req.rawHeaders[i], v = req.rawHeaders[i + 1], lk = k.toLowerCase();
			if (seen.has(lk)) continue;
			if (lk === "host") { lines.push(`Host: ${authority}`); seen.add(lk); continue; }
			if (lk === "origin") { lines.push(`Origin: http://${authority}`); seen.add(lk); continue; }
			if (lk === "referer") { try { lines.push(`Referer: ${new URL(v).pathname}`); } catch {} seen.add(lk); continue; }
			if (lk === "cookie" || (lk === "authorization" && String(v).startsWith("Bearer "))) continue;
			if (lk === "connection" || lk === "upgrade") continue;
			lines.push(`${k}: ${v}`); seen.add(lk);
		}
		if (!seen.has("host")) lines.push(`Host: ${authority}`);
		if (device) { lines.push(`X-DSH-Remote-Device: ${encodeURIComponent(device.name)}`, `X-DSH-Remote-Role: ${device.role}`); }
		lines.push("Connection: Upgrade", "Upgrade: websocket");
		sock.write(lines.join("\r\n") + "\r\n\r\n");
		if (head && head.length) sock.write(head);
		sock.pipe(socket); socket.pipe(sock);
	});
	sock.on("error", () => socket.destroy());
	socket.on("error", () => sock.destroy());
}

// ---------------------------------------------------------------- HTTP 服务
const startedAt = now();

/** 本机直连视为 owner —— 与 DSH 自身的安全模型一致（本机可信）。
 *  判据必须同时满足：来源是回环地址，**且没有任何"经过隧道"的痕迹**。
 *  为什么后半句是硬要求：cloudflared 也是从回环连上来的，只看来源地址会把公网请求误判成本机。
 *  隧道一定会带上 X-Forwarded-* / Cf-* 这些头。 */
const TUNNEL_MARKERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "cf-connecting-ip", "cf-ray", "cf-ipcountry", "cdn-loop"];
function isLocalTrusted(req) {
	const remote = String(req.socket.remoteAddress || "");
	if (!/^(::1|::ffff:127\.|127\.)/.test(remote)) return false;
	for (const k of TUNNEL_MARKERS) if (req.headers[k]) return false;
	return true;
}

/** 只对「本机来源页面」放开 CORS，让 DSH 桌面页面能直连守卫（插件路由不可用时的兜底）。
 *  只放行 127.0.0.1 / localhost / ::1 且带凭据；公网域名拿不到这些头。 */
function withLocalCors(req, res) {
	const origin = String(req.headers.origin || "");
	if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return;
	const cors = {
		"access-control-allow-origin": origin,
		"access-control-allow-credentials": "true",
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "content-type, accept",
		"vary": "Origin"
	};
	const writeHead = res.writeHead.bind(res);
	res.writeHead = function (code, a, b) {
		if (a && typeof a === "object") return writeHead(code, { ...a, ...cors });
		if (b && typeof b === "object") return writeHead(code, a, { ...b, ...cors });
		// 无 headers 的调用（例如 OPTIONS 的 204）也必须带上 CORS 头，
		// 否则浏览器预检失败 → 页面里的跨源 POST（重置/吊销的兜底路径）会被拦下。
		if (a === undefined) return writeHead(code, { ...cors });
		return writeHead(code, a, { ...cors });
	};
}

function handle(req, res) {
	const urlPath = (req.url || "/").split("?")[0];
	const query = new URLSearchParams((req.url || "/").split("?")[1] || "");
	reloadIfChanged();
	withLocalCors(req, res);
	if (String(req.method).toUpperCase() === "OPTIONS") { res.writeHead(204); res.end(); return; }

	if (urlPath.startsWith("/__guard/")) { serveGuardEndpoint(req, res, urlPath).catch((e) => log(`guard 端点异常 ${urlPath}: ${e?.message || e}`)); return; }

	// 链接带 token：/?t=<token> —— 先换 cookie 再重定向掉 token
	const linkToken = query.get("t");
	if (linkToken) {
		if (resolveDevice(req)) { send(res, 302, "text/plain; charset=utf-8", "已登录", { location: urlPath || "/" }); return; }
		if (redeemLongLivedLink(req, res, linkToken, urlPath || "/")) return;   // 长期链接（可重复用）
		if (redeemLink(req, res, linkToken, urlPath || "/")) return;           // 一次性配对码链接
		log(`链接 token 无效或已作废：${String(linkToken).slice(0, 6)}…`);
	}

	// 本机直连（回环且无隧道痕迹）等同 owner —— 桌面 DSH 页面靠这条兜底
	const auth = resolveDevice(req) || (isLocalTrusted(req)
		? { device: { id: "local", name: "本机(直连)", role: "owner", lastSeenAt: null }, via: "local" }
		: null);
	if (!auth) {
		audit({ event: "deny", reason: "unauthenticated", method: req.method, path: urlPath, ip: req.socket.remoteAddress });
		denyHtml(res, 401);
		return;
	}
	auth.device.lastSeenAt = new Date().toISOString();
	persistThrottled();

	if ((isWrite(req) || isOwnerOnly(urlPath)) && auth.device.role !== "owner") {
		audit({ event: "deny", reason: isOwnerOnly(urlPath) ? "owner-only-path" : "readonly", device: auth.device.name, method: req.method, path: urlPath });
		log(`拒绝：只读设备 ${auth.device.name} 试图 ${req.method} ${urlPath}`);
		send(res, 403, "application/json; charset=utf-8",
			JSON.stringify({ ok: false, error: "该设备是只读权限（observer），服务端已拒绝这次写入", path: urlPath }));
		return;
	}
	if (!originOk(req)) {
		audit({ event: "deny", reason: "origin", device: auth.device.name, origin: req.headers.origin });
		send(res, 403, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "Origin 校验失败" }));
		return;
	}
	if (isWrite(req)) audit({ event: "allow-write", device: auth.device.name, method: req.method, path: urlPath });
	proxyHttp(req, res, auth.device);
}

const server = http.createServer(handle);
server.on("upgrade", (req, socket, head) => {
	const urlPath = (req.url || "/").split("?")[0];
	reloadIfChanged();
	const auth = resolveDevice(req);
	if (!auth) {
		socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
		socket.destroy();
		return;
	}
	if (auth.device.role !== "owner" && !READONLY_ALLOWED_UPGRADE.has(urlPath)) {
		audit({ event: "deny", reason: "upgrade-path", device: auth.device.name, path: urlPath });
		log(`拒绝：只读设备 ${auth.device.name} 试图升级 ${urlPath}（不在只读白名单）`);
		socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
		socket.destroy();
		return;
	}
	if (auth.device.role === "owner") audit({ event: "allow-upgrade", device: auth.device.name, path: urlPath });
	proxyUpgrade(req, socket, head, auth.device);
});

// ---------------------------------------------------------------- 隧道管理
function tunnelState() {
	try { return { ...JSON.parse(fs.readFileSync(TUNNEL_FILE, "utf8")), desired: conf.superviseTunnel }; }
	catch { return { pid: null, url: null, startedAt: null, desired: conf.superviseTunnel }; }
}
function saveTunnelState(state) {
	fs.mkdirSync(CONF_DIR, { recursive: true });
	fs.writeFileSync(TUNNEL_FILE, JSON.stringify(state, null, 2), "utf8");
}
function alive(pid) {
	if (!pid) return false;
	try { process.kill(pid, 0); return true; } catch { return false; }
}
function findCloudflared() {
	if (conf.cloudflared && fs.existsSync(conf.cloudflared)) return conf.cloudflared;
	const candidates = [
		path.join(SELF_DIR, "cloudflared.exe"),
		path.join(SELF_DIR, "cloudflared"),
		path.join(CONF_DIR, "cloudflared.exe")
	];
	for (const c of candidates) if (fs.existsSync(c)) return c;
	for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
		for (const name of ["cloudflared.exe", "cloudflared"]) {
			const c = path.join(dir, name);
			if (fs.existsSync(c)) return c;
		}
	}
	return null;
}
let lastTunnelError = "";
function startTunnel() {
	const bin = findCloudflared();
	if (!bin) { log("找不到 cloudflared：请用 --cloudflared 指定路径，或把 cloudflared 放进 PATH"); return null; }
	if (/\.(cmd|bat)$/i.test(bin)) {
		// Node 20+ 出于安全不再直接 spawn .cmd/.bat（报 spawn EINVAL），
		// 而很多人会给 cloudflared 套一层批处理包装 —— 明确告诉他原因，别让他对着"等待域名超时"发呆。
		lastTunnelError = `cloudflared 不能是 .cmd/.bat 包装脚本（Node 会拒绝执行）：${bin}。请指向 cloudflared.exe 本体。`;
		log(lastTunnelError);
		return null;
	}
	lastTunnelError = "";
	try { fs.rmSync(conf.tunnelLog, { force: true }); } catch {}
	try { fs.rmSync(conf.urlFile, { force: true }); } catch {}
	const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${conf.port}`, "--logfile", conf.tunnelLog, "--loglevel", "info"], { detached: true, stdio: "ignore", windowsHide: true });
	// spawn 失败是异步的：不接住就会变成一条 unhandledRejection，用户只看到"等待域名超时"
	child.on("error", (e) => {
		lastTunnelError = `拉起 cloudflared 失败：${e.message}（${bin}）`;
		log(lastTunnelError);
		saveTunnelState({ pid: null, url: null, startedAt: null, restarts: tunnelState().restarts || 0 });
	});
	child.unref();
	saveTunnelState({ pid: child.pid, url: null, startedAt: new Date().toISOString(), restarts: (tunnelState().restarts || 0) });
	log(`已拉起 cloudflared（PID ${child.pid}）→ http://127.0.0.1:${conf.port}`);
	return child.pid;
}
/** 从隧道日志里取「最近一次」分配的域名。
 *  踩坑（2026-09-22）：日志没被清空时文件里会同时存在多个历史域名，
 *  取第一条会把已经作废的旧域名当成当前入口 → 必须取最后一条。 */
function readTunnelUrl() {
	try {
		const text = fs.readFileSync(conf.tunnelLog, "utf8");
		const all = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
		return all && all.length ? all[all.length - 1] : null;
	} catch { return null; }
}
async function waitTunnelUrl(seconds = 60) {
	for (let i = 0; i < seconds; i++) {
		if (lastTunnelError) return null;         // 起不来就别再等满 60 秒
		const url = readTunnelUrl();
		if (url) {
			const state = tunnelState();
			saveTunnelState({ ...state, url });
			try { fs.mkdirSync(path.dirname(conf.urlFile), { recursive: true }); fs.writeFileSync(conf.urlFile, url + "\n", "utf8"); } catch {}
			return url;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	return null;
}
function stopTunnel() {
	const state = tunnelState();
	if (alive(state.pid)) { try { process.kill(state.pid); log(`已停止 cloudflared（PID ${state.pid}）`); } catch {} }
	saveTunnelState({ pid: null, url: null, startedAt: null, restarts: state.restarts || 0 });
}
/** 隧道守护：进程没了就按退避重启 —— 「稳定连接」的服务端一半。
 *  语义：`superviseTunnel` 表达的是「想要公网入口」这个意图。
 *    · true（默认）= 开机/重启 DSH 后自动把入口拉回来；进程掉了自动重启；
 *    · false = `tunnel down` 明确关掉，守护不再自动拉起。
 *  （踩过的坑：`tunnel down` 只杀进程、不关意图 → 10 秒后守护又把它拉回来了。） */
let tunnelBackoff = 2000;
function superviseTunnel() {
	if (!conf.superviseTunnel) return;
	reloadIfChanged();                       // CLI 改过配置（比如换隧道二进制路径）要立刻生效
	const state = tunnelState();
	if (state.pid && alive(state.pid)) {
		const url = state.url || readTunnelUrl();
		if (url && url !== state.url) { saveTunnelState({ ...state, url }); try { fs.writeFileSync(conf.urlFile, url + "\n", "utf8"); } catch {} }
		tunnelBackoff = 2000;
		return;
	}
	if (!state.desired && !state.startedAt) return;                       // 从未启动过就不自动起
	log(`cloudflared 不在了 → ${Math.round(tunnelBackoff / 1000)}s 后重启`);
	const restarts = (state.restarts || 0) + 1;
	setTimeout(async () => {
		startTunnel();
		const url = await waitTunnelUrl(45);
		saveTunnelState({ ...tunnelState(), restarts, url });
		if (url) log(`新域名：${url}`);
	}, tunnelBackoff);
	tunnelBackoff = Math.min(tunnelBackoff * 2, 60_000);
}

// ---------------------------------------------------------------- CLI
function entryUrl() {
	if (fs.existsSync(conf.urlFile)) {
		const u = fs.readFileSync(conf.urlFile, "utf8").trim();
		if (u) return u.replace(/\/+$/, "");
	}
	const state = tunnelState();
	if (state.url) return String(state.url).replace(/\/+$/, "");
	return `http://${conf.bind}:${conf.port}`;
}

/** 显示当前链接（默认）；`--reset` 才换新的；`--qr` 直接打一张可扫的二维码。
 *  形态对齐 ZCode：链接长期有效，改之前一直是这一条。 */
function cliPair() {
	const reset = argv.includes("--reset");
	const wantQr = argv.includes("--qr");
	const roleFlag = flag("role", "");
	const name = flag("name", "");
	if (reset) {
		if (roleFlag === "readonly") currentLink("readonly", { reset: true });
		else currentLink("owner", { reset: true, name });      // 主链接重置时会连只读一起换
	}
	const owner = currentLink("owner", { name });
	const ro = currentLink("readonly", {});
	const fmt = (l) => `   ${l.url}`;
	if (roleFlag === "owner" || roleFlag === "readonly") {
		// 指定了角色就只打印那一条（脚本/自动化好抓取）
		const l = roleFlag === "readonly" ? ro : owner;
		console.log("==========================================================");
		console.log(roleFlag === "readonly" ? " 当前只读链接（长期有效，改之前一直是这条）" : " 当前主设备链接（owner 全权，长期有效）");
		console.log("");
		console.log(fmt(l));
		console.log("");
		console.log(` 创建于 ${l.createdAt}${reset ? "　（本次 --reset：旧链接已作废）" : ""}`);
		if (wantQr) console.log("\n" + matrixToAscii(qrEncode(l.url, { ecc: "M" })) + "\n  ↑ 用手机相机扫这张码即进入 DSH");
		console.log("==========================================================");
		console.log(roleFlag === "readonly" ? ro.url : owner.url);
		return;
	}
	console.log("==========================================================");
	if (reset) console.log(" 已重置：旧链接立即作废，下面这两条是新的");
	else console.log(" 当前链接（长期有效，改之前一直是这两条）");
	console.log("");
	console.log(" ① 主设备（owner · 可发指令 / 看图 / 审批）");
	console.log(fmt(owner));
	console.log("");
	console.log(" ② 只读设备（可看会话与图片，写入被拦）");
	console.log(fmt(ro));
	console.log("");
	console.log(` 主链接创建于 ${owner.createdAt}　只读链接创建于 ${ro.createdAt}`);
	if (wantQr) console.log("\n" + matrixToAscii(qrEncode(owner.url, { ecc: "M" })) + "\n  ↑ 主链接的二维码：手机相机直接扫");
	console.log(" 手机点开即自动配对并进入 DSH；token 换完 cookie 后从地址栏消失。");
	console.log(" 要换新链接：node guard.mjs pair --reset（或面板里的「重置链接」）");
	console.log(" 要临时给一台设备一次性凭据：node guard.mjs pair --code");
	console.log("==========================================================");
}

/** 只输出二维码：--svg 给网页/图片用（默认 SVG），不带则打终端字符画。 */
function cliQr() {
	const role = flag("role", "owner") === "readonly" ? "readonly" : "owner";
	const link = currentLink(role, {});
	const qr = qrEncode(link.url, { ecc: "M" });
	if (argv.includes("--svg")) { process.stdout.write(matrixToSvg(qr, { scale: 8 })); return; }
	console.log(`（${role === "readonly" ? "只读" : "主设备"}链接 · ${link.url}）`);
	console.log(matrixToAscii(qr));
	console.log("用手机相机扫这张码即自动配对进入 DSH。要存成图片：node guard.mjs qr --svg > qr.svg");
}

/** 旧的一次性配对码（临时给某台设备用；长期链接之外的备用通道）。 */
function cliCode() {
	const role = flag("role", "owner") === "readonly" ? "readonly" : "owner";
	const ttl = Number(flag("ttl", String(conf.pairTtlSeconds))) || conf.pairTtlSeconds;
	const code = makeCode();
	const token = b64(crypto.randomBytes(32));
	conf.pairings = conf.pairings.filter((p) => p.expiresAt > now());
	conf.pairings.push({ code, tokenHash: sha(token), role, name: flag("name", ""), expiresAt: now() + ttl * 1000, attempts: 0, usesLeft: 1 });
	saveConf();
	console.log("==========================================================");
	console.log(` 一次性配对码： ${code}（${role === "readonly" ? "只读" : "owner 全权"}）`);
	console.log(` 有效期 ${Math.round(ttl / 60)} 分钟 · 只能用一次`);
	console.log(` 在要授权的设备上打开 ${entryUrl()}/ ，输入上面的码`);
	console.log("==========================================================");
}
function cliDevices() {
	if (!conf.devices.length) { console.log("（还没有已授权设备，运行 `guard.mjs pair` 生成配对码）"); return; }
	console.log(`已授权设备（${conf.devices.length}）：`);
	for (const d of conf.devices) console.log(`  ${d.id.slice(0, 8)}  ${d.name.padEnd(18)} ${d.role.padEnd(9)} 最近活跃 ${d.lastSeenAt || "从未"}`);
}
function cliRevoke(ident) {
	const dev = findDeviceByIdent(ident);
	if (!dev) { console.log("没有找到该设备：", ident); process.exitCode = 2; return; }
	conf.devices = conf.devices.filter((d) => d.id !== dev.id);
	conf.sessions = conf.sessions.filter((s) => s.deviceId !== dev.id);
	saveConf();
	audit({ event: "revoke", device: dev.name, role: dev.role });
	console.log(`已吊销 ${dev.name}（${dev.role}）并注销其全部会话`);
}
async function cliStatus() {
	const state = tunnelState();
	let upstreamOk = "未知";
	try {
		const r = await fetch(new URL("/__health", conf.upstream), { signal: AbortSignal.timeout(4000) });
		upstreamOk = r.ok ? "正常" : `HTTP ${r.status}`;
	} catch (e) { upstreamOk = `不可达（${e.message}）`; }
	console.log(JSON.stringify({
		监听: `${conf.bind}:${conf.port}`, 上游: conf.upstream, 上游健康: upstreamOk,
		隧道: state.url ? `${state.url}（PID ${state.pid}${alive(state.pid) ? "" : " 已退出"}）` : "未启动",
		设备数: conf.devices.length, 活跃会话: conf.sessions.filter((s) => s.expiresAt > now()).length,
		配置文件: CONF_FILE, 审计日志: AUDIT_FILE
	}, null, 2));
}

// ---------------------------------------------------------------- 主流程
if (cmd === "pair" || cmd === "link") { (argv.includes("--code") ? cliCode : cliPair)(); process.exit(0); }
if (cmd === "qr") { cliQr(); process.exit(0); }
if (cmd === "devices") { cliDevices(); process.exit(0); }
if (cmd === "revoke") { cliRevoke(argv[1]); process.exit(0); }
if (cmd === "print") { console.log(JSON.stringify(conf, null, 2)); process.exit(0); }
if (cmd === "status") { await cliStatus(); process.exit(0); }
if (cmd === "tunnel") {
	const sub = argv[1] || "status";
	if (sub === "up") {
		conf.superviseTunnel = true;
		saveConf();
		const pid = startTunnel();
		if (!pid) { console.log(lastTunnelError || "已经找不到 cloudflared 了，请用 --cloudflared 指定路径"); process.exit(1); }
		const url = await waitTunnelUrl(60);
		if (!url && lastTunnelError) { console.log(lastTunnelError); process.exit(1); }
		console.log(url ? `公网入口： ${url}/` : "等待域名超时，请查看 " + conf.tunnelLog);
		process.exit(url ? 0 : 1);
	}
	if (sub === "down") {
		// 必须把「想要隧道」这个意图也关掉：否则守护进程每 10 秒会把它拉回来（实测：12 秒后复活）。
		conf.superviseTunnel = false;
		saveConf();
		stopTunnel();
		console.log("隧道已停止（守护进程不会再自动拉起；重新开启：guard.mjs tunnel up）");
		process.exit(0);
	}
	const state = tunnelState();
	console.log(JSON.stringify({ ...state, alive: alive(state.pid), desired: conf.superviseTunnel }, null, 2));
	process.exit(0);
}

saveConf();
server.listen(conf.port, conf.bind, () => {
	log(`dsh-remote guard 已启动：http://${conf.bind}:${conf.port} → ${conf.upstream}`);
	log(`设备 ${conf.devices.length} 台（owner ${conf.devices.filter((d) => d.role === "owner").length} / 只读 ${conf.devices.filter((d) => d.role === "readonly").length}）`);
	if (!conf.devices.length) log("还没有授权设备：运行 `node guard.mjs pair` 生成配对码");
});
setInterval(superviseTunnel, 10_000);
// 兜底：任何未捕获异常都只记录下来，不让守卫退出（它是常驻服务，退出等于公网入口断掉）
process.on("uncaughtException", (e) => { try { log(`uncaughtException: ${e?.stack || e}`); } catch {} });
process.on("unhandledRejection", (r) => { try { log(`unhandledRejection: ${r}`); } catch {} });
