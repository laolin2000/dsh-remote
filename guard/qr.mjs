// ============================================================================
// guard/qr.mjs —— 纯 JS 的 QR 码编码器（零第三方依赖）
//
// 为什么自己写：本项目的硬约束是「只用 Node 内置模块」（守卫要能在任何机器上
// 直接 `node guard.mjs serve` 起来，不该为了一张二维码引入依赖树）。
//
// 范围：字节模式（UTF-8）、版本 1–10 自动选择、纠错级别 L/M/Q/H、8 种掩码自动择优。
//   版本 10 在 M 级可容纳 213 字节 —— 本项目里编码的是一条入口链接（约 90 字符），
//   余量充足；超长会显式报错而不是静默降级。
//
// 对外接口：
//   encode(text, { ecc, version, mask }) → { size, modules, version, ecc, mask, get(x,y) }
//   toSvg(text, opts)                    → 独立 SVG 字符串（白底黑块 + 静默区）
//   toAscii(text, opts)                  → 终端里可扫的字符画（半块字符，一行顶两行）
//   encodeToSvg(matrix) / encodeToAscii(matrix)（内部复用）
//
// 正确性：test/qr.test.mjs 用「参考实现生成的黄金矩阵」逐年逐级比对
//   （参考实现 = npm 的 qrcode 包，仅在开发机上生成向量，不是本项目的依赖）。
// ============================================================================

// ---------------------------------------------------------------- GF(256)
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
	let x = 1;
	for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(n) {
	let poly = [1];
	for (let i = 0; i < n; i++) {
		const next = new Array(poly.length + 1).fill(0);
		for (let j = 0; j < poly.length; j++) {
			next[j] ^= poly[j];
			next[j + 1] ^= gfMul(poly[j], EXP[i]);
		}
		poly = next;
	}
	return poly;
}
function rsEncode(data, ecLen) {
	const gen = rsGenerator(ecLen);
	const rem = new Uint8Array(ecLen);
	for (const b of data) {
		const factor = b ^ rem[0];
		for (let i = 0; i < ecLen - 1; i++) rem[i] = rem[i + 1] ^ gfMul(gen[i + 1], factor);
		rem[ecLen - 1] = gfMul(gen[ecLen], factor);
	}
	return rem;
}

// ---------------------------------------------------------------- 版本表（1–10）
// 每项：总码字数 total、每个纠错块的 ECC 码字数 ec、块结构 blocks: [[数量, 每块数据码字数], ...]
const ECC_ORDER = ["L", "M", "Q", "H"];
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };   // 格式信息里的两位纠错标识
const CAPACITY = {
	1: { total: 26, L: { ec: 7, blocks: [[1, 19]] }, M: { ec: 10, blocks: [[1, 16]] }, Q: { ec: 13, blocks: [[1, 13]] }, H: { ec: 17, blocks: [[1, 9]] } },
	2: { total: 44, L: { ec: 10, blocks: [[1, 34]] }, M: { ec: 16, blocks: [[1, 28]] }, Q: { ec: 22, blocks: [[1, 22]] }, H: { ec: 28, blocks: [[1, 16]] } },
	3: { total: 70, L: { ec: 15, blocks: [[1, 55]] }, M: { ec: 26, blocks: [[1, 44]] }, Q: { ec: 18, blocks: [[2, 17]] }, H: { ec: 22, blocks: [[2, 13]] } },
	4: { total: 100, L: { ec: 20, blocks: [[1, 80]] }, M: { ec: 18, blocks: [[2, 32]] }, Q: { ec: 26, blocks: [[2, 24]] }, H: { ec: 16, blocks: [[4, 9]] } },
	5: { total: 134, L: { ec: 26, blocks: [[1, 108]] }, M: { ec: 24, blocks: [[2, 43]] }, Q: { ec: 18, blocks: [[2, 15], [2, 16]] }, H: { ec: 22, blocks: [[2, 11], [2, 12]] } },
	6: { total: 172, L: { ec: 18, blocks: [[2, 68]] }, M: { ec: 16, blocks: [[4, 27]] }, Q: { ec: 24, blocks: [[4, 19]] }, H: { ec: 28, blocks: [[4, 15]] } },
	7: { total: 196, L: { ec: 20, blocks: [[2, 78]] }, M: { ec: 18, blocks: [[4, 31]] }, Q: { ec: 18, blocks: [[2, 14], [4, 15]] }, H: { ec: 26, blocks: [[4, 13], [1, 14]] } },
	8: { total: 242, L: { ec: 24, blocks: [[2, 97]] }, M: { ec: 22, blocks: [[2, 38], [2, 39]] }, Q: { ec: 22, blocks: [[4, 18], [2, 19]] }, H: { ec: 26, blocks: [[4, 14], [2, 15]] } },
	9: { total: 292, L: { ec: 30, blocks: [[2, 116]] }, M: { ec: 22, blocks: [[3, 36], [2, 37]] }, Q: { ec: 20, blocks: [[4, 16], [4, 17]] }, H: { ec: 24, blocks: [[4, 12], [4, 13]] } },
	10: { total: 346, L: { ec: 18, blocks: [[2, 68], [2, 69]] }, M: { ec: 26, blocks: [[4, 43], [1, 44]] }, Q: { ec: 24, blocks: [[6, 19], [2, 20]] }, H: { ec: 28, blocks: [[6, 15], [2, 16]] } }
};
const MAX_VERSION = 10;
const ALIGN_CENTERS = {
	1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
	7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

function dataCodewords(version, ecc) {
	const spec = CAPACITY[version][ecc];
	return spec.blocks.reduce((n, [count, per]) => n + count * per, 0);
}
/** 字节模式能装多少字节：数据码字数 - 模式(4bit) - 字符计数(8 或 16 bit)，再按 8 位对齐 */
function byteCapacity(version, ecc) {
	const bits = dataCodewords(version, ecc) * 8 - 4 - (version >= 10 ? 16 : 8);
	return Math.floor(bits / 8);
}

// ---------------------------------------------------------------- 位缓冲
class BitBuffer {
	constructor() { this.bits = []; }
	put(value, length) { for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1); }
	get length() { return this.bits.length; }
	toBytes() {
		const out = new Uint8Array(Math.ceil(this.bits.length / 8));
		this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
		return out;
	}
}

// ---------------------------------------------------------------- 码字装配
function buildCodewords(text, version, ecc) {
	const bytes = Buffer.from(text, "utf8");
	const cap = byteCapacity(version, ecc);
	if (bytes.length > cap) throw new RangeError(`内容 ${bytes.length} 字节 > 版本 ${version}/${ecc} 的容量 ${cap} 字节`);
	const total = dataCodewords(version, ecc);
	const bb = new BitBuffer();
	bb.put(0b0100, 4);                                   // 字节模式
	bb.put(bytes.length, version >= 10 ? 16 : 8);        // 字符计数
	for (const b of bytes) bb.put(b, 8);
	const remain = total * 8 - bb.length;
	bb.put(0, Math.min(4, Math.max(0, remain)));         // 结束符（最多 4 位）
	while (bb.length % 8 !== 0) bb.put(0, 1);            // 补齐到字节
	const data = bb.toBytes();
	const pads = [0xec, 0x11];
	const full = new Uint8Array(total);
	full.set(data);
	for (let i = data.length, k = 0; i < total; i++, k++) full[i] = pads[k % 2];
	return full;
}

function interleave(data, version, ecc) {
	const spec = CAPACITY[version][ecc];
	const blocks = [];
	let offset = 0;
	for (const [count, per] of spec.blocks) {
		for (let b = 0; b < count; b++) {
			const chunk = data.slice(offset, offset + per);
			offset += per;
			blocks.push({ data: chunk, ec: rsEncode(chunk, spec.ec) });
		}
	}
	const out = [];
	const maxData = Math.max(...blocks.map((b) => b.data.length));
	for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
	for (let i = 0; i < spec.ec; i++) for (const b of blocks) out.push(b.ec[i]);
	return Uint8Array.from(out);
}

// ---------------------------------------------------------------- 矩阵
function newMatrix(size) {
	const m = { size, modules: [], reserved: [] };
	for (let i = 0; i < size; i++) { m.modules.push(new Array(size).fill(false)); m.reserved.push(new Array(size).fill(false)); }
	return m;
}
function setFn(m, x, y, dark) {
	if (x < 0 || y < 0 || x >= m.size || y >= m.size) return;
	m.modules[y][x] = dark; m.reserved[y][x] = true;
}
function finder(m, cx, cy) {
	for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
		const dist = Math.max(Math.abs(dx), Math.abs(dy));
		setFn(m, cx + dx, cy + dy, dist !== 2 && dist !== 4);
	}
}
function alignment(m, cx, cy) {
	for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(m, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
}
function formatBits(ecc, mask) {
	const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
	let rem = data;
	for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	return ((data << 10) | rem) ^ 0x5412;
}
function versionBits(v) {
	let rem = v;
	for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
	return (v << 12) | rem;
}
function formatCells(size) {
	// 15 位格式信息的两份拷贝，按 bit 0..14 的顺序给出坐标。
	// 踩过的坑：这些格子必须在「放数据之前」就标记为功能区 —— 否则数据会先写进去、
	// 再被格式信息覆盖，码流出现空洞（现象：前几个码字对、之后全乱，扫描器直接解不出）。
	const first = [
		[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
		[7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
	];
	const second = [];
	for (let i = 0; i < 8; i++) second.push([size - 1 - i, 8]);
	for (let i = 8; i < 15; i++) second.push([8, size - 15 + i]);
	return { first, second };
}
function versionCells(version, size) {
	const out = [];
	if (version < 7) return out;
	for (let i = 0; i < 18; i++) {
		const a = Math.floor(i / 3), b = i % 3;
		out.push([size - 11 + b, a, i]);
		out.push([a, size - 11 + b, i]);
	}
	return out;
}
function placeFormat(m, ecc, mask) {
	const bits = formatBits(ecc, mask);
	const { first, second } = formatCells(m.size);
	first.forEach(([x, y], i) => setFn(m, x, y, ((bits >> i) & 1) === 1));
	second.forEach(([x, y], i) => setFn(m, x, y, ((bits >> i) & 1) === 1));
	setFn(m, 8, m.size - 8, true);          // 固定的暗模块
}
function placeVersion(m, version) {
	for (const [x, y, i] of versionCells(version, m.size)) setFn(m, x, y, ((versionBits(version) >> i) & 1) === 1);
}
function functionPatterns(version) {
	const size = version * 4 + 17;
	const m = newMatrix(size);
	for (let i = 0; i < size; i++) {
		setFn(m, 6, i, i % 2 === 0);      // 垂直定时
		setFn(m, i, 6, i % 2 === 0);      // 水平定时
	}
	finder(m, 3, 3); finder(m, size - 4, 3); finder(m, 3, size - 4);
	const centers = ALIGN_CENTERS[version];
	for (const cy of centers) for (const cx of centers) {
		const corner = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
		if (!corner) alignment(m, cx, cy);
	}
	// 格式信息、暗模块、版本信息：先占位（值稍后由 placeFormat/placeVersion 填入）
	const { first, second } = formatCells(size);
	for (const [x, y] of first.concat(second)) setFn(m, x, y, false);
	setFn(m, 8, size - 8, true);
	for (const [x, y] of versionCells(version, size)) setFn(m, x, y, false);
	return m;
}
const MASKS = [
	(i, j) => (i + j) % 2 === 0,
	(i) => i % 2 === 0,
	(i, j) => j % 3 === 0,               // 注意：列（j），不是行 —— 写成第一个参数就错了
	(i, j) => (i + j) % 3 === 0,
	(i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
	(i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
	(i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
	(i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0
];
function placeData(m, codewords) {
	const size = m.size;
	let bitIndex = 0;
	let upward = true;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;                     // 跳过第 6 列（垂直定时）
		for (let vert = 0; vert < size; vert++) {
			const y = upward ? size - 1 - vert : vert;
			for (let c = 0; c < 2; c++) {
				const x = right - c;
				if (m.reserved[y][x]) continue;
				let dark = false;
				if (bitIndex < codewords.length * 8) dark = ((codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1) === 1;
				bitIndex++;
				m.modules[y][x] = dark;
			}
		}
		upward = !upward;
	}
}
function penalty(m) {
	const size = m.size;
	let score = 0;
	const lineRun = (get) => {
		for (let a = 0; a < size; a++) {
			let run = 1;
			for (let b = 1; b < size; b++) {
				if (get(a, b) === get(a, b - 1)) run++;
				else { if (run >= 5) score += 3 + (run - 5); run = 1; }
			}
			if (run >= 5) score += 3 + (run - 5);
		}
	};
	lineRun((a, b) => m.modules[a][b]);                 // 行
	lineRun((a, b) => m.modules[b][a]);                 // 列
	for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
		const v = m.modules[y][x];
		if (v === m.modules[y][x + 1] && v === m.modules[y + 1][x] && v === m.modules[y + 1][x + 1]) score += 3;
	}
	const pattern = [true, false, true, true, true, false, true, false, false, false, false];
	const patternRev = [false, false, false, false, true, false, true, true, true, false, true];
	const matchAt = (get, a, b) => {
		for (let k = 0; k < 11; k++) if (get(a, b + k) !== pattern[k]) return patternRev.every((p, k2) => get(a, b + k2) === p);
		return true;
	};
	for (let y = 0; y < size; y++) for (let x = 0; x + 11 <= size; x++) {
		if (matchAt((a, b) => m.modules[a][b], y, x)) score += 40;
		if (matchAt((a, b) => m.modules[b][a], y, x)) score += 40;
	}
	let dark = 0;
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m.modules[y][x]) dark++;
	// N4：按标准写法（|ceil(百分比/5) - 10| × 10），与参考实现一致；
	// 别用 floor(|百分比-50|/5) —— 在 55% 附近会差一档，导致自动择优选到别的掩码。
	const k = Math.abs(Math.ceil((dark * 100) / (size * size) / 5) - 10);
	score += k * 10;
	return score;
}

/** 把格式信息格子清成「亮」（暗模块保持暗）——用于逐个候选掩码评分时来回切换。 */
function clearFormat(m) {
	const { first, second } = formatCells(m.size);
	for (const [x, y] of first.concat(second)) setFn(m, x, y, false);
	setFn(m, 8, m.size - 8, true);
}

/** 编码入口：返回矩阵与选中的版本/纠错级/掩码。 */
export function encode(text, { ecc = "M", version = 0, mask = -1 } = {}) {
	const level = ECC_ORDER.includes(String(ecc).toUpperCase()) ? String(ecc).toUpperCase() : "M";
	const bytes = Buffer.from(String(text), "utf8");
	let v = Number(version) || 0;
	if (!v) {
		v = 1;
		while (v <= MAX_VERSION && byteCapacity(v, level) < bytes.length) v++;
		if (v > MAX_VERSION) throw new RangeError(`内容 ${bytes.length} 字节超出本实现支持的最大版本 ${MAX_VERSION}/${level}（${byteCapacity(MAX_VERSION, level)} 字节）`);
	}
	if (!CAPACITY[v]) throw new RangeError(`不支持的版本：${v}（本实现支持 1–${MAX_VERSION}）`);
	const codewords = interleave(buildCodewords(String(text), v, level), v, level);
	const m = functionPatterns(v);
	placeData(m, codewords);
	placeVersion(m, v);                       // 版本信息与掩码无关，先放好（评分时要算进去）
	// 逐个候选掩码评分：每个候选都要写成「该掩码下的完整符号」（含格式信息）再打分，
	// 否则评分与标准不一致 → 自动择优选到的掩码会和别的实现不同。
	const pickMask = () => {
		if (mask >= 0 && mask <= 7) return mask;
		let best = 0, bestScore = Infinity;
		for (let k = 0; k < 8; k++) {
			applyMask(m, k);
			placeFormat(m, level, k);
			const s = penalty(m);
			clearFormat(m);
			applyMask(m, k);
			if (s < bestScore) { bestScore = s; best = k; }
		}
		return best;
	};
	const chosen = pickMask();
	applyMask(m, chosen);
	placeFormat(m, level, chosen);
	return {
		size: m.size, version: v, ecc: level, mask: chosen, modules: m.modules, reserved: m.reserved,
		get: (x, y) => m.modules[y][x]
	};
}
function applyMask(m, k) {
	const fn = MASKS[k];
	for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (!m.reserved[y][x] && fn(y, x)) m.modules[y][x] = !m.modules[y][x];
}
export const maxVersion = MAX_VERSION;
export const capacity = byteCapacity;

// ---------------------------------------------------------------- 渲染
/** 独立 SVG：白底黑块，默认 4 模块静默区（扫码器需要）。 */
export function matrixToSvg(qr, { scale = 8, quiet = 4, dark = "#000", light = "#fff" } = {}) {
	const n = qr.size, total = n + quiet * 2;
	let path = "";
	for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${total * scale}" height="${total * scale}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR">` +
		`<rect width="${total}" height="${total}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}
/** 终端字符画：一个字符表示上下两个模块（▀ 上半 / ▄ 下半 / █ 全黑），四周留 2 模块静默区。 */
export function matrixToAscii(qr, { quiet = 2, dark = "██", light = "  " } = {}) {
	const n = qr.size, lines = [];
	const half = (x, y) => (y < 0 || y >= n || x < 0 || x >= n ? false : qr.modules[y][x]);
	const pad = light.repeat(quiet);
	for (let y = -quiet; y < n + quiet; y += 2) {
		let line = pad;
		for (let x = -quiet; x < n + quiet; x++) {
			const top = half(x, y), bottom = half(x, y + 1);
			line += top && bottom ? dark : top ? "▀▀" : bottom ? "▄▄" : light;
		}
		lines.push(line + pad);
	}
	return lines.join("\n");
}
export function toSvg(text, opts = {}) { return matrixToSvg(encode(text, opts), opts); }
export function toAscii(text, opts = {}) { return matrixToAscii(encode(text, opts), opts); }

/** 内部件导出（供 test/qr.test.mjs 逐级比对用；不属于稳定 API）。 */
export const _internals = { buildCodewords, interleave, functionPatterns, formatBits, placeData, applyMask, MASKS, penalty, dataCodewords, rsEncode, rsGenerator };
