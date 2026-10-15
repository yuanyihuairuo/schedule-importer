/* 课表导入器 · 单文件页面行为测试（jsdom，跑真实交互路径） */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'dist', '课表导入器.html');

let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; failures.push(label + '\n      期望: ' + e + '\n      实际: ' + a); }
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log('\n── ' + t); }

/* jsdom 未实现但无害的报错 */
const BENIGN = [
  /Not implemented: navigation/,
  /Not implemented: window\.scrollTo/,
  /Could not parse CSS/,
  /Not implemented: HTMLCanvasElement/
];

const problems = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  const m = String((e.detail && e.detail.stack) || e.message || e);
  if (BENIGN.some(r => r.test(m))) return;
  problems.push('JSDOM_ERR: ' + m);
});
vc.on('error', function () {
  const m = Array.prototype.join.call(arguments, ' ');
  if (BENIGN.some(r => r.test(m))) return;
  problems.push('CONSOLE_ERR: ' + m);
});
vc.on('warn', function () {});

const dom = new JSDOM(fs.readFileSync(HTML_PATH, 'utf8'), {
  runScripts: 'dangerously',
  url: 'http://localhost/',
  pretendToBeVisual: true,
  virtualConsole: vc
});
const win = dom.window;
const doc = win.document;
const RAW = fs.readFileSync(HTML_PATH, 'utf8');   // 源码原文，用于查不容易从 DOM 断言的标记
const HEAD = doc.head.innerHTML;

/* jsdom 缺失能力的最小补齐 */
let capturedICS = null;     // 文本类下载（.ics / .csv）
let capturedBytes = null;   // 二进制下载（.xlsx）
win.confirm = () => true;
win.alert = () => {};
win.scrollTo = () => {};
win.URL.createObjectURL = () => 'blob:mock';
win.URL.revokeObjectURL = () => {};

// jsdom 没有流的压缩 API，注入 Node 的实现（Node 22 自带）
win.CompressionStream = CompressionStream;
win.DecompressionStream = DecompressionStream;
win.Response = Response;

// 用 Node 的 Blob（它有 .stream()），同时把内容捕获下来做断言
const NodeBlob = Blob;
win.Blob = function (parts, opts) {
  const first = parts && parts[0];
  if (typeof first === 'string') {
    capturedICS = parts.map(String).join('');
    capturedBytes = null;
  } else {
    capturedBytes = first;
    capturedICS = null;
  }
  return new NodeBlob(parts, opts);
};

const $ = s => doc.querySelector(s);
const $$ = s => Array.prototype.slice.call(doc.querySelectorAll(s));
const txt = el => (el && el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const cell = (tr, k) => tr.querySelector('[data-k="' + k + '"]');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 触发一次下载并把捕获到的 .ics 文本取出来 */
function icsTextForTest() {
  capturedICS = null;
  $('#btnDownload').click();
  return capturedICS || '';
}

(async function run() {

  await sleep(120);   // 等 DOMContentLoaded + init()

  /* ============================================================ */
  section('1. 页面初始化');

  eq(typeof win.Core, 'object', '内核已挂载到 window.Core');
  eq(typeof win.Core.buildICS, 'function', '核心 API 可用');
  eq($('#panel1').hidden, false, '默认显示第 1 步');
  eq($('#panel2').hidden, true, '第 2 步隐藏');
  eq($('#panel3').hidden, true, '第 3 步隐藏');
  eq($('#panel4').hidden, true, '第 4 步隐藏');
  ok($('#semName').value.length > 0, '学期名有默认值');
  ok(/^\d{4}-\d{2}-\d{2}$/.test($('#semStart').value), '开学日期格式正确');
  ok(+$('#semWeeks').value >= 1, '总周数有默认值');
  eq($('#semTZ').value, '480', '默认时区 UTC+8');

  const semStart = win.Core.parseISODate($('#semStart').value);
  eq(win.Core.wallDowIso(semStart), 1, '默认开学日落在周一');
  ok(txt($('#semInfo')).indexOf('第 1 周周一') >= 0, '学期信息已渲染');
  ok($('#btnDownload').disabled, '未解析前下载按钮不可用');

  /* ============================================================ */
  section('2. 模板帮助（首次使用最容易卡住的地方）');

  const tplHelp = $('#tplHelp');
  ok(tplHelp, '模板帮助区存在');
  eq(tplHelp.open, false, '默认折叠，不占版面');
  ok(tplHelp.querySelectorAll('[data-tpl]').length >= 4, '提供多个模板入口');

  // 「填入粘贴框」
  tplHelp.querySelector('[data-tpl="fill"]').click();
  await sleep(100);
  ok($('#pasteText').value.indexOf('课程名称') >= 0, '★「填入粘贴框」把模板写进了文本框');
  ok($('#pasteText').value.indexOf('高等数学') >= 0, '模板含示例课程');

  $('#btnParse').click();
  await sleep(150);
  eq($('#panel2').hidden, false, '★ 模板内容能被直接解析成功');
  eq($$('#courseBody tr').length, 4, '模板的 4 行示例全部解析出来');
  eq(cell($$('#courseBody tr')[0], 'name').value, '高等数学', '模板第一行课程名正确');

  // CSV 模板
  $('#btnBack2').click();
  await sleep(100);
  capturedICS = null; capturedBytes = null;
  tplHelp.querySelector('[data-tpl="csv"]').click();
  await sleep(150);
  ok(capturedICS && capturedICS.length > 0, 'CSV 模板已生成');
  eq(capturedICS.charCodeAt(0), 0xFEFF, '★ CSV 带 UTF-8 BOM（Excel 打开中文不乱码）');
  ok(capturedICS.indexOf('课程名称,教师,周次,星期,节次,教室') >= 0, 'CSV 含表头');
  ok(capturedICS.indexOf('高等数学,张老师,1-16周,周一,1-2,教一301') >= 0, 'CSV 含示例行');
  ok(capturedICS.indexOf('# 周次写法') >= 0, 'CSV 含填写说明');

  // TSV 模板
  capturedICS = null; capturedBytes = null;
  tplHelp.querySelector('[data-tpl="tsv"]').click();
  await sleep(150);
  ok(capturedICS && capturedICS.indexOf('课程名称\t教师') >= 0, 'TSV 模板用制表符分隔');

  // Excel 模板
  capturedICS = null; capturedBytes = null;
  tplHelp.querySelector('[data-tpl="xlsx"]').click();
  await sleep(500);
  ok(capturedBytes && capturedBytes.length > 1000,
     'xlsx 模板已生成（' + (capturedBytes ? capturedBytes.length : 0) + ' 字节）');
  if (capturedBytes) {
    eq(capturedBytes[0], 0x50, 'xlsx 以 ZIP 魔数 P 开头');
    eq(capturedBytes[1], 0x4B, 'xlsx 以 ZIP 魔数 K 开头');
  }
  ok(txt($('#step1Msg')).indexOf('已下载') >= 0, '下载后给出使用提示');
  ok(txt($('#step1Msg')).indexOf('上下课时间') >= 0,
     '★ 模板下载提示里点明「节次对应几点由上下课时间决定」');

  $('#btnClear').click();
  await sleep(80);

  /* ============================================================ */
  section('2b. 上下课时间（作息表）');

  const fire = (el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true }));
  const slotIn = (i, k) => doc.querySelector('#slotEditor input[data-slot="' + i + '"][data-k="' + k + '"]');

  ok($('#slotEditor'), '作息表编辑器存在');
  eq($$('#slotEditor .slot-item').length, 12, '默认渲染出 12 节');
  eq($$('#slotEditor .slot-grp-h').map(txt), ['上午', '下午', '晚上'], '按上午 / 下午 / 晚上分组');
  eq(txt($('#slotCount')), '12 节', '节数徽标');
  eq(slotIn(1, 'start').value, '08:00', '第 1 节默认 08:00 开始');
  eq(slotIn(1, 'end').value, '08:45', '第 1 节默认 08:45 结束');
  eq($('#slotPreset').value, 'std12', '下拉框回显「标准 12 节」');

  // 上一段刚解析过模板课表，所以这里预览的是课表里真实出现的节次组合
  const pvOf = () => {
    const m = {};
    $$('#slotPreview .sp-row').map(txt).forEach(t => {
      const k = (t.match(/^([\d,\-、一-鿿]+) 节/) || [])[1];
      if (k) m[k] = t;
    });
    return m;
  };
  ok(txt($('#slotPreview')).indexOf('实际出现的节次') >= 0, '预览用的是课表里真实出现的节次组合');
  // 预览左边的写法改成「区间文本」（1-2 / 中午2-6），与课表里的写法一致
  let pv = pvOf();
  ok(pv['1-2'] && pv['1-2'].indexOf('1 个事件') >= 0, 'gap 模式：1,2 节 -> 1 个事件');
  ok(pv['1-2'] && pv['1-2'].indexOf('08:00–09:35') >= 0, '1,2 节合并跨度 08:00–09:35');
  ok(pv['2-3'] && pv['2-3'].indexOf('2 个事件') >= 0, '★ gap 模式：2,3 节 -> 2 个事件（中间夹大课间）');
  ok(pv['2-3'] && pv['2-3'].indexOf('08:50–09:35') >= 0 && pv['2-3'].indexOf('10:00–10:45') >= 0,
     '★ 拆出的两个事件时间正确');

  /* --- 连堂策略：keep --- */
  $('#joinMode').value = 'keep';
  fire($('#joinMode'), 'change');
  await sleep(60);
  pv = pvOf();
  ok(pv['2-3'] && pv['2-3'].indexOf('1 个事件') >= 0, '★ keep 模式：2,3 节并成 1 个事件');
  ok(pv['2-3'] && pv['2-3'].indexOf('08:50–10:45') >= 0, '★ keep 模式事件跨度 08:50–10:45（含课间）');
  ok(txt($('#slotPreview')).indexOf('合并成一个事件') >= 0, '说明文案随之切换');
  eq($('#maxBreak').disabled, true, 'keep 模式下「课间阈值」置灰（不生效）');

  /* --- 连堂策略：split --- */
  $('#joinMode').value = 'split';
  fire($('#joinMode'), 'change');
  await sleep(60);
  pv = pvOf();
  ok(pv['1-2'] && pv['1-2'].indexOf('2 个事件') >= 0, 'split 模式：1,2 节 -> 2 个事件');
  ok(pv['2-3'] && pv['2-3'].indexOf('2 个事件') >= 0, 'split 模式：2,3 节 -> 2 个事件');

  /* --- 回到 gap --- */
  $('#joinMode').value = 'gap';
  fire($('#joinMode'), 'change');
  await sleep(60);
  eq($('#maxBreak').disabled, false, 'gap 模式下「课间阈值」可用');

  /* --- 改单节时间 --- */
  const s1 = slotIn(1, 'start');
  s1.value = '07:30';
  fire(s1, 'change');
  await sleep(60);
  eq(slotIn(1, 'start').value, '07:30', '★ 第 1 节开始时间改成 07:30 生效');
  eq(slotIn(1, 'end').value, '08:45', '同节结束时间未受影响');
  ok(txt($('#slotPreview')).indexOf('07:30') >= 0, '预览时间跟着更新');

  /* --- 非法时间被拒绝 --- */
  const s1bad = slotIn(1, 'start');
  s1bad.value = '10:00';          // 晚于 08:45 的结束时间
  fire(s1bad, 'change');
  await sleep(60);
  eq(slotIn(1, 'start').value, '07:30', '★ 结束早于开始的改动被拒绝并还原');
  ok(txt($('#slotPreview')).indexOf('要晚于开始时间') >= 0, '给出可操作的提示文案');

  /* --- 切换预设 --- */
  $('#slotPreset').value = 'compact10';
  fire($('#slotPreset'), 'change');
  await sleep(60);
  eq($$('#slotEditor .slot-item').length, 10, '★ 切到「紧凑 10 节」-> 10 节');
  eq(txt($('#slotCount')), '10 节', '节数徽标同步');
  eq(slotIn(1, 'start').value, '08:00', '预设第 1 节 08:00');
  eq(slotIn(5, 'start').value, '13:30', '预设第 5 节 13:30（下午界限不同）');

  /* --- 删除一节 --- */
  $$('#slotEditor [data-del]')[4].click();
  await sleep(60);
  eq($$('#slotEditor .slot-item').length, 9, '★ 删除一节 -> 9 节');
  eq(slotIn(5, 'start'), null, '被删的第 5 节已从界面移除');

  /* --- 添加一节 --- */
  $('#btnAddSlot').click();
  await sleep(60);
  eq($$('#slotEditor .slot-item').length, 10, '添加一节 -> 10 节');

  /* --- 按「每节时长 + 课间」重排 --- */
  $('#slotDur').value = '50';
  $('#slotGap').value = '10';
  $('#btnRegenSlots').click();
  await sleep(60);
  eq(slotIn(1, 'end').value, '08:50', '★ 重排：每节 50 分钟 -> 第 1 节 08:00–08:50');
  eq(slotIn(2, 'start').value, '09:00', '★ 重排：课间 10 分钟 -> 第 2 节 09:00 开始');
  eq(slotIn(4, 'end').value, '11:50', '上午第 4 节结束 11:50（08:00 起顺推 4 节）');

  /* --- 持久化 --- */
  const savedRaw = win.localStorage.getItem('schedule-importer.slots.v1');
  ok(savedRaw, '★ 作息表已写入 localStorage');
  const savedObj = JSON.parse(savedRaw);
  eq(savedObj.v, 2, '存储格式带版本号（v2 = 节次可具名）');
  eq(savedObj.rows.length, 10, '存储的节数与界面一致');
  eq(savedObj.joinMode, 'gap', '存储了连堂策略');

  /* --- 恢复默认，避免影响后续断言 --- */
  $('#btnResetSlots').click();
  await sleep(60);
  eq($$('#slotEditor .slot-item').length, 12, '恢复默认 -> 12 节');
  eq(slotIn(1, 'start').value, '08:00', '恢复默认后第 1 节 08:00');
  eq($('#joinMode').value, 'gap', '恢复默认连堂策略');
  ok(txt($('#slotPreview')).indexOf('08:00–09:35') >= 0, '预览已回到标准作息');

  /* ============================================================ */
  section('3. 载入示例 → 解析 → 跳转到第 2 步');

  $('#btnSample').click();
  await sleep(80);

  eq($('#panel2').hidden, false, '解析成功后进入第 2 步');
  eq($('#panel1').hidden, true, '第 1 步隐藏');
  eq($$('#courseBody tr').length, 7, '示例课表解析出 7 个上课时段（7 门课）');
  ok(txt($('#courseCount')).indexOf('7 门') >= 0, '课程计数显示 7 门');

  let rows = $$('#courseBody tr');
  eq(cell(rows[0], 'name').value, '高等数学', '第 1 行课程名');
  eq(cell(rows[0], 'teacher').value, '张老师', '第 1 行教师');
  eq(cell(rows[0], 'room').value, '教一301', '第 1 行地点');
  eq(cell(rows[0], 'weekday').value, '1', '第 1 行星期 = 周一');
  eq(cell(rows[0], 'slots').value, '1-2', '第 1 行节次');
  eq(cell(rows[0], 'weeks').value, '1-16周', '第 1 行周次原文');

  eq(cell(rows[1], 'name').value, '线性代数', '第 2 行是线性代数');
  eq(cell(rows[1], 'weeks').value, '1-16周(单)', '单周课的原文被保留');
  eq(cell(rows[2], 'weeks').value, '1-16周(双)', '双周课的原文被保留');
  eq(cell(rows[3], 'slots').value, '2-3', '数据结构为 2-3 节（跨课间）');
  eq(cell(rows[6], 'name').value, '体育', '最后一行是体育');

  ok(txt($('#parseWarnings')).indexOf('没有发现问题') >= 0,
     '干净输入不产生警告');

  /* ============================================================ */
  section('3b. 作息表 ↔ 课表联动');

  $$('#steps .step')[0].click();
  await sleep(80);
  ok(txt($('#slotPreview')).indexOf('实际出现的节次') >= 0,
     '★ 解析过课表后，预览改用课表里真实出现的节次');
  const linkedRows = $$('#slotPreview .sp-row').map(txt);
  ok(linkedRows.length >= 1 && linkedRows.length <= 6, '预览条数受控（最多 6 条）');
  ok(linkedRows.some(t => t.indexOf('2-3 节') >= 0), '★ 预览里出现了数据结构用到的 2,3 节');

  // 切到 keep：数据结构 [2,3] 应从 2 个事件并成 1 个
  $('#joinMode').value = 'keep';
  fire($('#joinMode'), 'change');
  await sleep(60);
  const dsRow = $$('#slotPreview .sp-row').map(txt).filter(t => t.indexOf('2-3 节') >= 0)[0];
  ok(dsRow && dsRow.indexOf('1 个事件') >= 0, '★ keep 模式下 2,3 节并成 1 个事件');
  ok(dsRow && dsRow.indexOf('08:50–10:45') >= 0, '★ 合并后跨度 08:50–10:45');

  // 复位，后面的导出断言依赖标准作息
  $('#joinMode').value = 'gap';
  fire($('#joinMode'), 'change');
  await sleep(60);
  $$('#steps .step')[1].click();
  await sleep(80);

  section('4. 冲突检测');
  ok(txt($('#conflictBox')).indexOf('没有检测到课内冲突') >= 0,
     '★ 线性代数(单周) 与 大学英语(双周) 时间重叠但周次不相交 → 不误报');

  /* ============================================================ */
  section('5. 编辑课程（真实键盘输入路径）');

  const nameEl = cell($$('#courseBody tr')[0], 'name');
  nameEl.value = '高等数学 A';
  nameEl.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(300);
  eq(cell($$('#courseBody tr')[0], 'name').value, '高等数学 A', '编辑后值保留在输入框');

  const badWeek = cell($$('#courseBody tr')[0], 'weeks');
  badWeek.value = '张三';
  badWeek.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(300);
  ok(badWeek.style.borderColor.length > 0, '★ 无法解析的周次被标红');
  badWeek.value = '1-16周';
  badWeek.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(300);
  eq(badWeek.style.borderColor, '', '改回合法周次后标红撤销');

  // 删除一行
  const beforeDel = $$('#courseBody tr').length;
  $$('#courseBody tr')[6].querySelector('[data-del]').click();
  await sleep(120);
  eq($$('#courseBody tr').length, beforeDel - 1, '删除按钮移除一行');

  // 加回来（用「手动添加一行」按钮）
  $('#btnAddRow').click();
  await sleep(120);
  eq($$('#courseBody tr').length, beforeDel, '手动添加一行恢复数量');

  /* ============================================================ */
  section('6. 放假与补课（第 3 步）');

  $('#btnToStep3').click();
  await sleep(80);
  eq($('#panel3').hidden, false, '进入第 3 步');
  ok(txt($('#holidayList')).indexOf('还没有添加放假日') >= 0, '初始无放假');

  $('#btnQuickNational').click();
  await sleep(120);
  eq($$('#holidayList .rule-row').length, 7, '国庆 7 天已添加');
  const h0 = $$('#holidayList .rule-row')[0];
  const year = semStart.getUTCFullYear();
  eq(h0.querySelector('[data-k="date"]').value, year + '-10-01', '国庆首日日期正确');
  eq(h0.querySelector('[data-k="name"]').value, '国庆节', '国庆名称已填');

  // 手工添加一个放假日并改名字
  $('#btnAddHoliday').click();
  await sleep(100);
  eq($$('#holidayList .rule-row').length, 8, '手动新增一个放假日');

  // 删除
  $$('#holidayList .rule-row')[7].querySelector('[data-hdel]').click();
  await sleep(100);
  eq($$('#holidayList .rule-row').length, 7, '删除放假日生效');

  ok(txt($('#makeupList')).indexOf('还没有补课') >= 0, '初始无补课');
  $('#btnAddMakeup').click();
  await sleep(120);
  eq($$('#makeupList .rule-row').length, 1, '添加一条补课');

  /* ============================================================ */
  section('7. 导出（第 4 步）');

  $('#btnToStep4').click();
  await sleep(400);
  eq($('#panel4').hidden, false, '进入第 4 步');

  let evRows = $$('#eventBody tr');
  eq(evRows.length, 9, '★ 共 9 个事件（7 个时段 + 数据结构拆成两块 + 1 次补课）');
  eq(txt($('#eventCount')), '9 个事件', '事件计数与行数一致');
  ok(txt($('#statsBox')).indexOf('课次合计') >= 0, '统计卡片含课次合计');
  ok(txt($('#statsBox')).indexOf('排除的日期') >= 0, '统计卡片含排除日期');

  const allEvents = txt($('#eventBody'));
  ok(allEvents.indexOf('高等数学 A') >= 0, '编辑过的课程名出现在事件表');
  ok(/每周 ×\d+/.test(allEvents), '含「每周 ×N」的重复规则描述');
  ok(/排除 \d+/.test(allEvents), '★ 含「排除 N」— 国庆用 EXDATE 表达而非断成多段');

  // 点下载，捕获真实生成的 ics 文本
  capturedICS = null;
  $('#btnDownload').click();
  await sleep(120);
  ok(capturedICS && capturedICS.length > 0, '点击下载后生成 .ics 内容');
  ok($('#btnDownload').disabled === false, '下载按钮已启用');

  if (capturedICS) {
    const ics = capturedICS;
    ok(ics.indexOf('BEGIN:VCALENDAR') === 0, '以 BEGIN:VCALENDAR 开头');
    ok(/\r\nEND:VCALENDAR\r\n$/.test(ics), '以 END:VCALENDAR 结尾，CRLF 换行');
    ok(ics.indexOf('VERSION:2.0') >= 0, '含 VERSION:2.0');
    ok(ics.indexOf('X-WR-CALNAME:') >= 0, '含日历名');

    const nVE = (ics.match(/BEGIN:VEVENT/g) || []).length;
    const nEnd = (ics.match(/END:VEVENT/g) || []).length;
    eq(nVE, 9, 'ics 中 VEVENT 数量 = 9');
    eq(nVE, nEnd, 'VEVENT 开闭配对');

    ok(/RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=\d+/.test(ics), 'RRULE 格式正确');
    ok(/RRULE:FREQ=WEEKLY;INTERVAL=2/.test(ics), '★ 单/双周课用 INTERVAL=2');
    ok(/\r\nEXDATE:/.test(ics), '★ 含 EXDATE —— 国庆假期用例外日期表达');
    ok(/UID:[0-9a-f-]{36}@schedule-importer/.test(ics), 'UID 格式正确');
    ok(ics.indexOf('SUMMARY:高等数学 A') >= 0, '中文课程名正确写入');
    ok(/DTSTART:\d{8}T000000Z/.test(ics), '★ 北京时间 08:00 → UTC 00:00Z（免 VTIMEZONE）');
    ok(/TRIGGER:-PT10M/.test(ics), '含 10 分钟提醒');

    const over = ics.split('\r\n').filter(l => Buffer.byteLength(l, 'utf8') > 75);
    eq(over.length, 0, '★ 所有行 ≤75 字节（RFC 5545 折叠规则）');

    // 每个 VEVENT 字段完整
    const vs = ics.split('BEGIN:VEVENT').slice(1);
    ok(vs.every(v => /UID:/.test(v) && /DTSTAMP:/.test(v) && /DTSTART:/.test(v) && /SUMMARY:/.test(v)),
       '每个 VEVENT 都含 UID/DTSTAMP/DTSTART/SUMMARY');

    ok(txt($('#dlMsg')).indexOf('已下载') >= 0, '下载后有成功提示');
  }

  /* ============================================================ */
  section('8. 时区切换重算');

  $('#semTZ').value = '540';
  $('#semTZ').dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(420);
  capturedICS = null;
  $('#btnDownload').click();
  await sleep(120);
  ok(capturedICS && /DTSTART:20260906T230000Z/.test(capturedICS),
     '★ 切到 UTC+9 后，北京时间 09-07 08:00 → 09-06 23:00Z');

  $('#semTZ').value = '480';
  $('#semTZ').dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(420);

  /* ============================================================ */
  section('9. 事件样式设置');

  $('#reminder').value = '30';
  $('#reminder').dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(320);
  capturedICS = null;
  $('#btnDownload').click();
  await sleep(120);
  ok(capturedICS && /TRIGGER:-PT30M/.test(capturedICS), '提醒时间改为 30 分钟后生效');

  $('#useEmoji').checked = true;
  $('#useEmoji').dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(320);
  ok(txt($('#eventBody')).indexOf('📘') >= 0, '开启图标后标题前出现类型 emoji');

  $('#titleTpl').value = '{课程名} @{地点}';
  $('#titleTpl').dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(320);
  ok(txt($('#eventBody')).indexOf('@教一301') >= 0, '★ 标题模板变量 {地点} 生效');
  capturedICS = null;
  $('#btnDownload').click();
  await sleep(120);
  ok(capturedICS && /SUMMARY:.*@教一301/.test(capturedICS), '模板变化写入 ics');

  /* ============================================================ */
  section('9b. 改上下课时间 → 导出时间跟着变');

  $('#btnBack4').click();
  await sleep(80);
  $('#btnBack3').click();
  await sleep(80);
  $('#btnBack2').click();
  await sleep(80);
  eq($('#panel1').hidden, false, '回到第 1 步');

  // 第 1 节提前 15 分钟（08:00–08:45 → 07:45–08:45），保持与第 2 节的连堂关系不变
  slotIn(1, 'start').value = '07:45';
  fire(slotIn(1, 'start'), 'change');
  await sleep(80);
  eq(slotIn(1, 'start').value, '07:45', '第 1 节起始时间已改为 07:45');
  const pvAfter = $$('#slotPreview .sp-row').map(txt).filter(t => t.indexOf('1-2 节') >= 0)[0];
  ok(pvAfter && pvAfter.indexOf('07:45–09:35') >= 0, '★ 预览里 1,2 节合并块跟着变成 07:45–09:35');

  $$('.step')[3].click();
  await sleep(180);
  capturedICS = null;
  $('#btnDownload').click();
  await sleep(120);
  ok(capturedICS && /DTSTART:20260906T234500Z/.test(capturedICS),
     '★ 第 1 节 07:45（UTC+8）→ 导出 DTSTART 为 20260906T234500Z');

  // 恢复默认作息，避免影响后续断言
  $$('.step')[0].click();
  await sleep(80);
  $('#btnResetSlots').click();
  await sleep(80);
  eq(slotIn(1, 'start').value, '08:00', '作息表已恢复默认');

  /* ============================================================ */
  section('10. 导航与重新开始');

  $('#btnBack4').click();
  await sleep(80);
  eq($('#panel3').hidden, false, '返回第 3 步');
  $('#btnBack3').click();
  await sleep(80);
  eq($('#panel2').hidden, false, '返回第 2 步');
  $('#btnBack2').click();
  await sleep(80);
  eq($('#panel1').hidden, false, '返回第 1 步');

  // 步骤条点击
  $$('.step')[3].click();
  await sleep(120);
  eq($('#panel4').hidden, false, '点步骤条可跳到第 4 步');

  $('#btnRestart').click();
  await sleep(120);
  eq($('#panel1').hidden, false, '重新开始回到第 1 步');
  eq($('#pasteText').value, '', '粘贴框已清空');
  eq($$('.step.done').length, 0, '步骤进度已重置');

  /* ============================================================ */
  section('11. 空输入与错误处理');

  $('#btnParse').click();
  await sleep(80);
  ok(txt($('#step1Msg')).indexOf('先粘贴课表内容') >= 0, '空输入给出提示而不是崩溃');

  $('#pasteText').value = '这是一段完全不是课表的文字\n没有任何列';
  $('#btnParse').click();
  await sleep(120);
  ok(txt($('#step1Msg')).length > 0, '无效输入给出错误提示');
  ok($('#panel1').hidden === false, '无效输入时停留在第 1 步');

  /* ============================================================ */
  section('12. 具名节次（中午 / 早读）');

  // 切到「11 节 + 中午 2 节」这套真实作息
  $('#slotPreset').value = 'noon13';
  fire($('#slotPreset'), 'change');
  await sleep(80);
  eq($$('#slotEditor .slot-item').length, 13, '★ 含中午节次的预设 -> 13 节');
  eq($$('#slotEditor .slot-grp-h').map(txt), ['上午', '中午', '下午', '晚上'], '中午单独成一组');
  const noonIn = doc.querySelector('#slotEditor input[data-rename="中午2"]');
  ok(noonIn, '具名节次的名字是可编辑输入框');
  eq(noonIn.value, '中午2', '输入框回显节次名');
  eq(doc.querySelector('#slotEditor input[data-slot="中午2"][data-k="start"]').value, '13:35',
     '具名节次也能改时间');
  eq(doc.querySelector('#slotEditor input[data-slot="4"][data-k="end"]').value, '12:00',
     '数字节次仍按编号定位');

  // 粘一份用了中午节次的长表课表
  $('#semName').value = '2026 秋';
  fire($('#semName'), 'change');
  $('#semStart').value = '2026-09-07';
  fire($('#semStart'), 'change');
  $('#semWeeks').value = '16';
  fire($('#semWeeks'), 'change');
  $('#semTZ').value = '480';          // 第 8 节测过时区切换，这里显式定回 UTC+8
  fire($('#semTZ'), 'change');
  const paste3 = () => {
    $('#pasteText').value = [
      '课程名称\t教师\t周次\t星期\t节次\t教室',
      '高等数学\t张老师\t13周\t周四\t中午2-6\t教一301',
      '数据结构\t陈老师\t3-18周\t周一\t中午2-6\t计算中心A302',
      '大学英语\t李老师\t3-18周\t周二\t3-4\t教二205'
    ].join('\n');
    $('#btnParse').click();
  };
  paste3();
  await sleep(220);
  const cRows = $$('#courseBody tr');
  eq(cRows.length, 3, '解析出 3 个时段');
  eq(cell(cRows[0], 'slots').value, '中午2-6', '★ 「中午2-6」按位置展开成三节');
  eq(cell(cRows[2], 'slots').value, '3-4', '普通范围不受影响');
  const noonPv = $$('#slotPreview .sp-row').map(txt).filter(t => t.indexOf('中午2-6 节') >= 0)[0];
  ok(noonPv, '连堂预览里能看到中午那三节');
  ok(noonPv.indexOf('1 个事件') >= 0, '★ 中午2 + 5 + 6 课间各 5 分钟 -> 合成一次长课');
  ok(noonPv.indexOf('13:35–16:15') >= 0, '长课跨度 13:35–16:15');

  /* --- 一路走到 .ics --- */
  $('#btnToStep4').click();
  await sleep(320);
  const ics = icsTextForTest();
  ok(/DTSTART:\d{8}T053500Z/.test(ics), '★ 中午长课 DTSTART 13:35 -> 05:35:00Z');
  ok(/DTEND:\d{8}T081500Z/.test(ics), '★ 长课 DTEND 16:15 -> 08:15:00Z');
  const gongBlock = ics.split('BEGIN:VEVENT').filter(b => b.indexOf('高等数学') >= 0)[0] || '';
  ok(gongBlock.length > 0, '高等数学进了 .ics');
  ok(/COUNT=1/.test(gongBlock), '第 13 周那门课只有一次');
  ok(gongBlock.indexOf('RRULE') >= 0, '仍是一条重复规则（只是次数为 1）');
  $('#btnBack2') && $('#btnBack2').click();
  await sleep(80);

  /* --- 改节次名：课表里的引用要跟着走 --- */
  const renameNoon = doc.querySelector('#slotEditor input[data-rename="中午2"]');
  renameNoon.value = '午2';
  fire(renameNoon, 'change');
  await sleep(150);
  eq(cell($$('#courseBody tr')[0], 'slots').value, '午2-6', '★ 改节次名后课程表里的引用跟着变');
  ok(doc.querySelector('#slotEditor input[data-rename="午2"]'), '新名字出现在节次表里');

  /* --- 撞名保护 --- */
  const clash = doc.querySelector('#slotEditor input[data-rename="午2"]');
  clash.value = '5';
  fire(clash, 'change');
  await sleep(150);
  ok(doc.querySelector('#slotEditor input[data-rename="午2"]'), '★ 与已有节次撞名 -> 改名被拒绝并恢复');
  ok(txt($('#slotPreview')).indexOf('已经有叫') >= 0, '撞名给出可操作的提示');

  /* --- 空名与非法名 --- */
  const empty = doc.querySelector('#slotEditor input[data-rename="午2"]');
  empty.value = '   ';
  fire(empty, 'change');
  await sleep(150);
  ok(doc.querySelector('#slotEditor input[data-rename="午2"]'), '空名字被拒绝');

  /* --- 插入一节具名节次（中午1/中午2 已占用 -> 该给出 中午3）--- */
  // 注意：新节次会占住一个位置，「中午2-6」这类范围的含义跟着变，所以放在解析与导出之后再做
  const keysBefore = $$('#slotEditor input[data-rename]').map(i => i.dataset.rename);
  $('#btnAddNamedSlot').click();
  await sleep(120);
  const keysAfter = $$('#slotEditor input[data-rename]').map(i => i.dataset.rename);
  eq(keysAfter.length, keysBefore.length + 1, '「+ 中午/早读」插入一节');
  const added = keysAfter.filter(k => keysBefore.indexOf(k) < 0);
  eq(added.length, 1, '新节次只多出一个，且没占用已有名字');
  ok(/^中午\d+$/.test(added[0]), '★ 自动命名形如 中午N（实际得到 ' + added[0] + '）');
  ok(keysAfter.indexOf(added[0]) > keysAfter.indexOf('中午1'),
     '★ 排在已有中午节次之后，不是硬 append 到整张表末尾');

  /* --- 从课表底部的作息表整张替换 --- */
  $('#bellText').value = [
    '上午:\t下午:\t晚上:',
    '第1节课 8:00–8:50\t第5节课 14:30–15:20\t第9节课 19:00–19:50',
    '第2节课 8:55–9:45\t第6节课 15:25–16:15\t第10节课 19:55–20:45',
    '中午第1节课 12:05–12:55\t中午第2节课 13:35–14:25'
  ].join('\n');
  $('#btnParseBell').click();
  await sleep(180);
  ok(txt($('#bellMsg')).indexOf('识别出') >= 0, '作息表识别给出结果');
  ok(txt($('#bellMsg')).indexOf('中午1') >= 0, '结果里列出具名节次');
  eq($$('#slotEditor .slot-item').length, 8, '★ 整张作息表被替换成识别出来的 8 节');
  eq(doc.querySelector('#slotEditor input[data-slot="中午1"][data-k="start"]').value, '12:05',
     '「中午第1节课」这种写法被认成具名节次 中午1');
  ok(txt($('#step1Msg')).length >= 0, '页面没炸');

  // 作息表被换掉了，重新解析一次课表（引用中午2 而不是午2）
  paste3();
  await sleep(220);
  eq(cell($$('#courseBody tr')[0], 'slots').value, '中午2-6', '★ 识别出来的作息能直接喂给课表解析');
  $('#btnToStep4').click();
  await sleep(320);
  const ics2 = icsTextForTest();
  ok(/DTSTART:\d{8}T053500Z/.test(ics2), '★ 识别 + 解析 + 导出整条链路时间仍然正确');

  /* ============================================================ */
  section('13. 课程信息卡片（一行一个字段）');

  // 回第 1 步
  $('#btnBack4').click();
  await sleep(80);
  $('#btnBack3').click();
  await sleep(80);
  $('#btnBack2').click();
  await sleep(80);
  eq($('#panel1').hidden, false, '回到第 1 步');

  /* --- 模板说明里多了第三种格式 --- */
  eq($$('#tplTabs button').length, 3, '★ 模板说明有 3 种格式标签');
  $$('#tplTabs button')[2].click();
  await sleep(80);
  eq($('#tplpanel-card').hidden, false, '★ 切到「格式三 · 课程信息」');
  eq($('#tplpanel-long').hidden, true, '格式一面板收起');
  eq($('#tplpanel-matrix').hidden, true, '格式二面板收起');

  doc.querySelector('[data-tpl="card"]').click();
  await sleep(140);
  ok($('#pasteText').value.indexOf('课程:高等数学（A班）') >= 0,
     '★「填入粘贴框试试」把卡片示例写进文本框');
  ok($('#pasteText').value.indexOf('主讲教师:张老师') >= 0, '示例含教师行');

  /* --- 一键载入卡片示例并解析 --- */
  $('#btnSampleCard').click();
  await sleep(260);
  eq($('#panel2').hidden, false, '★ 卡片格式能直接解析并进入第 2 步');
  const kRows = $$('#courseBody tr');
  eq(kRows.length, 2, '两张卡片 -> 2 门课');
  eq(cell(kRows[0], 'name').value, '高等数学（A班）', '课程名');
  eq(cell(kRows[0], 'teacher').value, '张老师', '★ 教师来自「主讲教师:」前缀');
  eq(cell(kRows[0], 'room').value, '教一301', '★ 地点取 教一301，不是课程名里的「混合」');
  eq(cell(kRows[0], 'weekday').value, '4', '★ 星期四 -> 4');
  eq(cell(kRows[0], 'slots').value, '中午2-6', '★ 节次 中午2-6');
  eq(cell(kRows[0], 'weeks').value, '5,9,13周', '★ 周次框只留周次本身');
  eq(cell(kRows[1], 'name').value, '数据结构', '第二门课');
  eq(cell(kRows[1], 'slots').value, '中午2-6',
     '★ 逗号罗列的「中午2,5,6节」被识别成同样三节（界面按范围写法回显）');
  eq(cell(kRows[1], 'weeks').value, '3-18周', '第二门课周次');

  /* --- 一路走到 .ics --- */
  $('#btnToStep3').click();
  await sleep(140);
  $('#btnToStep4').click();
  await sleep(340);

  const cardIcs = icsTextForTest();
  const gong = cardIcs.split('BEGIN:VEVENT').filter(b => b.indexOf('高等数学') >= 0)[0] || '';
  ok(gong.length > 0, '高等数学进了 .ics');
  ok(/RRULE:FREQ=WEEKLY;INTERVAL=4;COUNT=3/.test(gong),
     '★ 5,9,13 周 -> 每 4 周一次、共 3 次（不是每周连排）');
  ok(/DTSTART:20261008T053500Z/.test(gong), '★ 首次课 2026-10-08 13:35（第 5 周周四）');
  ok(/DTEND:20261008T081500Z/.test(gong), '结束 16:15');

  /* --- 事件表要能直接看出是哪几周 --- */
  const evTxt = txt($('#eventBody'));
  ok(evTxt.indexOf('每 4 周 ×3') >= 0, '★ 事件表标出「每 4 周 ×3」');
  ok(evTxt.indexOf('5,9,13周') >= 0,
     '★ 事件表直接摊开「5,9,13周」，不用用户自己推算');

  /* --- 没设对应作息时，要说人话 --- */
  $('#btnBack4').click();
  await sleep(80);
  $('#btnBack3').click();
  await sleep(80);
  $('#btnBack2').click();
  await sleep(80);
  $('#slotPreset').value = 'std12';       // 换回没有「中午」的标准作息
  fire($('#slotPreset'), 'change');
  await sleep(140);
  $('#pasteText').value = [
    '课程:高等数学（A班）',
    '(教一301)',
    '5,9,13周 星期四 中午2-6节',
    '主讲教师:张老师'
  ].join('\n');
  $('#btnParse').click();
  await sleep(200);
  eq($('#panel1').hidden, false, '解析失败时停留在第 1 步');
  const errTxt = txt($('#step1Msg'));
  ok(errTxt.indexOf('课程信息') >= 0, '★ 提示里点明「这是课程信息卡片格式」');
  ok(errTxt.indexOf('中午') >= 0, '★ 点出「中午」这一节在当前作息表里没有');
  ok(errTxt.indexOf('星期空无法识别') < 0,
     '★ 不再冒出「星期空无法识别」这种牛头不对马嘴的提示');

  /* ============================================================ */
  section('14. 单双周');

  $('#slotPreset').value = 'std12';
  fire($('#slotPreset'), 'change');
  await sleep(120);
  $('#semStart').value = '2026-09-07';
  fire($('#semStart'), 'change');
  $('#semWeeks').value = '16';
  fire($('#semWeeks'), 'change');
  $('#semTZ').value = '480';
  fire($('#semTZ'), 'change');
  await sleep(160);

  $('#pasteText').value = [
    '课程名称\t教师\t周次\t星期\t节次\t教室',
    '高等数学\t张老师\t1-16周(单)\t周一\t1-2\t教一301',
    '大学英语\t王老师\t1-16周(双)\t周二\t3-4\t教二205',
    '体育\t赵老师\t单双周\t周五\t7-8\t操场'
  ].join('\n');
  $('#btnParse').click();
  await sleep(280);
  eq($('#panel2').hidden, false, '单双周课表能解析');
  const sRows = $$('#courseBody tr');
  eq(sRows.length, 3, '3 个时段');
  eq(cell(sRows[0], 'weeks').value, '1-16周(单)', '单周原文保留供核对');
  eq(cell(sRows[1], 'weeks').value, '1-16周(双)', '双周原文保留');
  eq(cell(sRows[2], 'weeks').value, '单双周', '「单双周」原文保留');

  $('#btnToStep3').click();
  await sleep(140);
  $('#btnToStep4').click();
  await sleep(360);

  const evTxt2 = txt($('#eventBody'));
  ok(evTxt2.indexOf('1,3,5,7,9,11,13,15周') >= 0,
     '★ 单周课在事件表里摊开成具体奇数周，供直接核对');
  ok(evTxt2.indexOf('2,4,6,8,10,12,14,16周') >= 0,
     '★ 双周课摊开成具体偶数周');
  ok(evTxt2.indexOf('每 2 周 ×8') >= 0, '★ 重复列显示「每 2 周 ×8」');
  ok(evTxt2.indexOf('每周 ×16') < 0,
     '★ 不再出现「每周 ×16」——「单双周」不是每周');
  eq((evTxt2.match(/每 2 周 ×8/g) || []).length, 3,
     '★ 三门课（单周 / 双周 / 单双周）都是「每 2 周 ×8」');

  const sIcs = icsTextForTest();
  const single = sIcs.split('BEGIN:VEVENT').filter(b => b.indexOf('高等数学') >= 0)[0] || '';
  const double = sIcs.split('BEGIN:VEVENT').filter(b => b.indexOf('大学英语') >= 0)[0] || '';
  ok(/RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=8/.test(single), '★ 单周课 ICS: INTERVAL=2;COUNT=8');
  ok(/DTSTART:20260907T/.test(single), '★ 单周课首课在第 1 周（2026-09-07）');
  ok(/RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=8/.test(double), '★ 双周课 ICS: INTERVAL=2;COUNT=8');
  ok(/DTSTART:20260915T/.test(double), '★ 双周课首课在第 2 周（2026-09-15 周二）');

  /* ============================================================ */
  section('15. 单双周基准（第 1 周算单周还是双周）');

  $('#btnBack4').click();
  await sleep(80);
  $('#btnBack3').click();
  await sleep(80);
  $('#btnBack2').click();
  await sleep(80);
  eq($('#panel1').hidden, false, '回到第 1 步');
  eq($('#oddBasis').value, '1', '默认「本学期的第 1 周 = 单周」');
  ok(txt($('#panel1')).indexOf('本学期的第 1 周') >= 0, '界面上写明了基准');
  ok(txt($('#panel1')).indexOf('自然年周数') >= 0, '并说明了什么时候需要改');

  $('#pasteText').value = [
    '课程名称\t教师\t周次\t星期\t节次\t教室',
    '高等数学\t张老师\t1-16周(单)\t周一\t1-2\t教一301'
  ].join('\n');
  $('#btnParse').click();
  await sleep(280);
  eq($$('#courseBody tr').length, 1, '解析出 1 个时段');

  $('#btnToStep3').click();
  await sleep(140);
  $('#btnToStep4').click();
  await sleep(340);
  ok(txt($('#eventBody')).indexOf('1,3,5,7,9,11,13,15周') >= 0,
     '★ 默认基准下「单周」= 奇数周');

  /* --- 切到「第 1 周 = 双周」 --- */
  $('#btnBack4').click();
  await sleep(80);
  $('#btnBack3').click();
  await sleep(80);
  $('#btnBack2').click();
  await sleep(80);
  $('#oddBasis').value = '2';
  fire($('#oddBasis'), 'change');
  await sleep(220);
  ok(txt($('#semInfo')).indexOf('单双周基准已切换') >= 0, '切换后给出提示');
  ok(txt($('#semInfo')).indexOf('1 个时段') >= 0, '提示里说明重算了几处');
  eq(cell($$('#courseBody tr')[0], 'weeks').value, '1-16周(单)',
     '★ 周次原文没被改动，改的只是它的解释');

  $('#btnToStep3').click();
  await sleep(140);
  $('#btnToStep4').click();
  await sleep(340);
  const evB = txt($('#eventBody'));
  ok(evB.indexOf('2,4,6,8,10,12,14,16周') >= 0,
     '★ 基准切换后「单周」变成偶数周（整体错开一格）');
  ok(evB.indexOf('1,3,5,7,9,11,13,15周') < 0, '旧的奇数周结果已经不在了');

  const icsB = icsTextForTest();
  ok(/DTSTART:20260914T000000Z/.test(icsB),
     '★ 首次课顺移到第 2 周周一（2026-09-14 08:00 -> 00:00Z）');

  /* --- 切回默认，别影响后面的用例 --- */
  $('#btnBack4').click();
  await sleep(80);
  $('#btnBack3').click();
  await sleep(80);
  $('#btnBack2').click();
  await sleep(80);
  $('#oddBasis').value = '1';
  fire($('#oddBasis'), 'change');
  await sleep(220);
  $('#btnToStep3').click();
  await sleep(140);
  $('#btnToStep4').click();
  await sleep(340);
  ok(txt($('#eventBody')).indexOf('1,3,5,7,9,11,13,15周') >= 0,
     '切回默认基准后恢复成奇数周');

  /* ============================================================ */
  section('16. 移动端结构 / iOS 适配');

  const css = Array.prototype.map.call(doc.querySelectorAll('style'), s => s.textContent).join('\n');

  ok(/--sat:env\(safe-area-inset-top/.test(css),
     '★ 用 iOS 安全区变量——刘海和 Home 指示条不会盖住内容');
  ok(/env\(safe-area-inset-bottom/.test(css), '底部安全区（吸底操作条要留出指示条的高度）');
  ok(/prefers-color-scheme:dark/.test(css), '★ 跟随系统深色模式');
  ok(/-webkit-text-size-adjust:100%/.test(css), '禁掉 iOS 横屏时的字号自动放大');
  ok(/-webkit-tap-highlight-color:transparent/.test(css), '禁掉点按瞬间的灰色高亮块');
  ok(/@media\(max-width:760px\)/.test(css), '有手机断点');
  ok(/input,select,textarea\{font-size:16px\}/.test(css),
     '★ 手机上所有输入框抬到 16px——小于 16px 时 iOS Safari 聚焦会把整页放大');

  eq($$('meta[name="theme-color"]').length, 2, '★ 状态栏配色浅色/深色各一份');
  ok(/apple-mobile-web-app-capable/.test(HEAD), '可从主屏以独立应用方式打开');
  ok(/viewport-fit=cover/.test(HEAD), 'viewport 声明了 viewport-fit=cover');

  ok($('.hero .mark svg') !== null, '顶栏换成矢量图标');
  eq($$('#steps .lbl').length, 4, '四个步骤都保留完整名（宽屏）');
  eq($$('#steps .lbl-s').length, 4, '★ 各自另有窄屏短名');
  eq($$('#steps .lbl-s').map(txt), ['学期', '核对', '放假', '导出'], '短名内容');
  eq($$('#steps .step.on').length, 1, '当前步骤只有一个');

  const wraps = $$('.table-wrap.cards');
  eq(wraps.length, 2, '★ 课程表与事件表都标成「窄屏转卡片」');

  const mRows = $$('#courseBody tr');
  const mTds = Array.prototype.slice.call(mRows[0].children);
  eq(mTds.filter(td => td.hasAttribute('data-label')).length, 6,
     '★ 课程行 6 个字段都带 data-label（卡片里的字段名）');
  ok(mRows[0].querySelector('td.c-title') !== null, '课程名单独标记成卡片标题');
  ok(mRows[0].querySelector('td.c-del button') !== null, '删除按钮独占一格（卡片里整行铺开）');
  ok(mRows[0].querySelector('td.t-num') !== null, '序号格保留（显示在卡片右上角）');

  /* 表头与内容对齐：输入框自带 1px 边框和内边距，单元格若再留内边距，
     里面的文字就会比表头右移 11px。靠 c-in 这个类把内边距挪到控件身上。 */
  eq(Array.prototype.slice.call(mRows[0].children)
       .filter(td => td.classList.contains('c-in')).length, 6,
     '★ 6 个可编辑单元格都标了 c-in（表头对齐靠它）');
  ok(/\.table-wrap td\.c-in\{padding:6px 4px\}/.test(css),
     '★ 该类横向内边距 4px + 控件 1px 边框 + 5px 内边距 = 表头的 10px');
  ok(/\.table-wrap td\.c-in select\{padding-right:28px/.test(css),
     '★ 下拉框右侧留够 28px，箭头不会贴住「周一」');
  ok(/background-position:right 9px center/.test(css), '箭头退到距右边缘 9px');

  const mEvRows = $$('#eventBody tr');
  const mEvTds = Array.prototype.slice.call(mEvRows[0].children);
  eq(mEvTds.filter(td => td.hasAttribute('data-label')).length, 4, '★ 事件行 4 个字段带 data-label');
  ok(mEvRows[0].querySelector('td.c-ev-title') !== null, '事件标题单独标记');
  ok(mEvRows[0].querySelector('td.c-ev-rr') !== null,
     '★「重复」格单独标记——它里面有 <br>，必须按块级排，flex 会把换行吃掉');

  ok(/empty-row/.test(RAW), '空表用的占位行有独立类名（卡片模式下不画成一张空卡片）');
  ok(/\.actions\{[\s\S]{0,400}position:sticky;bottom:0/.test(css),
     '★ 手机端底部操作条吸底（拇指够得着，不用滚到底）');
  ok(/\.steps\{[\s\S]{0,600}position:sticky/.test(css), '★ 手机端步骤条吸顶');

  /* ============================================================ */
  section('17. 空状态示例（文本框里塞不下对齐的表格）');

  /* 这块以前是 placeholder 里的制表符文本。文本框里中英混排对不齐：
     中文 1.0em、等宽拉丁 0.6em，比值 1.667 不是整数，制表位落点会随
     中文个数漂移 —— 实测最大偏差 101px，换等宽字体也还有 73px。
     所以示例改成用真表格渲染，文本框只留一句说明。 */
  let ph = $('#pasteText').getAttribute('placeholder') || '';
  ok(!/\t/.test(ph), '★ placeholder 里不再有制表符排版的「假表格」');
  ok(/制表符 \/ 逗号 \/ 竖线/.test(ph), '✔ 改成用文字说明可用的分隔符');
  ok(/列的顺序无所谓/.test(ph), '✔ 顺带告诉用户列序不敏感');

  ok($('#pasteSample') !== null, '示例区块存在');
  eq($$('#pasteSample .tbl-demo thead th').length, 6, '★ 示例是真正的 <table>（天然对齐）');
  eq($$('#pasteSample tbody tr').length, 2, '示例给 2 行课程');

  $('#btnClear').click();
  await sleep(50);
  eq($('#pasteSample').hidden, false, '★ 文本框为空时展示示例');
  ok(txt($('#pasteSample .tbl-demo thead th')).indexOf('课程名称') >= 0, '示例表头可读');

  $('#pasteText').value = '课程名称\t星期\t节次\n某课\t周一\t1-2';
  fire($('#pasteText'), 'input');
  await sleep(50);
  eq($('#pasteSample').hidden, true, '★ 一旦有内容，示例自动收起（不挡视线）');

  $('#btnClear').click();
  await sleep(50);
  eq($('#pasteSample').hidden, false, '清空后示例回来');

  $('#btnSample').click();
  await sleep(200);
  eq($('#pasteSample').hidden, true, '载入示例课表后示例也收起');

  /* ============================================================ */

  console.log('\n' + '═'.repeat(60));
  if (problems.length) {
    console.log('❌ 运行时异常 ' + problems.length + ' 条：');
    problems.forEach(p => console.log('  • ' + p));
  } else {
    console.log('✅ 无未捕获运行时异常');
  }
  if (fail) {
    console.log('❌ 断言失败 ' + fail + ' 项：');
    failures.forEach(f => console.log('  • ' + f));
  } else {
    console.log('✅ 全部通过：' + pass + ' 项断言');
  }
  console.log('═'.repeat(60));

  process.exit(fail || problems.length ? 1 : 0);
})();
