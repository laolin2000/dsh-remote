// 黄金向量：由参考实现（npm 的 qrcode 包）生成，只用于本测试，不是运行时依赖。
// 矩阵按「行优先、每 4 位一个十六进制字符」打包（末组右侧补 0）。
// 注意：向量里的链接一律是**合成占位**，不要写入真实入口域名或 token。
export const VECTORS = [
	{ name: "短文本(自动版本/纠错)", text: "A", version: 1, ecc: "M", mask: "auto", size: 21,
		hex: "fe93fc17d06e8abb75b5dba72ec12d07faafe01b00b73a5acaf233b41b6827c9e492005927fa65105836ba6f8dd79faeaac1044a5fe8480" },
	{ name: "普通文本", text: "hello dsh", version: 1, ecc: "M", mask: "auto", size: 21,
		hex: "fe6bfc11906ebabb75f5dba8aec17907faafe01400be33e622c76e8b9d61face68a08045e7f840d05c2eba910dd4fe2eaac904bdcfec890" },
	{ name: "真实长度的手机链接（合成占位）", text: "https://demo-entry-placeholder.trycloudflare.com/?t=DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", version: 6, ecc: "M", mask: "auto", size: 41,
		hex: "fe1aec1abfc1246358106ea97b06abb753b1d605dbab1b90baec16e8758507faaaaaaafe01c73e5600be69d3f43e32d21fe7edbcd0020e220f2c16d37ba16dbebe516309d420d6e8a8cc3ac100883e48356aeb0806b0520847160d5eebe689ac0211b6c18359ae203aeb0089e8e6ae5dec1ff4b1c22082b17830b857ca5275083aaebc93aebbb222a722121d40f53babf5682e5065ac7561c66a38765ac19172357835da9b2d96b0fe0079b60d46ff84b1ac2a1055ed83719bad204b0f8dd7a78872aeea9e3ae5e104429b339afef5b275780" },
	{ name: "中文内容", text: "手机链接：扫描进入 DSH", version: 3, ecc: "M", mask: "auto", size: 29,
		hex: "feb70bfc15fa506eab94bb743675dbae512ec1031d07faaaafe00148009fafc4bdaad14b23f094a378663962b166d372e01f033eac0152aada63ae112fde2243f97d95b1559abb171d284efe80625443faf5ebb0549d16baeccfa5d6f573ae8a474f049b5c1febbc640" },
	{ name: "指定 v10/H/mask3", text: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", version: 10, ecc: "H", mask: 3, size: 57,
		hex: "fe4a30c7b5673fc13a06473e50906e8b5d42eacacbb740b9b5a64625dba892d7f740d2ec1157bd1fe3f107faaaaaaaaaaafe01678cc4ebd30033c9babe6f8fe82e590027dbb6e8f5872b2386ad537a2c9f9448e51ea7be5edf5003504f0046670370633a2ea9d7aea9f080101690e0553c6ccf3d07c95b58ba64ddca4d6c6b8155b0118bf1f2badf1a04181e3e731a68fdda2ed83df886a93a15ab0ea7987cbe6c729d3f3ac7f2558f11ee7bfe697981750250092e58f7a630e3eff8afaab73e491109347363d1ecaa304eb6a59aae45343f10c6bc557e48b0ffbf2fede816787ee3e5919f159feca58277941da8bca6b040fc84587ccb29997731b6e655a514a77d85157cc358cd6083277e5067b9f99e8b7bc1f72103108393a126bca3031c59774b1a20f38fbd3a622d71ea8557657154d6ba619ae1be591cfd44635c7827784f584d88fb040e9fcdf1af2a9b97f1c6aa7576534a02bef4feaa34fc80597231a206c7bfb108eabf1f2a10419cd47ad3d1cba649cbef358fa5d40dc1e7a6bf8aeab845a6472e1904a111871866c9fe4049d24122a40" },
	{ name: "指定 v1/L/mask0", text: "1", version: 1, ecc: "L", mask: 0, size: 21,
		hex: "fe5bfc13906eb6bb74a5dba2aec10507faafe01b00eff6256f11bdda2393844334aa804aa7fbddb05bb8baf76dd011aeba2305446feaab8" },
];

export const ECC_VECTORS = [
	{ data: [64,20,16,236,17,236,17,236,17], ecLen: 17, ec: [170,217,174,249,235,169,98,236,62,144,27,172,10,106,24,191,143] },
	{ data: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], ecLen: 10, ec: [0,94,88,20,18,99,65,86,119,19] },
	{ data: [255,0,128,64,32,16,8,4,2,1], ecLen: 24, ec: [101,202,70,122,96,54,167,216,166,216,20,82,226,246,145,95,225,64,131,240,46,121,199,26] },
];