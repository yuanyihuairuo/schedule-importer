/* 把 template.html + core.js + ui.js 合成单个自包含 HTML 文件 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const tpl = fs.readFileSync(path.join(src, 'template.html'), 'utf8');
const core = fs.readFileSync(path.join(src, 'core.js'), 'utf8');
const ui = fs.readFileSync(path.join(src, 'ui.js'), 'utf8');

// 防止 JS 里出现 </script 提前闭合标签
const safe = s => s.replace(/<\/script/gi, '<\\/script');

let out = tpl.split('/*__CORE__*/').join(safe(core));
out = out.split('/*__UI__*/').join(safe(ui));

if (out.indexOf('/*__CORE__*/') >= 0 || out.indexOf('/*__UI__*/') >= 0) {
  console.error('❌ 占位符未被替换，检查 template.html');
  process.exit(1);
}

const outPath = path.join(dist, '课表导入器.html');
fs.writeFileSync(outPath, out, 'utf8');

const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
console.log('✅ 已生成 ' + outPath);
console.log('   体积 ' + kb + ' KB（零外部依赖，双击即可用）');
console.log('   位置 ' + outPath);
