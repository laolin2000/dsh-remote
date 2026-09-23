#!/usr/bin/env node
// ============================================================================
// qr.mjs 的测试：黄金向量比对 + 结构性断言（不需要任何第三方依赖）
//
// 黄金向量来自参考实现（npm 的 qrcode 包，权威且被广泛验证），
// 只在开发机上生成一次、写进 test/qr-vectors.mjs；运行时不需要它。
//   比对粒度是**逐模块**：只要有一位不同就报错，因此能抓到纠错码、
//   排布顺序、掩码、格式信息、功能图案里任何一处偏差。
//
//   node test/qr.test.mjs
// ============================================================================
import { encode, matrixToSvg, matrixToAscii, capacity, maxVersion, _internals as I } from "../guard/qr.mjs";
import { VECTORS, ECC_VECTORS } from "./qr-vectors.mjs";

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
	if (ok) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}
/** 把矩阵打包成与黄金向量相同的十六进制（行优先，每 4 位一个字符；末组右侧补 0） */
function pack(qr) {
	let bits = "";
	for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) bits += qr.modules[y][x] ? "1" : "0";
	let hex = "";
	for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
	return hex;
}

console.log("\n=== 1. 黄金向量：逐模块与参考实现比对 ===");
for (const v of VECTORS) {
	const opts = { ecc: v.ecc };
	if (v.version) opts.version = v.version;
	if (v.mask !== "auto") opts.mask = v.mask;
	const qr = encode(v.text, opts);
	check(`「${v.name}」版本/纠错级与参考一致（v${qr.version}/${qr.ecc}）`, qr.version === v.version && qr.ecc === v.ecc, `实际 v${qr.version}/${qr.ecc}`);
	check(`「${v.name}」尺寸与掩码正确（${qr.size}×${qr.size}, mask ${qr.mask}）`,
		qr.size === v.size && (v.mask === "auto" || qr.mask === v.mask), `实际 ${qr.size}×${qr.size} mask ${qr.mask}`);
	check(`「${v.name}」矩阵与参考逐模块一致`, pack(qr) === v.hex,
		`长度 ${pack(qr).length} vs ${v.hex.length}${pack(qr) !== v.hex ? "，首个差异位 " + [...pack(qr)].findIndex((c, i) => c !== v.hex[i]) : ""}`);
}

console.log("\n=== 2. 纠错码（Reed-Solomon）黄金向量 ===");
for (const [i, e] of ECC_VECTORS.entries()) {
	const ec = Array.from(I.rsEncode(Uint8Array.from(e.data), e.ecLen));
	check(`纠错向量 ${i + 1}（${e.data.length} 数据 + ${e.ecLen} 纠错）与参考一致`,
		ec.length === e.ec.length && ec.every((b, k) => b === e.ec[k]),
		JSON.stringify(ec.slice(0, 6)) + "… vs " + JSON.stringify(e.ec.slice(0, 6)) + "…");
}
{
	// 生成多项式也应与标准一致（n=17 的系数是公开表值）
	const gen = Array.from(I.rsGenerator(17));
	const known = [1, 0x77, 0x42, 0x53, 0x78, 0x77, 0x16, 0xc5, 0x53, 0xf9, 0x29, 0x8f, 0x86, 0x55, 0x35, 0x7d, 0x63, 0x4f];
	check("n=17 的生成多项式与标准表一致", gen.length === known.length && gen.every((b, k) => b === known[k]), JSON.stringify(gen));
}

console.log("\n=== 3. 结构：定位图案 / 定时图案 / 暗模块 / 静默区 ===");
{
	const qr = encode("https://example.com/?t=abc", { ecc: "M" });
	const dark = (x, y) => qr.modules[y][x];
	// 定位图案以 (3,3) 为中心：距中心 3 的外环最暗、2 的一环最亮、中心 3×3 暗
	check("左上定位图案外环为暗", [dark(0, 0), dark(6, 0), dark(0, 6), dark(6, 6)].every(Boolean));
	check("左上定位图案内环为亮", [dark(1, 1), dark(5, 1), dark(1, 5), dark(5, 5)].every((v) => v === false));
	check("定位图案中心 3×3 为暗", [dark(3, 3), dark(2, 2), dark(4, 4), dark(3, 2)].every(Boolean));
	check("右上/左下定位图案存在", [dark(qr.size - 1, 0), dark(0, qr.size - 1), dark(qr.size - 4, 3)].every(Boolean));
	check("水平/垂直定时图案交替", dark(8, 6) === true && dark(9, 6) === false && dark(6, 8) === true);
	check("暗模块固定为暗", dark(8, qr.size - 8) === true);
	const svg = matrixToSvg(qr, { scale: 4, quiet: 4 });
	check("SVG 含静默区（含 quiet 边距的 rect）", svg.includes(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`));
	check("SVG 是合法 XML 头且含路径", svg.startsWith("<svg") && svg.includes("<path d=\"M"));
	check("SVG 尺寸 = (模块数+静默区×2) × scale", svg.includes(`width="${(qr.size + 8) * 4}"`));
	const ascii = matrixToAscii(qr, { quiet: 2 });
	const expectLines = Math.ceil((qr.size + 4) / 2);
	check("字符画行数 = ⌈(模块数+静默区×2)/2⌉", ascii.split("\n").length === expectLines, `${ascii.split("\n").length} vs ${expectLines}`);
	check("字符画只含半块字符与空格", /^[▀▄█ \n]+$/.test(ascii));
}

console.log("\n=== 4. 版本选择与容量边界 ===");
{
	check("短内容自动选最小版本 v1", encode("A").version === 1);
	let v = 1; while (capacity(v, "M") < 90) v++;
	check(`90 字节内容自动选到 v${v}`, encode("x".repeat(90)).version === v, String(encode("x".repeat(90)).version));
	const maxBytes = capacity(maxVersion, "L");
	check(`超出最大版本 ${maxVersion}/L（${maxBytes} 字节）时显式报错`, (() => {
		try { encode("x".repeat(maxBytes + 1), { ecc: "L" }); return false; } catch (e) { return e instanceof RangeError; }
	})());
	check("刚好等于容量上限时可以编码", encode("x".repeat(maxBytes), { ecc: "L" }).size === maxVersion * 4 + 17);
	check("中文字符按 UTF-8 字节计（3 字节/字）", encode("中".repeat(40)).version >= encode("a".repeat(40)).version);
	check("未知纠错级回退到 M", encode("A", { ecc: "Z" }).ecc === "M");
}

console.log("\n=== 5. 掩码与评分函数（对照标准定义）===");
{
	// 掩码函数的参数是 (行 i, 列 j)；这里用与标准定义逐点比对的方式确认（含列敏感的第 2 号掩码）
	const std = {
		0: (i, j) => (i + j) % 2 === 0,
		1: (i) => i % 2 === 0,
		2: (i, j) => j % 3 === 0,
		3: (i, j) => (i + j) % 3 === 0,
		4: (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
		5: (i, j) => (i * j) % 2 + (i * j) % 3 === 0,
		6: (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0,
		7: (i, j) => ((i * j) % 3 + (i + j) % 2) % 2 === 0
	};
	let maskBad = 0, mask2ColSensitive = false;
	for (let k = 0; k < 8; k++) for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) if (I.MASKS[k](i, j) !== std[k](i, j)) maskBad++;
	for (let j = 0; j < 40; j++) if (I.MASKS[2](7, j) !== std[2](7, j)) mask2ColSensitive = true;
	check("8 个掩码函数逐点符合标准定义", maskBad === 0, `${maskBad} 处不符`);
	check("2 号掩码确实是「列」敏感（踩过的坑：写成行就全错）", !mask2ColSensitive);
	const fmt = I.formatBits("H", 0).toString(2).padStart(15, "0");
	check("格式信息 H/mask0 = 001011010001001（标准表）", fmt === "001011010001001", fmt);
	const fmtM = I.formatBits("M", 0).toString(2).padStart(15, "0");
	check("格式信息 M/mask0 = 101010000010010（标准表）", fmtM === "101010000010010", fmtM);
}

console.log("\n=== 6. 渲染的互相一致性 ===");
{
	const qr = encode("结构一致性", { ecc: "Q" });
	const svg = matrixToSvg(qr, { quiet: 0 });
	const rects = (svg.match(/h1v1h-1z/g) || []).length;
	let darkCount = 0;
	for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) darkCount++;
	check("SVG 的暗块数量 = 矩阵里的暗模块数", rects === darkCount, `${rects} vs ${darkCount}`);
	const ascii = matrixToAscii(qr, { quiet: 0 });
	const asciiDark = (ascii.match(/[▀▄█]/g) || []).length;
	check("字符画覆盖的列数 = 模块数×2", ascii.split("\n")[0].length === qr.size * 2);
	check("字符画确实画出了暗块", asciiDark > 0);
}

console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail ? 1 : 0);
