#!/usr/bin/env node
/*
 * 生成「课表模板」示例文件（docs/课表模板-示例.xlsx）。
 *
 * 这个 xlsx 是用 core.js 里的 buildXlsx 自己写出来的 —— 不是从磁盘拷的，
 * 所以模板长什么样、和解析器能不能吃下，永远是同一份真相。
 * 想改模板就改 src/core.js 里的 TEMPLATES，然后重跑本脚本。
 */

const fs = require('fs');
const path = require('path');
const Core = require('../src/core.js');

const OUT = path.join(__dirname, '..', 'docs', '课表模板-示例.xlsx');

(async function main() {
  const sheets = Core.buildTemplateSheets();
  const bytes = await Core.buildXlsx(sheets);

  // 自检：写完立刻用自家解析器读回来，确认它能被正常识别
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const back = await Core.parseXlsxBuffer(ab, 16, {});

  fs.writeFileSync(OUT, bytes);
  console.log('✅ ' + OUT);
  console.log('   %d 字节 · %d 张工作表 · 回读解析出 %d 门课（工作表：%s）',
    bytes.length, back.sheetCount, back.courses.length, back.sheetName);
  if (!back.courses.length) {
    console.error('❌ 回读没解析出课程，模板与解析器不一致');
    process.exit(1);
  }
})().catch(e => {
  console.error('❌ ' + e.message);
  process.exit(1);
});