/* xlsx 解析测试（Node）
   跑之前先执行：python3 tools/make-fixtures.py
   验证自研的 ZIP + XML + DecompressionStream 链路，以及两种课表形态的识别。 */

const fs = require('fs');
const path = require('path');
const Core = require('../src/core.js');

let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; failures.push(label + '\n      期望: ' + e + '\n      实际: ' + a); }
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log('\n── ' + t); }

/** Buffer -> 精确的 ArrayBuffer（直接传 buffer.buffer 会带上多余字节） */
function toAB(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const FIX = path.join(__dirname, 'fixtures');
const SEM = Core.buildSemester({
  name: '2026秋季', firstDay: Core.parseISODate('2026-09-07'),
  totalWeeks: 16, offsetMinutes: 480
});

(async function run() {
  if (!fs.existsSync(path.join(FIX, 'long-table.xlsx'))) {
    console.log('⚠️  找不到 fixtures，请先运行: python3 tools/make-fixtures.py');
    process.exit(1);
  }

  /* ============================================================ */
  section('ZIP 解压链路（自研，用浏览器原生 DecompressionStream）');

  const raw = fs.readFileSync(path.join(FIX, 'long-table.xlsx'));
  ok(raw.length > 0, '读到 xlsx 字节');
  eq(raw[0], 0x50, '以 ZIP 魔数 P 开头');
  eq(raw[1], 0x4B, '以 ZIP 魔数 K 开头');

  const files = await Core._internals.unzipAll(toAB(raw));
  const names = Object.keys(files).sort();
  ok(names.indexOf('xl/worksheets/sheet1.xml') >= 0, '解出 sheet1.xml');
  ok(names.indexOf('xl/sharedStrings.xml') >= 0, '解出 sharedStrings.xml');
  ok(names.indexOf('xl/workbook.xml') >= 0, '解出 workbook.xml');
  ok(files['xl/worksheets/sheet1.xml'].length > 0, 'sheet xml 非空');

  section('共享字符串与单元格解析');
  const shared = Core._internals.parseSharedStrings(
    new TextDecoder('utf-8').decode(files['xl/sharedStrings.xml']));
  ok(shared.indexOf('高等数学') >= 0, '共享字符串含「高等数学」');
  ok(shared.indexOf('1-16周(单)') >= 0, '含带括号的周次文本');
  eq(Core._internals.colIndex('A1'), 0, '列引用 A -> 0');
  eq(Core._internals.colIndex('F9'), 5, '列引用 F -> 5');
  eq(Core._internals.colIndex('AA1'), 26, '列引用 AA -> 26');
  eq(Core._internals.unescapeXML('a&amp;b&lt;c'), 'a&b<c', 'XML 反转义');

  const grid = Core._internals.parseSheetGrid(
    new TextDecoder('utf-8').decode(files['xl/worksheets/sheet1.xml']), shared);
  // 空行在 xlsx 里根本不产生 <row>，所以只有「表头 + 6 门课」7 行
  eq(grid.length, 7, '解析出 7 行（表头 + 6 门课）');
  eq(grid[0].slice(0, 6), ['课程名称', '教师', '周次', '星期', '节次', '教室'], '表头行');
  eq(grid[1].slice(0, 6), ['高等数学', '张老师', '1-16周', '周一', '1-2', '教一301'], '第一门课');

  /* ============================================================ */
  section('长表型 xlsx -> 课程');

  const longRes = await Core.parseXlsxBuffer(toAB(raw), 16, {});
  eq(longRes.layout, undefined, '识别为长表型（非矩阵）');
  eq(longRes.courses.length, 6, '解析出 6 门课（空行被跳过）');
  eq(longRes.headerDetected, true, '识别到表头');

  const math = longRes.courses.find(c => c.name === '高等数学');
  eq(math.teacher, '张老师', '教师');
  eq(math.room, '教一301', '地点');
  eq(math.patterns[0].weekday, 1, '星期');
  eq(math.patterns[0].slots, [1, 2], '节次');
  eq(math.patterns[0].weekMask.weeks().length, 16, '周次');

  const lin = longRes.courses.find(c => c.name === '线性代数');
  eq(lin.patterns[0].weekMask.weeks(), [1,3,5,7,9,11,13,15], '单周课');
  eq(lin.patterns[0].rawWeekText, '1-16周(单)', '原始周次文本被保留');

  const eng = longRes.courses.find(c => c.name === '大学英语');
  eq(eng.patterns[0].weekMask.weeks(), [2,4,6,8,10,12,14,16], '双周课');

  const lab = longRes.courses.find(c => c.name === '大学物理实验');
  eq(lab.courseType, 'lab', '「实验」课类型推断');
  const pe = longRes.courses.find(c => c.name === '体育');
  eq(pe.courseType, 'pe', '「体育」课类型推断');

  ok(longRes.warnings.length === 0, '长表型无警告');

  /* ============================================================ */
  section('矩阵型 xlsx -> 课程（教务系统常见形态）');

  const mRaw = fs.readFileSync(path.join(FIX, 'matrix.xlsx'));
  const mRes = await Core.parseXlsxBuffer(toAB(mRaw), 16, {});

  eq(mRes.layout, 'matrix', '★ 正确识别为矩阵型');
  eq(mRes.courses.length, 5, '解析出 5 门课');
  ok(mRes.warnings.some(w => /矩阵/.test(w.message)), '给出「已按矩阵还原，请核对」的提示');

  const m1 = mRes.courses.find(c => c.name === '高等数学');
  ok(m1, '格子里的课程名被正确提取');
  eq(m1.teacher, '张老师', '格子里的教师被拆出');
  eq(m1.room, '教一301', '格子里的地点被拆出');
  eq(m1.patterns[0].weekday, 1, '列头「周一」-> 星期 1');
  eq(m1.patterns[0].slots, [1, 2], '行头「第1-2节」-> 节次 [1,2]');
  eq(m1.patterns[0].rawWeekText, '1-16周', '格子里的周次被拆出');

  const m2 = mRes.courses.find(c => c.name === '线性代数');
  eq(m2.patterns[0].weekday, 2, '「周二」列');
  eq(m2.patterns[0].slots, [3, 4], '「第3-4节」行');
  eq(m2.patterns[0].weekMask.weeks(), [1,3,5,7,9,11,13,15], '单周');

  const mDs = mRes.courses.find(c => c.name === '数据结构');
  eq(mDs.patterns[0].weekday, 3, '「周三」列');
  eq(mDs.patterns[0].slots, [5, 6], '「第5-6节」行');

  const mPe = mRes.courses.find(c => c.name === '体育');
  ok(mPe, '最后一格（体育）也被解析');
  eq(mPe.room, '操场', '地点 = 操场');

  /* ============================================================ */
  section('★ 研究生教务真实导出（带标签格子 + 具名中午节次 + 合并单元格）');

{
  const noonPreset = Core.SLOT_PRESETS.find(p => p.id === 'noon13');
  const NOON = Core.makeSlotTable(noonPreset.name, noonPreset.rows,
    { maxBreak: 5, joinMode: 'gap' });

  const labRaw = fs.readFileSync(path.join(FIX, 'labeled-matrix.xlsx'));
  const labRes = await Core.parseXlsxBuffer(toAB(labRaw), 18, { slotTable: NOON });
  eq(labRes.layout, 'matrix', '识别为矩阵型');
  eq(labRes.courses.length, 5, '解析出 5 门课');
  const byName = n => labRes.courses.find(c => c.name === n);

  const eng = byName('高等数学（A班）');
  ok(eng, '★ 课程名剥掉了「课程:」前缀');
  eq(eng.teacher, '张老师', '★ 「主讲教师:」这种前缀式写法能认（旧实现教师全空）');
  eq(eng.room, '教一301', '★ 单独一行的 (教一301) 认作地点（旧实现把「班级:」整行当地点）');
  eq(eng.patterns[0].slots.join(','), '中午2,5,6', '★「中午2–6节」按位置展开成三节');
  eq(eng.patterns[0].weekday, 4, '星期四');
  eq(eng.patterns[0].weekMask.weeks(), [13], '★ 周次只有第 13 周（节次的 2–6 没被当成周次）');

  const ic = byName('数据结构');
  eq(ic.patterns[0].slots.join(','), '中午2,5,6', '合并单元格：值只在锚点行，格子横跨三行');
  eq(ic.patterns[0].weekday, 1, '星期一');
  eq(ic.patterns[0].weekMask.runs()[0].count, 16, '3–18 周连续 16 次');

  const lab = byName('大学物理实验');
  eq(lab.patterns[0].slots.join(','), '11', '★ 格子里写 11 节、所在行标的是 9 -> 以格子为准');
  ok(labRes.warnings.some(w => /格子里写的节次是「11」/.test(w.message)), '★ 并提示这一处不一致');
  ok(labRes.warnings.some(w => /格子里写的节次是「中午2-6」/.test(w.message)), '中午长课的跨度也提示了');
  eq(lab.room, '实验楼B203', '教室号 实验楼B203');

  const eng2 = byName('大学英语');
  eq(eng2.patterns[0].slots.join(','), '3,4', '普通范围照常');
  eq(eng2.room, '教二205', '教室号 教二205');
  eq(eng2.teacher, '李老师', '教师');

  const num = byName('线性代数');
  eq(num.patterns[0].weekMask.weeks(), [3, 5, 7, 9, 11, 13, 15, 17], '「3–18周:单周」解析成单周');

  /* 端到端：这份课表一路导到 .ics */
  const labPlan = Core.planEvents(labRes.courses,
    Core.buildSemester({ name: '2026秋', firstDay: Core.parseISODate('2026-09-07'), totalWeeks: 18 }),
    NOON, [], { titleTemplate: '{课程名}', reminderMinutes: 10 });
  const noonEv = labPlan.events.filter(e => /中午/.test(e.slotsText));
  eq(noonEv.length, 2, '两门中午长课（高等数学 + 数据结构）');
  eq(Core.wallHHMM(noonEv[0].start), '13:35', '中午长课 13:35 开始');
  eq(Core.wallHHMM(noonEv[0].end), '16:15', '中午长课 16:15 结束');
  eq(labPlan.warnings.filter(w => /无法解析/.test(w)).length, 0, '没有任何一门课的节次解析失败');
  const labICS = Core.buildICS(labPlan.events, { offsetMinutes: 480, calendarName: '课表' });
  ok(labICS.indexOf('T053500Z') >= 0, '★ .ics 里的 UTC 时刻是 05:35:00Z（13:35 − 8h）');
  ok(labICS.indexOf('高等数学（A班）') >= 0, '全角括号的中文课名写进 .ics');

  /* 同一份 xlsx 用「不含中午节次」的作息表读 -> 必须报警告而不是静默错 */
  const badRes = await Core.parseXlsxBuffer(toAB(labRaw), 18, { slotTable: Core.makeStandard12() });
  ok(badRes.warnings.some(w => w.level === 'warn' && /中午2/.test(w.message)
     && /没有导进来/.test(w.message)),
     '★ 作息表里没有中午节次 -> 明说这一行没导进来，而不是悄悄排到 8:55');
  eq(badRes.courses.some(c => /高等数学/.test(c.name)), false,
     '中午那两门课被丢弃（宁缺勿错），不给错误时间');
  ok(badRes.courses.some(c => /大学英语/.test(c.name)), '不受影响的课照常解析');
}

    /* ============================================================ */
  section('从 xlsx 一路走到 .ics');

  const plan = Core.planEvents(longRes.courses, SEM, Core.makeStandard12(), [], {});
  ok(plan.events.length > 0, '生成事件');
  eq(new Set(plan.events.map(e => e.uid)).size, plan.events.length, '无 UID 碰撞');

  const ics = Core.buildICS(plan.events, { offsetMinutes: 480, calendarName: '课表' });
  ok(/^BEGIN:VCALENDAR/.test(ics), 'ics 生成成功');
  eq((ics.match(/BEGIN:VEVENT/g) || []).length, plan.events.length, 'VEVENT 数与事件数一致');
  ok(ics.indexOf('SUMMARY:高等数学') >= 0, '中文课程名写入 ics');
  ok(ics.indexOf('RRULE:FREQ=WEEKLY;INTERVAL=2') >= 0, '单周课写成 INTERVAL=2');

  /* ============================================================ */
  section('★ 模板往返：生成 xlsx → 用自己的解析器读回');

  const T = Core.TEMPLATES;
  // 与界面走同一条组装路径（含样式、列宽、冻结行）
  const tplBytes = await Core.buildXlsx(Core.buildTemplateSheets());
  ok(tplBytes.length > 1000, '生成的 xlsx 有内容（' + tplBytes.length + ' 字节）');
  eq(tplBytes[0], 0x50, 'ZIP 魔数 P');
  eq(tplBytes[1], 0x4B, 'ZIP 魔数 K');

  const back = await Core.parseXlsxBuffer(toAB(Buffer.from(tplBytes)), 16, {});
  eq(back.sheetCount, 3, '生成的 xlsx 含 3 张工作表');
  eq(back.sheetName, 'sheet2.xml', '★ 自动选中「长表型」表（跳过「填写说明」）');
  eq(back.courses.length, 6, '模板里的 6 个示例课程被读回');
  eq(back.courses[0].name, '高等数学', '课程名往返一致');
  eq(back.courses[0].teacher, '张老师', '教师往返一致');
  eq(back.courses[0].room, '教一301', '地点往返一致');
  eq(back.courses[1].patterns[0].weekMask.weeks(), [1,3,5,7,9,11,13,15], '单周往返一致');
  eq(back.courses[1].patterns[0].rawWeekText, '1-16周(单)', '原始周次文本往返一致');

  section('CSV / TSV 模板也能被自己解析');
  const cq = v => /[",\n\r]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const rowsAll = [T.longTable.headers].concat(T.longTable.sample, T.longTable.footer);

  const csvText = '\uFEFF' + rowsAll.map(r => r.map(cq).join(',')).join('\r\n') + '\r\n';
  const csvRes = Core.parseDelimitedText(csvText, 16, {});
  ok(csvRes.headerDetected, 'CSV 模板表头识别成功');
  eq(csvRes.courses.length, 6, '★ CSV 模板解析出 6 门课（BOM 与 # 注释行都被正确处理）');
  eq(csvRes.separator, '逗号', 'CSV 分隔符识别');
  eq(csvRes.courses[2].patterns[0].weekMask.weeks(), [2,4,6,8,10,12,14,16], '双周课正确');

  const tsvText = rowsAll.map(r => r.join('\t')).join('\r\n');
  const tsvRes = Core.parseDelimitedText(tsvText, 16, {});
  eq(tsvRes.courses.length, 6, 'TSV 模板解析出 6 门课');
  eq(tsvRes.separator, '制表符', 'TSV 分隔符识别');

  section('模板 xlsx 的结构完整性');
  const inner = await Core._internals.unzipAll(toAB(Buffer.from(tplBytes)));
  const keys = Object.keys(inner).sort();
  eq(keys.length, 9, '包含 9 个 ZIP 条目（多了 styles.xml）');
  ok(keys.indexOf('[Content_Types].xml') >= 0, '含 [Content_Types].xml');
  ok(keys.indexOf('_rels/.rels') >= 0, '含根关系文件');
  ok(keys.indexOf('xl/workbook.xml') >= 0, '含 workbook.xml');
  ok(keys.indexOf('xl/sharedStrings.xml') >= 0, '含 sharedStrings.xml');
  ok(keys.indexOf('xl/styles.xml') >= 0, '★ 含 styles.xml（表头样式）');
  ok(keys.indexOf('xl/worksheets/sheet3.xml') >= 0, '含第 3 张工作表');
  eq(inner['xl/workbook.xml'].length > 0, true, 'workbook.xml 非空');

  /* --- 样式表本身是否合法 --- */
  const styles = new TextDecoder('utf-8').decode(inner['xl/styles.xml']);
  ok(/<fonts count="5">/.test(styles), 'styles.xml 声明 5 种字体');
  ok(/<fill><patternFill patternType="none"\/><\/fill>/.test(styles),
     '★ fills[0] = none（Excel 硬性要求，否则文件被判损坏）');
  ok(/<fill><patternFill patternType="gray125"\/><\/fill>/.test(styles),
     '★ fills[1] = gray125（同上）');
  ok(/<cellXfs count="7">/.test(styles), 'cellXfs 声明 7 种单元格格式');
  ok(/horizontal="center"/.test(styles), '表头水平居中');
  ok(/wrapText="1"/.test(styles), '★ 课程格样式带 wrapText（矩阵型一格是多行文本，不换行只显示第一行）');

  /* --- 工作表是否真的用上了样式 / 列宽 / 冻结 --- */
  const sheet1 = new TextDecoder('utf-8').decode(inner['xl/worksheets/sheet1.xml']);
  const sheet2 = new TextDecoder('utf-8').decode(inner['xl/worksheets/sheet2.xml']);
  ok(/<c r="A1" t="s" s="4">/.test(sheet1), '★ 说明表标题用了大标题样式 s=4');
  ok(/<col min="1" max="1" width="20" customWidth="1"\/>/.test(sheet1), '说明表设置了列宽');
  ok(/<c r="A1" t="s" s="1">/.test(sheet2), '★ 长表型表头用了表头样式 s=1');
  ok(/state="frozen"/.test(sheet2), '★ 长表型冻结了首行');
  ok(/<col min="1" max="1" width="20" customWidth="1"\/>/.test(sheet2), '长表型设置了列宽');
  ok(/<cols>[\s\S]*<\/cols><sheetData>/.test(sheet2), '★ XML 元素顺序合法（cols 在 sheetData 之前）');
  ok(/<sheetViews>[\s\S]*<\/sheetViews><cols>/.test(sheet2), '★ sheetViews 在 cols 之前（规范要求）');

  const sheet3 = new TextDecoder('utf-8').decode(inner['xl/worksheets/sheet3.xml']);
  ok(/<c r="A2" t="s" s="3">/.test(sheet3), '★ 矩阵型首列用了强调样式 s=3');

  /* --- OOXML 引用完整性：Excel 报「文件已损坏」几乎都出在这几处 --- */
  const dec2 = new TextDecoder('utf-8');
  const ct = dec2.decode(inner['[Content_Types].xml']);
  const overrides = [...ct.matchAll(/PartName="\/([^"]+)"/g)].map(m => m[1]);
  eq(overrides.length, 6, 'Content_Types 声明 workbook + styles + sharedStrings + 3 张表');
  ok(overrides.every(p => keys.indexOf(p) >= 0),
     '★ Content_Types 里每个 Part 都真实存在于 ZIP 中');

  const rels = dec2.decode(inner['xl/_rels/workbook.xml.rels']);
  const targets = [...rels.matchAll(/Target="([^"]+)"/g)].map(m => 'xl/' + m[1]);
  eq(targets.length, 5, 'workbook.rels 声明 3 张表 + styles + sharedStrings');
  ok(targets.every(p => keys.indexOf(p) >= 0), '★ workbook.rels 的每个 Target 都真实存在');

  const wbXml = dec2.decode(inner['xl/workbook.xml']);
  const rids = [...wbXml.matchAll(/r:id="([^"]+)"/g)].map(m => m[1]);
  ok(rids.every(id => rels.indexOf('Id="' + id + '"') >= 0),
     '★ workbook.xml 引用的每个 rId 都有对应关系定义');

  const usedStyles = new Set();
  ['sheet1', 'sheet2', 'sheet3'].forEach(kk => {
    const xml = dec2.decode(inner['xl/worksheets/' + kk + '.xml']);
    [...xml.matchAll(/ s="(\d+)"/g)].forEach(m => usedStyles.add(+m[1]));
  });
  ok([...usedStyles].every(n => n >= 0 && n < 7),
     '★ 工作表里用到的样式索引都在 cellXfs 范围内（不越界）');
  ok(usedStyles.size >= 4, '实际用到 ' + usedStyles.size + ' 种不同样式：' +
     [...usedStyles].sort().join(','));

  // 说明表的内容要讲清「节次 ↔ 具体时间」由页面上的作息表决定
  const dec = new TextDecoder('utf-8');
  const allXml = Object.keys(inner).map(k => dec.decode(inner[k])).join('');
  ok(allXml.indexOf('上下课时间') >= 0, '★ 模板说明里写明了「上下课时间」决定节次对应几点');
  ok(allXml.indexOf('1-3') >= 0, '模板说明给出「连上三节」的写法 1-3');
  ok(allXml.indexOf('1,3') >= 0, '模板说明给出「跳着上」的写法 1,3');
  ok(allXml.indexOf('每个学校作息不同') >= 0, '模板说明解释了为什么作息要自己设');

  /* --- 具名节次与格子写法有没有讲进去 --- */
  ok(allXml.indexOf('中午2-6') >= 0, '★ 模板说明给出具名节次的写法 中午2-6');
  ok(allXml.indexOf('中午第1节课') >= 0, '★ 作息表里的长写法也写进说明（两种写法都认）');
  ok(allXml.indexOf('主讲教师:') >= 0, '★ 说明里演示了带字段名的格子写法');
  ok(allXml.indexOf('不是数字上的 2 到 6') >= 0
     || allXml.indexOf('不是数字 2 到 6') >= 0,
     '说明里点破「范围按位置连，不是数字相减」这个最容易误解的点');

  /* --- 矩阵型这张表本身的样子 --- */
  // 注意：表里的文字都存在 sharedStrings 里，sheet XML 只有字符串下标，
  // 所以「有没有中午1 这一行」要到解析出来的网格里去看，不能 grep 表 XML。
  const s3 = dec.decode(inner['xl/worksheets/sheet3.xml']);
  ok(/<c r="A1" t="s" s="1">/.test(s3), '矩阵型表头用表头样式');
  ok(/<c r="D4" t="s" s="6">/.test(s3), '★ 矩阵型课程格用带换行的样式 s=6');
  ok((s3.match(/ s="6"/g) || []).length >= 5, '至少 5 个课程格用上了 s=6');

  /* --- 矩阵型模板能被自己读回（用配套的 noon13 作息）--- */
  {
    const noon = Core.SLOT_PRESETS.find(x => x.id === 'noon13');
    const NOON = Core.makeSlotTable(noon.name, noon.rows, { maxBreak: 5, joinMode: 'gap' });
    const g3 = Core._internals.parseSheetGrid(
      dec.decode(inner['xl/worksheets/sheet3.xml']),
      Core._internals.parseSharedStrings(dec.decode(inner['xl/sharedStrings.xml'])));
    const mBack = Core.coursesFromGrid(g3, 18, { slotTable: NOON });
    eq(mBack.layout, 'matrix', '★ 矩阵型模板被识别为矩阵型');
    eq(g3.filter(r => r[1] === '中午1' || r[1] === '中午2').length, 2,
       '★ 矩阵型示例含具名节次行（中午1 / 中午2）');
    eq(g3[1][0], '上午', '★ 行首是「分组列 + 节次列」两列，跟教务导出一样');
    eq(mBack.courses.length, 6, '模板矩阵里的 6 个示例课都读回来了');
    const eng = mBack.courses.find(c => c.name === '高等数学');
    ok(!!eng, '带标签的格子往返后课程名干净（没有「课程:」前缀）');
    eq(eng.patterns[0].slots.join(','), '中午2,5,6', '★ 中午2-6 往返后仍按位置展开成三节');
    eq(eng.patterns[0].weekMask.weeks(), [13], '周次 13-13周 往返后只有第 13 周');
    eq(eng.room, '教一301', '括号里的教室号往返一致');
    eq(eng.teacher, '张老师', '「主讲教师:」往返一致');
    const math = mBack.courses.find(c => c.name === '高等数学');
    eq(math.teacher, '张老师', '不带字段名的格子照样认');
    eq(math.room, '教一301', '不带字段名的地点照样认');
  }

  /* --- 模板自带的 # 说明行不该制造警告噪音 --- */
  {
    const tplLong = Core.parseDelimitedText(
      [T.longTable.headers].concat(T.longTable.sample, T.longTable.footer)
        .map(r => r.join('\t')).join('\n'), 16, {});
    eq(tplLong.courses.length, 6, '长表型模板解析出 6 门课');
    eq(tplLong.warnings.filter(w => w.level !== 'info').length, 0,
       '★ 模板里的 # 注释行被静默跳过，不会刷一屏「星期无法识别」');
  }

  /* ============================================================ */
  console.log('\n' + '═'.repeat(60));
  if (fail) {
    console.log('❌ 失败 ' + fail + ' 项：');
    failures.forEach(f => console.log('  • ' + f));
  } else {
    console.log('✅ 全部通过：' + pass + ' 项断言');
  }
  console.log('═'.repeat(60));
  process.exit(fail ? 1 : 0);
})();
