/* 课表导入器 · 界面逻辑 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var STORAGE_KEY = 'schedule-importer.slots.v1';
  var ODD_BASIS_KEY = 'schedule-importer.oddWeek.v1';

  /**
   * 作息表读盘。
   *
   * 放在 localStorage 而不是每次打开重填：一个学校的作息四年不变，
   * 用户没有理由第二次打开还要再输一遍。隐私模式 / 存储被禁时静默退回默认值。
   */
  function loadSlotTable() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var t = Core.deserializeSlotTable(JSON.parse(raw));
        if (t) return t;
      }
    } catch (e) { /* 忽略：用默认作息 */ }
    return Core.makeStandard12();
  }

  function saveSlotTable() {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY,
          JSON.stringify(Core.serializeSlotTable(S.slotTable)));
      }
    } catch (e) { /* 忽略：存储不可用不影响使用 */ }
  }

  /**
   * 单双周基准：本学期的第 1 周算单周（默认）还是双周。
   *
   * 单双周必须有个基准，本工具以**学期第 1 周**为准。
   * 少数学校按自然年周数或学年连续编号，第 1 周会落在偶数上，
   * 单双周就整体反了 —— 那种情况下切到「第 1 周 = 双周」。
   */
  function loadOddWeek() {
    try {
      var v = window.localStorage && window.localStorage.getItem(ODD_BASIS_KEY);
      if (v === '2') return 2;
    } catch (e) { /* 忽略 */ }
    return 1;
  }

  function saveOddWeek() {
    try {
      if (window.localStorage) window.localStorage.setItem(ODD_BASIS_KEY, String(S.oddWeek));
    } catch (e) { /* 忽略 */ }
  }

  function weekOpts() { return { oddWeek: S.oddWeek }; }

  var S = {
    step: 1,
    maxStep: 1,
    courses: [],
    holidays: [],       // { date: Date, name: string }
    makeups: [],        // { date: Date, courseId: string, slots: [int] }
    slotTable: loadSlotTable(),
    slotPresetId: '',
    oddWeek: loadOddWeek(),
    semester: null,
    plan: null,
    conflicts: [],
    parseWarnings: [],
    parseMeta: null,
    recomputeTimer: null
  };

  /* ---------- 小工具 ---------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function notice(level, html) {
    var ic = { warn: '⚠️', err: '⛔', ok: '✅', info: '💡' }[level] || 'ℹ️';
    return '<div class="nt ' + level + '"><span class="ic">' + ic + '</span><span>' + html + '</span></div>';
  }

  /** 统一的文件下载 */
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function firstMondayOnOrAfter(y, m, d) {
    var dt = Core.wallDate(y, m, d);
    var guard = 0;
    while (Core.wallDowIso(dt) !== 1 && guard++ < 10) dt = Core.wallAddDays(dt, 1);
    return dt;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function dateInputValue(dt) {
    return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
  }

  /* ---------- 学期 ---------- */

  function defaultSemester() {
    var now = new Date();
    var y = now.getFullYear();
    var m = now.getMonth() + 1;
    var autumn = m >= 7;
    var start = autumn ? firstMondayOnOrAfter(y, 9, 1) : firstMondayOnOrAfter(y, 2, 20);
    return {
      name: y + (autumn ? ' 秋季学期' : ' 春季学期'),
      start: start,
      weeks: autumn ? 16 : 18
    };
  }

  function readSemester() {
    var name = $('#semName').value.trim() || '学期';
    var start = Core.parseISODate($('#semStart').value);
    var weeks = parseInt($('#semWeeks').value, 10);
    var offset = parseInt($('#semTZ').value, 10);
    if (!start || !(weeks >= 1 && weeks <= 53)) return null;
    var sem = Core.buildSemester({
      name: name, firstDay: start, totalWeeks: weeks, offsetMinutes: offset
    });
    return sem;
  }

  function refreshSemester() {
    var sem = readSemester();
    if (!sem) {
      $('#semInfo').innerHTML = notice('err', '请填写有效的开学日期与总周数（1–53）。');
      S.semester = null;
      return null;
    }
    S.semester = sem;
    var lastMonday = Core.wallAddDays(sem.anchorMonday, (sem.totalWeeks - 1) * 7);
    $('#semInfo').innerHTML = notice('info',
      '第 1 周周一 <b>' + Core.wallISO(sem.anchorMonday) + '</b>　·　'
      + '第 ' + sem.totalWeeks + ' 周周一 <b>' + Core.wallISO(lastMonday) + '</b>　·　'
      + '学期最后一天 ' + Core.wallISO(sem.endDate));
    return sem;
  }

  /**
   * 切换单双周基准后，把已有课程的周次按新基准重算一遍。
   *
   * 只重算日历事件是不够的：weekMask 在解析那一刻就固化了，
   * 基准换了必须回到「周次原文」重新解析 —— 所以每个 pattern 都留了 rawWeekText。
   */
  function reapplyWeekBasis() {
    if (!S.semester) return 0;
    var n = 0;
    S.courses.forEach(function (c) {
      (c.patterns || []).forEach(function (p) {
        if (!p.rawWeekText) return;
        var r = Core.parseWeekMask(p.rawWeekText, S.semester.totalWeeks, weekOpts());
        if (r && !r.mask.isEmpty()) { p.weekMask = r.mask; n++; }
      });
    });
    return n;
  }

  /* ---------- 上下课时间（作息表） ---------- */

  function mOf(t) { return t.h * 60 + t.m; }

  function hhmm(t) {
    return (t.h < 10 ? '0' : '') + t.h + ':' + (t.m < 10 ? '0' : '') + t.m;
  }

  /**
   * 一行节次。
   *
   * 左侧的「编号」是一个输入框而不是死文本：填数字就是第 N 节，
   * 填文字（中午1 / 早读）就是具名节次 —— 很多学校的午休里真的排课，
   * 而那些节次不在 1…N 的主序列里。
   */
  function slotItemHTML(s) {
    var k = esc(s.key);
    var label = s.label != null ? '「' + k + '」' : '第 ' + k + ' 节';
    return '<div class="slot-item">'
      + '<input class="n" data-rename="' + k + '" value="' + k + '" maxlength="8" spellcheck="false"'
      + ' aria-label="节次名称" title="填数字=第 N 节；填文字（如 中午1）=具名节次">'
      + '<input type="time" data-slot="' + k + '" data-k="start" value="' + hhmm(s.start) + '"'
      + ' aria-label="' + label + '开始时间">'
      + '<span class="dash">–</span>'
      + '<input type="time" data-slot="' + k + '" data-k="end" value="' + hhmm(s.end) + '"'
      + ' aria-label="' + label + '结束时间">'
      + '<button class="x" data-del="' + k + '" aria-label="删除' + label + '"'
      + ' title="删除这一节">×</button>'
      + '</div>';
  }

  function renderSlots() {
    var groups = Core.slotGroups(S.slotTable);
    $('#slotEditor').innerHTML = groups.map(function (g) {
      return '<div class="slot-grp">'
        + '<div class="slot-grp-h">' + esc(g.label) + '</div>'
        + '<div class="slot-grid">' + g.slots.map(slotItemHTML).join('') + '</div>'
        + '</div>';
    }).join('');

    $('#slotCount').textContent = S.slotTable.slots.length + ' 节';

    var sel = $('#slotPreset');
    if (!sel.options.length) {
      sel.innerHTML = '<option value="">选一套接近你学校的作息…</option>'
        + Core.SLOT_PRESETS.map(function (p) {
            return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
          }).join('');
    }
    sel.value = S.slotPresetId;

    $('#joinMode').value = S.slotTable.joinMode;
    $('#maxBreak').value = S.slotTable.maxBreak;
    $('#maxBreak').disabled = S.slotTable.joinMode !== 'gap';

    renderSlotPreview();
  }

  function joinModeHint() {
    var t = S.slotTable;
    if (t.joinMode === 'keep') {
      return '当前：<b>在作息表里挨着的节次会合并成一个事件</b>，事件时长包含中间的课间。'
        + '课表里写 <code>1-3</code>，日历上就是一条 08:00–10:45。';
    }
    if (t.joinMode === 'split') {
      return '当前：<b>每一节各自成为一个事件</b>。连上三节会变成三条日历事件，但它们首尾相接、互不重叠。';
    }
    return '当前：只有<b>在作息表里挨着、且课间不超过 ' + t.maxBreak + ' 分钟</b>的节次才合并。'
      + '像上午 2 节与 3 节之间的大课间会被保留成你的自由时间；'
      + '而「上午最后一节」和「下午第一节」中间隔着中午，也不会被并成一条跨午休的长事件。';
  }

  /**
   * 连堂预览。
   *
   * 优先拿「课表里真实出现过的节次组合」来举例 —— 抽象讲「1-2 会合并」没有说服力，
   * 让用户直接看到自己那门《数据结构》是 1 条还是 2 条事件才有用。
   */
  function renderSlotPreview() {
    var cases = [];
    var seen = {};
    (S.courses || []).forEach(function (c) {
      (c.patterns || []).forEach(function (p) {
        var key = (p.slots || []).join(',');
        if (key && !seen[key]) { seen[key] = 1; cases.push(p.slots.slice()); }
      });
    });
    var fromCourses = cases.length > 0;
    if (!fromCourses) cases = [[1, 2], [1, 3], [2, 3]];
    if (cases.length > 6) cases = cases.slice(0, 6);

    var rows = cases.map(function (slots) {
      var pv = Core.previewSlots(S.slotTable, slots);
      var label = esc(slotsToText(slots) + ' 节');
      if (!pv.blocks.length) {
        return '<div class="sp-row"><span class="k">' + label + '</span>'
          + '<span class="arrow">→</span><span class="v">无法解析（不在上面的节次表里）</span></div>';
      }
      var times = pv.blocks.map(function (b) { return esc(b.time); })
        .join(' <span class="sep">/</span> ');
      return '<div class="sp-row">'
        + '<span class="k">' + label + '</span>'
        + '<span class="arrow">→</span>'
        + '<span class="v">' + pv.blocks.length + ' 个事件</span>'
        + '<span class="t">' + times + '</span>'
        + '</div>';
    }).join('');

    $('#slotPreview').innerHTML =
      '<div class="ph">' + (fromCourses ? '按你课表里实际出现的节次预览' : '连堂效果预览') + '</div>'
      + rows
      + '<div class="hint" style="margin-top:8px">' + joinModeHint() + '</div>';
  }

  function slotWarn(msg) {
    var pv = $('#slotPreview');
    pv.innerHTML = notice('warn', msg) + pv.innerHTML;
  }

  /** 作息表变动后的统一收尾：存盘 -> 重渲染 -> 重算 */
  function afterSlotChange() {
    saveSlotTable();
    renderSlots();
    if (S.courses.length) {
      // 节次改名/删除会连带改写课表里的节次引用，课程表那一栏得跟着重画，
      // 否则数据已经变了、输入框里还显示着旧名字。
      renderCourses();
      renderConflicts();
      scheduleRecompute();
    }
  }

  function findPreset(id) {
    var hit = null;
    Core.SLOT_PRESETS.forEach(function (p) { if (p.id === id) hit = p; });
    return hit;
  }

  function slotLabelOf(s) {
    return s.label != null ? '「' + s.label + '」' : '第 ' + s.index + ' 节';
  }

  /** 按时间重排（连堂判断用的是位置，位置必须始终等于时间顺序） */
  function resortSlots() {
    S.slotTable.slots.sort(function (a, b) { return mOf(a.start) - mOf(b.start); });
  }

  function onSlotEditorChange(e) {
    var el = e.target;
    if (!el || !el.dataset) return;
    if (el.dataset.rename !== undefined) { onSlotRename(el); return; }
    if (!el.dataset.slot) return;

    var slot = Core.slotOf(S.slotTable, el.dataset.slot);
    if (!slot) return;

    var m = /^(\d{1,2}):(\d{2})$/.exec(el.value || '');
    if (!m) { renderSlots(); return; }
    var t = { h: +m[1], m: +m[2] };
    var isStart = el.dataset.k === 'start';

    if (isStart ? (mOf(t) >= mOf(slot.end)) : (mOf(t) <= mOf(slot.start))) {
      el.value = isStart ? hhmm(slot.start) : hhmm(slot.end);
      slotWarn(slotLabelOf(slot) + '：结束时间要晚于开始时间，这一处改动没有生效。');
      return;
    }

    if (isStart) slot.start = t; else slot.end = t;
    resortSlots();
    S.slotPresetId = '';
    afterSlotChange();
  }

  /**
   * 改节次名字。
   *
   * 已经导入的课表里存的是旧名字，光改表不改引用的话那些课会集体变成
   * 「节次不在节次表中」—— 所以改名要顺手把引用一起带过去。
   */
  function onSlotRename(el) {
    var oldKey = el.dataset.rename;
    var slot = Core.slotOf(S.slotTable, oldKey);
    if (!slot) { renderSlots(); return; }

    var v = String(el.value || '').trim();
    if (!v) {
      renderSlots();
      slotWarn('节次名称不能为空，已恢复原名。');
      return;
    }
    if (!/^\d+$/.test(v) && !/[一-鿿A-Za-z]/.test(v)) {
      renderSlots();
      slotWarn('节次名称要么是数字（如 5），要么带文字（如 中午1、早读）。已恢复原名。');
      return;
    }
    if (v === oldKey) return;

    var clash = S.slotTable.slots.some(function (s) { return s !== slot && s.key === v; });
    if (clash) {
      renderSlots();
      slotWarn('已经有叫「' + esc(v) + '」的一节了。两个同名节次会让课表里的节次对不上，'
        + '已恢复原名。');
      return;
    }

    slot.index = /^\d+$/.test(v) ? parseInt(v, 10) : null;
    slot.label = /^\d+$/.test(v) ? null : v;
    slot.key = v;
    remapSlotRef(oldKey, v);
    resortSlots();
    S.slotPresetId = '';
    afterSlotChange();
  }

  /** 把课表与补课记录里指向 oldKey 的节次引用改成 newKey */
  function remapSlotRef(oldKey, newKey) {
    var to = /^\d+$/.test(newKey) ? parseInt(newKey, 10) : newKey;
    function walk(list) {
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        if (String(list[i]) === String(oldKey)) list[i] = to;
      }
    }
    S.courses.forEach(function (c) {
      (c.patterns || []).forEach(function (p) { walk(p.slots); });
    });
    S.makeups.forEach(function (m) { walk(m.slots); });
  }

  /* ---------- 步骤 ---------- */

  function goStep(n) {
    if (n > S.maxStep) n = S.maxStep;
    S.step = n;
    $$('.panel').forEach(function (p) { p.hidden = (p.id !== 'panel' + n); });
    $$('.step').forEach(function (b) {
      var s = +b.dataset.step;
      b.classList.toggle('on', s === n);
      b.classList.toggle('done', s < n);
    });
    if (n === 2) { renderCourses(); renderConflicts(); }
    if (n === 3) { renderHolidays(); renderMakeups(); }
    if (n === 4) { recompute(); renderPlan(); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function advance(n) {
    if (n > S.maxStep) S.maxStep = n;
    goStep(n);
  }

  /* ---------- 解析入口 ---------- */

  function applyParseResult(res, sourceLabel) {
    if (!res.courses.length) {
      /* 失败原因要贴着实际格式说：卡片和表格的排查方向完全不同 */
      var how = res.layout === 'card'
        ? '每张卡片里要有「课程:X」这一行，另外还要有「星期X」和「第几节」。'
        : res.layout === 'matrix'
          ? '表格的行首要是节次、列要是星期（周一～周五）。'
          : '是否包含「课程名称 / 星期 / 节次」这几列？分隔符是制表符或逗号？';
      var msg = notice('err', '<b>没能解析出课程。</b>请检查：' + how
        + (res.warnings.length ? '<br>' + res.warnings.slice(0, 4).map(function (w) { return esc(w.message); }).join('<br>') : ''));
      $('#step1Msg').innerHTML = msg;
      return false;
    }
    S.courses = res.courses;
    S.parseWarnings = res.warnings || [];
    S.parseMeta = {
      label: sourceLabel,
      headerDetected: res.headerDetected,
      separator: res.separator || (res.sheetName ? 'Excel 工作表 ' + res.sheetName : ''),
      sheetCount: res.sheetCount,
      layout: res.layout || 'table'
    };
    $('#step1Msg').innerHTML = '';
    renderSlotPreview();
    advance(2);
    return true;
  }

  function doParseText() {
    var sem = refreshSemester();
    if (!sem) return;
    var text = $('#pasteText').value;
    if (!text.trim()) {
      $('#step1Msg').innerHTML = notice('warn', '先粘贴课表内容，或点「载入示例课表」看看效果。');
      return;
    }
    var res = Core.parseDelimitedText(text, sem.totalWeeks, { slotTable: S.slotTable, oddWeek: S.oddWeek });
    applyParseResult(res, '粘贴文本');
  }

  async function readFileSmart(file) {
    var buf = await file.arrayBuffer();
    var text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    // 教务系统导出的 CSV 常见 GBK 编码，UTF-8 解出来会是满屏替换字符
    if (text.indexOf('\uFFFD') >= 0) {
      try { text = new TextDecoder('gbk').decode(buf); } catch (e) { /* 浏览器不支持则保持原样 */ }
    }
    return text;
  }

  async function handleFile(file) {
    var sem = refreshSemester();
    if (!sem) return;
    var name = (file.name || '').toLowerCase();
    $('#step1Msg').innerHTML = notice('info', '正在解析 <b>' + esc(file.name) + '</b> …');
    try {
      var res;
      if (/\.xlsx$/.test(name)) {
        res = await Core.parseXlsxBuffer(await file.arrayBuffer(), sem.totalWeeks,
          { slotTable: S.slotTable, oddWeek: S.oddWeek });
        if (res.sheetCount > 1) {
          res.warnings.push({ level: 'info',
            message: '这个文件有 ' + res.sheetCount + ' 张工作表，'
              + '已自动选用课程最多的第 ' + res.sheetIndex + ' 张。' });
        }
      } else {
        res = Core.parseDelimitedText(await readFileSmart(file), sem.totalWeeks,
          { slotTable: S.slotTable, oddWeek: S.oddWeek });
      }
      applyParseResult(res, file.name);
    } catch (err) {
      $('#step1Msg').innerHTML = notice('err',
        '<b>解析失败：</b>' + esc(err && err.message ? err.message : String(err))
        + '<br>如果是旧版 <code>.xls</code>，请先在 Excel / WPS 里另存为 <code>.xlsx</code> 或 <code>.csv</code>。');
    }
  }

  /* ---------- 课程表渲染 ---------- */

  var WEEKDAYS = [
    [1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'],
    [5, '周五'], [6, '周六'], [7, '周日']
  ];

  /**
   * 节次引用 -> 编辑框里的一行文本（'1-2' / '中午2-6' / '1,3'）。
   * 交给内核按「位置」判断连续性：数字 min-max 会把 1,3 写成 1-3，
   * 那等于谎称第 2 节也在这门课里。
   */
  function slotsToText(slots) {
    return Core.refsToText(S.slotTable, slots);
  }

  function renderCourses() {
    var tb = $('#courseBody');
    var rows = [];
    var n = 0;
    S.courses.forEach(function (c, ci) {
      c.patterns.forEach(function (p, pi) {
        n++;
        var wdOpts = WEEKDAYS.map(function (w) {
          return '<option value="' + w[0] + '"' + (p.weekday === w[0] ? ' selected' : '') + '>' + w[1] + '</option>';
        }).join('');
        rows.push('<tr>'
          + '<td class="t-num">' + n + '</td>'
          + '<td class="c-title c-in" data-label="课程名">'
          +   '<input data-ci="' + ci + '" data-pi="' + pi + '" data-k="name" value="' + esc(c.name) + '"></td>'
          + '<td class="c-in" data-label="教师">'
          +   '<input data-ci="' + ci + '" data-pi="' + pi + '" data-k="teacher" value="' + esc(c.teacher) + '"></td>'
          + '<td class="c-in" data-label="地点">'
          +   '<input data-ci="' + ci + '" data-pi="' + pi + '" data-k="room" value="' + esc(p.room || c.room || '') + '"></td>'
          + '<td class="c-in" data-label="星期">'
          +   '<select data-ci="' + ci + '" data-pi="' + pi + '" data-k="weekday">' + wdOpts + '</select></td>'
          + '<td class="c-in" data-label="节次">'
          +   '<input data-ci="' + ci + '" data-pi="' + pi + '" data-k="slots" value="' + esc(slotsToText(p.slots)) + '"></td>'
          + '<td class="c-in" data-label="周次">'
          +   '<input data-ci="' + ci + '" data-pi="' + pi + '" data-k="weeks" value="' + esc(p.rawWeekText || p.weekMask.summary()) + '"></td>'
          + '<td class="c-del"><button class="link danger" data-del="' + ci + ':' + pi + '">删除此时段</button></td>'
          + '</tr>');
      });
    });
    tb.innerHTML = rows.length ? rows.join('')
      : '<tr class="empty-row"><td colspan="8" class="empty">还没有课程</td></tr>';
    $('#courseCount').textContent = S.courses.length + ' 门 / ' + n + ' 个时段';

    // 解析警告
    var wbox = $('#parseWarnings');
    if (S.parseWarnings.length) {
      var items = S.parseWarnings.slice(0, 6).map(function (w) {
        var loc = w.row ? '<b>第 ' + w.row + ' 行</b>　' : '';
        return '<div>' + loc + esc(w.message) + (w.raw ? '<br><span style="color:var(--ink3)">原文：' + esc(w.raw) + '</span>' : '') + '</div>';
      });
      var more = S.parseWarnings.length > 6
        ? '<div style="margin-top:6px">…还有 ' + (S.parseWarnings.length - 6) + ' 条</div>' : '';
      var lv = S.parseWarnings.some(function (w) { return w.level === 'error'; }) ? 'err'
        : S.parseWarnings.some(function (w) { return w.level === 'warn'; }) ? 'warn'
        : 'info';
      wbox.innerHTML = notice(lv, '<b>解析时注意到这些：</b><div style="margin-top:6px">'
        + items.join('') + more + '</div>');
    } else if (S.parseMeta) {
      wbox.innerHTML = notice('ok', '解析完成：'
        + (S.parseMeta.headerDetected ? '识别到表头' : '未识别表头（按默认列序解析）')
        + '，分隔符为 ' + esc(S.parseMeta.separator) + '，没有发现问题。');
    } else {
      wbox.innerHTML = '';
    }
  }

  function onCourseEdit(e) {
    var el = e.target;
    var k = el.dataset.k;
    if (!k) return;
    var ci = +el.dataset.ci, pi = +el.dataset.pi;
    var c = S.courses[ci];
    if (!c) return;
    var p = c.patterns[pi];

    if (k === 'name') c.name = el.value;
    else if (k === 'teacher') c.teacher = el.value;
    else if (k === 'room') { c.room = el.value; if (p) p.room = el.value || null; }
    else if (k === 'weekday') { if (p) p.weekday = +el.value; }
    else if (k === 'slots') {
      if (p) {
        var slots = Core.parseSlotRefs(el.value, S.slotTable).refs;
        if (slots.length) { p.slots = slots; el.style.borderColor = ''; }
        else el.style.borderColor = 'var(--err)';
      }
    } else if (k === 'weeks') {
      if (p && S.semester) {
        var r = Core.parseWeekMask(el.value, S.semester.totalWeeks, weekOpts());
        if (r && !r.mask.isEmpty()) {
          p.weekMask = r.mask; p.rawWeekText = el.value; el.style.borderColor = '';
        } else {
          el.style.borderColor = 'var(--err)';
        }
      }
    }
    scheduleRecompute();
  }

  function onCourseClick(e) {
    var d = e.target.dataset && e.target.dataset.del;
    if (!d) return;
    var parts = d.split(':');
    var ci = +parts[0], pi = +parts[1];
    var c = S.courses[ci];
    if (!c) return;
    c.patterns.splice(pi, 1);
    if (!c.patterns.length) S.courses.splice(ci, 1);
    renderCourses(); renderConflicts(); scheduleRecompute();
  }

  /* ---------- 冲突 ---------- */

  function renderConflicts() {
    var box = $('#conflictBox');
    if (!S.courses.length || !S.semester) { box.innerHTML = ''; return; }
    var rules = buildRules();
    S.conflicts = Core.detectConflicts(S.courses, S.semester, S.slotTable, rules);
    if (!S.conflicts.length) {
      box.innerHTML = notice('ok', '<b>没有检测到课内冲突。</b>'
        + '（单周与双周课即使时间重叠、周次不相交，也不会被误判为冲突。）');
      return;
    }
    var html = S.conflicts.map(function (g) {
      var dates = g.dates.slice(0, 3).join('、') + (g.dates.length > 3 ? ' …' : '');
      return '<div style="margin-bottom:8px">'
        + '<b>' + esc(g.courseA) + '</b> ⟷ <b>' + esc(g.courseB) + '</b>　'
        + '<span class="badge">' + esc(g.suggestion) + '</span>　共 ' + g.dates.length + ' 次'
        + '<div style="color:var(--ink3);font-size:12.5px;margin-top:2px">'
        + esc(g.slotsA) + ' @ ' + esc(g.roomA || '—') + '　·　'
        + esc(g.slotsB) + ' @ ' + esc(g.roomB || '—')
        + '　·　' + esc(dates) + '</div></div>';
    }).join('');
    box.innerHTML = notice('warn',
      '<b>检测到 ' + S.conflicts.length + ' 组时间冲突。</b>'
      + '<div style="margin-top:8px">' + html + '</div>'
      + '<div style="margin-top:6px">冲突通常意味着课表本身有问题，建议回上一页核对后再导出。</div>');
  }

  /* ---------- 例外规则 ---------- */

  function buildRules() {
    var rules = [];
    S.holidays.forEach(function (h) {
      if (h.date) rules.push({ kind: 'holiday', date: h.date, name: h.name || '放假', skipClasses: true });
    });
    S.makeups.forEach(function (m) {
      if (m.date && m.courseId && m.slots && m.slots.length) {
        rules.push({
          kind: 'makeup', date: m.date, courseId: m.courseId,
          slots: m.slots, room: null
        });
      }
    });
    return rules;
  }

  function renderHolidays() {
    var box = $('#holidayList');
    if (!S.holidays.length) {
      box.innerHTML = '<div class="empty">还没有添加放假日（没有放假就直接下一步）</div>';
      return;
    }
    box.innerHTML = S.holidays.map(function (h, i) {
      return '<div class="rule-row">'
        + '<input type="date" data-hd="' + i + '" data-k="date" value="' + dateInputValue(h.date) + '">'
        + '<input data-hd="' + i + '" data-k="name" value="' + esc(h.name) + '" placeholder="放假名称，如 国庆节">'
        + '<button class="link danger" data-hdel="' + i + '">删除</button>'
        + '</div>';
    }).join('');
  }

  function renderMakeups() {
    var box = $('#makeupList');
    if (!S.makeups.length) {
      box.innerHTML = '<div class="empty">还没有补课（没有就直接下一步）</div>';
      return;
    }
    var opts = S.courses.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
    }).join('');
    box.innerHTML = S.makeups.map(function (m, i) {
      var sel = '<select data-md="' + i + '" data-k="courseId">' + opts + '</select>';
      if (m.courseId) {
        sel = sel.replace('value="' + esc(m.courseId) + '"', 'value="' + esc(m.courseId) + '" selected');
      }
      return '<div class="rule-row wide">'
        + '<input type="date" data-md="' + i + '" data-k="date" value="' + dateInputValue(m.date) + '">'
        + sel
        + '<input data-md="' + i + '" data-k="slots" value="' + esc(slotsToText(m.slots)) + '" placeholder="节次，如 1-2">'
        + '<button class="link danger" data-mdel="' + i + '">删除</button>'
        + '</div>';
    }).join('');
  }

  function addHoliday(dateISO, name) {
    S.holidays.push({ date: Core.parseISODate(dateISO), name: name });
    renderHolidays(); scheduleRecompute();
  }

  function bindRuleEvents() {
    $('#holidayList').addEventListener('input', function (e) {
      var el = e.target;
      var i = el.dataset.hd;
      if (i === undefined) return;
      i = +i;
      if (!S.holidays[i]) return;
      if (el.dataset.k === 'date') {
        var d = Core.parseISODate(el.value);
        if (d) { S.holidays[i].date = d; el.style.borderColor = ''; }
        else el.style.borderColor = 'var(--err)';
      } else if (el.dataset.k === 'name') {
        S.holidays[i].name = el.value;
      }
      scheduleRecompute();
    });
    $('#holidayList').addEventListener('click', function (e) {
      var i = e.target.dataset && e.target.dataset.hdel;
      if (i === undefined) return;
      S.holidays.splice(+i, 1); renderHolidays(); scheduleRecompute();
    });

    $('#makeupList').addEventListener('input', function (e) {
      var el = e.target;
      var i = el.dataset.md;
      if (i === undefined) return;
      i = +i;
      if (!S.makeups[i]) return;
      if (el.dataset.k === 'date') {
        var d = Core.parseISODate(el.value);
        if (d) { S.makeups[i].date = d; el.style.borderColor = ''; }
        else el.style.borderColor = 'var(--err)';
      } else if (el.dataset.k === 'courseId') {
        S.makeups[i].courseId = el.value;
      } else if (el.dataset.k === 'slots') {
        var slots = Core.parseSlotRefs(el.value, S.slotTable).refs;
        if (slots.length) { S.makeups[i].slots = slots; el.style.borderColor = ''; }
        else el.style.borderColor = 'var(--err)';
      }
      scheduleRecompute();
    });
    $('#makeupList').addEventListener('click', function (e) {
      var i = e.target.dataset && e.target.dataset.mdel;
      if (i === undefined) return;
      S.makeups.splice(+i, 1); renderMakeups(); scheduleRecompute();
    });
  }

  /* ---------- 计划与导出 ---------- */

  function recompute() {
    if (!S.semester || !S.courses.length) { S.plan = null; return; }
    try {
      S.plan = Core.planEvents(S.courses, S.semester, S.slotTable, buildRules(), {
        titleTemplate: $('#titleTpl').value || '{课程名}',
        reminderMinutes: parseInt($('#reminder').value, 10),
        useEmoji: $('#useEmoji').checked
      });
    } catch (err) {
      S.plan = null;
      $('#planWarnings').innerHTML = notice('err', '计算出错：' + esc(err.message));
    }
  }

  function scheduleRecompute() {
    if (S.recomputeTimer) clearTimeout(S.recomputeTimer);
    S.recomputeTimer = setTimeout(function () {
      recompute();
      if (S.step === 4) renderPlan();
    }, 200);
  }

  function renderPlan() {
    recompute();
    var pw = $('#planWarnings');
    if (!S.plan) {
      $('#eventCount').textContent = '0 个事件';
      $('#statsBox').innerHTML = '';
      $('#eventBody').innerHTML = '<tr class="empty-row"><td colspan="7" class="empty">还没有数据</td></tr>';
      $('#fnCount').textContent = '0';
      $('#btnDownload').disabled = true;
      pw.innerHTML = '';
      return;
    }

    var evs = S.plan.events;
    $('#eventCount').textContent = evs.length + ' 个事件';
    $('#fnCount').textContent = evs.length;
    $('#btnDownload').disabled = false;

    var totalOcc = evs.reduce(function (s, e) { return s + e.occurrenceCount; }, 0);
    var recurring = evs.filter(function (e) { return e.rrule; }).length;
    var singles = evs.length - recurring;
    var exTotal = evs.reduce(function (s, e) { return s + (e.exdates ? e.exdates.length : 0); }, 0);
    var makeups = evs.filter(function (e) { return e.isMakeup; }).length;
    var spanDays = 0;
    if (evs.length) {
      var minD = evs.reduce(function (a, e) { return e.start < a ? e.start : a; }, evs[0].start);
      var maxD = evs.reduce(function (a, e) { return e.end > a ? e.end : a; }, evs[0].end);
      spanDays = Core.wallDiffDays(minD, maxD) + 1;
    }

    $('#statsBox').innerHTML = [
      ['课程', S.courses.length, '门'],
      ['课次合计', totalOcc, '次'],
      ['日历事件', evs.length, '个'],
      ['含重复规则', recurring, '个'],
      ['独立事件', singles, '个'],
      ['排除的日期', exTotal, '天']
    ].map(function (x) {
      return '<div class="stat"><div class="k">' + x[0] + '</div><div class="v">'
        + x[1] + '<small>' + x[2] + '</small></div></div>';
    }).join('');

    var rows = evs.map(function (e, i) {
      var rr = e.rrule
        ? (e.rrule.interval === 1 ? '每周' : '每 ' + e.rrule.interval + ' 周') + ' ×' + e.rrule.count
        : '单次';
      if (e.exdates && e.exdates.length) rr += '（排除 ' + e.exdates.length + '）';
      // 把「具体哪几周」直接摊开：核对时最想看的就是这个。
      // 只写「每 4 周 ×3」，用户还得自己掰手指算是哪三周。
      if (e.weekSummary) {
        rr += '<br><span class="t-c-weeks">' + esc(e.weekSummary) + '</span>';
      }
      return '<tr>'
        + '<td class="t-num">' + (i + 1) + '</td>'
        + '<td class="t-c-uid">' + esc(e.uid.slice(0, 8)) + '</td>'
        + '<td class="c-ev-title">' + esc(e.title)
        + (e.isMakeup ? ' <span class="badge">补课</span>' : '') + '</td>'
        + '<td class="t-c-time" data-label="时间">' + Core.wallISO(e.start) + ' '
        + Core.wallHHMM(e.start) + '–' + Core.wallHHMM(e.end) + '</td>'
        + '<td class="t-c-rr c-ev-rr" data-label="重复">' + rr + '</td>'
        + '<td data-label="地点">' + esc(e.location || '—') + '</td>'
        + '<td class="t-c-ct" data-label="覆盖">' + e.occurrenceCount + ' 次</td>'
        + '</tr>';
    }).join('');
    $('#eventBody').innerHTML = rows
      || '<tr class="empty-row"><td colspan="7" class="empty">没有事件</td></tr>';

    // 警告与提示
    var msgs = [];
    if (S.plan.warnings && S.plan.warnings.length) {
      msgs.push(notice('warn', '<b>注意到这些：</b><br>'
        + S.plan.warnings.slice(0, 5).map(esc).join('<br>')));
    }
    var lastDate = evs.length
      ? evs.reduce(function (a, e) { return e.start > a ? e.start : a; }, evs[0].start) : null;
    if (lastDate && lastDate > S.semester.endDate) {
      msgs.push(notice('info', '有 ' + makeups + ' 次补课落在学期结束之后，属于正常情况（补课周）。'));
    }
    if (spanDays > 0) {
      msgs.push(notice('info', '课表覆盖 <b>' + spanDays + '</b> 天，从首次课到最后一次课。'
        + '在日历里建议用「周」视图查看效果。'));
    }
    pw.innerHTML = msgs.join('');
  }

  function icsFilename() {
    var n = ($('#semName').value || '课表').replace(/[\\/:*?"<>|]/g, '').trim() || '课表';
    return n + ' 课表.ics';
  }

  function icsText() {
    if (!S.plan) return '';
    return Core.buildICS(S.plan.events, {
      offsetMinutes: S.semester ? S.semester.offsetMinutes : 480,
      calendarName: $('#semName').value || '课表'
    });
  }

  function downloadICS() {
    var text = icsText();
    if (!text) return;
    downloadBlob(new Blob([text], { type: 'text/calendar;charset=utf-8' }), icsFilename());

    $('#dlMsg').innerHTML = notice('ok',
      '已下载 <b>' + esc(icsFilename()) + '</b>。'
      + '<br>下一步：打开「文件」App →「下载」→ 点这个文件 → 日历预览 →「添加全部」→ 选到你的 iCloud 日历。'
      + '<br><span style="color:var(--ink3)">在电脑上：先建一个专用日历，再双击这个文件导入。</span>');
  }

  /* ---------- 模板下载 ---------- */

  function csvCell(v, sep) {
    var s = String(v == null ? '' : v);
    if (sep === '\t') return s.replace(/[\t\r\n]/g, ' ');
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildDelimitedTemplate(sep) {
    var T = Core.TEMPLATES.longTable;
    var lines = [T.headers.map(function (h) { return csvCell(h, sep); }).join(sep)];
    T.sample.concat(T.footer).forEach(function (row) {
      lines.push(row.map(function (c) { return csvCell(c, sep); }).join(sep));
    });
    // 带 BOM，Excel 打开中文才不乱码
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  /**
   * 空文本框才显示示例表格；一旦有内容就收起来。
   *
   * 示例以前直接写在 placeholder 里（制表符分隔），但文本框里中英混排
   * **根本对不齐**：中文是 1.0em、等宽拉丁只有 0.6em，比值 1.667 不是整数，
   * 制表位的落点会随中文个数漂移。实测最大偏差 101px，换成等宽字体也还有 73px。
   * 所以示例改用真表格渲染，文本框只留一句说明。
   */
  function syncPasteSample() {
    var box = $('#pasteSample');
    if (!box) return;
    box.hidden = $('#pasteText').value.trim() !== '';
  }

  /** 把一段文本塞进「粘贴文本」框，并切回该标签页 */
  function fillPasteBox(text, msg) {
    $('#pasteText').value = text;
    syncPasteSample();
    var pasteTab = document.querySelector('#tabs button[data-tab="paste"]');
    if (pasteTab) pasteTab.click();
    $('#step1Msg').innerHTML = notice('info', msg);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function downloadTemplate(kind) {
    try {
      if (kind === 'xlsx') {
        var bytes = await Core.buildXlsx(Core.buildTemplateSheets());
        downloadBlob(new Blob([bytes], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }), '课表模板.xlsx');
        $('#step1Msg').innerHTML = notice('ok',
          '已下载 <b>课表模板.xlsx</b>。里面有 3 张表：<b>填写说明</b> / <b>长表型</b> / <b>矩阵型</b>。'
          + '<br>把「长表型」里的示例行改成你的课程，保存后再拖回上面的上传区即可。'
          + '<br>提醒：文件里只写节次（如 1-2），第几节对应几点由上面的「上下课时间」决定。'
          + '作息表里有的具名节次可以直接写，如 <b>中午2-6</b>。');
      } else if (kind === 'csv' || kind === 'tsv') {
        var text = buildDelimitedTemplate(kind === 'csv' ? ',' : '\t');
        downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), '课表模板.' + kind);
        $('#step1Msg').innerHTML = notice('ok',
          '已下载 <b>课表模板.' + kind + '</b>（已带 UTF-8 BOM，Excel 打开中文不会乱码）。'
          + '<br>用 Excel / 记事本改成你的课程后保存，再拖回上面的上传区。'
          + '<br>提醒：文件里只写节次（如 1-2、中午2-6），第几节对应几点由上面的「上下课时间」决定。');
      } else if (kind === 'fill') {
        var t = Core.TEMPLATES.longTable;
        var rows2 = [t.headers].concat(t.sample.slice(0, 4));
        fillPasteBox(rows2.map(function (r) { return r.join('\t'); }).join('\n'),
          '已经把表格模板填进上面的文本框了，改成你自己的课程就行。');
      } else if (kind === 'card') {
        fillPasteBox(Core.TEMPLATES.card.sample.join('\n'),
          '已经把两张「课程信息」示例填进文本框了。'
          + '每张卡片改成你自己的课就行，卡片之间留一个空行即可。');
      }
    } catch (err) {
      $('#step1Msg').innerHTML = notice('err',
        '生成模板失败：' + esc(err && err.message ? err.message : String(err))
        + '<br>可以改用 CSV 模板。');
    }
  }

  async function copyICS() {
    var text = icsText();
    if (!text) return;
    var okDone = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        okDone = true;
      }
    } catch (e) { okDone = false; }
    if (!okDone) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); okDone = true; } catch (e2) { okDone = false; }
      document.body.removeChild(ta);
    }
    $('#dlMsg').innerHTML = okDone
      ? notice('ok', '日历文件内容已复制到剪贴板（' + text.split('\r\n').length + ' 行）。')
      : notice('warn', '当前环境不允许自动复制，请改用「下载 .ics 文件」。');
  }

  /* ---------- 示例数据 ---------- */

  var SAMPLE = [
    '课程名称\t教师\t周次\t星期\t节次\t教室',
    '高等数学\t张老师\t1-16周\t周一\t1-2\t教一301',
    '线性代数\t李老师\t1-16周(单)\t周二\t3-4\t教二205',
    '大学英语\t王老师\t1-16周(双)\t周二\t3-4\t教二206',
    '数据结构\t陈老师\t3-15周\t周三\t2-3\t教三101',
    '大学物理\t刘老师\t1-16周\t周四\t5-6\t教一101',
    '大学物理实验\t刘老师\t4-14周\t周四\t7-8\t实验楼B203',
    '体育\t赵老师\t1-16周\t周五\t7-8\t操场'
  ].join('\n');

  /* ---------- 初始化 ---------- */

  function init() {
    var d = defaultSemester();
    $('#semName').value = d.name;
    $('#semStart').value = dateInputValue(d.start);
    $('#semWeeks').value = d.weeks;
    $('#oddBasis').value = String(S.oddWeek);
    $('#titleTpl').value = '{课程名}';
    refreshSemester();
    syncPasteSample();

    // 表与某个内置预设完全一致时，下拉框回显它
    if (!S.slotPresetId) {
      Core.SLOT_PRESETS.forEach(function (p) {
        if (S.slotTable.name === p.name) S.slotPresetId = p.id;
      });
    }
    renderSlots();

    // 作息表
    $('#slotEditor').addEventListener('change', onSlotEditorChange);
    $('#slotEditor').addEventListener('click', function (e) {
      var b = e.target.closest('[data-del]');
      if (!b) return;
      if (S.slotTable.slots.length <= 1) { alert('至少要保留一节。'); return; }
      var key = b.getAttribute('data-del');
      var gone = Core.slotOf(S.slotTable, key);
      S.slotTable.slots = S.slotTable.slots.filter(function (s) { return s.key !== key; });
      S.slotPresetId = '';
      if (gone) {
        var orphan = 0;
        S.courses.forEach(function (c) {
          (c.patterns || []).forEach(function (p) {
            (p.slots || []).forEach(function (r) { if (String(r) === String(key)) orphan++; });
          });
        });
        if (orphan) {
          slotWarn('已删除「' + esc(key) + '」，但你课表里有 ' + orphan
            + ' 个时段用着这一节，它们会显示成「节次无法解析」。'
            + '需要的话把那一节加回来。');
        }
      }
      afterSlotChange();
    });

    $('#slotPreset').addEventListener('change', function (e) {
      var p = findPreset(e.target.value);
      if (!p) return;
      S.slotPresetId = p.id;
      S.slotTable = Core.makeSlotTable(p.name, p.rows, {
        maxBreak: S.slotTable.maxBreak,
        joinMode: S.slotTable.joinMode
      });
      afterSlotChange();
    });

    $('#btnRegenSlots').addEventListener('click', function () {
      S.slotTable = Core.regenerateSlots(S.slotTable,
        +$('#slotDur').value, +$('#slotGap').value);
      S.slotPresetId = '';
      afterSlotChange();
    });

    $('#btnAddSlot').addEventListener('click', function () {
      var list = S.slotTable.slots;
      var last = list[list.length - 1];
      if (!last) return;
      var maxNum = 0;
      list.forEach(function (s) { if (s.index != null && s.index > maxNum) maxNum = s.index; });
      var dur = Math.max(5, mOf(last.end) - mOf(last.start));
      var s0 = mOf(last.end) + 5;
      var idx = maxNum + 1;
      list.push({
        index: idx, label: null, key: String(idx),
        start: { h: Math.floor(s0 / 60) % 24, m: s0 % 60 },
        end: { h: Math.floor((s0 + dur) / 60) % 24, m: (s0 + dur) % 60 },
        group: last.label == null ? last.group : '晚上'
      });
      S.slotPresetId = '';
      afterSlotChange();
    });

    /**
     * 插一节「中午」这样的具名节次。
     *
     * 位置放在上午最后一节之后 —— 学校真正排午休课就是塞在这个缝里。
     * 名字先给个 中午1，要叫早读/晚自习直接在左侧输入框里改。
     */
    $('#btnAddNamedSlot').addEventListener('click', function () {
      var list = S.slotTable.slots;
      if (!list.length) return;
      var n = 1;
      while (list.some(function (s) { return s.key === '中午' + n; })) n++;
      var name = '中午' + n;

      // 跟着已有的中午节次往后接，没有则接在上午最后一节之后
      var afterIdx = -1;
      list.forEach(function (s, i) { if (s.group === '中午') afterIdx = i; });
      if (afterIdx < 0) list.forEach(function (s, i) { if (s.group === '上午') afterIdx = i; });
      if (afterIdx < 0) afterIdx = list.length - 1;

      var anchor = list[afterIdx];
      var s0 = mOf(anchor.end) + 5;
      var dur = Math.max(5, mOf(anchor.end) - mOf(anchor.start));
      list.splice(afterIdx + 1, 0, {
        index: null, label: name, key: name,
        start: { h: Math.floor(s0 / 60) % 24, m: s0 % 60 },
        end: { h: Math.floor((s0 + dur) / 60) % 24, m: (s0 + dur) % 60 },
        group: anchor.group === '中午' ? '中午' : '中午'
      });
      resortSlots();
      S.slotPresetId = '';
      afterSlotChange();
    });

    /** 把课表底部那张作息表粘进来，省得手敲十几节时间 */
    $('#btnParseBell').addEventListener('click', function () {
      var text = $('#bellText').value;
      if (!text.trim()) {
        $('#bellMsg').innerHTML = notice('warn', '先把课表底部那张作息表复制进来。');
        return;
      }
      var res = Core.parseBellSchedule(text);
      var t = Core.makeSlotTable('从课表识别的作息', res.rows, {
        maxBreak: S.slotTable.maxBreak, joinMode: S.slotTable.joinMode
      });
      if (!t.slots.length) {
        $('#bellMsg').innerHTML = notice('err', esc(res.warnings[0] || '没认出来。'));
        return;
      }
      S.slotTable = t;
      S.slotPresetId = '';
      $('#bellMsg').innerHTML = notice('ok', '识别出 <b>' + t.slots.length + '</b> 节：'
        + esc(t.slots.map(function (s) { return Core.slotName(s) + ' ' + Core.slotTimeText(s); })
          .join('　'))
        + (res.warnings.length
          ? '<br><span style="color:var(--warn)">' + res.warnings.map(esc).join('<br>') + '</span>'
          : ''));
      afterSlotChange();
    });

    $('#btnResetSlots').addEventListener('click', function () {
      if (!confirm('把上下课时间恢复成标准的 12 节作息？')) return;
      S.slotTable = Core.makeStandard12();
      S.slotPresetId = 'std12';
      afterSlotChange();
    });

    $('#joinMode').addEventListener('change', function (e) {
      S.slotTable.joinMode = e.target.value;
      afterSlotChange();
    });

    $('#maxBreak').addEventListener('change', function (e) {
      S.slotTable.maxBreak = Math.max(0, Math.min(+e.target.value || 0, 60));
      afterSlotChange();
    });

    // 模板说明的两个格式切换
    var tplTabs = $('#tplTabs');
    if (tplTabs) {
      tplTabs.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        $$('#tplTabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
        ['long', 'matrix', 'card'].forEach(function (k) {
          var p = $('#tplpanel-' + k);
          if (p) p.hidden = b.dataset.tpltab !== k;
        });
      });
    }

    // 步骤条
    $('#steps').addEventListener('click', function (e) {
      var b = e.target.closest('.step');
      if (b) goStep(+b.dataset.step);
    });

    // 标签页
    $('#tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      $$('#tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      $('#tab-paste').hidden = b.dataset.tab !== 'paste';
      $('#tab-file').hidden = b.dataset.tab !== 'file';
    });

    // 学期字段
    ['#semName', '#semStart', '#semWeeks', '#semTZ'].forEach(function (sel) {
      $(sel).addEventListener('change', function () {
        refreshSemester();
        scheduleRecompute();
      });
    });

    // 单双周基准：换了要拿「周次原文」把全部课程的 weekMask 重算一遍
    $('#oddBasis').addEventListener('change', function (e) {
      S.oddWeek = (+e.target.value === 2) ? 2 : 1;
      saveOddWeek();
      refreshSemester();
      var n = reapplyWeekBasis();
      if (S.courses.length) {
        renderCourses(); renderConflicts(); scheduleRecompute();
      }
      $('#semInfo').innerHTML += '<br><b>单双周基准已切换</b>：'
        + (n ? '全部 ' + n + ' 个时段的周次已按新基准重算，请到第 2 步核对。'
             : '（还没有已解析的课程，本次导入会按新基准解析。）');
    });

    // 解析
    $('#btnParse').addEventListener('click', doParseText);
    $('#pasteText').addEventListener('input', syncPasteSample);
    $('#btnSample').addEventListener('click', function () {
      $('#pasteText').value = SAMPLE;
      syncPasteSample();
      doParseText();
    });
    $('#btnSampleCard').addEventListener('click', function () {
      $('#pasteText').value = Core.TEMPLATES.card.sample.join('\n');
      syncPasteSample();
      doParseText();
    });
    $('#btnClear').addEventListener('click', function () {
      $('#pasteText').value = '';
      syncPasteSample();
      $('#step1Msg').innerHTML = '';
    });

    // 文件
    var dz = $('#dropZone');
    dz.addEventListener('click', function () { $('#fileInput').click(); });
    dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', function () { dz.classList.remove('over'); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault(); dz.classList.remove('over');
      var f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    $('#fileInput').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (f) handleFile(f);
    });

    // 模板下载 / 填入
    var tplHelp = $('#tplHelp');
    if (tplHelp) {
      tplHelp.addEventListener('click', function (e) {
        var b = e.target.closest('[data-tpl]');
        if (!b) return;
        downloadTemplate(b.getAttribute('data-tpl'));
      });
    }

    // 课程表编辑
    $('#courseBody').addEventListener('input', onCourseEdit);
    $('#courseBody').addEventListener('change', onCourseEdit);
    $('#courseBody').addEventListener('click', onCourseClick);
    $('#btnAddRow').addEventListener('click', function () {
      if (!S.semester) refreshSemester();
      var wm = new Core.WeekMask(S.semester.totalWeeks);
      for (var w = 1; w <= S.semester.totalWeeks; w++) wm.add(w);
      S.courses.push({
        id: 'manual_' + Date.now() + '_' + S.courses.length,
        name: '新课程', teacher: '', room: '', courseType: 'required',
        patterns: [{ weekday: 1, slots: [1, 2], weekMask: wm, rawWeekText: '1-' + S.semester.totalWeeks + '周', room: null }]
      });
      renderCourses(); renderConflicts(); scheduleRecompute();
    });

    // 例外
    bindRuleEvents();
    $('#btnAddHoliday').addEventListener('click', function () {
      S.holidays.push({ date: Core.wallDate(2026, 10, 1), name: '' });
      renderHolidays(); scheduleRecompute();
    });
    $('#btnQuickNational').addEventListener('click', function () {
      var y = Core.parseISODate($('#semStart').value).getUTCFullYear();
      for (var d2 = 1; d2 <= 7; d2++) addHoliday(y + '-10-0' + d2, '国庆节');
      renderHolidays();
    });
    $('#btnQuickNewYear').addEventListener('click', function () {
      var y = Core.parseISODate($('#semStart').value).getUTCFullYear();
      addHoliday((y + 1) + '-01-01', '元旦');
      renderHolidays();
    });
    $('#btnQuickLabor').addEventListener('click', function () {
      var y = Core.parseISODate($('#semStart').value).getUTCFullYear();
      addHoliday(y + '-05-01', '劳动节');
      addHoliday(y + '-05-02', '劳动节');
      addHoliday(y + '-05-03', '劳动节');
      renderHolidays();
    });
    $('#btnAddMakeup').addEventListener('click', function () {
      if (!S.courses.length) { alert('请先在上一页添加课程'); return; }
      S.makeups.push({
        date: Core.parseISODate($('#semStart').value),
        courseId: S.courses[0].id,
        slots: [1, 2]
      });
      renderMakeups(); scheduleRecompute();
    });

    // 事件样式
    ['#titleTpl', '#reminder', '#useEmoji'].forEach(function (sel) {
      $(sel).addEventListener('input', function () { if (S.step === 4) renderPlan(); });
      $(sel).addEventListener('change', function () { if (S.step === 4) renderPlan(); });
    });

    // 导出
    $('#btnDownload').addEventListener('click', downloadICS);
    $('#btnCopyICS').addEventListener('click', copyICS);

    // 导航
    $('#btnBack2').addEventListener('click', function () { goStep(1); });
    $('#btnToStep3').addEventListener('click', function () { advance(3); });
    $('#btnBack3').addEventListener('click', function () { goStep(2); });
    $('#btnToStep4').addEventListener('click', function () { advance(4); });
    $('#btnBack4').addEventListener('click', function () { goStep(3); });
    $('#btnRestart').addEventListener('click', function () {
      if (!confirm('清空当前课表并重新开始？')) return;
      S.courses = []; S.holidays = []; S.makeups = [];
      S.plan = null; S.conflicts = []; S.parseWarnings = []; S.parseMeta = null;
      $('#pasteText').value = ''; $('#step1Msg').innerHTML = '';
      syncPasteSample();
      S.maxStep = 1; goStep(1);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
