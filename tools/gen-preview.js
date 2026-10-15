/* 生成「交互到指定步骤」的预览副本，用于无头截图（不改动原文件） */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'dist', '课表导入器.html'), 'utf8');

/* iPhone 15/16 Pro 的安全区（无头 Chrome 不会真给 env 值，这里手动喂进去） */
const IPHONE_INSETS = `
  var st = document.createElement('style');
  st.textContent = ':root{--sat:59px;--sab:34px}';
  document.head.appendChild(st);
`;

/* 无头截图的虚拟时钟不会推进 CSS 过渡，会拍到「过渡刚开始」的那一帧。
   截图前统一关掉动画，保证拍到的是最终态（真实浏览器不受影响）。 */
const FREEZE = `
  var fz = document.createElement('style');
  fz.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
  document.head.appendChild(fz);
`;

/* 把 @media (prefers-color-scheme:dark) 里的令牌块原地展开成无条件生效，
   这样无头截图能看到深色皮肤（源文件里仍然只有一份深色定义） */
function toDark(src) {
  return src.replace(
    /@media \(prefers-color-scheme:dark\)\{\s*:root\{([\s\S]*?)\n  \}\n\}/,
    (m, inner) => ':root{color-scheme:dark;' + inner + '\n}'
  );
}

/* 进入第 2 步：解析示例课表 */
const toStep2 = `
  document.getElementById('btnSample').click();
`;

/* 进入第 3 步：再点下一步 */
const toStep3 = toStep2 + `
  setTimeout(function () {
    document.getElementById('btnToStep3').click();
    document.getElementById('btnQuickNational').click();
  }, 260);
`;

/* 进入第 4 步：填好放大与补课，再导出 */
const toStep4 = toStep2 + `
  setTimeout(function () {
    document.getElementById('btnToStep3').click();
    setTimeout(function () {
      document.getElementById('btnQuickNational').click();
      document.getElementById('btnAddMakeup').click();
      setTimeout(function () {
        document.getElementById('btnToStep4').click();
      }, 200);
    }, 200);
  }, 260);
`;

/* 只留「上下课时间」卡片，便于聚焦截图 */
const toSlots = `
  var cards = document.querySelectorAll('#panel1 > .card');
  if (cards[0]) cards[0].style.display = 'none';
  if (cards[2]) cards[2].style.display = 'none';
`;

/* 只留「课表来源」卡片并展开模板说明 */
const toTemplate = `
  document.getElementById('tplHelp').open = true;
  var cards = document.querySelectorAll('#panel1 > .card');
  if (cards[0]) cards[0].style.display = 'none';
  if (cards[1]) cards[1].style.display = 'none';
`;

/* 只留「课表来源」卡片，文本框保持空的 —— 看空状态下的示例表格 */
const toPaste = `
  var cards = document.querySelectorAll('#panel1 > .card');
  if (cards[0]) cards[0].style.display = 'none';
  if (cards[1]) cards[1].style.display = 'none';
`;

/* 模板说明切到「格式二 · 课程表矩阵」 */
const toTemplate2 = toTemplate + `
  setTimeout(function () {
    document.querySelector('[data-tpltab="matrix"]').click();
  }, 80);
`;

/* 模板说明切到「格式三 · 课程信息卡片」 */
const toTemplate3 = toTemplate + `
  setTimeout(function () {
    document.querySelector('[data-tpltab="card"]').click();
  }, 80);
`;

/* 用「课程信息卡片」跑通全流程，看第 2 步（核对课程） */
const CARD_TEXT = [
  '课程:高等数学（A班）',
  '班级:高等数学（A班）3',
  '(教一301)',
  '5,9,13周 星期四 中午2-6节',
  '主讲教师:张老师',
  '',
  '课程:数据结构',
  '班级:数据结构 17',
  '(A302)',
  '3-18周 星期三 中午2,5,6节',
  '主讲教师:张三'
].join('\n');

const toCard2 = `
  var sel = document.getElementById('slotPreset');
  sel.value = 'noon13';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  setTimeout(function () {
    document.getElementById('pasteText').value = ${JSON.stringify(CARD_TEXT)};
    document.getElementById('btnParse').click();
  }, 260);
`;

/* 卡片格式一路到第 4 步，看事件表里的周次 */
const toCard4 = toCard2 + `
  setTimeout(function () {
    document.getElementById('btnToStep3').click();
    setTimeout(function () {
      document.getElementById('btnToStep4').click();
    }, 220);
  }, 800);
`;

/* 切到「11 节 + 中午 2 节」这套真实作息，展示具名节次 */
const toNoon = toSlots + `
  var sel = document.getElementById('slotPreset');
  sel.value = 'noon13';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
`;

/* 作息表粘贴识别：填好文本、展开、点识别 */
const BELL_TEXT = [
  '上午:\t下午:\t晚上:',
  '第1节课 8:00–8:50\t第5节课 14:30–15:20\t第9节课 19:00–19:50',
  '第2节课 8:55–9:45\t第6节课 15:25–16:15\t第10节课 19:55–20:45',
  '中午第1节课 12:05–12:55\t中午第2节课 13:35–14:25'
].join('\n');

const REAL_TABLE = [
  '课程名称\t教师\t周次\t星期\t节次\t教室',
  '高等数学\t张老师\t13周\t周四\t中午2-6\t教一301',
  '数据结构\t陈老师\t3-18周\t周一\t中午2-6\t计算中心A302',
  '大学英语\t李老师\t3-18周\t周二\t3-4\t教二205',
  '大学物理实验\t刘老师\t3-18周\t周四\t11\t实验楼B203'
].join('\n');

const toBell = toNoon + `
  setTimeout(function () {
    document.getElementById('bellText').value = ${JSON.stringify(BELL_TEXT)};
    document.querySelector('details.bell').open = true;
    document.getElementById('btnParseBell').click();
  }, 200);
`;

/* 用真实课表的形态解析，看课程表与连堂预览 */
const toReal = `
  var sel = document.getElementById('slotPreset');
  sel.value = 'noon13';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  setTimeout(function () {
    document.getElementById('pasteText').value = ${JSON.stringify(REAL_TABLE)};
    document.getElementById('btnParse').click();
  }, 260);
`;

/* 单双周：看事件表里是怎么摊开的 */
const ODD_EVEN_TABLE = [
  '课程名称\t教师\t周次\t星期\t节次\t教室',
  '高等数学\t张老师\t1-16周(单)\t周一\t1-2\t教一301',
  '大学英语\t王老师\t1-16周(双)\t周二\t3-4\t教二205',
  '体育\t赵老师\t单双周\t周五\t7-8\t操场'
].join('\n');

const toOddEven4 = `
  setTimeout(function () {
    document.getElementById('pasteText').value = ${JSON.stringify(ODD_EVEN_TABLE)};
    document.getElementById('btnParse').click();
    setTimeout(function () {
      document.getElementById('btnToStep3').click();
      setTimeout(function () {
        document.getElementById('btnToStep4').click();
      }, 220);
    }, 320);
  }, 240);
`;

/* 只留「学期」卡片，看单双周基准那项 */
const toBasis = `
  var cards = document.querySelectorAll('#panel1 > .card');
  if (cards[1]) cards[1].style.display = 'none';
  if (cards[2]) cards[2].style.display = 'none';
`;

/* ── 手机端（393pt，模拟 iPhone 安全区）── */
const toPhone2 = IPHONE_INSETS + toStep2;
const toPhone3 = IPHONE_INSETS + toStep3;
const toPhone4 = IPHONE_INSETS + toStep4;
const toPhone1 = IPHONE_INSETS + toSlots;
const toPhonePaste = IPHONE_INSETS + toPaste;

/* ── 深色模式 ── */
const toDark4 = toDark(html);

const jobs = [
  ['preview-noon.html', toNoon],
  ['preview-bell.html', toBell],
  ['preview-real.html', toReal],
  ['preview-step2.html', toStep2],
  ['preview-step3.html', toStep3],
  ['preview-step4.html', toStep4],
  ['preview-slots.html', toSlots],
  ['preview-template.html', toTemplate],
  ['preview-template2.html', toTemplate2],
  ['preview-template3.html', toTemplate3],
  ['preview-card2.html', toCard2],
  ['preview-card4.html', toCard4],
  ['preview-oddeven.html', toOddEven4],
  ['preview-basis.html', toBasis],
  ['preview-phone1.html', toPhone1],
  ['preview-phone2.html', toPhone2],
  ['preview-phone3.html', toPhone3],
  ['preview-phone4.html', toPhone4],
  ['preview-paste.html', toPaste],
  ['preview-phonepaste.html', toPhonePaste]
];

for (const [file, code] of jobs) {
  const injected = '<script>\nwindow.addEventListener("load", function () {\n'
    + 'setTimeout(function () {\n' + FREEZE + code + '\n}, 120);\n});\n</' + 'script>'
    + '\n</body>';
  const out = html.replace('</body>', injected);
  fs.writeFileSync(path.join('/tmp', file), out, 'utf8');
  console.log('已生成 /tmp/' + file);
}

/* 深色模式：整份替换，再挂上同样的交互脚本 */
{
  const out = toDark4.replace('</body>',
    '<script>\nwindow.addEventListener("load", function () {\n'
    + 'setTimeout(function () {\n' + FREEZE + toPhone4 + '\n}, 120);\n});\n</' + 'script>\n</body>');
  fs.writeFileSync(path.join('/tmp', 'preview-dark4.html'), out, 'utf8');
  console.log('已生成 /tmp/preview-dark4.html（深色）');
}
