// ============================================================================
// dsh-remote-panel · 服务端半边
//
// 在 DSH 自己的 HTTP 服务器上挂 /dsh-remote/* 路由，供同源的客户端面板调用。
// 它只做三件事：读守卫的状态文件、调守卫 CLI 生成链接、调守卫 CLU 吊销设备。
//
// 为什么要有这一半：客户端面板跑在 DSH 页面里（同源 = DSH 的端口），
// 而守卫在另一个端口上；让它跨源调守卫要处理 CORS 与凭据，得不偿失。
// 插件本来就跑在 DSH 进程里、本来就是本机可信方，直接读文件/调 CLI 最干净。
//
// 权限：这些路由是"控制面"，必须只有 owner 能用。两道闸——
//   ① 守卫侧：/dsh-remote/* 在守卫里按 owner-only 处理（只读设备到不了这里）；
//   ② 本插件侧：经守卫来的请求必须带 x-dsh-remote-role: owner；本机直连必须 Host 是回环。
// ============================================================================
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "dsh-remote-panel";
export const inject = ["webServer"];

const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const CONF_DIR = path.join(HOME, "remote");
const GUARD_CONF = path.join(CONF_DIR, "guard.json");
const TUNNEL_STATE = path.join(CONF_DIR, "tunnel.json");

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function isLoopbackHost(req) {
	const host = String(req.headers.host || "").replace(/^\[|\]$/g, "");
	return /^(127\.0\.0\.1|localhost|::1)(:\d+)?$/i.test(host);
}

/** 控制面准入：经守卫来的看角色头；本机直连（桌面壳）看 Host 是否回环。 */
function ownerAllowed(req) {
	const role = req.headers["x-dsh-remote-role"];
	if (role !== undefined) return String(role) === "owner";
	return isLoopbackHost(req);
}

function runGuard(guardPath, args) {
	return new Promise((resolve) => {
		if (!guardPath || !fs.existsSync(guardPath)) {
			resolve({ ok: false, error: "找不到守卫脚本：请在插件配置里填 config.guardPath，或设 DSH_REMOTE_GUARD" });
			return;
		}
		const child = spawn(process.execPath, [guardPath, ...args], { windowsHide: true });
		let out = "";
		child.stdout.on("data", (c) => { out += String(c); });
		child.stderr.on("data", (c) => { out += String(c); });
		child.on("error", (e) => resolve({ ok: false, error: e.message }));
		child.on("close", (code) => resolve({ ok: code === 0, out, code }));
	});
}

function json(res, code, value) {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store" });
	res.end(body);
}

async function readBody(req) {
	return new Promise((resolve) => {
		let size = 0, chunks = [];
		req.on("data", (c) => { size += c.length; if (size > 64 * 1024) { req.destroy(); return; } chunks.push(c); });
		req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(null); } });
		req.on("error", () => resolve(null));
	});
}


/** 从守卫的状态文件里拼出当前两条链接的 URL（不解析 CLI 输出，稳定）。
 *  链接长期有效；要换新的必须走 /dsh-remote/reset。
 *  没有公网入口时**必须退回本机入口**——否则会拼出没有域名的 "/?t=..."，
 *  面板上看着就是一条坏链接（实测踩到过：隧道没起来时就是这个样子）。 */
function linksFromState() {
	const conf = readJson(GUARD_CONF) || {};
	const tun = readJson(TUNNEL_STATE) || {};
	let base = "";
	try {
		if (conf.urlFile && fs.existsSync(conf.urlFile)) base = fs.readFileSync(conf.urlFile, "utf8").trim();
	} catch { /* 读不到就用隧道状态里的域名 */ }
	if (!base) base = tun.url || "";
	base = String(base).replace(/\/+$/, "");
	const local = !base;                                   // true = 还没有公网入口
	if (local) base = `http://${conf.bind || "127.0.0.1"}:${conf.port || 8443}`;
	const mk = (l) => (l && l.token ? { url: base + "/?t=" + l.token, role: l.role, name: l.name, createdAt: l.createdAt, longLived: true, local } : null);
	return { owner: mk(conf.links && conf.links.owner), readonly: mk(conf.links && conf.links.readonly), local };
}

function guardSnapshot() {
	const conf = readJson(GUARD_CONF) || {};
	const tunnel = readJson(TUNNEL_STATE) || {};
	let urlFileEntry = "";
	try {
		const urlFile = conf.urlFile;
		if (urlFile && fs.existsSync(urlFile)) urlFileEntry = fs.readFileSync(urlFile, "utf8").trim();
	} catch { /* 读不到就算了 */ }
	return {
		entry: urlFileEntry || tunnel.url || "",
		tunnel: { url: tunnel.url || "", pid: tunnel.pid || null, restarts: tunnel.restarts || 0 },
		devices: (conf.devices || []).map((d) => ({ id: d.id, name: d.name, role: d.role, lastSeenAt: d.lastSeenAt, createdAt: d.createdAt })),
		links: linksFromState(),
		pendingLinks: (conf.pairings || []).length,
		sessions: (conf.sessions || []).filter((s) => s.expiresAt > Date.now()).length
	};
}

// ---------------------------------------------------------------- 链路自检与自愈
// 为什么由插件来干这件事：守卫是普通后台进程，机器/DSH 一重启它就没了，
// 而"重启之后手机和网页都用不了"正是这么来的（实测踩到）。DSH 是用户天天在用的
// 常驻程序，所以让它内置的插件负责「发现守卫掉了就把它拉回来」最可靠。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function guardBase() {
	const conf = readJson(GUARD_CONF) || {};
	return { base: `http://127.0.0.1:${conf.port || 8443}`, conf };
}
async function probe(url, ms = 2500) {
	try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok; } catch { return false; }
}
/** 逐段健康：守卫 / 隧道 / 上游（上游探的是守卫的配置，不是 DSH 自己） */
async function chainHealth() {
	const { base, conf } = guardBase();
	const guardOk = await probe(base + "/__guard/health");
	const tun = readJson(TUNNEL_STATE) || {};
	const cfg = readJson(GUARD_CONF) || {};
	let url = "";
	try { if (cfg.urlFile && fs.existsSync(cfg.urlFile)) url = fs.readFileSync(cfg.urlFile, "utf8").trim(); } catch {}
	if (!url) url = tun.url || "";
	const problems = [];
	if (!guardOk) problems.push("守卫没在运行（手机链接、二维码都靠它）");
	if (guardOk && conf.superviseTunnel !== false && !pidAlive(tun.pid)) problems.push("公网隧道没在运行（手机连不上，只能本机打开）");
	return {
		guard: guardOk, guardPort: conf.port || 8443, upstream: conf.upstream || "",
		tunnel: { alive: pidAlive(tun.pid), url, desired: conf.superviseTunnel !== false, pid: tun.pid || null },
		cloudflared: conf.cloudflared || "", problems
	};
}
let starting = null;
/** 守卫不在就拉起来（并发去重；最多等 12 秒看它是否就绪）。 */
async function ensureGuard(guardPath) {
	if ((await chainHealth()).guard) return { ok: true, started: false };
	if (!guardPath || !fs.existsSync(guardPath)) {
		return { ok: false, error: "找不到守卫脚本：请在插件配置里填 config.guardPath（或用安装脚本重装一次）", guardPath };
	}
	if (starting) return starting;
	starting = (async () => {
		let child;
		try {
			child = spawn(process.execPath, [guardPath, "serve"], { detached: true, stdio: "ignore", windowsHide: true, cwd: path.dirname(guardPath) });
		} catch (e) { return { ok: false, error: `拉起守卫失败：${e.message}` }; }
		child.on("error", () => {});
		child.unref();
		const { base } = guardBase();
		for (let i = 0; i < 24; i++) {
			await sleep(500);
			if (await probe(base + "/__guard/health")) return { ok: true, started: true, pid: child.pid };
		}
		return { ok: false, error: `守卫进程起了（PID ${child.pid}）但 12 秒内没就绪；看状态目录里的 guard.log`, pid: child.pid };
	})();
	try { return await starting; } finally { starting = null; }
}
/** 隧道不在就交给守卫自己拉（守卫的守护进程会看住它）。 */
async function ensureTunnel(guardPath) {
	const h = await chainHealth();
	if (!h.guard) return { ok: false, error: "守卫还没起来，先起守卫" };
	if (h.tunnel.alive) return { ok: true, started: false, url: h.tunnel.url };
	if (h.tunnel.desired === false) return { ok: false, error: "隧道被显式关掉了（tunnel down）；想用就点“启动”，它会重新打开" };
	if (!h.cloudflared || !fs.existsSync(h.cloudflared)) return { ok: false, error: "没有可用的 cloudflared：用 node bin/setup.mjs --cloudflared <路径> 指定一次即可记住" };
	if (!guardPath || !fs.existsSync(guardPath)) return { ok: false, error: "找不到守卫脚本，无法调用 tunnel up" };
	const out = await runGuard(guardPath, ["tunnel", "up"]);        // 里面会 spawn cloudflared（分离进程）
	const h2 = await chainHealth();
	return { ok: !!h2.tunnel.alive, started: true, url: h2.tunnel.url, detail: (out.out || "").trim().slice(-200) };
}

export function apply(ctx, config) {
	const guardPath = (config && config.guardPath) || process.env.DSH_REMOTE_GUARD || "";

	ctx.webServer.register({
		kind: "prefix",
		path: "/dsh-remote",
		handler: async (req, res) => {
			const pathname = new URL(req.url || "/", "http://dsh.internal").pathname;
			const method = String(req.method || "GET").toUpperCase();

			if (!ownerAllowed(req)) {
				json(res, 403, { ok: false, error: "只允许 owner 设备（或本机）使用手机链接控制面" });
				return;
			}

			if (pathname === "/dsh-remote/status" && method === "GET") {
				json(res, 200, { ok: true, guardPath, configured: Boolean(guardPath), ...guardSnapshot() });
				return;
			}

			// 逐段体检：守卫 / 隧道 / 上游（面板据此告诉用户"哪一段没起来"）
			if (pathname === "/dsh-remote/health" && method === "GET") {
				json(res, 200, { ok: true, ...(await chainHealth()) });
				return;
			}

			// 把没起来的环节拉起来（守卫 → 隧道）。幂等：已经好的不会被重启。
			if (pathname === "/dsh-remote/start" && method === "POST") {
				const g = await ensureGuard(guardPath);
				const t = g.ok ? await ensureTunnel(guardPath) : { ok: false, error: "守卫未就绪，跳过隧道" };
				// 注意：体检结果要放在 health 键下，别和 start 的结果同名（踩过：展开覆盖后 PID 与错误原因全丢了）
				const health = await chainHealth();
				json(res, g.ok && t.ok ? 200 : 500, { ok: g.ok && t.ok, guard: g, tunnel: t, health });
				return;
			}

			if (pathname === "/dsh-remote/devices" && method === "GET") {
				json(res, 200, { ok: true, devices: guardSnapshot().devices });
				return;
			}

			// 当前长期链接（两条）：不改动任何东西，纯读取
			if (pathname === "/dsh-remote/links" && method === "GET") {
				json(res, 200, { ok: true, ...linksFromState() });
				return;
			}

			// 重置：换新链接（旧链接立即作废）
			if (pathname === "/dsh-remote/reset" && method === "POST") {
				const out = await runGuard(guardPath, ["pair", "--reset"]);
				if (!out.ok) { json(res, 500, { ok: false, error: out.error || "重置失败", detail: out.out }); return; }
				const state = linksFromState();
				json(res, 200, { ok: true, ...state });
				return;
			}

			if (pathname === "/dsh-remote/link" && method === "GET") {
				const q = new URL(req.url || "/", "http://dsh.internal").searchParams;
				const role = q.get("role") === "readonly" ? "readonly" : "owner";
				const reset = q.get("reset") === "1";
				const args = ["pair", "--ttl", "3600", "--name", role === "readonly" ? "只读设备" : "我的手机"];
				if (role === "readonly") args.push("--role", "readonly");
				if (reset) args.push("--reset");
				const out = await runGuard(guardPath, args);
				if (!out.ok) { json(res, 500, { ok: false, error: out.error || "生成失败", detail: out.out }); return; }
				const url = (out.out.match(/https?:\/\/\S+\?t=[A-Za-z0-9_-]+/) || [])[0] || "";
				const code = (out.out.match(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/) || [])[0] || "";
				if (!url) { json(res, 500, { ok: false, error: "守卫没有返回链接", detail: out.out }); return; }
				json(res, 200, { ok: true, url, code, role, ttlSeconds: 3600, expiresAt: Date.now() + 3600 * 1000 });
				return;
			}

			// 手机二维码（SVG）：面板里点「二维码」时显示，手机相机扫一下即进
			if (pathname === "/dsh-remote/qr" && method === "GET") {
				const q = new URL(req.url || "/", "http://dsh.internal").searchParams;
				const role = q.get("role") === "readonly" ? "readonly" : "owner";
				const out = await runGuard(guardPath, ["qr", "--svg", "--role", role]);
				if (!out.ok || !out.out.includes("<svg")) {
					json(res, 500, { ok: false, error: out.error || "守卫没有返回二维码", detail: (out.out || "").slice(-300) });
					return;
				}
				const svg = out.out.slice(out.out.indexOf("<svg")).trim();
				const body = Buffer.from(svg, "utf8");
				res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store" });
				res.end(body);
				return;
			}

			if (pathname === "/dsh-remote/revoke" && method === "POST") {
				const body = await readBody(req);
				const id = body && typeof body.id === "string" ? body.id : "";
				if (!id) { json(res, 400, { ok: false, error: "缺少 id" }); return; }
				const out = await runGuard(guardPath, ["revoke", id]);
				json(res, out.ok ? 200 : 500, { ok: out.ok, error: out.ok ? undefined : (out.error || "吊销失败"), detail: out.ok ? undefined : out.out });
				return;
			}

			json(res, 404, { ok: false, error: "unknown dsh-remote endpoint" });
		}
	});

	// 后台自愈：DSH 起动后与之后每隔一段时间，发现守卫不在就把它拉回来。
	// （这就是"重启之后手机和网页都用不了"的根治办法：以前没有任何东西负责重启守卫。）
	// 可用环境变量 DSH_REMOTE_HEAL_SECONDS=0 关掉；正数则改检查间隔（秒）。
	const healSeconds = process.env.DSH_REMOTE_HEAL_SECONDS === undefined ? 60 : Number(process.env.DSH_REMOTE_HEAL_SECONDS);
	if (healSeconds > 0) {
		const tick = async () => {
			try {
				const h = await chainHealth();
				if (h.guard) return;
				const r = await ensureGuard(guardPath);
				console.log(r.ok ? `[dsh-remote] 发现守卫没在运行，已自动拉起${r.pid ? `（PID ${r.pid}）` : ""}` : `[dsh-remote] 守卫没在运行，拉起失败：${r.error}`);
			} catch (e) { console.log("[dsh-remote] 自愈检查异常：", e?.message || e); }
		};
		const first = setTimeout(tick, 5000);          // DSH 起动 5 秒后先查一次
		if (first.unref) first.unref();
		const loop = setInterval(tick, healSeconds * 1000);
		if (loop.unref) loop.unref();
		console.log(`[dsh-remote] 守卫自愈已开启（每 ${healSeconds} 秒检查一次）`);
	}
}
