/* 生成 .ics 基线，用于验证「节次表改造不会让已有 UID 漂移」。
   用法：node baseline-ics.js 输出/文件    （纯数字节次场景，改造前后各跑一次做逐行 diff）
   DTSTAMP 是当前时间，diff 时剔除。 */

const fs = require('fs');
const Core = require('../src/core.js');

const SEM = Core.buildSemester({
  name: '2026秋季',
  firstDay: Core.parseISODate('2026-09-07'),
  totalWeeks: 16,
  offsetMinutes: 480
});

function maskOf(weeks, total) {
  const m = new Core.WeekMask(total || 16);
  weeks.forEach(w => m.add(w));
  return m;
}
function every(total) {
  return maskOf(Array.from({ length: total || 16 }, (_, i) => i + 1), total);
}
function mk(name, weekday, slots, weeks, room, teacher, type) {
  return {
    id: 'c_' + name + '_' + weekday + '_' + slots.join('-'),
    name: name,
    teacher: teacher || '张老师',
    room: room || '教一301',
    courseType: type || 'required',
    patterns: [{ weekday: weekday, slots: slots, weekMask: weeks || every(16) }]
  };
}

/* 覆盖：单节 / 连排 / 跳号 / 单周 / 双周 / 多 pattern / 实验课 / 体育 */
const courses = [
  mk('高等数学', 1, [1, 2]),
  mk('线性代数', 2, [3]),
  mk('数据结构', 3, [2, 3], maskOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])),
  mk('大学英语读写', 4, [1, 3], maskOf([1, 3, 5, 7, 9, 11, 13, 15])),
  mk('英语听说', 4, [9, 10], maskOf([2, 4, 6, 8, 10, 12, 14, 16])),
  mk('线性代数', 5, [5, 6, 7], maskOf([3, 5, 7, 9, 11, 13, 15]), '教一301', '王老师', 'elective'),
  mk('大学物理实验', 5, [9, 10, 11], maskOf([3, 4, 5, 6, 7, 8]), '实验楼B203', '刘老师', 'lab'),
  mk('体育', 2, [7, 8], every(16), '操场', '李老师', 'pe')
];

const rules = [
  { kind: 'holiday', date: Core.parseISODate('2026-10-01'), name: '国庆节', skipClasses: true },
  { kind: 'holiday', date: Core.parseISODate('2026-10-05'), name: '国庆假期', skipClasses: true },
  { kind: 'cancelAll', date: Core.parseISODate('2026-11-11') },
  { kind: 'cancel', date: Core.parseISODate('2026-10-14'), courseId: courses[0].id },
  { kind: 'roomOverride', date: Core.parseISODate('2026-10-21'), courseId: courses[0].id, room: '教三502' },
  { kind: 'makeup', date: Core.parseISODate('2026-11-01'), courseId: courses[0].id,
    slots: [1, 2], room: '教一301' }
];

function run(slotTable) {
  const plan = Core.planEvents(courses, SEM, slotTable, rules, {
    titleTemplate: '{课程名}', reminderMinutes: 10, useEmoji: true
  });
  const ics = Core.buildICS(plan.events, { offsetMinutes: 480, calendarName: '课表 2026秋' });
  return {
    lines: ics.split('\n').filter(l => !/^DTSTAMP:/.test(l)),
    warnings: plan.warnings,
    uids: plan.events.map(e => e.uid)
  };
}

function buildAll() {
const presets = ['std12', 'compact10', 'light8', 'bigblock', 'schoolk12'];
const out = [];
presets.forEach(id => {
  const p = Core.SLOT_PRESETS.find(x => x.id === id);
  const t = Core.makeSlotTable(p.name, p.rows, { maxBreak: 5, joinMode: 'gap' });
  const r = run(t);
  out.push('===== preset ' + id + ' | ' + r.uids.length + ' 个事件 =====');
  out.push(...r.lines);
});

/* 另外三种连堂策略也各存一份，因为它们直接改变切块结果 */
['keep', 'split'].forEach(mode => {
  const p = Core.SLOT_PRESETS[0];
  const t = Core.makeSlotTable(p.name, p.rows, { maxBreak: 5, joinMode: mode });
  out.push('===== preset std12 joinMode=' + mode + ' =====');
  out.push(...run(t).lines);
});

  return out;
}

module.exports = { buildAll: buildAll, courses: courses, rules: rules, SEM: SEM };

/* 直接运行时写文件：node baseline-ics.js <输出文件> */
if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('用法：node baseline-ics.js <输出文件>');
    process.exit(1);
  }
  const out = buildAll();
  fs.writeFileSync(target, out.join('\n') + '\n', 'utf8');
  const total = out.filter(l => l.startsWith('UID:')).length;
  console.log('✅ 基线已写入 ' + target + '（' + total + ' 个 UID，' + out.length + ' 行）');
}
