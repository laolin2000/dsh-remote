// 黄金向量：由参考实现（npm 的 qrcode 包）生成，只用于本测试，不是运行时依赖。
// 生成方式见文件末尾注释；矩阵按「行优先、每 4 位一个十六进制字符」打包。
export const VECTORS = [
	{ name: "短文本(自动版本/纠错)", text: "A", version: 1, ecc: "M", mask: "auto", size: 21,
		hex: "fe93fc17d06e8abb75b5dba72ec12d07faafe01b00b73a5acaf233b41b6827c9e492005927fa65105836ba6f8dd79faeaac1044a5fe8480" },
	{ name: "普通文本", text: "hello dsh", version: 1, ecc: "M", mask: "auto", size: 21,
		hex: "fe6bfc11906ebabb75f5dba8aec17907faafe01400be33e622c76e8b9d61face68a08045e7f840d05c2eba910dd4fe2eaac904bdcfec890" },
	{ name: "真实手机链接", text: "https://crafts-jennifer-examines-dad.trycloudflare.com/?t=7KYQzRfaE3bFp3dT_1E5bAXJNHRgWZkhaKobg2pEm3Q", version: 6, ecc: "M", mask: "auto", size: 41,
		hex: "fecbd125bfc16b11f4106e88f650cbb757401e85dba401ebd2ec1229e02d07faaaaaaafe01ffc30d00b749f41725e655ba84d590cf6bd980d487d07c1315bc5cbf717e6cda45c925fa14e214c3017b085678a345abd709eace8ca3e930892a3eb381b09d609e67ef8900632cc450db5fdf19c3a60344ba4b41f39387a1cafc101c77ba7ccb80c2f63bf97d2601817785bfb2f435c34d84d69fb258d1db7b90209fa26a5f7faaa8ffff0071fb85c7ffbd48592b5050f93a511ba641c78ffdd56a86e866eac3f2265f04b30a315afeacee43c30" },
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