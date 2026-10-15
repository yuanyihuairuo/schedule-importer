/* 课表导入器 · 内核测试（Node 运行） */

const path = require('path');
const Core = require('../src/core.js');

let pass = 0, fail = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; failures.push(label + '\n      期望: ' + e + '\n      实际: ' + a); }
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log('\n── ' + t); }

/* ---------- fixtures ---------- */

const SEM = Core.buildSemester({
  name: '2026秋季',
  firstDay: Core.parseISODate('2026-09-07'),
  totalWeeks: 16,
  offsetMinutes: 480
});

const SLOTS = Core.makeStandard12();

function maskOf(weeks, total) {
  const m = new Core.WeekMask(total || 16);
  weeks.forEach(w => m.add(w));
  return m;
}
function everyMask(total) {
  return maskOf(Array.from({ length: total || 16 }, (_, i) => i + 1), total);
}
function course(name, o) {
  o = o || {};
  const total = 16;
  const mask = o.weeks ? maskOf(o.weeks, total) : everyMask(total);
  return {
    id: 'c_' + name,
    name: name,
    teacher: o.teacher === undefined ? '张老师' : o.teacher,
    room: o.room === undefined ? '教一301' : o.room,
    courseType: o.type || 'required',
    patterns: [{
      weekday: o.weekday || 1,
      slots: o.slots || [1, 2],
      weekMask: mask,
      rawWeekText: o.weekText || null
    }]
  };
}
function holiday(iso, name) {
  return { kind: 'holiday', date: Core.parseISODate(iso), name: name, skipClasses: true };
}
function expand(courses, rules) {
  return Core.planEvents(courses, SEM, SLOTS, rules || [], {});
}
function occurrencesOf(courses, rules) {
  const out = [];
  (courses || []).forEach(c => {
    Core.expandCourse(c, SEM, SLOTS, rules || []).events.forEach(ev => {
      ev.occurrences.forEach(o => out.push(o));
    });
  });
  return out;
}

/* ============================================================ */

section('SHA-1');
eq(Core.sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d', 'sha1("abc")');
eq(Core.sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709', 'sha1("")');
eq(Core.sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
   '84983e441c3bd26ebaae4aa1f95129e5e54670f1', 'sha1(56字节)');
eq(Core.sha1Hex('中文测试'), Core.sha1Hex('中文测试'), 'sha1(中文) 稳定');

section('UUIDv5（与 Python uuid.uuid5 交叉验证）');
const NS = '8e4c1a72-3b5d-4f60-9a11-7c2d6e8f0b34';
eq(Core.uuidV5(NS, 'test'), '612d08e4-aa71-5556-9d17-a7ad5817f6d4', 'uuid5(NS,"test")');
eq(Core.uuidV5(NS, ''), '17278d4f-2646-53a6-912e-78533fa5c1d9', 'uuid5(NS,"")');
eq(Core.uuidV5(NS, '高等数学'), '38a255b3-d176-591d-9b2e-0f18c30b7b45', 'uuid5(NS,"高等数学")');
eq(Core.ID.semesterID('2026秋季', Core.parseISODate('2026-09-07'), 16, 480),
   '7b9e50af-275e-5ed4-a462-289569ab5b60', 'semesterID 与 Python 一致');

section('周次文本解析');
function pm(s) { const r = Core.parseWeekMask(s, 16); return r ? r.mask.weeks() : null; }
eq(pm('1-16周'), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], '1-16周');
eq(pm('1-16'), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], '1-16（无「周」字）');
eq(pm('第1-16周'), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], '第1-16周');
eq(pm('1至16周'), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], '1至16周（中文「至」）');
eq(pm('1—16周'), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], '1—16周（em dash）');
eq(pm('１－１６周'), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], '全角数字与全角减号');
eq(pm('1 - 16 周'), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], '数字与破折号间有空格');
eq(pm('1-16周(单)'), [1,3,5,7,9,11,13,15], '1-16周(单)');
eq(pm('1-16周(双)'), [2,4,6,8,10,12,14,16], '1-16周(双)');
eq(pm('1-16周单周'), [1,3,5,7,9,11,13,15], '1-16周单周');
eq(pm('3-15周单周'), [3,5,7,9,11,13,15], '3-15周单周');
eq(pm('2-16双'), [2,4,6,8,10,12,14,16], '2-16双');
eq(pm('单双周'), [1,3,5,7,9,11,13,15], '★「单双周」= 隔周上一次（不是每周）');
eq(pm('1-16周 单双周'), [1,3,5,7,9,11,13,15], '★「1-16周 单双周」= 隔周');
eq(pm('2-16周 单双周'), [2,4,6,8,10,12,14,16], '★ 从第 2 周起算的「单双周」');
eq(pm('1-16周 隔周'), [1,3,5,7,9,11,13,15], '「隔周」同「单双周」');
eq(pm('1-4周 单双周'), [1,3], '★ 行数按位置取，不是按周次奇偶');
eq(pm('每周'), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], '每周');
eq(pm('1-8,10-16周').length, 15, '1-8,10-16周 共 15 周');
ok(!pm('1-8,10-16周').includes(9), '1-8,10-16周 缺第 9 周');
eq(pm('第1-4,6,8-10周'), [1,2,3,4,6,8,9,10], '混合区间与单点');
eq(pm('1-20周'), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], '1-20周 越界裁剪到 16');
eq(Core.parseWeekMask('1-20周', 16).warnings.length > 0, true, '越界产生警告');
eq(Core.parseWeekMask('', 16), null, '空串返回 null');
eq(Core.parseWeekMask('张老师', 16), null, '无数字无关键词返回 null');
eq(Core.detectModifier(Core.normalizeWeekText('单双周')), 'alternate', '单双周 -> alternate');
eq(Core.detectModifier(Core.normalizeWeekText('1-16周(单)')), 'odd', '(单) -> odd');
eq(Core.detectModifier(Core.normalizeWeekText('1-16周(双)')), 'even', '(双) -> even');
eq(Core.detectModifier(Core.normalizeWeekText('每周')), 'every', '每周 -> every');

section('周次切段（等差数列）');
const runsOf = ws => {
  const m = maskOf(ws, 16); return m.runs();
};
eq(runsOf([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]),
   [{ firstWeek: 1, step: 1, count: 16 }], '连续 16 周 -> 一段');
eq(runsOf([1,3,5,7,9,11,13,15]), [{ firstWeek: 1, step: 2, count: 8 }], '单周 -> 一段 step2');
eq(runsOf([1,3,7,9]), [{ firstWeek: 1, step: 2, count: 2 }, { firstWeek: 7, step: 2, count: 2 }],
   '[1,3,7,9] -> 两段');
eq(runsOf([1,2,3,4,6,8,9,10]),
   [{ firstWeek: 1, step: 1, count: 4 }, { firstWeek: 6, step: 2, count: 2 },
    { firstWeek: 9, step: 1, count: 2 }], '贪心切段');

section('节次表');
/** 节次时间是 {h,m} 墙钟对象，不是 Date */
const fmtT = t => String(t.h).padStart(2, '0') + ':' + String(t.m).padStart(2, '0');

const r12 = Core.resolveSlots(SLOTS, [1, 2]);
eq(r12.blocks.length, 1, '[1,2] 合并为一个块');
eq(r12.blocks[0].slotsText, '1-2节', '[1,2] 文案');
eq(fmtT(r12.blocks[0].start), '08:00', '[1,2] 开始 08:00');
eq(fmtT(r12.blocks[0].end), '09:35', '[1,2] 结束 09:35');

const r23 = Core.resolveSlots(SLOTS, [2, 3]);
eq(r23.blocks.length, 2, '⚠️ [2,3] 中间隔 25 分钟 -> 必须拆成两个块');
eq(fmtT(r23.blocks[0].start), '08:50', '[2,3] 第一块开始');
eq(fmtT(r23.blocks[0].end), '09:35', '[2,3] 第一块结束');
eq(fmtT(r23.blocks[1].start), '10:00', '[2,3] 第二块开始');
eq(fmtT(r23.blocks[1].end), '10:45', '[2,3] 第二块结束');

eq(Core.resolveSlots(SLOTS, [1, 2, 3, 4]).blocks.length, 2, '[1,2,3,4] -> 两个块');
eq(Core.resolveSlots(SLOTS, [4, 5]).blocks.length, 2, '[4,5] 跨午间不合并');
eq(Core.resolveSlots(SLOTS, [9, 10]).blocks[0].slotsText, '9-10节', '[9,10] 晚间连堂');
eq(Core.resolveSlots(SLOTS, [2, 1]).blocks.length, 1, '顺序无关');
eq(Core.resolveSlots(SLOTS, [1, 1, 2]).blocks.length, 1, '去重');
eq(Core.resolveSlots(SLOTS, [20]).blocks.length, 0, '未知节次 -> 空');
eq(Core.resolveSlots(SLOTS, []).blocks.length, 0, '空节次 -> 空');

section('节次表 · 自定义作息');

/* 自定义一张「每节 50 分钟、课间 10 分钟」的作息 */
const custom = Core.makeSlotTable('自建', [
  [1, 9, 0, 9, 50, '上午'], [2, 10, 0, 10, 50, '上午'], [3, 11, 0, 11, 50, '上午'],
  [4, 14, 30, 15, 20, '下午'], [5, 15, 30, 16, 20, '下午']
], { maxBreak: 10, joinMode: 'gap' });
eq(custom.slots.length, 5, '自定义表 5 节');
eq(custom.slots[0].start.h, 9, '第 1 节 09:00');
const rc = Core.resolveSlots(custom, [1, 2, 3]);
eq(rc.blocks.length, 1, '自定义作息：三节连排（课间 10 分钟）-> 1 个块');
eq(fmtT(rc.blocks[0].start), '09:00', '自定义作息开始 09:00');
eq(fmtT(rc.blocks[0].end), '11:50', '自定义作息结束 11:50');
eq(rc.blocks[0].slotCount, 3, '块含 3 节');
eq(Core.resolveSlots(custom, [3, 4]).blocks.length, 2, '跨午间 11:50->14:30 -> 拆开');

/* 节次序号不连续时，无论什么模式都不能合并 */
eq(Core.resolveSlots(custom, [1, 3], { joinMode: 'keep' }).blocks.length, 2,
   '⚠️ 跳号节次 [1,3] 即使 keep 模式也拆开');

/* joinMode = keep：连排三节中间夹大课间也合并成一个事件 */
const keepTable = Core.makeSlotTable('keep', [
  [1, 8, 0, 8, 45, '上午'], [2, 8, 50, 9, 35, '上午'],
  [3, 10, 0, 10, 45, '上午'], [4, 10, 50, 11, 35, '上午']
], { joinMode: 'keep' });
const keep3 = Core.resolveSlots(keepTable, [1, 2, 3]);
eq(keep3.blocks.length, 1, "keep 模式：1-3 节（含 25 分钟大课间）-> 1 个事件");
eq(fmtT(keep3.blocks[0].start), '08:00', 'keep 模式 08:00 开始');
eq(fmtT(keep3.blocks[0].end), '10:45', 'keep 模式 10:45 结束（含课间）');
eq(keep3.blocks[0].minutes, 165, 'keep 模式时长 165 分钟 = 含中间课间');
eq(Core.resolveSlots(keepTable, [2, 3], { joinMode: 'gap' }).blocks.length, 2,
   '同一张表切回 gap 模式 -> 又拆成 2 个');

/* joinMode = split：每节一个事件 */
const split3 = Core.resolveSlots(keepTable, [1, 2, 3], { joinMode: 'split' });
eq(split3.blocks.length, 3, 'split 模式：三节 -> 3 个事件');
eq(split3.blocks.map(b => b.slotsText).join('|'), '1节|2节|3节', 'split 模式文案');

section('节次表 · 快速重排与持久化');
const regen = Core.regenerateSlots(custom, 45, 5);
eq(regen.slots.length, 5, '重排后节数不变');
eq(fmtT(regen.slots[0].start), '09:00', '重排保留上午起始时间');
eq(fmtT(regen.slots[1].start), '09:50', '重排：第 2 节 = 上一节结束 + 5 分钟课间');
eq(fmtT(regen.slots[2].end), '11:25', '重排后第 3 节结束 11:25');
eq(fmtT(Core.slotOf(regen, 4).start), '14:30', '重排保留下午起始时间');

const round = Core.deserializeSlotTable(Core.serializeSlotTable(custom));
eq(round.slots.length, 5, '序列化往返：节数一致');
eq(fmtT(round.slots[2].start), '11:00', '序列化往返：时间一致');
eq(round.joinMode, 'gap', '序列化往返：joinMode 一致');
eq(Core.deserializeSlotTable({ v: 1, rows: [] }), null, '空行 -> 反序列化返回 null');
eq(Core.deserializeSlotTable(null), null, '空值 -> 反序列化返回 null');

section('节次表 · 预设');
eq(Core.SLOT_PRESETS.length >= 4, true, '至少 4 套内置作息');
Core.SLOT_PRESETS.forEach(p => {
  const t = Core.makeSlotTable(p.name, p.rows);
  eq(t.slots.length, p.rows.length, `预设「${p.id}」节数一致`);
});
// 按 id 取而不是按下标：预设列表会增删，下标一挪这些断言就集体误报
const presetById = id => Core.SLOT_PRESETS.find(p => p.id === id);
const p10 = Core.makeSlotTable('p10', presetById('compact10').rows);
eq(Core.previewSlots(p10, [1, 2]).blocks.length, 1, '预设预览：紧凑 10 节 [1,2] -> 1 个事件');
eq(Core.slotGroups(p10).map(g => g.label).join(','), '上午,下午,晚上', '分组归档顺序正确');
eq(Core.slotTimeText(p10.slots[0]), '08:00–08:45', 'slotTimeText 格式');

section('展开：基本');
let out = Core.expandCourse(course('高等数学'), SEM, SLOTS, []);
eq(out.events.length, 1, '周一 1-2 节 16 周 -> 1 个事件');
eq(out.events[0].occurrences.length, 16, '16 次课');
eq(Core.wallISO(out.events[0].occurrences[0].start), '2026-09-07', '第 1 次 2026-09-07');
eq(Core.wallISO(out.events[0].occurrences[15].start), '2026-12-21', '第 16 次 2026-12-21');
eq(Core.wallHHMM(out.events[0].occurrences[0].start), '08:00', '墙钟时间 08:00');

out = Core.expandCourse(course('线性代数', { weekday: 2, slots: [3, 4], weeks: [1,3,5,7,9,11,13,15] }), SEM, SLOTS, []);
eq(out.events[0].occurrences.map(o => o.week), [1,3,5,7,9,11,13,15], '单周 -> 8 次奇数周');

out = Core.expandCourse(course('数据结构', { weekday: 3, slots: [2, 3] }), SEM, SLOTS, []);
eq(out.events.length, 2, '[2,3] 节 -> 两个事件（两个时间块）');
eq(out.events[0].occurrences.length, 16, '每个块 16 次');
eq(out.events[1].occurrences.length, 16, '每个块 16 次');

section('展开：日期例外');
out = Core.expandCourse(course('高等数学'), SEM, SLOTS, [holiday('2026-09-21', '中秋节')]);
eq(out.events[0].occurrences.length, 15, '放假一次 -> 15 次课');
eq(out.stats.skippedByHoliday, 1, '假日跳过计数');
eq(out.events[0].exdates.map(Core.wallISO), ['2026-09-21'], 'EXDATE 记录了被排除的日期');
ok(!out.events[0].occurrences.some(o => Core.wallISO(o.start) === '2026-09-21'), '该日确实无课');

out = Core.expandCourse(course('高等数学'), SEM, SLOTS,
  [{ kind: 'holiday', date: Core.parseISODate('2026-09-21'), name: '校庆', skipClasses: false }]);
eq(out.events[0].occurrences.length, 16, '不跳课的假日不影响课次');

out = Core.expandCourse(course('高等数学'), SEM, SLOTS,
  [{ kind: 'cancelAll', date: Core.parseISODate('2026-09-21') }]);
eq(out.events[0].occurrences.length, 15, '整天停课');
eq(out.stats.skippedByCancel, 1, '停课计数');

out = Core.expandCourse(course('高等数学'), SEM, SLOTS,
  [{ kind: 'roomOverride', date: Core.parseISODate('2026-09-28'), courseId: 'c_高等数学', room: '教三401' }]);
const moved = out.events[0].occurrences.find(o => Core.wallISO(o.start) === '2026-09-28');
eq(moved.room, '教三401', '换教室生效');
eq(out.events[0].occurrences[0].room, '教一301', '其他日期不受影响');

out = Core.expandCourse(course('高等数学'), SEM, SLOTS,
  [{ kind: 'makeup', date: Core.parseISODate('2026-09-12'), courseId: 'c_高等数学',
     slots: [5, 6], room: '教二205' }]);
eq(out.events.length, 2, '补课 -> 额外一个事件');
const mk = out.events.find(e => e.isMakeup);
eq(Core.wallISO(mk.occurrences[0].start), '2026-09-12', '补课日期');
eq(Core.wallHHMM(mk.occurrences[0].start), '14:00', '补课时间 14:00');

section('展开：跨年');
const SEM18 = Core.buildSemester({
  name: '长学期', firstDay: Core.parseISODate('2026-09-07'), totalWeeks: 18, offsetMinutes: 480
});
eq(Core.weekIndexOf(SEM18, Core.parseISODate('2027-01-04')), 18, '跨年后第 18 周仍正确（不用 weekOfYear）');
const out18 = Core.expandCourse(
  { id: 'x', name: '大学英语', teacher: '', room: '', courseType: 'required',
    patterns: [{ weekday: 1, slots: [1, 2], weekMask: (function () {
      const m = new Core.WeekMask(18); for (let i = 1; i <= 18; i++) m.add(i); return m;
    })() }] },
  SEM18, SLOTS, []);
eq(out18.events[0].occurrences.length, 18, '跨年学期 18 次课');
eq(Core.wallISO(out18.events[0].occurrences[17].start), '2027-01-04', '最后一次落在 2027-01-04');

section('事件计划与确定性 UID');
const P1 = expand([course('高等数学')]);
const P2 = expand([course('高等数学')]);
eq(P1.events.length, 1, '一个事件');
eq(P1.events[0].rrule, { interval: 1, count: 16 }, 'RRULE: 每周 ×16');
eq(Core.wallISO(P1.events[0].start), '2026-09-07', 'DTSTART');
eq(P1.events.map(e => e.uid), P2.events.map(e => e.uid), '★ 同一输入两次 -> UID 完全一致');
eq(P1.events[0].uid.length, 36, 'UID 是标准 UUID 格式');

const sameRoomDiff = expand([course('高等数学', { room: '教三401' })]);
eq(sameRoomDiff.events[0].uid, P1.events[0].uid, '★ 只改教室 -> UID 不变（判为 update）');

const diffTeacher = expand([course('高等数学', { teacher: '李老师' })]);
eq(diffTeacher.events[0].uid, P1.events[0].uid, '★ 只改教师 -> UID 不变');

const diffSlots = expand([course('高等数学', { slots: [3, 4] })]);
ok(diffSlots.events[0].uid !== P1.events[0].uid, '★ 改节次 -> UID 变化');

const diffName = expand([course('数学分析')]);
ok(diffName.events[0].uid !== P1.events[0].uid, '改课程名 -> UID 变化');

// 停课不应改变 UID（否则每次放假都会"删了重建"）
const withHoliday = expand([course('高等数学')], [holiday('2026-09-21', '中秋节')]);
eq(withHoliday.events[0].uid, P1.events[0].uid, '★ 增加一天停课 -> UID 不变');

section('EXDATE 与 DTSTART 的配合');
const h1 = expand([course('高等数学')], [holiday('2026-09-21', '中秋节')]).events[0];
eq(h1.rrule.count, 16, '中间停课：COUNT 保持理论值 16');
eq(h1.exdates.map(Core.wallISO), ['2026-09-21'], '被排除的日期进入 EXDATE');
eq(h1.occurrenceCount, 15, '实际课次 15');

// 第 1 周就被停课（DTSTART 落在被排除日）—— 必须调整 DTSTART 与 COUNT
const h2 = expand([course('高等数学')], [holiday('2026-09-07', '开学典礼')]).events[0];
eq(Core.wallISO(h2.start), '2026-09-14', '首次课被停 -> DTSTART 顺移到下一次');
eq(h2.rrule.count, 15, 'COUNT 相应减去被跳过的次数');
eq(h2.exdates.length, 0, '不再需要 EXDATE');
eq(h2.occurrenceCount, 15, '实际课次 15');

section('ICS 生成');
const ICS1 = Core.buildICS(P1.events, { offsetMinutes: 480, calendarName: '课表 2026秋' });
ok(ICS1.indexOf('BEGIN:VCALENDAR') === 0, '以 BEGIN:VCALENDAR 开头');
ok(/\r\nEND:VCALENDAR\r\n$/.test(ICS1), '以 END:VCALENDAR 结尾且用 CRLF');
ok(ICS1.indexOf('VERSION:2.0') >= 0, '含 VERSION');
ok(ICS1.indexOf('X-WR-CALNAME:课表 2026秋') >= 0, '含日历名');
ok(ICS1.indexOf('UID:' + P1.events[0].uid + '@schedule-importer') >= 0, '含 UID');
ok(ICS1.indexOf('DTSTART:20260907T000000Z') >= 0, '北京时间 08:00 -> UTC 00:00（写 Z 免 VTIMEZONE）');
ok(ICS1.indexOf('DTEND:20260907T013500Z') >= 0, '结束时间 09:35 -> 01:35Z');
ok(ICS1.indexOf('RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=16') >= 0, 'RRULE 正确');
ok(ICS1.indexOf('TRIGGER:-PT10M') >= 0, '含提醒');

const ICS2 = Core.buildICS(expand([course('高等数学')], [holiday('2026-09-21', '中秋节')]).events,
  { offsetMinutes: 480 });
ok(ICS2.indexOf('EXDATE:20260921T000000Z') >= 0, 'EXDATE 正确写入');

// 行折叠：75 八位组上限，中文按字符边界切
const longTitle = '这是一门名字非常非常长的课程用来测试行折叠功能是否正确处理多字节字符边界问题';
const folded = Core.foldLine('SUMMARY:' + longTitle);
const foldedLines = folded.split('\r\n');
ok(foldedLines.length > 1, '超长行被折叠');
ok(foldedLines.slice(1).every(l => l.charAt(0) === ' '), '续行以空格开头');
ok(foldedLines.every(l => new TextEncoder().encode(l).length <= 75), '每一行都不超过 75 字节');
eq(foldedLines.map(l => l.charAt(0) === ' ' ? l.slice(1) : l).join(''), 'SUMMARY:' + longTitle,
   '★ 折叠后能无损还原（中文没被从中间切断）');

eq(Core.escapeICS('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne', 'ICS 文本转义');

const ICS3 = Core.buildICS(expand([course('高等数学, 上', { room: '教一301; 东区' })], []).events, {});
ok(ICS3.indexOf('SUMMARY:高等数学\\, 上') >= 0, '标题中的逗号被转义');
ok(ICS3.indexOf('LOCATION:教一301\\; 东区') >= 0, '地点中的分号被转义');

section('ICS 幂等（除 DTSTAMP 外逐字节一致）');
const strip = s => s.split('\r\n').filter(l => l.indexOf('DTSTAMP:') !== 0).join('\r\n');
const a1 = Core.buildICS(expand([course('高等数学'), course('线性代数', { weekday: 2 })]).events, {});
const a2 = Core.buildICS(expand([course('高等数学'), course('线性代数', { weekday: 2 })]).events, {});
eq(strip(a1), strip(a2), '★ 同一课表两次导出 -> 除时间戳外完全相同');

section('冲突检测');
let conflicts = Core.detectConflicts(
  [course('高等数学', { room: 'A' }), course('大学英语', { room: 'B' })], SEM, SLOTS, []);
eq(conflicts.length, 1, '同天同时段两门课 -> 1 组冲突');
eq(conflicts[0].dates.length, 16, '冲突 16 次');
eq(conflicts[0].suggestion, '时间冲突', '建议：时间冲突');

// 两门「彼此独立」的同名课（id 不同）。解析器会把同名课合并，
// 这里模拟手工构造 / 合并后仍残留的情况。
const dupA = course('高等数学', { room: 'A' }); dupA.id = 'dup_a';
const dupB = course('高等数学', { room: 'A' }); dupB.id = 'dup_b';
conflicts = Core.detectConflicts([dupA, dupB], SEM, SLOTS, []);
eq(conflicts.length, 1, '两门独立同名课 -> 报冲突');
eq(conflicts[0].suggestion, '疑似重复解析', '同名同地点 -> 疑似重复解析');

const roomA = course('高等数学', { room: 'A' }); roomA.id = 'r_a';
const roomB = course('高等数学', { room: 'B' }); roomB.id = 'r_b';
conflicts = Core.detectConflicts([roomA, roomB], SEM, SLOTS, []);
eq(conflicts[0].suggestion, '同名不同教室', '同名不同地点');

conflicts = Core.detectConflicts(
  [course('高等数学', { slots: [1, 2] }), course('大学英语', { slots: [3, 4] })], SEM, SLOTS, []);
eq(conflicts.length, 0, '时间不重叠 -> 无冲突');

conflicts = Core.detectConflicts([course('高等数学')], SEM, SLOTS, []);
eq(conflicts.length, 0, '同一门课不算自我冲突');

// 单周 vs 双周：时间重叠但周次不相交 -> 不应报冲突
conflicts = Core.detectConflicts([
  course('线性代数', { weekday: 2, slots: [3, 4], weeks: [1,3,5,7,9,11,13,15] }),
  course('大学英语', { weekday: 2, slots: [3, 4], weeks: [2,4,6,8,10,12,14,16] })
], SEM, SLOTS, []);
eq(conflicts.length, 0, '★ 单周与双周时间重叠但周次不相交 -> 不误报');

section('文本解析');
const TEXT = [
  '课程名称\t教师\t周次\t星期\t节次\t教室',
  '高等数学\t张老师\t1-16周\t周一\t1-2\t教一301',
  '线性代数\t李老师\t1-16周(单)\t周二\t3-4\t教二205',
  '大学英语\t王老师\t1-16周(双)\t周二\t3-4\t教二206',
  '数据结构\t陈老师\t3-15周\t周三\t2-3\t教三101',
  '体育\t赵老师\t1-16周\t周五\t7-8\t操场'
].join('\n');
const T = Core.parseDelimitedText(TEXT, 16, {});
eq(T.courses.length, 5, '解析出 5 门课');
eq(T.headerDetected, true, '识别到表头');
eq(T.separator, '制表符', '分隔符嗅探');
eq(T.courses[0].name, '高等数学', '课程名');
eq(T.courses[0].teacher, '张老师', '教师');
eq(T.courses[0].room, '教一301', '地点');
eq(T.courses[0].patterns[0].weekday, 1, '星期');
eq(T.courses[0].patterns[0].slots, [1, 2], '节次');
eq(T.courses[0].patterns[0].weekMask.weeks().length, 16, '周次');
eq(T.courses[1].patterns[0].weekMask.weeks(), [1,3,5,7,9,11,13,15], '单周');
eq(T.courses[4].courseType, 'pe', '「体育」类型推断');
eq(T.warnings.length, 0, '干净输入无警告');

const T2 = Core.parseDelimitedText('课程名称,周次,星期,节次\n高等数学,1-16周,周一,1-2', 16, {});
eq(T2.separator, '逗号', '逗号分隔');
eq(T2.courses.length, 1, '逗号分隔解析');

const T3 = Core.parseDelimitedText('高等数学\t张老师\t1-16周\t周一\t1-2\t教一301', 16, {});
eq(T3.headerDetected, false, '无表头');
eq(T3.courses.length, 1, '无表头时按默认列序解析');
ok(T3.warnings.length > 0, '无表头产生警告');

const T4 = Core.parseDelimitedText('课程名称\t周次\t星期\t节次\n某课\t1-16周\t星期八\t1-2', 16, {});
eq(T4.courses.length, 0, '无法识别的星期 -> 跳过该行');
ok(T4.warnings.some(w => /星期/.test(w.message)), '产生可定位到行的警告');

const T5 = Core.parseDelimitedText('课程名称\t周次\t星期\t节次\n某课\t\t周一\t1-2', 16, {});
eq(T5.courses[0].patterns[0].weekMask.weeks().length, 16, '周次缺失 -> 默认全学期');
ok(!T5.warnings.some(w => /无法识别/.test(w.message)),
   '★ 周次留空不报警告（默认整学期是合理行为，每门课都报太吵）');

// 写了却看不懂 -> 必须出声，否则用户只会觉得「App 排错了」
const T5b = Core.parseDelimitedText('课程名称\t周次\t星期\t节次\n某课\t待定\t周一\t1-2', 16, {});
eq(T5b.courses[0].patterns[0].weekMask.weeks().length, 16, '看不懂的周次兜底成整学期');
ok(T5b.warnings.some(w => /无法识别/.test(w.message)),
   '★ 周次「待定」看不懂 -> 明确警告（兜底成每周会多出课）');

// 同名课程多个时间段应合并为一门课、多个 pattern
const T6 = Core.parseDelimitedText(
  '课程名称\t周次\t星期\t节次\n高等数学\t1-16周\t周一\t1-2\n高等数学\t1-16周\t周三\t3-4', 16, {});
eq(T6.courses.length, 1, '同名课程合并为一门');
eq(T6.courses[0].patterns.length, 2, '保留两个上课时段');

// 完全重复的行（教务表合并单元格常导致）必须被去重，否则会生成两个重叠事件
const T7 = Core.parseDelimitedText(
  '课程名称\t周次\t星期\t节次\n高等数学\t1-16周\t周一\t1-2\n高等数学\t1-16周\t周一\t1-2', 16, {});
eq(T7.courses.length, 1, '完全重复的行合并为一门课');
eq(T7.courses[0].patterns.length, 1, '★ 完全重复的上课时段被自动去重');
ok(T7.warnings.some(w => /重复/.test(w.message)), '产生重复提示');

eq(Core.parseSlotIndices('1-2'), [1, 2], '节次 1-2');
eq(Core.parseSlotIndices('第1-2节'), [1, 2], '节次 第1-2节');
eq(Core.parseSlotIndices('3、4'), [3, 4], '节次 3、4');
eq(Core.parseSlotIndices('5'), [5], '节次 5');
eq(Core.splitCSVLine('a,"b,c",d'), ['a', 'b,c', 'd'], 'CSV 引号包裹的逗号');

section('端到端');
const plan = Core.planEvents(T.courses, SEM, SLOTS, [
  holiday('2026-10-01', '国庆节'),
  holiday('2026-10-02', '国庆节'),
  holiday('2026-10-05', '国庆假期'),
  holiday('2026-10-06', '国庆假期'),
  holiday('2026-10-07', '国庆假期'),
  { kind: 'cancelAll', date: Core.parseISODate('2026-11-11') }
], { titleTemplate: '{课程名}', reminderMinutes: 10 });

ok(plan.events.length > 0, '生成事件');
eq(plan.events.every(e => e.uid && e.uid.length === 36), true, '每个事件都有 UID');
eq(new Set(plan.events.map(e => e.uid)).size, plan.events.length, '无 UID 碰撞');
const covered = plan.events.reduce((s, e) => s + e.occurrenceCount, 0);
eq(plan.events.every(e => e.occurrenceCount > 0), true, '每个事件至少覆盖 1 次课');
ok(covered > 0, '总课次 > 0');

const ics = Core.buildICS(plan.events, { offsetMinutes: 480, calendarName: '课表 2026秋' });
const veventCount = (ics.match(/BEGIN:VEVENT/g) || []).length;
eq(veventCount, plan.events.length, 'VEVENT 数量与事件数一致');
eq((ics.match(/BEGIN:VCALENDAR/g) || []).length, 1, '只有一个 VCALENDAR');
eq((ics.match(/END:VCALENDAR/g) || []).length, 1, 'VCALENDAR 正确闭合');
eq((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length,
   'VEVENT 开闭配对');
// 每个 VEVENT 必须含 UID / DTSTAMP / DTSTART / SUMMARY
const vevents = ics.split('BEGIN:VEVENT').slice(1);
eq(vevents.every(v => /UID:/.test(v) && /DTSTAMP:/.test(v) && /DTSTART:/.test(v) && /SUMMARY:/.test(v)),
   true, '每个 VEVENT 字段完整');

section('国庆假期效果抽查');
const mathOnly = Core.planEvents([course('高等数学')], SEM, SLOTS, [
  holiday('2026-10-05', '国庆假期')
], {});
eq(mathOnly.events[0].occurrenceCount, 15, '高数 16 周 - 国庆 1 次 = 15 次');
eq(mathOnly.events[0].exdates.map(Core.wallISO), ['2026-10-05'], 'EXDATE 收录国庆那天');
eq(mathOnly.events[0].rrule.count, 16, '仍是一条 COUNT=16 的规则（未被断成两段）');
eq(mathOnly.events.length, 1, '★ 只有 1 个事件（对比原生 EventKit 需拆成 2 个）');

const ds = Core.planEvents([course('数据结构', { weekday: 3, slots: [2, 3] })], SEM, SLOTS, [
  holiday('2026-10-07', '国庆假期')
], {});
eq(ds.events.length, 2, '[2,3] 节 -> 2 个事件（两个时间块）');
eq(ds.events[0].occurrenceCount, 15, '每个块 15 次');
eq(ds.events[0].exdates.length, 1, '每个块各 1 个 EXDATE');

/* ============================================================
   具名节次（中午1 / 早读）—— 按真实研究生课表补的一组用例
   ============================================================ */

{
const NOON = Core.makeSlotTable('11 节 + 中午 2 节', [
  [1, 8, 0, 8, 50, '上午'], [2, 8, 55, 9, 45, '上午'],
  [3, 10, 15, 11, 5, '上午'], [4, 11, 10, 12, 0, '上午'],
  ['中午1', 12, 5, 12, 55, '中午'], ['中午2', 13, 35, 14, 25, '中午'],
  [5, 14, 30, 15, 20, '下午'], [6, 15, 25, 16, 15, '下午'],
  [7, 16, 35, 17, 25, '下午'], [8, 17, 30, 18, 20, '下午'],
  [9, 19, 0, 19, 50, '晚上'], [10, 19, 55, 20, 45, '晚上'],
  [11, 20, 50, 21, 40, '晚上']
], { maxBreak: 5, joinMode: 'gap' });

section('具名节次 · 作息表模型');
eq(NOON.slots.length, 13, '13 节（11 节正课 + 中午 2 节）');
eq(NOON.slots.map(s => s.key).join(','),
   '1,2,3,4,中午1,中午2,5,6,7,8,9,10,11', '★ 数组顺序 = 时间顺序，中午落在 4 与 5 之间');
eq(NOON.slots[4].label, '中午1', '具名节次带 label');
eq(NOON.slots[4].index, null, '具名节次没有数字编号');
eq(NOON.slots[6].index, 5, '数字节次仍带编号，且编号不等于位置（它是第 7 个）');
eq(Core.slotOf(NOON, '中午1').key, '中午1', 'slotOf 认具名 key');
eq(Core.slotOf(NOON, 5).key, '5', 'slotOf 认数字');
eq(Core.slotOf(NOON, '5').key, '5', 'slotOf 认数字字符串');
eq(Core.posOf(NOON, '中午2'), 5, 'posOf 给的是位置');
eq(Core.posOf(NOON, 99), -1, 'posOf：不在表里 -> -1');
eq(Core.slotName(NOON.slots[4]), '中午1', 'slotName 展示名');
eq(Core.slotName(NOON.slots[6]), '5', 'slotName：数字节次就是编号');

section('具名节次 · 文本解析');
const refStr = s => Core.parseSlotRefs(s, NOON).refs.join(',');
eq(refStr('中午2–6节'), '中午2,5,6', '★ 混合范围按位置展开（不是 2,3,4,5,6）');
eq(refStr('中午2-6节'), '中午2,5,6', '全角/半角破折号等价');
eq(refStr('中午第1节课'), '中午1', '★ 作息表写法 -> 节次列写法（别名）');
eq(refStr('午2'), '中午2', '缩写别名');
eq(refStr('11节'), '11', '数字节次解析成 number，不是字符串');
eq(refStr('3-4节'), '3,4', '普通范围不变');
eq(refStr('1,3'), '1,3', '跳号');
eq(refStr('中午1-2节'), '中午1,中午2', '★ 同前缀消歧：中午1-2 是中午两节，不是 2,3,4,中午1');
eq(Core.parseSlotRefs('第3节课', NOON).refs.join(','), '3', '「第 N 节课」写法');

section('具名节次 · 认不出来就不猜');
const noNamed = Core.makeStandard12();
const guard = Core.parseSlotRefs('中午2-6节', noNamed);
eq(guard.refs.length, 0, '★ 作息表里没有中午节次 -> 不返回任何引用（旧代码会静默读成 2,3,4,5,6）');
ok(guard.warnings.some(w => /中午/.test(w) && /作息表/.test(w)), '并提示去作息表里补一行');
const oob = Core.parseSlotRefs('20节', NOON);
eq(oob.refs.length, 0, '编号超出表内范围 -> 丢弃');
ok(oob.warnings.some(w => /不在节次表中/.test(w)), '超范围有警告');
eq(Core.parseSlotRefs('中午2-6节', NOON).warnings.length, 0, '能认出来的写法不该有警告');

section('具名节次 · 连堂按位置合并');
const pvNoon = Core.previewSlots(NOON, Core.parseSlotRefs('中午2–6节', NOON).refs);
eq(pvNoon.blocks.length, 1, '★ 中午2 + 5 + 6 课间各 5 分钟 -> 一次长课');
eq(pvNoon.blocks[0].time, '13:35–16:15', '长课跨度 13:35–16:15');
eq(pvNoon.blocks[0].text, '中午2-6节', '块的节次文案');
eq(Core.resolveSlots(NOON, [4, 5], { joinMode: 'keep' }).blocks.length, 2,
   '★ keep 也不会把上午末节与下午首节并成跨午休的事件（位置不相邻）');
eq(Core.resolveSlots(NOON, [4, 5], { joinMode: 'gap' }).blocks.length, 2, 'gap 同样拆开');
eq(Core.resolveSlots(NOON, [4, '中午1']).blocks.length, 1, '4 与 中午1 课间 5 分钟 -> 合并');
eq(Core.resolveSlots(NOON, ['中午1', '中午2']).blocks.length, 2, '中午1 与 中午2 之间 40 分钟 -> 拆开');
eq(Core.resolveSlots(NOON, [2, 3]).blocks.length, 2, '2→3 大课间 30 分钟 -> 拆开');
eq(Core.resolveSlots(NOON, [9, 10, 11]).blocks[0].slotsText, '9-11节', '晚间三连堂文案');
eq(Core.resolveSlots(NOON, [1, 3]).blocks.length, 2, '跳号永不合并');

section('周次不再被节次数字污染');
eq(Core.parseWeekMask('13–13周:连续周 星期四 中午2–6节', 18).mask.summary(), '13周',
   '★ 节次的 2–6 不再被当成周次（旧代码给出 2-6,13周）');
eq(Core.parseWeekMask('第5–5周:连续周重复 星期四 中午2–6节', 18).mask.summary(), '5周',
   '★ 带「第」「重复」的写法同样正确（旧代码给出 2-6周）');
eq(Core.parseWeekMask('3–18周:单周 星期五 3–4节', 18).mask.summary(), '3,5,7,9,11,13,15,17周',
   '单周 + 节次共存');
eq(Core.parseWeekMask('3–18周:连续周 星期一 3–4节', 18).mask.summary(), '3-18周', '连续周 + 节次');
eq(Core.parseWeekMask('1-16周', 16).mask.summary(), '1-16周', '纯周次不受影响');
eq(Core.extractSlotSegment('13–13周:连续周 星期四 中午2–6节'), '中午2-6', '从整行里截出节次片段');
eq(Core.extractSlotSegment('1-16周'), null, '没有「节」字 -> 不截');

section('带标签格子（研究生教务导出的真实形态）');
const LABELED = '课程:高等数学（A班）\n班级:高等数学（A班）3\n(教一301)\n13–13周:连续周 星期四 中午2–6节\n主讲教师:张老师';
const lab = Core._internals.parseMatrixCell(LABELED, 18, NOON);
eq(lab.name, '高等数学（A班）', '★ 剥掉「课程:」前缀（旧代码课名带着前缀）');
eq(lab.teacher, '张老师', '★ 「主讲教师:」前缀式写法能认（旧代码教师全空）');
eq(lab.room, '教一301', '★ 单独一行的 (教一301) 认作地点（旧代码填成「班级:」整行）');
eq(lab.mask.summary(), '13周', '格子里的周次不再被节次污染');
eq(lab.slots.join(','), '中午2,5,6', '格子里显式写的节次被提取出来');
const unlabeled = Core._internals.parseMatrixCell('高等数学\n张老师\n1-16周\n教一301', 16, noNamed);
eq(unlabeled.name, '高等数学', '无标签的格子仍走启发式：课名正确');
eq(unlabeled.teacher, '张老师', '无标签：教师正确');
eq(unlabeled.room, '教一301', '无标签：地点正确（没被当成课名）');
eq(unlabeled.slots, null, '无标签且不含「节」-> 节次交给行标签');

const realGrid = [
  ['节次', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日期'],
  ['1', '', '', '', '', '', '', ''],
  ['2', '', '', '', '', '', '', ''],
  ['3', '', '课程:大学英语\n班级:大学英语5\n(教二205)\n3–18周:连续周 星期二 3–4节\n主讲教师:李老师',
       '', '', '课程:线性代数\n班级:数学2班\n(教三101)\n3–18周:单周 星期五 3–4节\n主讲教师:王老师', '', ''],
  ['4', '', '', '', '', '', '', ''],
  ['中午1', '', '', '', '', '', '', ''],
  ['中午2', '', '', '', LABELED, '', '', ''],
  ['5', '课程:数据结构\n班级:计算机2班\n(计算中心A302)\n3–18周:连续周 星期一 中午2–6节\n主讲教师:陈老师',
       '', '', '', '', '', ''],
  ['6', '', '', '', '', '', '', ''],
  ['7', '', '', '', '', '', '', ''],
  ['8', '', '', '', '', '', '', ''],
  ['9', '', '', '', '课程:大学物理实验\n班级:物理1班\n(实验楼B203)\n3–18周:连续周 星期四 11节\n主讲教师:刘老师',
       '', '', '']
];
const realRes = Core.coursesFromGrid(realGrid, 18, { slotTable: NOON });
eq(realRes.layout, 'matrix', '识别为矩阵型');
eq(realRes.courses.length, 5, '5 门课');
const find = n => realRes.courses.find(c => c.name === n);
eq(find('高等数学（A班）').patterns[0].slots.join(','), '中午2,5,6', '★ 高等数学的节次');
eq(find('高等数学（A班）').patterns[0].weekMask.summary(), '13周', '★ 高等数学只有第 13 周');
eq(find('数据结构').patterns[0].weekday, 1, '数据结构在星期一');
eq(find('数据结构').patterns[0].slots.join(','), '中午2,5,6', '★ 行标签是 5，但格子里写中午2–6 -> 按格子');
eq(find('线性代数').patterns[0].weekMask.weeks(), [3, 5, 7, 9, 11, 13, 15, 17], '单周');
eq(find('大学物理实验').patterns[0].slots.join(','), '11', '★ 行标签 9 vs 格子 11节 -> 按格子');
ok(realRes.warnings.some(w => /合并单元格/.test(w.message)), '★ 行标签与格子不一致时给出提示');
ok(realRes.warnings.some(w => /格子里写的节次是「11」/.test(w.message)), '提示里写清楚两边各是什么');

/* 从这份真实课表一路走到 .ics */
const realPlan = Core.planEvents(
  find('高等数学（A班）') && [find('高等数学（A班）'), find('大学英语')],
  Core.buildSemester({ name: '2026秋', firstDay: Core.parseISODate('2026-09-07'), totalWeeks: 18 }),
  NOON, [], { titleTemplate: '{课程名}', reminderMinutes: 10 });
const noonEv = realPlan.events.filter(e => /中午/.test(e.slotsText));
eq(noonEv.length, 1, '高等数学的中午长课 -> 1 个事件');
eq(Core.wallHHMM(noonEv[0].start), '13:35', '中午长课 13:35 开始');
eq(Core.wallHHMM(noonEv[0].end), '16:15', '中午长课 16:15 结束');

section('作息表识别（课表底部那张小表）');
const bell = Core.parseBellSchedule(
  '上午:\t下午:\t晚上:\n'
  + '第1节课 8:00–8:50\t第5节课 14:30–15:20\t第9节课 19:00–19:50\n'
  + '第2节课 8:55–9:45\t第6节课 15:25–16:15\t第10节课 19:55–20:45\n'
  + '中午第1节课 12:05–12:55\t中午第2节课 13:35–14:25');
eq(bell.rows.length, 8, '识别出 8 节（3 列 × 若干行）');
eq(bell.rows.map(r => r[0]).join(','), '1,5,9,2,6,10,中午1,中午2',
   '「第N节课」-> N，「中午第1节课」-> 中午1');
const bt = Core.makeSlotTable('识别出来的作息', bell.rows);
eq(bt.slots.map(s => s.key).join(','), '1,2,中午1,中午2,5,6,9,10',
   '★ 按时间排序：中午两节落在上午与下午之间');
eq(Core.slotTimeText(Core.slotOf(bt, '中午1')), '12:05–12:55', '具名节次时间正确');
eq(Core.slotOf(bt, '中午1').group, '上午', '分组取自所在列的表头');
const bellBad = Core.parseBellSchedule('这是一份课表，但没有时间');
eq(bellBad.rows.length, 0, '认不出来时返回空');
ok(bellBad.warnings.length > 0, '并说明需要什么格式');

section('作息表持久化与重排');
const ser = Core.serializeSlotTable(NOON);
eq(ser.v, 2, '序列化版本号 2');
const back = Core.deserializeSlotTable(ser);
eq(back.slots.map(s => s.key).join(','), NOON.slots.map(s => s.key).join(','), '往返后节次与顺序一致');
eq(back.slots[4].label, '中午1', '往返保住具名节次');
const v1 = { v: 1, name: '旧存档', maxBreak: 5, joinMode: 'gap',
  rows: [[1, 8, 0, 8, 45, '上午'], [2, 9, 0, 9, 45, '上午']] };
const migrated = Core.deserializeSlotTable(v1);
eq(migrated && migrated.slots.length, 2, '★ 旧的 v1 存档（纯数字）仍能读');
eq(migrated.slots[0].key, '1', 'v1 -> v2：数字编号变成 key');
const regen = Core.regenerateSlots(NOON, 45, 5);
eq(Core.slotOf(regen, '中午1').start.h, 12, '★ 重排不动具名节次（中午那节仍 12:05 起）');
eq(Core.slotOf(regen, '中午1').start.m, 5, '中午1 的分钟也没动');
eq(Core.slotOf(regen, '中午2').start.h, 13, '中午2 同样保持');
eq(Core.slotOf(regen, 2).start.h, 8, '数字节次按 45+5 顺推');
eq(Core.slotOf(regen, 2).start.m, 50, '第 2 节被重排到 08:50');

section('★ UID 稳定性（节次改造不能让用户日历长出重复事件）');
// 摘要值取自改造前的实现：纯数字节次场景下 slotsText 逐字节未变，
// 因此 eventUID 也未变。将来若有人动了 slotsText 的拼法，这里会立刻红。
const sem16 = Core.buildSemester({ name: '2026秋季', firstDay: Core.parseISODate('2026-09-07'),
  totalWeeks: 16, offsetMinutes: 480 });
function uidCourse(n, wd, sl, wk, room, teacher, type) {
  return { id: 'u_' + n, name: n, teacher: teacher || '张老师', room: room || '教一301',
    courseType: type || 'required',
    patterns: [{ weekday: wd, slots: sl, weekMask: wk || everyMask(16) }] };
}
const uidPlan = Core.planEvents([
  uidCourse('高等数学', 1, [1, 2]),
  uidCourse('线性代数', 2, [3]),
  uidCourse('数据结构', 3, [2, 3]),
  uidCourse('大学英语', 4, [1, 3], maskOf([1, 3, 5, 7, 9, 11, 13, 15]), null, null, 'elective'),
  uidCourse('体育', 2, [7, 8], maskOf([2, 4, 6, 8]), '操场', '李老师', 'pe')
], sem16, SLOTS, [
  holiday('2026-10-01', '国庆节'),
  { kind: 'cancel', date: Core.parseISODate('2026-10-14'), courseId: 'u_高等数学' }
], { titleTemplate: '{课程名}', reminderMinutes: 10 });
eq(uidPlan.events.length, 7, '场景里有 7 个事件');
{
  // baseline-before.ics 是**改造前**那份内核生成的 .ics（5 套预设 × 3 种连堂策略，
  // 8 门课 92 个事件）。今天生成的必须与它逐字节相同，否则用户重复导入会多出重复事件。
  const fs = require('fs');
  const FIX = path.join(__dirname, 'baseline.ics');
  if (fs.existsSync(FIX)) {
    const before = fs.readFileSync(FIX, 'utf8');
    const today = require('../tools/baseline-ics.js').buildAll().join('\n') + '\n';
    eq(today.length, before.length, '基线 .ics 长度一致（' + before.length + ' 字符）');
    eq(today, before, '★ 与改造前的 .ics 逐字节一致：92 个 UID 全部未漂移');
  } else {
    console.log('  （baseline-before.ics 缺失，跳过逐字节对比）');
  }
}
eq(uidPlan.events.map(e => e.slotsText).join(' '), '1-2节 3节 2节 3节 1节 3节 7-8节',
   'slotsText 拼法保持原样');

}

/* ============================================================ */
section('排课卡片（教务「课程信息」一行一字段）');

{
  const noon = Core.SLOT_PRESETS.find(p => p.id === 'noon13');
  const NT = Core.makeSlotTable(noon.name, noon.rows);
  const cardOpts = { slotTable: NT };

  /* 用户实际截图里的那门课 */
  const cardText = [
    '课程:高等数学（A班）',
    '班级:高等数学（A班）3',
    '(教一301)',
    '5,9,13周 星期四 中午2-6节',
    '主讲教师:张老师'
  ].join('\n');

  const r = Core.parseDelimitedText(cardText, 16, cardOpts);
  eq(r.layout, 'card', '★ 识别为「课程信息」卡片格式');
  eq(r.courses.length, 1, '解析出 1 门课');

  const c = r.courses[0];
  eq(c.name, '高等数学（A班）', '课程名');
  eq(c.teacher, '张老师', '★ 教师来自「主讲教师:」前缀（不是结尾的「教师」）');
  eq(c.room, '教一301', '★ 地点取「(教一301)」，不是课程名里的「（混合）」');
  eq(c.klass, '高等数学（A班）3', '班级保留在单独字段');

  const pat = c.patterns[0];
  eq(pat.weekday, 4, '★ 星期四 -> ISO 4');
  eq(pat.weekMask.weeks(), [5, 9, 13], '★ 周次 5,9,13 三个离散周');
  eq(pat.slots, ['中午2', 5, 6], '★ 节次中午2-6 -> 中午2、5、6（按位置展开）');
  eq(pat.rawWeekText, '5,9,13周', '★ 周次框只留周次本身，不塞整行原文');

  /* 完整链路：这三周的课在日历上必须各出现一次，不能连成一片 */
  const SEMc = Core.buildSemester({
    name: '2026秋季', firstDay: Core.parseISODate('2026-09-07'),
    totalWeeks: 16, offsetMinutes: 480
  });
  const plan = Core.planEvents(r.courses, SEMc, NT, [], {});
  eq(plan.events.length, 1, '产出 1 个日历事件');
  eq(plan.events[0].slotsText, '中午2-6节', '节次文案');
  eq(Core.wallHHMM(plan.events[0].start), '13:35', '开始 13:35');
  eq(Core.wallHHMM(plan.events[0].end), '16:15', '结束 16:15');
  eq(plan.events[0].rrule, { interval: 4, count: 3 }, '★ RRULE = 每 4 周一次，共 3 次');
  eq(plan.events[0].weekSummary, '5,9,13周', '周次摘要');

  const ics = Core.buildICS(plan.events, { offsetMinutes: 480, calendarName: '课表' });
  ok(ics.indexOf('RRULE:FREQ=WEEKLY;INTERVAL=4;COUNT=3') >= 0,
     '★ ICS 里是 INTERVAL=4;COUNT=3，不是每周连续');
  /* 第 5/9/13 周的周四：10-08 / 11-05 / 12-03 */
  const d0 = plan.events[0].start;
  const d1 = new Date(d0.getTime() + 4 * 7 * 86400000);
  const d2 = new Date(d0.getTime() + 8 * 7 * 86400000);
  eq(Core.wallISO(d0), '2026-10-08', '第 1 次课 = 第 5 周周四');
  eq(Core.wallISO(d1), '2026-11-05', '★ 第 2 次课 = 第 9 周周四（隔 4 周）');
  eq(Core.wallISO(d2), '2026-12-03', '★ 第 3 次课 = 第 13 周周四');

  /* 多张卡片连贴 */
  const multi = cardText + '\n' + [
    '课程:数据结构',
    '(A302)',
    '3-18周 星期三 中午2,5,6节',
    '主讲教师:张三'
  ].join('\n');
  const r2 = Core.parseDelimitedText(multi, 16, cardOpts);
  eq(r2.courses.length, 2, '两张卡片 -> 2 门课');
  eq(r2.courses[1].name, '数据结构', '第二门课名');
  eq(r2.courses[1].room, 'A302', '第二门课地点');
  eq(r2.courses[1].patterns[0].slots, ['中午2', 5, 6], '★ 逗号罗列的「中午2,5,6节」也能解析');
  eq(r2.courses[1].patterns[0].weekMask.weeks().length, 14, '3-18 周按学期截断到 3..16，共 14 周');

  /* 被压成一行的卡片 */
  const oneLine = '课程:高等数学（A班） 班级:高等数学（A班）3 (教一301) 5,9,13周 星期四 中午2-6节 主讲教师:张老师';
  const r3 = Core.parseDelimitedText(oneLine, 16, cardOpts);
  eq(r3.courses.length, 1, '压成一行的卡片也能解析');
  eq(r3.courses[0].name, '高等数学（A班）', '★ 一行里课程名没有被后面的标签污染');
  eq(r3.courses[0].name.indexOf('班级'), -1, '课程名里不含「班级:」');
  eq(r3.courses[0].room, '教一301', '一行里也能取出 教一301');
  eq(r3.courses[0].patterns[0].slots, ['中午2', 5, 6], '一行里节次也对');

  /* 没设作息表时：要给出有用的话，而不是回落到表格解析 */
  const r4 = Core.parseDelimitedText(cardText, 16, {});
  eq(r4.courses.length, 0, '通用作息下取不出课');
  eq(r4.layout, 'card', '★ 仍然认定是卡片格式（不回落成表格）');
  ok(r4.warnings.some(w => w.level === 'error' && w.message.indexOf('卡片') >= 0),
     '★ 给出「识别为卡片但没取出课」的明确错误');
  ok(!r4.warnings.some(w => w.message.indexOf('星期「空」无法识别') >= 0),
     '★ 不再输出「星期空无法识别」这种牛头不对马嘴的提示');

  /* 回归：普通表格不能被误判成卡片 */
  const table = ['课程名称,教师,周次,星期,节次,教室',
                 '高等数学,张老师,1-16周,周一,1-2,教一301'].join('\n');
  const r5 = Core.parseDelimitedText(table, 16, cardOpts);
  eq(r5.layout === undefined || r5.layout !== 'card', true, '★ 普通 CSV 表格不会被误判成卡片');
  eq(r5.courses.length, 1, '普通表格仍解析出 1 门课');
  eq(r5.courses[0].name, '高等数学', '普通表格课程名正确');
  eq(r5.courses[0].patterns[0].slots, [1, 2], '普通表格节次正确');

  /* 回归：矩阵型也不能被误判 */
  const matrixLines = ['节次,周一,周二,周三,周四,周五',
                       '第1-2节,高等数学/张老师/1-16周/教一301,,,,'];
  eq(Core.looksLikeCardText(matrixLines), false, '★ 矩阵型表头不会被判成卡片');
  const plainLines = ['课程名称,教师,周次,星期,节次,教室',
                      '高等数学,张老师,1-16周,周一,1-2,教一301'];
  eq(Core.looksLikeCardText(plainLines), false, '★ 普通表格（表头无冒号）不会被判成卡片');
  eq(Core.looksLikeCardText(cardText.split('\n')), true, '卡片文本被判成卡片');

  /* 「5,9,13周」这种罗列不能被当成节次，节次也不能被当成周次 */
  const wm = Core.parseWeekMask('5,9,13周 星期四 中午2-6节', 16);
  eq(wm.mask.weeks(), [5, 9, 13], '★ 周次只取 5,9,13，不吃掉节次的 2-6');
  const wm2 = Core.parseWeekMask('3-18周 星期三 中午2,5,6节', 16);
  eq(wm2.mask.weeks()[0], 3, '★ 罗列型节次也不会污染周次起点');
  ok(wm2.mask.weeks().indexOf(2) < 0, '★ 周次里不含 2（那是节次的编号）');
}

/* ============================================================ */
section('单双周');

{
  const wk = t => {
    const r = Core.parseWeekMask(t, 16);
    return r ? r.mask.weeks() : null;
  };
  const mod = t => {
    const r = Core.parseWeekMask(t, 16);
    return r ? r.modifier : null;
  };

  eq(wk('1-16周(单)'), [1,3,5,7,9,11,13,15], '单周：半角括号');
  eq(wk('1-16周（单）'), [1,3,5,7,9,11,13,15], '单周：全角括号');
  eq(wk('1-16单周'), [1,3,5,7,9,11,13,15], '单周：无括号');
  eq(wk('单周'), [1,3,5,7,9,11,13,15], '单周：无区间');
  eq(wk('单数周'), [1,3,5,7,9,11,13,15], '单周：单数周');
  eq(wk('1-16单'), [1,3,5,7,9,11,13,15], '单周：数字后直接跟「单」');
  eq(wk('1-16周,单'), [1,3,5,7,9,11,13,15], '单周：逗号分隔');

  eq(wk('1-16周(双)'), [2,4,6,8,10,12,14,16], '双周：半角括号');
  eq(wk('1-16周（双）'), [2,4,6,8,10,12,14,16], '双周：全角括号');
  eq(wk('1-16双周'), [2,4,6,8,10,12,14,16], '双周：无括号');
  eq(wk('双周'), [2,4,6,8,10,12,14,16], '双周：无区间');
  eq(wk('双数周'), [2,4,6,8,10,12,14,16], '双周：双数周');
  eq(wk('2-16周(双)'), [2,4,6,8,10,12,14,16], '双周：显式从第 2 周起');

  /* ★「单双周」/「隔周」= 隔周上一次（课时减半），不是每周。
     字面上「单周 + 双周」很容易被读成「每周」，
     但业内口径说的是「隔周」这个属性本身。两者结果正好相反。 */
  eq(mod('单双周'), 'alternate', '★「单双周」判为隔周，不是每周');
  eq(wk('单双周'), [1,3,5,7,9,11,13,15], '★「单双周」= 隔周 8 次（不是每周 16 次）');
  eq(mod('1-16周 单双周'), 'alternate', '★ 带区间的「单双周」也是隔周');
  eq(wk('1-16周 单双周'), [1,3,5,7,9,11,13,15], '带区间的「单双周」= 1,3,5…');
  eq(wk('2-16周 单双周'), [2,4,6,8,10,12,14,16], '★ 从第 2 周起的「单双周」= 2,4,6…');
  eq(mod('单双'), 'alternate', '「单双」也是隔周');
  eq(mod('隔周'), 'alternate', '「隔周」这个词直接支持');
  eq(wk('隔周'), [1,3,5,7,9,11,13,15], '「隔周」默认从第 1 周起');
  ok(Core.parseWeekMask('隔周', 16).warnings.length > 0,
     '无区间的「隔周」给出提示（说明按第 1 周起算）');

  /* 「每周」仍然是每周，别被一起改掉 */
  eq(mod('每周'), 'every', '「每周」判为每周');
  eq(wk('1-8周 每周').length, 8, '带区间的「每周」按区间取，不被隔周影响');

  /* 直接罗列出来的单/双周次，不带任何修饰词 */
  eq(wk('1,3,5,7,9,11,13,15周'), [1,3,5,7,9,11,13,15], '直接罗列单周');
  eq(wk('2,4,6,8,10,12,14,16周'), [2,4,6,8,10,12,14,16], '直接罗列双周');

  /* --- 裸单/双的误判防护 ---
     周次那一行里还可能有别的字（卡片格式下整行原文都会进来），
     单字直接 indexOf 会把「双流校区」判成双周，16 周变 8 周。 */
  ['1-16周 双流校区', '双流校区 1-16周', '1-16周 单县校区',
   '1-16周 双语教学', '3-18周 双号教学楼', '1-16周 双向选择'].forEach(t => {
    eq(mod(t), 'unspecified', '★「' + t + '」不带单双周语义');
    ok(wk(t).length >= 14, '★「' + t + '」周次没被砍半（实得 ' + wk(t).length + ' 周）');
  });

  /* --- 单双周基准：本学期的第 1 周算单周还是双周 ---
     多数学校是「第 1 周 = 单周」。少数学校按自然年周数或学年连续编号，
     第 1 周会落在偶数上，此时单双周整体错开一格（正好相反）。 */
  eq(Core.parseWeekMask('1-16周(单)', 16, { oddWeek: 1 }).mask.weeks(),
     [1,3,5,7,9,11,13,15], '默认基准：第 1 周 = 单周');
  eq(Core.parseWeekMask('1-16周(单)', 16, { oddWeek: 2 }).mask.weeks(),
     [2,4,6,8,10,12,14,16], '★ 基准切到「第 1 周 = 双周」后，单周变成偶数周');
  eq(Core.parseWeekMask('1-16周(双)', 16, { oddWeek: 2 }).mask.weeks(),
     [1,3,5,7,9,11,13,15], '★ 双周跟着变成奇数周（整体错开一格）');
  eq(Core.parseWeekMask('单周', 16, { oddWeek: 2 }).mask.weeks(),
     [2,4,6,8,10,12,14,16], '无区间的「单周」也跟随基准');
  eq(Core.parseWeekMask('1-16周', 16, { oddWeek: 2 }).mask.weeks().length, 16,
     '连续周次不受基准影响');
  eq(Core.parseWeekMask('1-16周 单双周', 16, { oddWeek: 2 }).mask.weeks(),
     [1,3,5,7,9,11,13,15], '隔周是按位置取的，不受基准影响');
  eq(Core.parseWeekMask('1-16周(单)', 16, {}).mask.weeks(),
     [1,3,5,7,9,11,13,15], '不传 opts 时默认「第 1 周 = 单周」（向后兼容）');

  /* 基准参数要能穿过整条解析链（表格 / 矩阵 / 卡片） */
  const TBL = ['课程名称\t周次\t星期\t节次',
               '某课\t1-16周(单)\t周一\t1-2'].join('\n');
  eq(Core.parseDelimitedText(TBL, 16, { oddWeek: 2 }).courses[0].patterns[0].weekMask.weeks(),
     [2,4,6,8,10,12,14,16], '★ 表格路径透传 oddWeek');
  const CRD = ['课程:某课', '(教一301)', '1-16周(单) 星期四 1-2节', '主讲教师:张'].join('\n');
  eq(Core.parseDelimitedText(CRD, 16, { slotTable: Core.makeStandard12(), oddWeek: 2 })
       .courses[0].patterns[0].weekMask.weeks(),
     [2,4,6,8,10,12,14,16], '★ 卡片路径透传 oddWeek');

  const SEM2 = Core.buildSemester({
    name: '2026秋', firstDay: Core.parseISODate('2026-09-07'),
    totalWeeks: 16, offsetMinutes: 480
  });
  const T2 = Core.makeStandard12();
  const mkC = (name, weekday, weeks) => {
    const m = new Core.WeekMask(16);
    weeks.forEach(w => m.add(w));
    return { id: 'c_' + name, name: name, teacher: '张老师', room: '教一301',
             courseType: 'required',
             patterns: [{ weekday: weekday, slots: [1, 2], weekMask: m }] };
  };

  let p1 = Core.planEvents([mkC('单周课', 1, [1,3,5,7,9,11,13,15])], SEM2, T2, [], {});
  eq(p1.events[0].rrule, { interval: 2, count: 8 }, '★ 单周课 -> INTERVAL=2, COUNT=8');
  eq(Core.wallISO(p1.events[0].start), '2026-09-07', '单周课 DTSTART = 第 1 周周一');

  let p2 = Core.planEvents([mkC('双周课', 1, [2,4,6,8,10,12,14,16])], SEM2, T2, [], {});
  eq(p2.events[0].rrule, { interval: 2, count: 8 }, '★ 双周课 -> INTERVAL=2, COUNT=8');
  eq(Core.wallISO(p2.events[0].start), '2026-09-14', '★ 双周课 DTSTART = 第 2 周周一');

  const ics2 = Core.buildICS(p1.events, { offsetMinutes: 480, calendarName: '课表' });
  ok(ics2.indexOf('RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=8') >= 0,
     '★ .ics 里写的是 INTERVAL=2，不是每周');

  /* --- 双周课的第 2 周被停课：DTSTART 顺移，相位不能乱 --- */
  const cancelFirst = [{ kind: 'holiday', date: Core.parseISODate('2026-09-14'),
                         name: '临时停课', skipClasses: true }];
  const p3 = Core.planEvents([mkC('双周课', 1, [2,4,6,8,10,12,14,16])], SEM2, T2, cancelFirst, []);
  eq(Core.wallISO(p3.events[0].start), '2026-09-28', '★ 首次课被停 -> DTSTART 顺移到第 4 周（仍是双周相位）');
  eq(p3.events[0].rrule, { interval: 2, count: 7 }, '★ COUNT 相应减为 7');
  eq(p3.events[0].occurrenceCount, 7, '实际 7 次');

  /* --- 双周课中途停一周：用 EXDATE 排除，相位不受影响 --- */
  const cancelMid = [{ kind: 'cancelAll', date: Core.parseISODate('2026-09-28') }];
  const p4 = Core.planEvents([mkC('双周课', 1, [2,4,6,8,10,12,14,16])], SEM2, T2, cancelMid, []);
  eq(Core.wallISO(p4.events[0].start), '2026-09-14', '中途停课不动 DTSTART');
  eq(p4.events[0].rrule, { interval: 2, count: 8 }, '★ 中途停课不缩 COUNT（用 EXDATE 表达）');
  eq(p4.events[0].exdates.map(Core.wallISO), ['2026-09-28'], '★ 被停的那一周进 EXDATE');
  eq(p4.events[0].occurrenceCount, 7, '实际仍是 7 次');

  /* --- 单周课碰上单周放假：切段不能变 --- */
  const oddHoliday = [{ kind: 'holiday', date: Core.parseISODate('2026-10-05'),
                        name: '国庆', skipClasses: true }];
  const p5 = Core.planEvents([mkC('单周课', 1, [1,3,5,7,9,11,13,15])], SEM2, T2, oddHoliday, []);
  eq(p5.events[0].rrule, { interval: 2, count: 8 }, '单周课停一周仍是一条 INTERVAL=2 规则');
  eq(p5.events[0].exdates.map(Core.wallISO), ['2026-10-05'], '被停的第 5 周进 EXDATE');
  eq(p5.events[0].occurrenceCount, 7, '实际 7 次');
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
