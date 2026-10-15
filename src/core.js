/* ============================================================
   课表导入器 · 内核 Core
   ------------------------------------------------------------
   纯逻辑，零依赖，无 DOM 依赖（除 XLSX 的 XML 解析外）。
   同一份代码在浏览器与 Node 中运行，便于用 Node 做单元测试。

   设计要点（移植自已通过 115 个测试的 Swift 版本）：
   1. 所有日期以「学期时区的墙上时间」存 Date，一律用 getUTC* 读取，
      彻底绕开本机时区干扰；写 .ics 时再减去固定偏移得到真 UTC。
   2. WeekMask 用 BigInt 位掩码（53 周超出 32 位）。
   3. UID 由内容确定性推导（UUIDv5），保证重复导出得到同一批 UID，
      这是「重复导入不产生重复事件」的唯一指望。
   4. .ics 支持 EXDATE —— 比 EventKit 的 EKRecurrenceRule 表达力更强，
      所以「停课」不需要打断规则，一条 RRULE + 几个 EXDATE 即可。
   ============================================================ */

var Core = (function () {
  'use strict';

  var MS_DAY = 86400000;

  /* ============================================================
     一、日期工具（墙上时间）
     ============================================================ */

  function wallDate(y, m, d, hh, mm) {
    return new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0, 0));
  }

  function wallAddDays(dt, n) {
    return new Date(dt.getTime() + n * MS_DAY);
  }

  function wallStartOfDay(dt) {
    return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  }

  function wallDiffDays(a, b) {
    return Math.round((wallStartOfDay(b).getTime() - wallStartOfDay(a).getTime()) / MS_DAY);
  }

  /** 1 = 周一 … 7 = 周日（ISO 约定，与 Calendar 的 1=周日 不同） */
  function wallDowIso(dt) {
    var d = dt.getUTCDay();
    return d === 0 ? 7 : d;
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < (w || 2)) s = '0' + s;
    return s;
  }

  function wallISO(dt) {
    return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
  }

  function wallHHMM(dt) {
    return pad(dt.getUTCHours()) + ':' + pad(dt.getUTCMinutes());
  }

  function wallDateCN(dt) {
    var wd = ['一', '二', '三', '四', '五', '六', '日'][wallDowIso(dt) - 1];
    return (dt.getUTCMonth() + 1) + '月' + dt.getUTCDate() + '日 周' + wd;
  }

  /** 墙上时间 -> 真 UTC（用于写入 .ics，一律 Z 结尾，免去 VTIMEZONE） */
  function wallToUTC(dt, offsetMinutes) {
    return new Date(dt.getTime() - offsetMinutes * 60000);
  }

  /** "YYYYMMDDTHHMMSSZ" */
  function utcStamp(dt) {
    return '' + dt.getUTCFullYear() + pad(dt.getUTCMonth() + 1) + pad(dt.getUTCDate())
      + 'T' + pad(dt.getUTCHours()) + pad(dt.getUTCMinutes()) + pad(dt.getUTCSeconds()) + 'Z';
  }

  /** 解析 "2026-09-07" -> 墙上 Date */
  function parseISODate(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s).trim());
    if (!m) return null;
    return wallDate(+m[1], +m[2], +m[3]);
  }

  /** 解析 "08:00" / "8:00" / "800" / "8点30" -> {h, m} */
  function parseTimeOfDay(raw) {
    if (raw == null) return null;
    var s = String(raw).normalize('NFKC').trim()
      .replace(/[点时時]/g, ':').replace(/:$/, '');
    if (s.indexOf(':') >= 0) {
      var p = s.split(':');
      var h = parseInt(p[0], 10), mi = parseInt(p[1], 10);
      if (isNaN(h) || isNaN(mi)) return null;
      return { h: h, m: mi };
    }
    if (/^\d{4}$/.test(s)) return { h: Math.floor(+s / 100), m: +s % 100 };
    if (/^\d{1,2}$/.test(s)) return { h: +s, m: 0 };
    return null;
  }

  /* ============================================================
     二、SHA-1 与确定性 UID
     自实现 SHA-1：file:// 下 crypto.subtle 不可用（需 Secure Context），
     而 UID 必须确定性，所以不能依赖 Web Crypto。
     ============================================================ */

  var SHA1_K = [0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xCA62C1D6];

  function sha1(bytes) {
    var ml = bytes.length;
    var totalLen = Math.ceil((ml + 9) / 64) * 64;
    var msg = new Uint8Array(totalLen);
    msg.set(bytes);
    msg[ml] = 0x80;
    var bitLen = ml * 8;
    var hi = Math.floor(bitLen / 4294967296);
    var lo = bitLen >>> 0;
    msg[totalLen - 8] = (hi >>> 24) & 0xff;
    msg[totalLen - 7] = (hi >>> 16) & 0xff;
    msg[totalLen - 6] = (hi >>> 8) & 0xff;
    msg[totalLen - 5] = hi & 0xff;
    msg[totalLen - 4] = (lo >>> 24) & 0xff;
    msg[totalLen - 3] = (lo >>> 16) & 0xff;
    msg[totalLen - 2] = (lo >>> 8) & 0xff;
    msg[totalLen - 1] = lo & 0xff;

    var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE,
        h3 = 0x10325476, h4 = 0xC3D2E1F0;
    var w = new Uint32Array(80);

    for (var i = 0; i < totalLen; i += 64) {
      for (var j = 0; j < 16; j++) {
        w[j] = (msg[i + j * 4] << 24) | (msg[i + j * 4 + 1] << 16)
             | (msg[i + j * 4 + 2] << 8) | msg[i + j * 4 + 3];
      }
      for (var j2 = 16; j2 < 80; j2++) {
        var v = w[j2 - 3] ^ w[j2 - 8] ^ w[j2 - 14] ^ w[j2 - 16];
        w[j2] = ((v << 1) | (v >>> 31)) >>> 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4;
      for (var j3 = 0; j3 < 80; j3++) {
        var f, k;
        if (j3 < 20) { f = (b & c) | (~b & d); k = SHA1_K[0]; }
        else if (j3 < 40) { f = b ^ c ^ d; k = SHA1_K[1]; }
        else if (j3 < 60) { f = (b & c) | (b & d) | (c & d); k = SHA1_K[2]; }
        else { f = b ^ c ^ d; k = SHA1_K[3]; }
        var temp = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + w[j3]) >>> 0;
        e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = temp;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }

    var out = new Uint8Array(20);
    var hs = [h0, h1, h2, h3, h4];
    for (var t = 0; t < 5; t++) {
      out[t * 4] = (hs[t] >>> 24) & 0xff;
      out[t * 4 + 1] = (hs[t] >>> 16) & 0xff;
      out[t * 4 + 2] = (hs[t] >>> 8) & 0xff;
      out[t * 4 + 3] = hs[t] & 0xff;
    }
    return out;
  }

  var _enc = new TextEncoder();

  function utf8(s) { return _enc.encode(String(s)); }

  function concatBytes(a, b) {
    var o = new Uint8Array(a.length + b.length);
    o.set(a, 0);
    o.set(b, a.length);
    return o;
  }

  function hexOf(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += pad(bytes[i].toString(16));
    return s;
  }

  function uuidToBytes(s) {
    var hex = String(s).replace(/-/g, '');
    var out = new Uint8Array(16);
    for (var i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToUUID(b) {
    var h = hexOf(b);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16)
         + '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
  }

  /** App 级命名空间，永不改变 */
  var APP_NS = '8e4c1a72-3b5d-4f60-9a11-7c2d6e8f0b34';

  /** RFC 4122 UUIDv5（SHA-1） */
  function uuidV5(namespaceUuid, name) {
    var digest = sha1(concatBytes(uuidToBytes(namespaceUuid), utf8(name)));
    var b = digest.slice(0, 16);
    b[6] = (b[6] & 0x0f) | 0x50;   // version 5
    b[8] = (b[8] & 0x3f) | 0x80;   // RFC 4122 variant
    return bytesToUUID(b);
  }

  function sha1Hex(s) { return hexOf(sha1(utf8(s))); }

  var ID = {
    appNamespace: APP_NS,
    uuidV5: uuidV5,
    sha1Hex: sha1Hex,

    semesterID: function (name, anchorMonday, totalWeeks, offsetMinutes) {
      return uuidV5(APP_NS, 'semester|' + name + '|' + wallISO(anchorMonday)
        + '|' + totalWeeks + '|' + offsetMinutes);
    },

    /** 刻意不含地点/教师/节次：改教室时 key 不变，事件被判为「更新」而非「删除+新建」 */
    courseKey: function (semesterID, courseName, weekdayIso, patternIndex) {
      return sha1Hex('course|' + semesterID + '|' + courseName + '|'
        + weekdayIso + '|' + patternIndex).slice(0, 16);
    },

    eventUID: function (courseKey, blockSlots, blockTime, segmentFirstDate,
                        stepWeeks, occurrenceCount, offsetMinutes) {
      var name = 'event|' + courseKey + '|' + blockSlots + '|' + blockTime + '|'
        + wallISO(segmentFirstDate) + '|' + stepWeeks + '|' + occurrenceCount;
      return uuidV5(APP_NS, name);
    },

    contentFingerprint: function (title, start, end, location, rr, offsetMinutes) {
      return sha1Hex([title, wallISO(start), wallHHMM(start), wallHHMM(end),
        location || '', rr || 'single'].join('|')).slice(0, 24);
    }
  };

  /* ============================================================
     三、WeekMask（BigInt 位掩码）
     ============================================================ */

  var MASK_CAPACITY = 64;

  function WeekMask(totalWeeks, bits) {
    var n = Math.max(1, Math.min(totalWeeks || 1, MASK_CAPACITY));
    this.totalWeeks = n;
    this.bits = (bits === undefined ? 0n : bits) & WeekMask.validBits(n);
  }

  WeekMask.validBits = function (n) {
    if (n <= 0) return 0n;
    if (n >= 64) return (1n << 64n) - 1n;
    return (1n << BigInt(n)) - 1n;
  };

  WeekMask.prototype.has = function (w) {
    if (w < 1 || w > this.totalWeeks) return false;
    return (this.bits & (1n << BigInt(w - 1))) !== 0n;
  };

  WeekMask.prototype.add = function (w) {
    if (w < 1 || w > this.totalWeeks) return this;
    this.bits |= (1n << BigInt(w - 1));
    return this;
  };

  WeekMask.prototype.remove = function (w) {
    if (w < 1 || w > this.totalWeeks) return this;
    this.bits &= ~(1n << BigInt(w - 1));
    return this;
  };

  WeekMask.prototype.clone = function () { return new WeekMask(this.totalWeeks, this.bits); };

  WeekMask.prototype.count = function () {
    var c = 0, b = this.bits;
    while (b > 0n) { c += Number(b & 1n); b >>= 1n; }
    return c;
  };

  WeekMask.prototype.isEmpty = function () { return this.bits === 0n; };

  WeekMask.prototype.weeks = function () {
    var out = [];
    for (var w = 1; w <= this.totalWeeks; w++) if (this.has(w)) out.push(w);
    return out;
  };

  WeekMask.prototype.isEveryWeek = function () { return this.count() === this.totalWeeks; };

  WeekMask.prototype.intersect = function (o) {
    return new WeekMask(this.totalWeeks, this.bits & o.bits);
  };

  WeekMask.prototype.union = function (o) {
    return new WeekMask(this.totalWeeks, this.bits | o.bits);
  };

  WeekMask.prototype.subtract = function (o) {
    return new WeekMask(this.totalWeeks, this.bits & ~o.bits);
  };

  /** 等差数列最大连续段：连接「课表语义」与「RRULE INTERVAL」的桥梁 */
  WeekMask.prototype.runs = function () {
    var ws = this.weeks();
    var runs = [];
    if (!ws.length) return runs;
    if (ws.length === 1) return [{ firstWeek: ws[0], step: 1, count: 1 }];
    var i = 0;
    while (i < ws.length) {
      if (i === ws.length - 1) {
        runs.push({ firstWeek: ws[i], step: 1, count: 1 });
        break;
      }
      var step = ws[i + 1] - ws[i];
      var count = 2;
      while (i + count < ws.length && ws[i + count] - ws[i + count - 1] === step) count++;
      runs.push({ firstWeek: ws[i], step: step, count: count });
      i += count;
    }
    return runs;
  };

  WeekMask.prototype.summary = function () {
    if (this.isEmpty()) return '无';
    if (this.isEveryWeek()) return '1-' + this.totalWeeks + '周';
    var runs = this.runs();
    var allContig = runs.every(function (r) { return r.step === 1; });
    if (allContig && runs.length <= 8) {
      return runs.map(function (r) {
        return r.count === 1 ? String(r.firstWeek) : r.firstWeek + '-' + (r.firstWeek + r.count - 1);
      }).join(',') + '周';
    }
    var ws = this.weeks();
    if (ws.length <= 12) return ws.join(',') + '周';
    return '共' + ws.length + '周';
  };

  /* ============================================================
     四、周次文本解析
     ============================================================ */

  var DASH_RE = /[—–−－‐‑~～〜至到]/g;
  var SEP_RE = /[、，；;|/·\s]/g;

  /**
   * 归一化顺序是刻意的、且敏感的：先合破折号，再合空白。
   * 反过来会把 "1 - 16" 变成 "1,-,16"，数字区间就此失效。
   */
  function normalizeWeekText(raw) {
    var s = String(raw == null ? '' : raw).normalize('NFKC');
    s = s.replace(DASH_RE, '-');
    s = s.replace(/\s*-\s*/g, '-');
    s = s.replace(SEP_RE, ',');
    s = s.replace(/,{2,}/g, ',');
    s = s.replace(/^,+|,+$/g, '');
    return s;
  }

  /**
   * 最长匹配优先。`单双周` 必须排在 `单周`/`单` 之前。
   *
   * ⚠️「单双周」的正确含义是**隔周上一次**（每两周一次），不是「每周」。
   * 字面上它是「单周 + 双周」，很容易被读成「每周都上」——
   * 这两种理解的结果正好相反：每周 16 次 vs 隔周 8 次。
   * 业内口径（排课系统文档、各校选课须知）都是「单周 = 第 1、3、5… 周，
   * 双周 = 第 2、4、6… 周」，而「单双周」说的是**隔周**这个属性本身。
   *
   * 所以这里归到 'alternate'：先按周次取全集，再隔一个留一个，
   * 从**第一个有效周**算起。于是
   *     1-16周 单双周 -> 1,3,5,…,15
   *     2-16周 单双周 -> 2,4,6,…,16
   * 跟对应的「单周」「双周」一致，也符合「第一次课在哪周」的直觉。
   */
  var MODIFIER_TABLE = [
    ['单双周', 'alternate'], ['单双', 'alternate'], ['隔周', 'alternate'],
    ['每周', 'every'], ['全周', 'every'],
    ['单数周', 'odd'], ['双数周', 'even'],
    ['单周', 'odd'], ['双周', 'even'],
    ['(单)', 'odd'], ['（单）', 'odd'], ['(双)', 'even'], ['（双）', 'even']
  ];

  /**
   * 裸写的单个「单」「双」只在**独立成段**时才算数。
   *
   * ⚠️ 绝不能拿单字直接 indexOf 整个字符串。周次那一行里还可能有别的字：
   * 卡片格式下整行原文都会喂进来，于是
   *     `1-16周 双流校区`  -> 被当成双周，16 周变 8 周
   *     `3-18周 双号教学楼` -> 同上
   *     `1-16周 单县校区`  -> 被当成单周
   * 课少了一半，而从日历现象上完全看不出来。
   * 所以裸「单」「双」必须满足：前面是开头/分隔符/数字，且后面是分隔符或结尾。
   */
  var MODIFIER_BARE = [
    [/(?:^|[,、\s])\s*单\s*(?=$|[,、\s])/, 'odd'],
    [/(?:^|[,、\s])\s*双\s*(?=$|[,、\s])/, 'even'],
    [/\d\s*单(?:$|[,、\s])/, 'odd'],
    [/\d\s*双(?:$|[,、\s])/, 'even']
  ];

  function detectModifier(normalized) {
    var s = String(normalized == null ? '' : normalized);
    for (var i = 0; i < MODIFIER_TABLE.length; i++) {
      if (s.indexOf(MODIFIER_TABLE[i][0]) >= 0) return MODIFIER_TABLE[i][1];
    }
    for (var j = 0; j < MODIFIER_BARE.length; j++) {
      if (MODIFIER_BARE[j][0].test(s)) return MODIFIER_BARE[j][1];
    }
    return 'unspecified';
  }

  /**
   * 周次文本 -> WeekMask。
   *
   * @param opts.oddWeek  本学期的第 1 周算「单周」还是「双周」，取 1 或 2，默认 1。
   *
   * ★ 为什么需要这个参数：
   *   单双周的「单/双」必须有一个基准。本工具以**学期第 1 周**为基准
   *   （第 1 周 = 单周，第 3 周 = 单周…），这也是绝大多数高校的口径。
   *   但有两种情况会让基准整体错开一格，结果就是单双周完全相反：
   *     ① 学校按**自然年周数**编号（ISO 周），学期第 1 周恰好落在偶数 ISO 周；
   *     ② 学校按**学年连续编号**，秋季学期是奇数周，于是春季学期第 1 周是双周。
   *   这两种情况下把 oddWeek 设成 2 即可。逐学期导入课表，所以设一次就够。
   */
  function parseWeekMask(raw, totalWeeks, opts) {
    opts = opts || {};
    var oddWeek = (opts.oddWeek === 2) ? 2 : 1;
    var oddFrom = oddWeek;                       // 单周的起点学期周次
    var evenFrom = (oddWeek === 1) ? 2 : 1;      // 双周的起点学期周次
    totalWeeks = Math.max(1, Math.min(totalWeeks || 1, MASK_CAPACITY));
    var normalized = normalizeWeekText(raw);
    if (!normalized) return null;

    /**
     * ★ 抽周次数字之前，先把「节次」和「星期」片段摘掉。
     *
     * 教务矩阵格子里周次与节次写在同一行：
     *     13–13周:连续周 星期四 中午2–6节
     * 不摘的话 `2–6` 会被当成周次区间吃进去，结果是 2-6,13 周 ——
     * 用户日历上凭空多出 4 周的课，而且从现象上完全看不出来。
     * 这是本文件里最危险的一类静默错误。
     *
     * ⚠️ 编号之间要允许分隔符：`中午2,5,6节` 这种逗号罗列的写法，
     * 若只认单个数字或 x-y 区间，就只会吃掉末尾的 `6节`，
     * 剩下的 `2,5` 混进周次 —— 同样是静默错误。
     * 这里用 `(?:[-,\s]*\d+)*` 把一串编号整体吞掉。
     * 注意 `1-16周` 不会误伤：后面跟着的是「周」不是「节」。
     */
    var scanText = normalized
      .replace(/第?[一-鿿]*\d+(?:[-,\s]*\d+)*(?:节课?|节)/g, ' ')
      .replace(/(?:星期|周)[一二三四五六日天]/g, ' ');

    var mentionsWeek = String(raw == null ? '' : raw).indexOf('周') >= 0;
    var modifier = detectModifier(normalized);
    var mask = new WeekMask(totalWeeks);
    var warnings = [];
    var matched = false;

    // 区间分支写在前面，保证 `1-16` 作为整体被消费
    var re = /(\d+)\s*-\s*(\d+)|(\d+)/g;
    var m;
    while ((m = re.exec(scanText)) !== null) {
      if (m[1] !== undefined) {
        matched = true;
        var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        var lo = Math.min(a, b), hi = Math.max(a, b);
        if (hi > totalWeeks) {
          warnings.push('周次 ' + lo + '-' + hi + ' 超出学期 ' + totalWeeks + ' 周，超出部分已忽略');
        }
        for (var w = Math.max(1, lo); w <= Math.min(hi, totalWeeks); w++) mask.add(w);
      } else {
        matched = true;
        var v = parseInt(m[3], 10);
        if (v < 1 || v > totalWeeks) {
          warnings.push('周次 ' + v + ' 超出学期范围，已忽略');
        } else {
          mask.add(v);
        }
      }
    }

    if (!matched) {
      if (modifier === 'every') {
        for (var k = 1; k <= totalWeeks; k++) mask.add(k);
        return { mask: mask, modifier: modifier, confidence: 0.8, warnings: warnings,
                 normalizedText: normalized };
      }
      if (modifier === 'alternate') {
        // 没写区间时，从第 1 周起隔周
        for (var k0 = 1; k0 <= totalWeeks; k0 += 2) mask.add(k0);
        warnings.push('「单双周 / 隔周」是隔周上一次，这里按从第 1 周起隔周处理'
          + '（即第 1、3、5… 周）。若实际是第 2、4、6… 周，请写成「1-16周(双)」。');
        return { mask: mask, modifier: modifier, confidence: 0.6, warnings: warnings,
                 normalizedText: normalized };
      }
      if (modifier === 'odd' || modifier === 'even') {
        for (var k2 = (modifier === 'odd' ? oddFrom : evenFrom); k2 <= totalWeeks; k2 += 2) mask.add(k2);
        return { mask: mask, modifier: modifier, confidence: 0.8, warnings: warnings,
                 normalizedText: normalized };
      }
      return null;
    }

    if (mask.isEmpty()) return null;

    if (modifier === 'odd' || modifier === 'even') {
      var keep = new WeekMask(totalWeeks);
      for (var k3 = (modifier === 'odd' ? oddFrom : evenFrom); k3 <= totalWeeks; k3 += 2) keep.add(k3);
      mask = mask.intersect(keep);
    } else if (modifier === 'alternate') {
      /**
       * 隔周：按位置取，从**第一个有效周**算起，隔一个留一个。
       * 用位置而不是「周次的奇偶」，是为了让 `2-16周 单双周` 也能得到
       * 2、4、6…（跟「第一次课在第 2 周」的直觉一致）；
       * 若按奇偶去筛，2-16 会得到 3、5、7… 反而丢掉第一次课。
       */
      var seq = mask.weeks();
      var alt = new WeekMask(totalWeeks);
      for (var a = 0; a < seq.length; a += 2) alt.add(seq[a]);
      mask = alt;
    }

    if (mask.isEmpty()) {
      warnings.push('套用「' + modifier + '」后周次为空，请检查原文');
      return { mask: mask, modifier: modifier, confidence: 0.2, warnings: warnings,
               normalizedText: normalized };
    }

    var conf = 0.72;
    if (mentionsWeek) conf += 0.15;
    if (modifier !== 'unspecified') conf += 0.08;
    if (warnings.length) conf -= 0.20;
    conf = Math.max(0.05, Math.min(1, conf));

    return { mask: mask, modifier: modifier, confidence: conf, warnings: warnings,
             normalizedText: normalized };
  }

  /* ============================================================
     五、节次表
     ============================================================ */

  function hmOf(h, m) { return { h: h, m: m }; }
  function minOf(t) { return t.h * 60 + t.m; }
  function hmFromMin(m) { return { h: Math.floor(m / 60) % 24, m: m % 60 }; }

  function fmtHM(t) {
    return (t.h < 10 ? '0' : '') + t.h + ':' + (t.m < 10 ? '0' : '') + t.m;
  }

  /**
   * 构造节次表（通用工厂）。
   *
   * @param name  显示名，如「标准 12 节」
   * @param rows  [[编号或名称, 起h, 起m, 止h, 止m, 分组], ...]
   * @param opts  { maxBreak, joinMode }
   *
   * ── 为什么节次可以是「具名」的 ────────────────────────────────
   * 真实教务表里存在这样的作息：
   *     上午 1 2 3 4 → 中午1 → 中午2 → 下午 5 6 7 8 → 晚上 9 10 11
   * 「中午1」「中午2」有自己的时间段、真的会排课，但不在 1…11 的主序列里。
   * 所以节次标识不再是整数，而是一个 key：
   *     数字编号 -> key = '5'      （ref 用 number 5 表示）
   *     具名节次 -> key = '中午1'  （ref 用 string '中午1' 表示）
   * 数组顺序 = 时间顺序 = 连堂判断里的「位置」，与编号大小无关。
   *
   * ⚠️ 纯数字节次的展示文本（'3-4节'）与改造前逐字节一致。eventUID 的输入里
   *    含 slotsText，改一个字符，用户已导出的日历在重复导入时就会多出重复事件。
   *    baseline-before.ics + test-core.js 的回归段就是守这一条的。
   *
   * `joinMode` 决定「连堂节次」如何切成日历事件：
   *   'gap'   —— 按课间切分（默认）。位置相邻、且两节之间空档 ≤ maxBreak 分钟
   *              才合并。`1-3 节`若 2→3 之间夹着 25 分钟大课间，会拆成
   *              「08:00–09:35」和「10:00–10:45」两个事件。
   *              好处：不会凭空占用用户 09:35–10:00 的自由时间。
   *   'keep'  —— 位置相邻就合并，忽略课间长度。
   *   'split' —— 不合并，每节一个独立事件。
   *
   * 三种模式都只认「位置相邻」，不再认「数字差 1」。于是 `4` 与 `5` 之间隔着
   * 中午1、中午2 时，任何模式下都不会被并成一个跨午休的事件；而
   * `中午2–6节`（13:35–14:25 / 14:30–15:20 / 15:25–16:15，课间各 5 分钟）
   * 在默认的 gap 下正确合成一次 13:35–16:15 的长课。
   */
  function makeSlotTable(name, rows, opts) {
    opts = opts || {};
    var slots = [];
    var seen = {};

    (rows || []).forEach(function (r) {
      var str = String(r[0] == null ? '' : r[0]).trim();
      var isNum = /^\d+$/.test(str);
      var start = hmOf(+r[1], +r[2]);
      var end = hmOf(+r[3], +r[4]);
      if (!str) return;
      if (!(minOf(end) > minOf(start))) return;

      var s = {
        index: isNum ? parseInt(str, 10) : null,
        label: isNum ? null : str,
        start: start,
        end: end,
        group: r[5] || '上午'
      };
      s.key = s.label != null ? s.label : String(s.index);
      if (seen[s.key]) return;            // 同 key 只留第一个，标识必须唯一
      seen[s.key] = 1;
      slots.push(s);
    });

    // 时间顺序即位置顺序：中午1(12:05) 排在 5(14:30) 之前，与编号无关
    slots.sort(function (a, b) { return minOf(a.start) - minOf(b.start); });

    return {
      name: name || '自定义作息',
      maxBreak: opts.maxBreak == null ? 5 : +opts.maxBreak,
      joinMode: opts.joinMode || 'gap',
      slots: slots
    };
  }

  /**
   * 默认作息：标准 12 节。
   *
   * 刻意复用 SLOT_PRESETS[0] 而不是另抄一份 —— 两份定义一旦漂移，
   * 界面上的「下拉框回显」就会失效（名称对不上），而且改一处忘一处。
   * 运行期调用，此时 SLOT_PRESETS 已完成赋值。
   */
  function makeStandard12() {
    var p = SLOT_PRESETS[0];
    return makeSlotTable(p.name, p.rows, { maxBreak: 5, joinMode: 'gap' });
  }

  /** 一批常见作息，供界面下拉选择 */
  var SLOT_PRESETS = [
    { id: 'std12', name: '标准 12 节 · 上午4 下午4 晚上4', rows: [
      [1, 8, 0, 8, 45, '上午'], [2, 8, 50, 9, 35, '上午'],
      [3, 10, 0, 10, 45, '上午'], [4, 10, 50, 11, 35, '上午'],
      [5, 14, 0, 14, 45, '下午'], [6, 14, 50, 15, 35, '下午'],
      [7, 16, 0, 16, 45, '下午'], [8, 16, 50, 17, 35, '下午'],
      [9, 19, 0, 19, 45, '晚上'], [10, 19, 50, 20, 35, '晚上'],
      [11, 20, 40, 21, 25, '晚上'], [12, 21, 30, 22, 15, '晚上']
    ] },
    { id: 'noon13', name: '11 节 + 中午 2 节 · 上午4 中午2 下午4 晚上3', rows: [
      [1, 8, 0, 8, 50, '上午'], [2, 8, 55, 9, 45, '上午'],
      [3, 10, 15, 11, 5, '上午'], [4, 11, 10, 12, 0, '上午'],
      ['中午1', 12, 5, 12, 55, '中午'], ['中午2', 13, 35, 14, 25, '中午'],
      [5, 14, 30, 15, 20, '下午'], [6, 15, 25, 16, 15, '下午'],
      [7, 16, 35, 17, 25, '下午'], [8, 17, 30, 18, 20, '下午'],
      [9, 19, 0, 19, 50, '晚上'], [10, 19, 55, 20, 45, '晚上'],
      [11, 20, 50, 21, 40, '晚上']
    ] },
    { id: 'compact10', name: '紧凑 10 节 · 上午4 下午4 晚上2', rows: [
      [1, 8, 0, 8, 45, '上午'], [2, 8, 50, 9, 35, '上午'],
      [3, 10, 0, 10, 45, '上午'], [4, 10, 50, 11, 35, '上午'],
      [5, 13, 30, 14, 15, '下午'], [6, 14, 20, 15, 5, '下午'],
      [7, 15, 30, 16, 15, '下午'], [8, 16, 20, 17, 5, '下午'],
      [9, 18, 30, 19, 15, '晚上'], [10, 19, 20, 20, 5, '晚上']
    ] },
    { id: 'light8', name: '轻量 8 节 · 上午3 下午3 晚上2', rows: [
      [1, 8, 0, 8, 45, '上午'], [2, 8, 55, 9, 40, '上午'],
      [3, 10, 0, 10, 45, '上午'],
      [4, 14, 0, 14, 45, '下午'], [5, 14, 55, 15, 40, '下午'],
      [6, 16, 0, 16, 45, '下午'],
      [7, 19, 0, 19, 45, '晚上'], [8, 19, 55, 20, 40, '晚上']
    ] },
    { id: 'bigblock', name: '大节制 6 节 · 上午2 下午2 晚上2（每节 90 分钟）', rows: [
      [1, 8, 0, 9, 30, '上午'], [2, 9, 50, 11, 20, '上午'],
      [3, 13, 30, 15, 0, '下午'], [4, 15, 20, 16, 50, '下午'],
      [5, 18, 30, 20, 0, '晚上'], [6, 20, 20, 21, 50, '晚上']
    ] },
    { id: 'schoolk12', name: '中学 8 节 · 上午4 下午4（含课间操）', rows: [
      [1, 7, 50, 8, 35, '上午'], [2, 8, 45, 9, 30, '上午'],
      [3, 10, 0, 10, 45, '上午'], [4, 10, 55, 11, 40, '上午'],
      [5, 14, 0, 14, 45, '下午'], [6, 14, 55, 15, 40, '下午'],
      [7, 15, 50, 16, 35, '下午'], [8, 16, 45, 17, 30, '下午']
    ] }
  ];

  /**
   * 按「每节时长 + 课间」重新顺推整张表。
   *
   * 保留现有分组结构与每组第一节的开始时间（这样上午 08:00 / 下午 14:00
   * 这些校定的界限不会跑掉），只重算每节的具体起止。
   *
   * ⚠️ 具名节次（中午1、早读…）一律不参与重排：它们的时长和位置与正课
   * 完全不同（午休里单独插一节），统一顺推会把它们挤到错误的时间上。
   */
  function regenerateSlots(table, durationMin, gapMin) {
    durationMin = Math.max(5, Math.min(+durationMin || 45, 240));
    gapMin = Math.max(0, Math.min(gapMin == null ? 5 : +gapMin, 120));

    var order = [];
    table.slots.forEach(function (s) {
      if (order.indexOf(s.group) < 0) order.push(s.group);
    });

    var out = [];
    order.forEach(function (g) {
      var list = table.slots.filter(function (s) { return s.group === g; });
      if (!list.length) return;
      var named = list.filter(function (s) { return s.label != null; });
      var numbered = list.filter(function (s) { return s.label == null; });

      var cur = minOf((numbered.length ? numbered[0] : list[0]).start);
      numbered.forEach(function (s) {
        var st = hmFromMin(cur);
        var en = hmFromMin(cur + durationMin);
        out.push([s.index, st.h, st.m, en.h, en.m, g]);
        cur = cur + durationMin + gapMin;
      });
      named.forEach(function (s) {
        out.push([s.label, s.start.h, s.start.m, s.end.h, s.end.m, g]);
      });
    });

    return makeSlotTable(table.name, out, {
      maxBreak: table.maxBreak, joinMode: table.joinMode
    });
  }

  /** 节次表 -> 可持久化的纯对象（给 localStorage 用） */
  function serializeSlotTable(t) {
    return {
      v: 2,
      name: t.name,
      maxBreak: t.maxBreak,
      joinMode: t.joinMode,
      rows: t.slots.map(function (s) {
        return [s.label != null ? s.label : s.index,
                s.start.h, s.start.m, s.end.h, s.end.m, s.group];
      })
    };
  }

  /** v1（纯数字编号）与 v2（可具名）都读；rows 结构对两者通用 */
  function deserializeSlotTable(o) {
    if (!o || (o.v !== 1 && o.v !== 2) || !Array.isArray(o.rows) || !o.rows.length) return null;
    var t = makeSlotTable(o.name, o.rows, { maxBreak: o.maxBreak, joinMode: o.joinMode });
    return t.slots.length ? t : null;
  }

  /** 节次展示名：数字节次是 '5'，具名节次是 '中午1' */
  function slotName(slot) {
    if (!slot) return '';
    return slot.label != null ? slot.label : String(slot.index);
  }

  /**
   * 按引用取节次。ref 可以是 number（5）、数字字符串（'5'）、
   * 具名 key（'中午1'），或者直接传节次对象本身。
   */
  function slotOf(table, ref) {
    if (ref == null) return null;
    if (typeof ref === 'object') ref = ref.key != null ? ref.key : ref.index;
    var s = String(ref).trim();
    if (!s) return null;
    for (var i = 0; i < table.slots.length; i++) {
      if (table.slots[i].key === s) return table.slots[i];
    }
    return null;
  }

  /** 节次在表里的位置（-1 表示不在表里）。位置才是连堂判断的依据。 */
  function posOf(table, ref) {
    if (ref == null) return -1;
    if (typeof ref === 'object') ref = ref.key != null ? ref.key : ref.index;
    var s = String(ref).trim();
    if (!s) return -1;
    for (var i = 0; i < table.slots.length; i++) {
      if (table.slots[i].key === s) return i;
    }
    return -1;
  }

  var CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
                '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];

  /**
   * 具名节次的别名表。
   *
   * 同一份教务导出里，节次列写「中午1」，底部作息表写「中午第1节课」——
   * 两种写法都必须认，否则要么报「中午1 不在节次表里」这种莫名其妙的提示，
   * 要么更糟：被静默当成第 1 节（8:55 上课，实际是 12:05）。
   */
  function slotAliases(slot) {
    if (slot.label == null) return [];
    var out = [slot.label];
    var m = /^(.*?)(\d+)$/.exec(slot.label);
    if (m) {
      var pre = m[1], n = parseInt(m[2], 10), cn = CN_NUM[n];
      out.push(pre + '第' + n + '节');
      out.push(pre + '第' + n + '节课');
      out.push(pre + n + '节');
      if (cn) {
        out.push(pre + '第' + cn + '节');
        out.push(pre + '第' + cn + '节课');
        out.push(pre + cn);
      }
      if (pre.length >= 2) {
        var tail = pre.slice(-1);
        out.push(tail + n);
        out.push(tail + '第' + n + '节');
        if (cn) out.push(tail + cn);
      }
    }
    var uniq = [], seen = {};
    out.forEach(function (a) {
      a = String(a).trim();
      if (a && !seen[a]) { seen[a] = 1; uniq.push(a); }
    });
    return uniq;
  }

  /**
   * 剥掉周次与星期片段，只留节次可能用到的字符。
   *
   * ⚠️ 周次必须能整段剥掉**罗列**写法（`5,9,13周`），不能只认单个区间。
   * 否则 `5,9,13周 星期四 中午2-6节` 里会剩下一截 `5,9`，
   * 被节次解析当成第 5、9 节 —— 用户日历上凭空多出两节不存在的课。
   */
  function stripWeekAndDayNoise(s) {
    return String(s)
      // 周次：`1-16周` / `5,9,13周` / `2-6,13周` / `第3周`
      .replace(/\d+(?:\s*[-,、]\s*\d+)*\s*(?:周次?|星期)/g, '')
      // 周次前的修饰词：`13-13周:连续周` 里的「连续周」也是周次描述，不是节次
      .replace(/(?:连续|单双|每周|隔周|全周|不连续)周/g, '')
      // 光写「星期四」不带数字
      .replace(/(?:星期|周)[一二三四五六日天]/g, '');
  }

  /**
   * 「中午1-2节」里的 2 该算第 2 节还是中午 2？
   *
   * 范围左端是具名节次、右端是光秃秃的数字时，先按同前缀找具名节次
   * （中午1 → 中午2）。学校写这种范围几乎都是在说中午的两节，
   * 真指第 2 节会写成「2-中午1」这种反序。找不到同前缀才退回数字节次。
   */
  function samePrefixPos(table, pos, num) {
    var base = table.slots[pos];
    if (!base || base.label == null) return -1;
    var m = /^(.*?)(\d+)$/.exec(base.label);
    if (!m) return -1;
    var probe = m[1] + num;
    for (var i = 0; i < table.slots.length; i++) {
      if (table.slots[i].key === probe) return i;
    }
    return -1;
  }

  /**
   * 从一段混合文本里截出「节次」片段。
   *
   * 教务矩阵格子里的原文长这样：
   *     13–13周:连续周 星期四 中午2–6节
   * 节次段永远在最后一个「节」之前。先截出来再解析，
   * 才能避免 `2–6节` 被周次解析器当成 2-6 周吃掉。
   *
   * ⚠️ 顺序是关键：**先把周次/星期整段剥掉，再往回回溯**。
   * 反过来做的话，回溯时只能用逗号当边界（否则会把 `5,9,13周` 吃进来），
   * 可节次内部也用逗号（`中午2,5,6节`），于是只截到末尾的 `6`。
   * 先剥再回溯，逗号就只剩「节次罗列」这一种含义了。
   */
  function extractSlotSegment(raw) {
    var s = normalizeWeekText(raw);
    if (s.lastIndexOf('节') < 0) return null;

    var head = stripWeekAndDayNoise(s);
    var last = head.lastIndexOf('节');
    if (last < 0) return null;

    var i = last;
    while (i > 0 && /[一-鿿\d\-,、，]/.test(head.charAt(i - 1))) i--;
    var seg = head.slice(i, last + 1).replace(/节课?$/, '');
    // 剥完周次后会留下孤零零的分隔符，去掉
    seg = seg.replace(/^[\s,、，\-]+|[\s,、，\-]+$/g, '');
    return seg || null;
  }

  /* 哨兵字符：把具名节次就地替换掉，避免「中午1」里的 1 被当成第 1 节 */
  var SENT = String.fromCharCode(1);

  /** 作息表里可能出现的具名节次前缀，用来做「表里没有就别猜」的防呆 */
  var NAMED_HINTS = ['中午', '早读', '早自习', '午自习', '晚自习', '晚点名', '课外活动'];

  /**
   * 节次原文 -> 节次引用列表（number 表示数字节次，string 表示具名节次）。
   *
   * 处理顺序是有讲究的：
   *   1. 先按当前节次表生成别名，**最长匹配优先**替换成哨兵，
   *      这样「中午2」整体消费掉，剩下的 6 才是独立的数字；
   *   2. 再剥掉周次与星期片段（`3–18周`、`星期四`），
   *      否则 `中午2–6节` 的 2–6 会被周次解析器吃掉；
   *   3. 最后按「引用 / 连字符 / 数字」原子序列展开范围。
   *
   * 范围 **按位置展开**，不按数字相减：`中午2–6节` = 中午2、5、6 三节
   * （它们在表里位置连续），而不是数字上的 2,3,4,5,6。
   *
   * 认不出来的写法一律报警告并丢弃，绝不猜成第 1 节 —— 猜错的代价是
   * 用户日历上出现一堆时间全错的课，而且从现象上看不出来。
   */
  function parseSlotRefs(raw, table) {
    var warnings = [];
    if (!table || !table.slots || !table.slots.length) {
      return { refs: [], warnings: ['作息表是空的'] };
    }

    var alias = [];
    table.slots.forEach(function (sl, pos) {
      slotAliases(sl).forEach(function (a) { alias.push([a, pos]); });
    });
    alias.sort(function (x, y) { return y[0].length - x[0].length; });

    var src = normalizeWeekText(raw);
    var out = '';
    var i = 0;
    while (i < src.length) {
      var hit = -1;
      for (var k = 0; k < alias.length; k++) {
        if (src.substr(i, alias[k][0].length) === alias[k][0]) { hit = k; break; }
      }
      if (hit >= 0) {
        out += SENT + alias[hit][1] + SENT;
        i += alias[hit][0].length;
      } else {
        out += src.charAt(i);
        i++;
      }
    }
    out = stripWeekAndDayNoise(out);

    // 防呆：原文提到「中午/早读…」，但表里没有对应节次
    NAMED_HINTS.forEach(function (h) {
      if (src.indexOf(h) < 0) return;
      var has = table.slots.some(function (sl) {
        return sl.label != null && sl.label.indexOf(h) >= 0;
      });
      if (!has) {
        warnings.push('课表里出现了「' + h + '」节次，但当前作息表里没有这一节。'
          + '请在「上下课时间」里补一行同名节次，否则这门课的时间是错的。');
      }
    });

    // 原子序列
    var atoms = [];
    for (var c = 0; c < out.length; c++) {
      var ch = out.charAt(c);
      if (ch === SENT) {
        var j = out.indexOf(SENT, c + 1);
        if (j < 0) break;
        atoms.push({ t: 'ref', pos: parseInt(out.substring(c + 1, j), 10) });
        c = j;
      } else if (ch >= '0' && ch <= '9') {
        var d = c;
        while (d < out.length && out.charAt(d) >= '0' && out.charAt(d) <= '9') d++;
        var prev = c > 0 ? out.charAt(c - 1) : '';
        // 数字紧跟在汉字后面（且不是「第/节/课」这类标记）= 具名节次没被认出来
        var unknown = /[一-鿿]/.test(prev) && '第节课'.indexOf(prev) < 0;
        atoms.push({ t: 'num', v: parseInt(out.substring(c, d), 10), unknown: unknown });
        c = d - 1;
      } else if (ch === '-') {
        atoms.push({ t: 'dash' });
      } else if (ch === '第' || ch === '节' || ch === '课') {
        /* 纯标记，忽略 */
      } else {
        atoms.push({ t: 'sep' });
      }
    }

    function atomPos(at) {
      if (!at) return -1;
      if (at.t === 'ref') return at.pos;
      if (at.t === 'num') return posOf(table, at.v);
      return -1;
    }

    var posList = [];
    for (var a2 = 0; a2 < atoms.length; a2++) {
      var at = atoms[a2];
      if (at.t !== 'ref' && at.t !== 'num') continue;

      if (at.unknown) {
        warnings.push('节次写法里有个认不出来的编号（第 ' + at.v + ' 节？）'
          + '，已跳过而没有猜测它对应几点。请核对作息表。');
        if (atoms[a2 + 1] && atoms[a2 + 1].t === 'dash'
            && atoms[a2 + 2] && (atoms[a2 + 2].t === 'num' || atoms[a2 + 2].t === 'ref')) {
          a2 += 2;
        }
        continue;
      }

      var p = atomPos(at);
      if (p < 0) {
        warnings.push('节次 ' + at.v + ' 不在节次表中，已忽略');
        continue;
      }

      var nx = atoms[a2 + 1], nn = atoms[a2 + 2];
      if (nx && nx.t === 'dash' && nn && (nn.t === 'num' || nn.t === 'ref')) {
        var q = (at.t === 'ref' && nn.t === 'num') ? samePrefixPos(table, p, nn.v) : -1;
        if (q < 0) q = atomPos(nn);
        if (q < 0) {
          if (nn.t === 'num') warnings.push('节次 ' + nn.v + ' 不在节次表中，已忽略');
          posList.push(p);
          a2 += 2;
          continue;
        }
        if (q < p) {
          warnings.push('节次范围 ' + slotName(table.slots[p]) + '-' + slotName(table.slots[q])
            + ' 是倒着写的，已按时间顺序取这中间的每一节。');
        }
        var lo = Math.min(p, q), hi = Math.max(p, q);
        var swallowed = [];
        for (var x = lo; x <= hi; x++) {
          posList.push(x);
          if (x > lo && x < hi && table.slots[x].label != null) {
            swallowed.push(slotName(table.slots[x]));
          }
        }
        if (swallowed.length) {
          warnings.push('节次范围 ' + slotName(table.slots[lo]) + '-' + slotName(table.slots[hi])
            + ' 之间还夹着「' + swallowed.join('」「') + '」，已一并算进这门课。'
            + '不是本意的话，请改写成逗号分隔（如 ' + slotName(table.slots[lo]) + ','
            + slotName(table.slots[hi]) + '）。');
        }
        a2 += 2;
      } else {
        posList.push(p);
      }
    }

    var uniq = [], seenP = {};
    posList.forEach(function (p) { if (!seenP[p]) { seenP[p] = 1; uniq.push(p); } });
    uniq.sort(function (m, n) { return m - n; });

    var refs = uniq.map(function (p) {
      var sl = table.slots[p];
      return sl.label != null ? sl.label : sl.index;
    });
    return { refs: refs, warnings: warnings };
  }

  /**
   * 节次引用 -> 时间块列表。
   *
   * ⚠️ 关键：不能返回「单一起止时间」。`[2,3]` 节中间有 25 分钟大课间，
   * 若合并成 08:50–10:45，就凭空占用了用户 09:35–10:00 的自由时间。
   * 正确行为是拆成两个块，也就是两个独立事件。
   *
   * 合并与否由 `table.joinMode` 决定（见 makeSlotTable 注释），也可用 options 覆盖。
   * 判断「连不连着」用的是**表里的位置**，不是编号之差 —— 所以 4 与 5 之间
   * 夹着中午1、中午2 时不会被并成一条跨午休的事件。
   */
  function resolveSlots(table, refs, options) {
    options = options || {};
    var mode = options.joinMode || table.joinMode || 'gap';
    var maxBreak = options.maxBreak == null
      ? (table.maxBreak == null ? 5 : table.maxBreak)
      : options.maxBreak;

    var posList = [];
    var seen = {};
    var warnings = [];

    (refs || []).forEach(function (r) {
      var p = posOf(table, r);
      if (p >= 0) {
        if (!seen[p]) { seen[p] = 1; posList.push(p); }
        return;
      }
      var label = (r && typeof r === 'object') ? (r.key || r.index) : r;
      warnings.push(/^\d+$/.test(String(label))
        ? '节次 ' + label + ' 不在节次表中，已忽略'
        : '节次「' + label + '」不在节次表中，已忽略');
    });
    posList.sort(function (a, b) { return a - b; });

    if (!posList.length) return { blocks: [], warnings: warnings };

    var groups = [];
    var cur = [posList[0]];
    for (var k = 1; k < posList.length; k++) {
      var p = posList[k];
      var prevPos = cur[cur.length - 1];
      var a = table.slots[prevPos];
      var b = table.slots[p];
      var gap = minOf(b.start) - minOf(a.end);
      var adjacent = (p === prevPos + 1);

      var merge;
      if (mode === 'split') merge = false;
      else if (mode === 'keep') merge = adjacent;
      else merge = adjacent && gap >= 0 && gap <= maxBreak;

      if (merge) cur.push(p);
      else { groups.push(cur); cur = [p]; }
    }
    groups.push(cur);

    return { blocks: groups.map(function (g) { return makeBlock(table, g); }).filter(Boolean),
             warnings: warnings };
  }

  function makeBlock(table, posList) {
    var a = table.slots[posList[0]];
    var b = table.slots[posList[posList.length - 1]];
    if (!a || !b) return null;

    var names = posList.map(function (p) { return slotName(table.slots[p]); });
    var refs = posList.map(function (p) {
      var s = table.slots[p];
      return s.label != null ? s.label : s.index;
    });
    var contiguous = true;
    for (var i = 1; i < posList.length; i++) {
      if (posList[i] !== posList[i - 1] + 1) { contiguous = false; break; }
    }

    // 数字节次的 slotsText 必须与改造前逐字节一致（eventUID 依赖它）
    return {
      slots: refs,
      slotsText: names.length === 1
        ? names[0] + '节'
        : (contiguous ? names[0] + '-' + names[names.length - 1] + '节' : names.join(',') + '节'),
      start: a.start,
      end: b.end,
      minutes: minOf(b.end) - minOf(a.start),
      slotCount: posList.length,
      hasNamed: posList.some(function (p) { return table.slots[p].label != null; })
    };
  }

  /**
   * 节次引用 -> 编辑框里的一行文本。
   * 位置连续的合成 `a-b`，跳号的用逗号分开（`1,3` 不能写成 `1-3`，
   * 那会让用户以为第 2 节也在这门课里）。
   */
  function refsToText(table, refs) {
    if (!refs || !refs.length) return '';
    var posList = [];
    var seen = {};
    refs.forEach(function (r) {
      var p = posOf(table, r);
      if (p >= 0 && !seen[p]) { seen[p] = 1; posList.push(p); }
    });
    posList.sort(function (a, b) { return a - b; });
    if (!posList.length) return refs.map(function (r) { return String(r); }).join(',');

    var runs = [];
    posList.forEach(function (p) {
      var last = runs[runs.length - 1];
      if (last && last.hi === p - 1) last.hi = p;
      else runs.push({ lo: p, hi: p });
    });
    return runs.map(function (r) {
      var a = slotName(table.slots[r.lo]);
      return r.lo === r.hi ? a : a + '-' + slotName(table.slots[r.hi]);
    }).join(',');
  }

  /** 连排节次预览：给定节次 -> 会切成几个事件、各自几点到几点 */
  function previewSlots(table, refs) {
    var res = resolveSlots(table, refs);
    return {
      warnings: res.warnings,
      blocks: res.blocks.map(function (b) {
        return { text: b.slotsText, time: fmtHM(b.start) + '–' + fmtHM(b.end), minutes: b.minutes };
      })
    };
  }

  /** 节次的展示用时间范围，如「08:00–08:45」 */
  function slotTimeText(slot) {
    return fmtHM(slot.start) + '–' + fmtHM(slot.end);
  }

  /**
   * 整张表按分组归档，供界面分块渲染。
   * 分组只是展示用的归属标签，**不参与任何合并判断**：
   * 同一份教务导出里「中午1」在节次列自成一行、在作息表里又归在上午栏，
   * 拿它当规则依据必然两边不一致。
   */
  function slotGroups(table) {
    var order = [];
    (table.slots || []).forEach(function (s) {
      if (order.indexOf(s.group) < 0) order.push(s.group);
    });
    return order.map(function (g) {
      return { label: g, slots: table.slots.filter(function (s) { return s.group === g; }) };
    });
  }

  /**
   * 识别课表底部的「作息表」小表，直接产出节次表 rows。
   *
   * 教务导出的课表末尾常带这样一块（列 = 上午/下午/晚上）：
   *     上午:               下午:               晚上:
   *     第1节课 8:00–8:50    第5节课 14:30–15:20  第9节课 19:00–19:50
   *     中午第1节课 12:05–12:55 …
   * 让用户粘一次就能填好整张表，比在界面上手敲 13 节时间快得多。
   *
   * 列头决定分组；格子里的名字（中午第1节课 -> 中午1）决定具名节次。
   */
  var BELL_TIME = /(\d{1,2})[:：.](\d{1,2})\s*(?:-|–|—|~|至)\s*(\d{1,2})[:：.](\d{1,2})/g;
  var BELL_GROUP_WORDS = ['上午', '下午', '晚上', '中午', '早读'];

  function cleanBellName(raw) {
    return String(raw == null ? '' : raw)
      .normalize('NFKC')
      .replace(/[（(][^)）]*[)）]/g, '')
      .replace(/第|节课|节|课|[:：]/g, '')
      .replace(/\s+/g, '');
  }

  function parseBellSchedule(text) {
    var warnings = [];
    var rows = [];
    var colGroup = {};
    var lines = String(text == null ? '' : text).split(/\r?\n/);

    lines.forEach(function (line) {
      if (!line.trim()) return;
      var cells = /\t/.test(line) ? line.split('\t') : [line];

      cells.forEach(function (cellText, col) {
        var cell = String(cellText).trim();
        if (!cell) return;

        var headOnly = cell.replace(/[:：\s]/g, '');
        if (BELL_GROUP_WORDS.indexOf(headOnly) >= 0) {
          colGroup[col] = headOnly;
          return;
        }

        BELL_TIME.lastIndex = 0;
        var m, from = 0;
        while ((m = BELL_TIME.exec(cell)) !== null) {
          var name = cleanBellName(cell.slice(from, m.index));
          from = m.index + m[0].length;
          var sh = +m[1], sm = +m[2], eh = +m[3], em = +m[4];
          if (sh > 23 || eh > 23 || sm > 59 || em > 59) {
            warnings.push('时间写法不合法，已跳过：' + m[0]);
            continue;
          }
          if (!(eh * 60 + em > sh * 60 + sm)) {
            warnings.push('结束时间不晚于开始时间，已跳过：' + name + ' ' + m[0]);
            continue;
          }
          var group = colGroup[col] || '';
          if (!group) {
            for (var gi = 0; gi < BELL_GROUP_WORDS.length; gi++) {
              if (name.indexOf(BELL_GROUP_WORDS[gi]) === 0) { group = BELL_GROUP_WORDS[gi]; break; }
            }
          }
          rows.push([name, sh, sm, eh, em, group || '上午']);
        }
      });
    });

    if (!rows.length) {
      return { rows: [], warnings: ['没认出任何一节。需要「第3节课 10:15–11:05」这样的行，'
        + '每节一行（从 Excel 直接复制过来最好）。'] };
    }
    return { rows: rows, warnings: warnings };
  }

  /* ============================================================
     六、学期与展开
     ============================================================ */

  function buildSemester(opts) {
    var firstDay = opts.firstDay;
    if (!firstDay) return null;
    var totalWeeks = Math.max(1, Math.min(+opts.totalWeeks || 1, MASK_CAPACITY));
    var dow = wallDowIso(firstDay);
    var anchor = wallAddDays(wallStartOfDay(firstDay), 1 - dow);
    return {
      name: opts.name || '学期',
      anchorMonday: anchor,
      totalWeeks: totalWeeks,
      endDate: wallAddDays(anchor, totalWeeks * 7 - 1),
      offsetMinutes: opts.offsetMinutes === undefined ? 480 : opts.offsetMinutes
    };
  }

  function weekIndexOf(sem, dt) {
    return Math.floor(wallDiffDays(sem.anchorMonday, dt) / 7) + 1;
  }

  function dateInWeek(sem, week, weekdayIso, time) {
    var day = wallAddDays(sem.anchorMonday, (week - 1) * 7 + (weekdayIso - 1));
    return wallDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(),
                    time.h, time.m);
  }

  /** 把例外规则预处理成字典，避免在日期循环里反复线性扫描 */
  function indexRules(rules, sem) {
    var idx = {
      holidayDays: {}, holidayNames: {},
      cancelAllDays: {}, cancelByCourse: {},
      roomOverrides: {}, timeOverrides: {}, makeups: {}
    };
    (rules || []).forEach(function (r) {
      var key = wallISO(wallStartOfDay(r.date));
      if (r.kind === 'holiday') {
        idx.holidayNames[key] = r.name || '假日';
        if (r.skipClasses !== false) idx.holidayDays[key] = true;
      } else if (r.kind === 'cancelAll') {
        idx.cancelAllDays[key] = true;
      } else if (r.kind === 'cancel') {
        (idx.cancelByCourse[key] = idx.cancelByCourse[key] || {})[r.courseId] = true;
      } else if (r.kind === 'roomOverride') {
        (idx.roomOverrides[key] = idx.roomOverrides[key] || {})[r.courseId] = r.room;
      } else if (r.kind === 'timeOverride') {
        (idx.timeOverrides[key] = idx.timeOverrides[key] || {})[r.courseId] = r.slots;
      } else if (r.kind === 'makeup') {
        (idx.makeups[r.courseId] = idx.makeups[r.courseId] || []).push(r);
      }
    });
    return idx;
  }

  /**
   * 展开：把「星期 + 节次 + 周次」变成具体时刻，并消化所有日期级例外。
   *
   * 与 Swift 版的关键差异：这里**不切日期段**，而是按 weekMask 的等差数列段
   * （runs）分组，把被排除的日期交给 .ics 的 EXDATE 表达。
   * 于是「国庆停课」不再打断规则——一条 RRULE + 一个 EXDATE 即可。
   */
  function expandCourse(course, sem, slotTable, rules) {
    var idx = indexRules(rules, sem);
    var events = [];
    var stats = { skippedByHoliday: 0, skippedByCancel: 0, addedMakeups: 0, overrides: 0 };
    var warnings = [];

    course.patterns.forEach(function (pattern, patternIndex) {
      var runs = pattern.weekMask.runs();

      runs.forEach(function (run) {
        // 理论序列：这个 run 声称会上课的周次
        var theoretical = [];
        for (var i = 0; i < run.count; i++) {
          theoretical.push(run.firstWeek + i * run.step);
        }

        // 逐周判断是否被日期级例外排除
        var effective = [];
        var excluded = [];

        theoretical.forEach(function (week) {
          var day = wallAddDays(sem.anchorMonday, (week - 1) * 7 + (pattern.weekday - 1));
          var key = wallISO(day);

          var skipReason = null;
          if (idx.holidayDays[key]) skipReason = 'holiday';
          else if (idx.cancelAllDays[key]) skipReason = 'cancel';
          else {
            var cb = idx.cancelByCourse[key];
            if (cb && cb[course.id]) skipReason = 'cancel';
          }
          if (skipReason) {
            if (skipReason === 'holiday') stats.skippedByHoliday++;
            else stats.skippedByCancel++;
            excluded.push({ week: week, day: day });
            return;
          }

          var ovTime = idx.timeOverrides[key] && idx.timeOverrides[key][course.id];
          var slots = ovTime || pattern.slots;
          if (ovTime) stats.overrides++;

          var room = pattern.room || course.room;
          var ovRoom = idx.roomOverrides[key] && idx.roomOverrides[key][course.id];
          if (ovRoom) { room = ovRoom; stats.overrides++; }

          effective.push({ week: week, day: day, slots: slots, room: room });
        });

        if (!effective.length) return;

        // 每次上课的块（[2,3] 会产出两个块 -> 两条 VEVENT）
        var firstEff = effective[0];
        var res = resolveSlots(slotTable, firstEff.slots);
        if (!res.blocks.length) {
          warnings.push('《' + course.name + '》第 ' + run.firstWeek + ' 周起的节次无法解析，已跳过');
          return;
        }
        res.warnings.forEach(function (w) { warnings.push('《' + course.name + '》' + w); });

        res.blocks.forEach(function (block, blockIndex) {
          var occs = [];
          effective.forEach(function (e) {
            var st = dateInWeek(sem, e.week, pattern.weekday, block.start);
            var en = dateInWeek(sem, e.week, pattern.weekday, block.end);
            occs.push({
              week: e.week, start: st, end: en, room: e.room,
              slots: e.slots, day: e.day, isMakeup: false
            });
          });
          occs.sort(function (a, b) { return a.start - b.start; });

          var exdates = excluded
            .map(function (x) { return dateInWeek(sem, x.week, pattern.weekday, block.start); });

          events.push({
            courseId: course.id,
            courseName: course.name,
            courseType: course.courseType,
            weekday: pattern.weekday,
            patternIndex: patternIndex,
            blockIndex: blockIndex,
            block: block,
            run: run,
            occurrences: occs,
            exdates: exdates,
            isMakeup: false,
            theoreticalCount: run.count,
            // 理论序列的第一次日期。UID 用它而不是「实际第一次」，
            // 这样即使第 1 周停课，UID 也不变，事件仍被判为「更新」而非「新建」。
            theoreticalFirst: dateInWeek(sem, run.firstWeek, pattern.weekday, block.start)
          });
        });
      });

      // 补课：独立于理论序列，不参与假日/停课过滤
      var mks = idx.makeups[course.id] || [];
      mks.forEach(function (mk) {
        var res = resolveSlots(slotTable, mk.slots);
        if (!res.blocks.length) {
          warnings.push('《' + course.name + '》的补课节次无法解析，已跳过');
          return;
        }
        if (idx.holidayDays[wallISO(wallStartOfDay(mk.date))]) {
          warnings.push('补课《' + course.name + '》安排在 '
            + wallISO(mk.date) + '（' + (idx.holidayNames[wallISO(wallStartOfDay(mk.date))] || '假日')
            + '），请确认是否排错');
        }
        res.blocks.forEach(function (block, blockIndex) {
          var st = wallDate(mk.date.getUTCFullYear(), mk.date.getUTCMonth() + 1,
                            mk.date.getUTCDate(), block.start.h, block.start.m);
          var en = wallDate(mk.date.getUTCFullYear(), mk.date.getUTCMonth() + 1,
                            mk.date.getUTCDate(), block.end.h, block.end.m);
          events.push({
            courseId: course.id,
            courseName: course.name,
            courseType: course.courseType,
            weekday: wallDowIso(st),
            patternIndex: patternIndex,
            blockIndex: 100 + blockIndex,
            block: block,
            run: { firstWeek: weekIndexOf(sem, st), step: 1, count: 1 },
            occurrences: [{ week: weekIndexOf(sem, st), start: st, end: en,
                            room: mk.room || course.room, slots: mk.slots, isMakeup: true }],
            exdates: [],
            isMakeup: true,
            theoreticalCount: 1,
            theoreticalFirst: st
          });
          stats.addedMakeups++;
        });
      });
    });

    return { events: events, warnings: warnings, stats: stats };
  }

  /* ============================================================
     七、生成 .ics 事件
     ============================================================ */

  function planEvents(courses, sem, slotTable, rules, options) {
    options = options || {};
    var titleTemplate = options.titleTemplate || '{课程名}';
    var reminder = options.reminderMinutes === undefined ? 10 : options.reminderMinutes;
    var useEmoji = !!options.useEmoji;
    var notesTemplate = options.notesTemplate
      || '教师：{教师}\n节次：{节次}\n周次：{周次}';

    var semID = ID.semesterID(sem.name, sem.anchorMonday, sem.totalWeeks, sem.offsetMinutes);
    var planned = [];
    var allWarnings = [];

    courses.forEach(function (course) {
      var out = expandCourse(course, sem, slotTable, rules);
      out.warnings.forEach(function (w) { allWarnings.push(w); });

      out.events.forEach(function (ev) {
        var first = ev.occurrences[0];
        var block = ev.block;
        var courseKey = ID.courseKey(semID, ev.courseName, ev.weekday, ev.patternIndex);
        var blockTime = wallHHMM(first.start) + '-' + wallHHMM(first.end);

        // DTSTART 之后才有效的 EXDATE（DTSTART 之前的排除项由 COUNT 吸收）
        var laterEx = ev.exdates.filter(function (d) { return d.getTime() > first.start.getTime(); });
        var beforeEx = ev.exdates.length - laterEx.length;
        var effCount = Math.max(1, ev.theoreticalCount - beforeEx);

        // UID 刻意依赖「理论首次日期 + 理论次数」而非实际值：
        // 这样停课、放假不会改变 UID，重复导出仍是同一批事件 ID。
        var uid = ID.eventUID(courseKey, block.slotsText, blockTime, ev.theoreticalFirst,
                              ev.run.step, ev.theoreticalCount, sem.offsetMinutes);

        var weekSummary = ev.isMakeup
          ? ('补课 ' + wallISO(first.start))
          : summariseWeeks(ev.occurrences.map(function (o) { return o.week; }));

        var vars = {
          '课程名': ev.courseName,
          '教师': course.teacher || '',
          '地点': first.room || '',
          '节次': block.slotsText,
          '周次': weekSummary,
          '类型': TYPE_LABEL[ev.courseType] || '其他'
        };

        var title = render(titleTemplate, vars);
        if (useEmoji) title = (TYPE_EMOJI[ev.courseType] || '') + ' ' + title;

        planned.push({
          uid: uid,
          courseId: ev.courseId,
          courseName: ev.courseName,
          title: title,
          start: first.start,
          end: first.end,
          location: first.room || '',
          description: render(notesTemplate, vars) + '\n---\n[[sched:v1:' + uid + ']]',
          rrule: ev.isMakeup ? null : { interval: ev.run.step, count: effCount },
          exdates: laterEx,
          calendarKey: TYPE_LABEL[ev.courseType] || '其他',
          occurrenceCount: ev.occurrences.length,
          slotsText: block.slotsText,
          weekSummary: weekSummary,
          reminderMinutes: reminder,
          isMakeup: ev.isMakeup
        });
      });
    });

    planned.sort(function (a, b) {
      if (a.start.getTime() !== b.start.getTime()) return a.start - b.start;
      return a.uid < b.uid ? -1 : 1;
    });

    return { events: planned, warnings: allWarnings, semesterID: semID };
  }

  var TYPE_LABEL = { required: '必修', elective: '选修', lab: '实验', pe: '体育', other: '其他' };
  var TYPE_EMOJI = { required: '📘', elective: '📗', lab: '🔬', pe: '🏃', other: '📌' };

  function render(tpl, vars) {
    return String(tpl).replace(/\{([^}]+)\}/g, function (_, k) {
      return vars[k] !== undefined ? vars[k] : '';
    }).replace(/[ \t]+$/gm, '').trim();
  }

  function summariseWeeks(weeks) {
    var uniq = [];
    var seen = {};
    weeks.forEach(function (w) { if (!seen[w]) { seen[w] = 1; uniq.push(w); } });
    uniq.sort(function (a, b) { return a - b; });
    if (!uniq.length) return '';
    var m = new WeekMask(Math.max(53, uniq[uniq.length - 1]));
    uniq.forEach(function (w) { m.add(w); });
    return m.summary();
  }

  /* ============================================================
     八、ICS 生成
     ============================================================ */

  function escapeICS(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  /**
   * 行折叠：每行不超过 75 个八位组，续行以单个空格开头。
   * ⚠️ 中文一个字符 3 字节，必须在**字符边界**切，不能从多字节字符中间断开。
   * 这是中文 .ics 最常见的 bug。
   */
  function foldLine(line) {
    var bytes = utf8(line);
    if (bytes.length <= 75) return line;
    var out = [];
    var cur = '';
    var curLen = 0;
    var limit = 75;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      // 代理对：把高低位一起取出来
      var code = line.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < line.length) {
        ch = line.slice(i, i + 2);
        i++;
      }
      var bl = utf8(ch).length;
      if (curLen + bl > limit) {
        out.push(cur);
        cur = ch;
        curLen = bl;
        limit = 74;   // 续行开头有一个空格，占 1 字节
      } else {
        cur += ch;
        curLen += bl;
      }
    }
    if (cur) out.push(cur);
    return out.join('\r\n ');
  }

  function buildICS(events, options) {
    options = options || {};
    var offset = options.offsetMinutes === undefined ? 480 : options.offsetMinutes;
    var now = new Date();
    var stamp = utcStamp(now);

    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ScheduleImporter//CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH'
    ];
    if (options.calendarName) {
      lines.push('X-WR-CALNAME:' + escapeICS(options.calendarName));
    }

    events.forEach(function (ev) {
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + ev.uid + '@schedule-importer');
      lines.push('DTSTAMP:' + stamp);
      lines.push('DTSTART:' + utcStamp(wallToUTC(ev.start, offset)));
      lines.push('DTEND:' + utcStamp(wallToUTC(ev.end, offset)));
      if (ev.rrule) {
        lines.push('RRULE:FREQ=WEEKLY;INTERVAL=' + ev.rrule.interval
          + ';COUNT=' + ev.rrule.count);
      }
      if (ev.exdates && ev.exdates.length) {
        lines.push('EXDATE:' + ev.exdates.map(function (d) {
          return utcStamp(wallToUTC(d, offset));
        }).join(','));
      }
      lines.push('SUMMARY:' + escapeICS(ev.title));
      if (ev.location) lines.push('LOCATION:' + escapeICS(ev.location));
      if (ev.description) lines.push('DESCRIPTION:' + escapeICS(ev.description));
      lines.push('TRANSP:OPAQUE');
      lines.push('SEQUENCE:0');
      lines.push('STATUS:CONFIRMED');
      if (ev.reminderMinutes != null) {
        lines.push('BEGIN:VALARM');
        lines.push('TRIGGER:-PT' + ev.reminderMinutes + 'M');
        lines.push('ACTION:DISPLAY');
        lines.push('DESCRIPTION:' + escapeICS(ev.title));
        lines.push('END:VALARM');
      }
      lines.push('END:VEVENT');
    });

    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }

  /* ============================================================
     九、课内冲突检测
     ============================================================ */

  function detectConflicts(courses, sem, slotTable, rules) {
    var all = [];
    var idxRules = indexRules(rules, sem);
    courses.forEach(function (course) {
      var out = expandCourse(course, sem, slotTable, rules);
      out.events.forEach(function (ev) {
        ev.occurrences.forEach(function (o) { all.push({ c: course, o: o, ev: ev }); });
      });
    });

    var buckets = {};
    all.forEach(function (item) {
      var key = wallISO(wallStartOfDay(item.o.start));
      (buckets[key] = buckets[key] || []).push(item);
    });

    var groups = {};
    Object.keys(buckets).forEach(function (day) {
      var items = buckets[day].slice().sort(function (a, b) {
        return a.o.start - b.o.start;
      });
      for (var i = 0; i < items.length - 1; i++) {
        var a = items[i];
        for (var j = i + 1; j < items.length; j++) {
          var b = items[j];
          if (b.o.start.getTime() >= a.o.end.getTime()) break;   // 已排序，后续更不会重叠
          if (a.c.id === b.c.id) continue;                        // 同一门课不算冲突
          var pair = a.c.id < b.c.id ? [a, b] : [b, a];
          var key = pair[0].c.id + '|' + pair[1].c.id;
          if (!groups[key]) {
            groups[key] = {
              courseA: pair[0].c.name, courseB: pair[1].c.name,
              slotsA: pair[0].ev.block.slotsText, slotsB: pair[1].ev.block.slotsText,
              roomA: pair[0].o.room || '', roomB: pair[1].o.room || '',
              dates: [],
              suggestion: pair[0].c.name === pair[1].c.name
                ? ((pair[0].o.room || '') === (pair[1].o.room || '') ? '疑似重复解析' : '同名不同教室')
                : '时间冲突'
            };
          }
          groups[key].dates.push(day);
        }
      }
    });

    return Object.keys(groups).map(function (k) { return groups[k]; })
      .sort(function (a, b) { return b.dates.length - a.dates.length; });
  }

  /* ============================================================
     十、文本 / CSV 解析
     ============================================================ */

  var FIELD_KEYWORDS = [
    ['courseName', ['课程名称', '课程名', '科目', '名称', '课程']],
    ['teacher', ['任课教师', '授课教师', '教师', '老师']],
    ['weekRange', ['上课周次', '周次', '周数']],
    ['weekday', ['上课星期', '星期几', '星期', '周几']],
    ['slots', ['上课节次', '节次', '时间', '节']],
    ['room', ['上课教室', '上课地点', '教室', '地点']],
    ['credits', ['学分']]
  ];

  var FIELD_LABEL = {
    courseName: '课程名', teacher: '教师', weekRange: '周次',
    weekday: '星期', slots: '节次', room: '地点', credits: '学分'
  };

  var WEEKDAY_LOOKUP = (function () {
    var short = ['一', '二', '三', '四', '五', '六', '日'];
    var m = {};
    for (var i = 0; i < 7; i++) {
      var iso = i + 1;
      m[String(iso)] = iso;
      m['周' + short[i]] = iso;
      m['星期' + short[i]] = iso;
      m['礼拜' + short[i]] = iso;
      m[short[i]] = iso;
    }
    m['周天'] = 7; m['星期天'] = 7; m['7'] = 7;
    m['mon'] = 1; m['monday'] = 1; m['tue'] = 2; m['tues'] = 2;
    m['wed'] = 3; m['thu'] = 4; m['thur'] = 4; m['thurs'] = 4;
    m['fri'] = 5; m['sat'] = 6; m['sun'] = 7; m['sunday'] = 7;
    return m;
  })();

  function parseWeekday(raw) {
    var key = String(raw == null ? '' : raw).normalize('NFKC').trim().toLowerCase();
    return WEEKDAY_LOOKUP[key] || null;
  }

  function parseSlotIndices(raw, maxSlot) {
    maxSlot = maxSlot || 20;
    var normalized = normalizeWeekText(raw);
    var out = [];
    var re = /(\d+)-(\d+)|(\d+)/g;
    var m;
    while ((m = re.exec(normalized)) !== null) {
      if (m[1] !== undefined) {
        var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        var lo = Math.max(1, Math.min(a, b)), hi = Math.min(maxSlot, Math.max(a, b));
        for (var i = lo; i <= hi; i++) out.push(i);
      } else {
        var v = parseInt(m[3], 10);
        if (v >= 1 && v <= maxSlot) out.push(v);
      }
    }
    var uniq = [];
    var seen = {};
    out.forEach(function (x) { if (!seen[x]) { seen[x] = 1; uniq.push(x); } });
    return uniq.sort(function (a, b) { return a - b; });
  }

  function inferCourseType(name) {
    if (/实验/.test(name)) return 'lab';
    if (/体育|体测/.test(name)) return 'pe';
    if (/选修|通识/.test(name)) return 'elective';
    return 'required';
  }

  /* ---------- 矩阵型课表（行 = 节次，列 = 星期） ----------

     这是教务系统「课程表」导出的最常见形态：一格 = 一门课的一次，
     格子里用换行堆着「课程名 / 教师 / 周次 / 教室」。
     单元格内的字段拆分只能靠启发式——所以解析后必须提示用户核对。 */

  /** 地点：含「楼/馆/场/室」，或含数字（教室号），且不长 */
  function looksLikeRoom(line) {
    if (!line || line.length > 24) return false;
    if (/[楼馆场室]/.test(line)) return true;
    if (/\d/.test(line) && !/周/.test(line)) return true;
    return false;
  }

  /** 教师：以「老师/教授/讲师/教师/导师」结尾 */
  function looksLikeTeacher(line) {
    return /(老师|教授|讲师|教师|导师)$/.test(line);
  }

  /** 找出矩阵的表头行：一行里至少有 3 个可识别的星期 */
  function detectMatrixHeader(grid) {
    var limit = Math.min(grid.length, 8);
    for (var r = 0; r < limit; r++) {
      var row = grid[r] || [];
      var cols = [];
      var seen = {};
      var uniqCount = 0;
      for (var c = 0; c < row.length; c++) {
        var wd = parseWeekday(String(row[c] || '').replace(/\s+/g, ''));
        if (!wd) continue;
        cols.push({ col: c, weekday: wd });
        if (!seen[wd]) { seen[wd] = 1; uniqCount++; }
      }
      if (cols.length >= 3 && uniqCount >= 3) return { rowIndex: r, cols: cols };
    }
    return null;
  }

  /** 单元格内容切分：优先按换行，其次按连续空格 */
  function splitCellContent(raw) {
    var s = String(raw == null ? '' : raw);
    var parts;
    if (/\r?\n/.test(s)) parts = s.split(/\r?\n/);
    else if (/\s{2,}/.test(s)) parts = s.split(/\s{2,}/);
    else parts = [s];
    return parts.map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /** 格子里带前缀的字段名 -> 内部字段名 */
  var CELL_FIELD = [
    ['name',    /^(?:课程名称|课程名|课程)\s*[:：]/],
    ['teacher', /^(?:主讲教师|任课教师|授课教师|教师)\s*[:：]/],
    ['room',    /^(?:上课地点|上课教室|地点|教室)\s*[:：]/],
    ['klass',   /^(?:班级|课程班|教学班)\s*[:：]/],
    ['week',    /^(?:周次|上课周次)\s*[:：]/]
  ];

  /** 整行就是一个括号：(教一301) / （实验楼B203） —— 研究生课表里这就是上课地点 */
  function bareParenRoom(line) {
    var m = /^[（(]([^（）()]{1,20})[)）]$/.exec(line);
    return m ? m[1].trim() : null;
  }

  /** 从「班级:xxx（计算中心A302）」尾部摘出括号里的教室号 */
  function trailingParen(text) {
    var m = /[（(]([^（）()]{1,20})[)）]\s*$/.exec(text);
    return m ? m[1].trim() : null;
  }

  /**
   * 从整段文字里挑一个「像教室」的括号内容。
   *
   * 「班级:高等数学（A班）3 (教一301)」这种把课程名后缀和教室挤在同一行的写法，
   * 尾部括号规则会落空。这时得逐个扫括号，用 looksLikeRoom 把「混合」这类
   * 课程名后缀滤掉 —— 否则教室会变成「混合」。
   */
  function roomFromParens(text) {
    var re = /[（(]([^（）()]{1,20})[)）]/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var v = m[1].trim();
      if (looksLikeRoom(v)) return v;
    }
    return null;
  }

  /**
   * 把一格内容拆成「课程名 / 教师 / 周次 / 节次 / 地点」。
   *
   * ★ 优先走「标签命中」。研究生教务导出的格子里每行都带字段名：
   *     课程:高等数学（A班）
   *     班级:高等数学（A班）3
   *     (教一301)
   *     13–13周:连续周 星期四 中午2–6节
   *     主讲教师:张老师
   *   认标签比按长度和词尾猜准得多 —— 旧的启发式会把「班级:xxx」整行
   *   当成地点（它有数字）、又漏掉「主讲教师:张老师」（looksLikeTeacher
   *   要求以「教师」**结尾**，而这里是前缀），结果教师全空、地点全错。
   *   没有标签的课表（多数本科导出）仍然走原启发式。
   */
  function parseMatrixCell(raw, totalWeeks, table, opts) {
    opts = opts || {};
    var parts = splitCellContent(raw);
    if (!parts.length) return null;

    var name = null, teacher = null, room = null, weekText = null, klass = null;
    var labeled = false;
    var rest = [];

    parts.forEach(function (line) {
      for (var i = 0; i < CELL_FIELD.length; i++) {
        var f = CELL_FIELD[i];
        if (!f[1].test(line)) continue;
        var val = line.replace(f[1], '').trim();
        if (!val) return;
        labeled = true;
        if (f[0] === 'name') { if (!name) name = val; }
        else if (f[0] === 'teacher') { if (!teacher) teacher = val; }
        else if (f[0] === 'room') { if (!room) room = val; }
        else if (f[0] === 'klass') {
          if (!klass) klass = val;
          if (!room) room = trailingParen(val);
          if (!room) room = roomFromParens(val);
        } else if (f[0] === 'week') { if (!weekText) weekText = val; }
        return;
      }
      var paren = bareParenRoom(line);
      if (paren) { if (!room) room = paren; labeled = true; return; }
      rest.push(line);
    });

    // 节次：整格里显式写了「…节」的那一段（周次与节次常写在同一行，
    // extractSlotSegment 取最后一个「节」之前的片段）
    var slotText = extractSlotSegment(parts.join('\n'));
    var refs = null, slotWarnings = [];
    if (slotText && table) {
      var pr = parseSlotRefs(slotText, table);
      refs = pr.refs.length ? pr.refs : null;
      slotWarnings = pr.warnings;
    }

    /**
     * 没被标签吃掉的行，交给旧启发式按顺序认领。
     *
     * 顺序不能改：先周次、再地点、再教师，最后剩下的才是课程名。
     * 「教一301」比「高等数学」长，若先选最长的当课名，课程名就变成教室号了
     * —— 旧实现正是靠这个先后顺序躲过这一点的。
     */
    var legacy = [];
    rest.forEach(function (line) {
      if (!weekText && /周/.test(line) && /\d/.test(line)) { weekText = line; return; }
      if (!room && looksLikeRoom(line)) { room = line; return; }
      if (!teacher && looksLikeTeacher(line)) { teacher = line; return; }
      legacy.push(line);
    });

    if (!(labeled && name)) {
      if (legacy.length) {
        legacy.sort(function (a, b) { return b.length - a.length; });
        if (!name) name = legacy[0];
        if (!teacher && legacy.length > 1) {
          for (var i2 = 1; i2 < legacy.length; i2++) {
            if (legacy[i2].length <= 4 && /^[一-龥]+$/.test(legacy[i2])) { teacher = legacy[i2]; break; }
          }
        }
      } else if (!name) {
        name = parts[0];
      }
    }

    if (!name) return null;

    var parsed = weekText ? parseWeekMask(weekText, totalWeeks, opts) : null;
    var mask = parsed ? parsed.mask : null;
    var weekWarnings = parsed ? parsed.warnings.slice() : [];
    if (!mask || mask.isEmpty()) {
      /**
       * 周次看不懂时的兜底。必须出声 —— 默认成「整学期每周」会让课
       * 多出一大截（「隔周」本意就是隔一周上一次，直接翻倍），
       * 而用户只会觉得「这 App 排错了」，找不到原因。
       */
      if (weekText) {
        weekWarnings.push('周次「' + weekText + '」没能看懂，已按整学期每周处理。'
          + '请核对这一门课的周次写法（比如「隔周」要写成「1-16周(单)」或「1-16周(双)」）。');
      }
      mask = new WeekMask(totalWeeks);
      for (var k = 1; k <= totalWeeks; k++) mask.add(k);
    }

    return {
      name: name, teacher: teacher || null, room: room || null,
      klass: klass || null, weekText: weekText, mask: mask,
      slots: refs, slotText: slotText,
      warnings: weekWarnings.concat(slotWarnings)
    };
  }

  function parseMatrixGrid(grid, totalWeeks, opts) {
    var hdr = detectMatrixHeader(grid);
    if (!hdr) return null;

    opts = opts || {};
    var table = (opts.slotTable && opts.slotTable.slots && opts.slotTable.slots.length)
      ? opts.slotTable : makeStandard12();

    var warnings = [];
    var byName = {};
    var order = [];
    var seenSig = {};

    var firstCol = hdr.cols.length ? hdr.cols[0].col : 1;

    for (var r = hdr.rowIndex + 1; r < grid.length; r++) {
      var row = grid[r] || [];

      /**
       * 行首可能不止一列：真实教务表是「上午/下午/晚上」分组列 + 节次列两列，
       * 只读 row[0] 会永远拿不到节次。取星期列之前**第一个能解析出节次**的那一列。
       */
      var rowRefs = { refs: [], warnings: [] };
      var labelTried = [];
      for (var lc = 0; lc < firstCol; lc++) {
        var raw0 = String(row[lc] == null ? '' : row[lc]).trim();
        if (!raw0) continue;
        labelTried.push(raw0);
        var cand = parseSlotRefs(raw0, table);
        if (cand.refs.length) { rowRefs = cand; break; }
      }
      if (!rowRefs.refs.length) {
        // 行首有内容却对不上作息表 -> 这一行的课会整批丢掉，必须出声
        var rowHasCourse = hdr.cols.some(function (col) {
          return String(row[col.col] == null ? '' : row[col.col]).trim() !== '';
        });
        if (rowHasCourse && labelTried.length) {
          // 「上午 / 下午」这类分组词单独出现时没信息量，报出来太吵
          var shown = labelTried.filter(function (x) {
            return !/^(上午|下午|晚上|中午|早读|晚自习|晚点名)$/.test(x);
          });
          if (!shown.length) shown = labelTried;
          warnings.push({ level: 'warn', row: r + 1,
            message: '行首标的节次「' + shown.join(' / ') + '」在当前作息表里找不到，'
              + '这一行的课没有导进来。请到「上下课时间」里补上这一节再导出。' });
        }
        continue;
      }
      var rowLabel = refsToText(table, rowRefs.refs);

      for (var k = 0; k < hdr.cols.length; k++) {
        var col = hdr.cols[k];
        var rawCell = row[col.col];
        if (rawCell == null || String(rawCell).trim() === '') continue;

        var cell = parseMatrixCell(String(rawCell), totalWeeks, table, opts);
        if (!cell || !cell.name) continue;

        cell.warnings.forEach(function (w) {
          warnings.push({ level: 'warn', row: r + 1, message: '《' + cell.name + '》' + w });
        });

        /**
         * ★ 节次以格子里写的为准，行标签只兜底。
         *
         * 合并单元格里格子的值只存在于首行，于是「跨 9~11 节」的实验课
         * 会整块落在第 9 行上，行标签给的是 9，而格子里明明白白写着 11节。
         * 两者都有且不矛盾时不必出声；真不一致时必须说出来，
         * 因为按哪个都可能是错的，静默选一个等于让用户事后自己踩。
         */
        var slots = (cell.slots && cell.slots.length) ? cell.slots : rowRefs.refs;
        if (cell.slots && cell.slots.length) {
          var asRow = rowLabel;
          var asCell = refsToText(table, cell.slots);
          if (asRow && asCell && asRow !== asCell) {
            warnings.push({ level: 'info', row: r + 1,
              message: '《' + cell.name + '》格子里写的节次是「' + asCell + '」，'
                + '但它所在的那一行标的是「' + asRow + '」（合并单元格常见）。'
                + '已按格子里的写，请核对一遍。' });
          }
        }

        if (!byName[cell.name]) {
          byName[cell.name] = {
            id: 'm' + order.length + '_' + sha1Hex(cell.name).slice(0, 8),
            name: cell.name,
            teacher: cell.teacher || '',
            room: cell.room || '',
            courseType: inferCourseType(cell.name),
            patterns: []
          };
          order.push(cell.name);
        }
        var c = byName[cell.name];
        if (!c.teacher && cell.teacher) c.teacher = cell.teacher;
        if (!c.room && cell.room) c.room = cell.room;

        var sig = cell.name + '||' + col.weekday + '|' + slots.join(',') + '|' + cell.mask.weeks().join(',');
        if (!seenSig[sig]) {
          seenSig[sig] = true;
          c.patterns.push({
            weekday: col.weekday,
            slots: slots,
            weekMask: cell.mask,
            rawWeekText: cell.weekText || null,
            room: cell.room || null
          });
        }
      }
    }

    if (!order.length) return null;

    warnings.unshift({ level: 'info',
      message: '识别为「课程表矩阵」格式（行 = 节次、列 = 星期），已按表格结构还原。'
        + (table.slots.some(function (s) { return s.label != null; })
          ? '节次按当前「上下课时间」里的位置展开。' : '')
        + '格子里的课程名 / 教师 / 地点只能靠规则猜测，请逐条核对。' });

    return {
      courses: order.map(function (n) { return byName[n]; }),
      warnings: warnings,
      headerDetected: true,
      columnMap: {},
      layout: 'matrix'
    };
  }

  /** 二维数组（首行可为表头）-> 课程列表 */
  function coursesFromGrid(grid, totalWeeks, opts) {
    opts = opts || {};
    var defaultSlots = opts.defaultSlots || [1, 2];
    /**
     * 节次必须按**当前作息表**解析，不能只抠数字。
     * 同一份教务导出里「中午1」和「中午第1节课」是同一节；而抠数字会把
     * 它们读成上午第一节（8:55），时间错了却一声不吭。
     */
    var table = (opts.slotTable && opts.slotTable.slots && opts.slotTable.slots.length)
      ? opts.slotTable : makeStandard12();
    var warnings = [];

    var rows = (grid || []).map(function (r) {
      return (r || []).map(function (c) { return String(c == null ? '' : c).trim(); });
    }).filter(function (r) {
      return r.some(function (c) { return c !== ''; });
    });

    if (!rows.length) {
      return { courses: [], warnings: [{ level: 'error', message: '没有可解析的内容' }],
               headerDetected: false, columnMap: {} };
    }

    // 先试矩阵型（行=节次、列=星期）——教务系统导出的「课程表」多数是这个形态
    var matrix = parseMatrixGrid(rows, totalWeeks, opts);
    if (matrix) return matrix;

    // 表头识别
    var headerMap = {};
    rows[0].forEach(function (cell, i) {
      var h = cell.normalize('NFKC').toLowerCase();
      if (!h) return;
      for (var k = 0; k < FIELD_KEYWORDS.length; k++) {
        var field = FIELD_KEYWORDS[k][0];
        if (headerMap[field] !== undefined) continue;
        var hit = FIELD_KEYWORDS[k][1].some(function (kw) { return h.indexOf(kw) >= 0; });
        if (hit) { headerMap[field] = i; break; }
      }
    });

    var headerDetected = Object.keys(headerMap).length >= 3;
    var columnMap = headerMap;
    var startIndex = 0;

    if (headerDetected) {
      startIndex = 1;
    } else {
      columnMap = {};
      var fallback = ['courseName', 'teacher', 'weekRange', 'weekday', 'slots', 'room'];
      for (var i2 = 0; i2 < Math.min(fallback.length, rows[0].length); i2++) {
        columnMap[fallback[i2]] = i2;
      }
      warnings.push({ level: 'warn', row: 1,
        message: '未识别到表头，已按「课程名 / 教师 / 周次 / 星期 / 节次 / 地点」的默认列序解析，请核对' });
    }

    var byName = {};
    var order = [];
    var seenSig = {};   // 同名 + 同时段 的去重指纹

    for (var r = startIndex; r < rows.length; r++) {
      var row = rows[r];
      var rowNo = r + 1;
      function cell(field) {
        var ci = columnMap[field];
        if (ci === undefined || ci >= row.length) return null;
        var v = String(row[ci] || '').trim();
        return v === '' ? null : v;
      }

      /**
       * 以 # 开头的行是填写说明 —— 我们自己的模板里就带这种行。
       * 整行静默跳过：它们本来就不是课，报「星期无法识别」只会淹没真问题。
       */
      var firstText = '';
      for (var f0 = 0; f0 < row.length; f0++) {
        if (row[f0] !== '') { firstText = row[f0]; break; }
      }
      if (firstText.charAt(0) === '#') continue;

      var name = cell('courseName');
      if (!name) {
        warnings.push({ level: 'warn', row: rowNo, message: '缺少课程名，已跳过该行',
          raw: row.join(' | ') });
        continue;
      }

      var wdRaw = cell('weekday');
      var weekday = parseWeekday(wdRaw);
      if (!weekday) {
        warnings.push({ level: 'warn', row: rowNo,
          message: '《' + name + '》的星期「' + (wdRaw || '空') + '」无法识别，已跳过',
          raw: row.join(' | ') });
        continue;
      }

      var slotRaw = cell('slots');
      var slots = [];
      if (slotRaw) {
        var pr = parseSlotRefs(slotRaw, table);
        slots = pr.refs;
        pr.warnings.forEach(function (w) {
          warnings.push({ level: 'warn', row: rowNo, message: '《' + name + '》' + w });
        });
      }
      if (!slots.length) {
        slots = defaultSlots.slice();
        warnings.push({ level: 'warn', row: rowNo,
          message: '《' + name + '》未提供可识别的节次，已按默认第 '
            + defaultSlots.join(',') + ' 节处理，请核对' });
      }

      var weekText = cell('weekRange') || '';
      var parsed = parseWeekMask(weekText, totalWeeks, opts);
      var mask;
      if (parsed) {
        mask = parsed.mask;
        parsed.warnings.forEach(function (w) {
          warnings.push({ level: 'warn', row: rowNo,
            message: '《' + name + '》' + w + '（原文「' + weekText + '」）' });
        });
      } else {
        mask = new WeekMask(totalWeeks);
        for (var w = 1; w <= totalWeeks; w++) mask.add(w);
        // 周次那一栏本来就空着 = 用户默认整学期，不必吵他；
        // 写了却看不懂才需要出声
        if (weekText) {
          warnings.push({ level: 'warn', row: rowNo,
            message: '《' + name + '》的周次「' + weekText + '」无法识别，已按全学期 '
              + totalWeeks + ' 周处理，请核对' });
        }
      }

      if (!byName[name]) {
        byName[name] = {
          id: 'c' + order.length + '_' + sha1Hex(name).slice(0, 8),
          name: name,
          teacher: cell('teacher') || '',
          room: cell('room') || '',
          courseType: inferCourseType(name),
          patterns: []
        };
        order.push(name);
      }
      var course = byName[name];
      if (!course.teacher && cell('teacher')) course.teacher = cell('teacher');
      if (!course.room && cell('room')) course.room = cell('room');

      // 同名课程的同一时段重复出现（教务表合并单元格常导致）-> 自动合并并提示，
      // 否则会生成两个时间完全重叠的事件。
      var sig = name + '||' + weekday + '|' + slots.join(',') + '|' + mask.weeks().join(',');
      if (seenSig[sig]) {
        warnings.push({ level: 'info', row: rowNo, raw: row.join(' | '),
          message: '《' + name + '》的同一上课时段重复出现，已自动合并' });
      } else {
        seenSig[sig] = true;
        course.patterns.push({
          weekday: weekday,
          slots: slots,
          weekMask: mask,
          rawWeekText: weekText || null,
          room: cell('room') || null
        });
      }
    }

    return {
      courses: order.map(function (n) { return byName[n]; }),
      warnings: warnings,
      headerDetected: headerDetected,
      columnMap: columnMap
    };
  }

  /** 分隔符嗅探 */
  function splitTextLine(line, sep) {
    if (sep === 'tab') return line.split('\t');
    if (sep === 'pipe') return line.split('|');
    if (sep === 'comma') return splitCSVLine(line);
    return line.split(/\s{2,}/);
  }

  /** RFC 4180 风格的单行 CSV 切分（支持引号包裹） */
  function splitCSVLine(line) {
    var out = [];
    var cur = '';
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQuote) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuote = false;
        } else cur += ch;
      } else {
        if (ch === '"') inQuote = true;
        else if (ch === ',' || ch === '\t') { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function detectSeparator(lines) {
    if (lines.some(function (l) { return l.indexOf('\t') >= 0; })) return 'tab';
    if (lines.some(function (l) { return l.indexOf('|') >= 0; })) return 'pipe';
    if (lines.some(function (l) { return l.indexOf(',') >= 0; })) return 'comma';
    return 'space';
  }

  /* ============================================================
     十之二、排课卡片（一行一个字段的「课程信息」）

     从教务系统里点开一门课、复制出来的就是这种：

         课程:高等数学（A班）
         班级:高等数学（A班）3
         (教一301)
         5,9,13周 星期四 中午2-6节
         主讲教师:张老师

     它没有表格结构，但字段名齐全，所以直接复用 parseMatrixCell 的标签通道。
     唯一缺的是「星期」—— 矩阵里星期来自列，卡片里得自己从文字里找。

     识别必须保守：只有出现「课程:」这类**带冒号**的字段名才算卡片。
     普通表格的表头是「课程名称」没有冒号，不会误判。
     ============================================================ */

  var CARD_LABELS = '课程名称|课程名|课程|科目|班级|课程班|教学班|主讲教师|任课教师|'
    + '授课教师|教师|上课地点|上课教室|地点|教室|周次|上课周次';

  /** 一张新卡片的起点 */
  var CARD_HEAD_RE = new RegExp('^\\s*(?:课程名称|课程名|课程|科目)\\s*[:：]');
  /** 任意字段标签行 */
  var CARD_FIELD_RE = new RegExp('^\\s*(?:' + CARD_LABELS + ')\\s*[:：]');
  /** 行内出现的「星期四 / 周三 / 礼拜天」 */
  var WEEKDAY_INLINE_RE = /(?:星期|周|礼拜)[一二三四五六日天]/g;

  function looksLikeCardText(lines) {
    var head = 0, field = 0;
    lines.forEach(function (l) {
      if (CARD_HEAD_RE.test(l)) head++;
      else if (CARD_FIELD_RE.test(l)) field++;
    });
    return head >= 1 && (head + field) >= 2;
  }

  /**
   * 把「课程:A 班级:B 主讲教师:C」这种被压成一行的卡片拆回多行。
   *
   * 刻意只在**标签名**处切，不在括号处切 —— 中文课程名里「（混合）」「（实验）」
   * 这类括号太常见，按括号切会把课程名腰斩。教室从括号里提取是后面的
   * roomFromParens 负责的事。
   */
  function explodeInlineLabels(line) {
    var re = new RegExp('(?:' + CARD_LABELS + ')\\s*[:：]', 'g');
    var out = [];
    var last = 0;
    var m;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) {
        var seg = line.substring(last, m.index).trim();
        if (seg) out.push(seg);
      }
      last = m.index;
    }
    if (last < line.length) {
      var tail = line.substring(last).trim();
      if (tail) out.push(tail);
    }
    return out.length ? out : [line];
  }

  /** 按「课程:」把文本切成一张张卡片；前导杂行（学期名之类）自然被丢弃 */
  function splitCards(lines) {
    var blocks = [];
    var cur = [];
    lines.forEach(function (line) {
      if (CARD_HEAD_RE.test(line) && cur.length) { blocks.push(cur); cur = []; }
      cur.push(line);
    });
    if (cur.length) blocks.push(cur);
    var withHead = blocks.filter(function (b) {
      return b.some(function (l) { return CARD_HEAD_RE.test(l); });
    });
    return withHead.length ? withHead : blocks;
  }

  /** 从一段文字里找「星期X」，返回 ISO 星期号（周一 = 1） */
  function findWeekdayInText(text) {
    WEEKDAY_INLINE_RE.lastIndex = 0;
    var m;
    while ((m = WEEKDAY_INLINE_RE.exec(text)) !== null) {
      var wd = parseWeekday(m[0]);
      if (wd) return wd;
    }
    return null;
  }

  /**
   * 卡片里周次、星期、节次常挤在同一行。节次已经单列出来了，
   * 这里把节次与星期摘掉，只留周次本身 —— 否则「周次」输入框里
   * 会塞进整行原文，界面上被截断成一串看不懂的东西。
   */
  function cleanWeekText(t) {
    if (!t) return null;
    var s = String(t)
      .replace(/第?[一-鿿]*\d+(?:[-,\s]*\d+)*(?:节课?|节)/g, ' ')
      .replace(/(?:星期|周)[一二三四五六日天]/g, ' ')
      .replace(/[，、]/g, ',')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[,，、\s]+|[,，、\s]+$/g, '');
    return s || null;
  }

  /**
   * 整段「课程信息」文本 -> 课程列表。
   *
   * 返回 null 表示这段文本不是卡片（交给表格解析去处理）。
   */
  function parseCardText(lines, totalWeeks, opts) {
    opts = opts || {};
    var table = (opts.slotTable && opts.slotTable.slots && opts.slotTable.slots.length)
      ? opts.slotTable : null;

    // 一行里塞了多个标签的先摊开，之后一律按行处理
    var flat = [];
    lines.forEach(function (l) {
      explodeInlineLabels(l).forEach(function (x) { flat.push(x); });
    });
    if (!looksLikeCardText(flat)) return null;

    var warnings = [];
    var blocks = splitCards(flat);
    var byName = {};
    var order = [];
    var seenSig = {};

    blocks.forEach(function (block) {
      var joined = block.join('\n');
      var cell = parseMatrixCell(joined, totalWeeks, table, opts);
      if (!cell || !cell.name) return;

      cell.warnings.forEach(function (w) {
        warnings.push({ level: 'warn', message: '《' + cell.name + '》' + w });
      });

      var weekday = findWeekdayInText(joined);
      if (!weekday) {
        warnings.push({ level: 'warn',
          message: '《' + cell.name + '》这段课程信息里没找到「星期X」，已跳过。'
            + '请补上星期（例如「星期四」）再导入一次。' });
        return;
      }

      var slots = cell.slots || [];
      if (!slots.length) {
        warnings.push({ level: 'warn',
          message: '《' + cell.name + '》没解析出节次，已跳过。'
            + (table ? '请检查「上下课时间」里有没有这一节。' : '') });
        return;
      }

      if (!byName[cell.name]) {
        byName[cell.name] = {
          id: 'k' + order.length + '_' + sha1Hex(cell.name).slice(0, 8),
          name: cell.name,
          teacher: cell.teacher || '',
          room: cell.room || '',
          klass: cell.klass || '',
          courseType: inferCourseType(cell.name),
          patterns: []
        };
        order.push(cell.name);
      }
      var c = byName[cell.name];
      if (!c.teacher && cell.teacher) c.teacher = cell.teacher;
      if (!c.room && cell.room) c.room = cell.room;

      var sig = cell.name + '||' + weekday + '|' + slots.join(',') + '|' + cell.mask.weeks().join(',');
      if (!seenSig[sig]) {
        seenSig[sig] = true;
        /**
         * 卡片里周次、星期、节次是写在同一行的（`5,9,13周 星期四 中午2-6节`）。
         * 节次已经单列出来了，周次框里再塞整行，界面上会被截断成一串看不懂的东西。
         * 这里把节次和星期摘掉，只留周次本身给用户核对。
         */
        c.patterns.push({
          weekday: weekday,
          slots: slots,
          weekMask: cell.mask,
          rawWeekText: cleanWeekText(cell.weekText),
          room: cell.room || null
        });
      }
    });

    if (!order.length) {
      /**
       * 已经能确定「这是课程信息卡片」了，就不能再装作没看懂、把文本丢回给
       * 表格解析 —— 那样用户拿到的是「《课程:高等数学（A班）》的星期「空」无法识别」
       * 这种牛头不对马嘴的提示，真正的病因（作息表没设对）被埋掉。
       */
      return {
        courses: [],
        warnings: [{
          level: 'error',
          message: '识别出这是教务的「课程信息」卡片格式，但没能取出一门课。'
            + (warnings.length ? '原因见下面的提示。'
              : '请检查每张卡片里是否写了「星期X」和「第几节」。')
        }].concat(warnings.length ? warnings : [{
          level: 'info',
          message: '如果你学校有「中午1 / 中午2」这类特殊节次，'
            + '请先到上面的「上下课时间」里选一套接近的作息（或手动补上），再重新导入。'
        }]),
        headerDetected: false,
        columnMap: {},
        separator: '课程信息卡片',
        layout: 'card'
      };
    }

    var noWeekHint = blocks.some(function (b) {
      return !/周/.test(b.join(' '));
    });
    warnings.unshift({ level: 'info',
      message: '识别为「课程信息」卡片格式（一行一个字段），共 ' + order.length + ' 门课，'
        + '已从每张卡片里取出课程名 / 星期 / 节次 / 周次 / 地点。请逐条核对。'
        + (noWeekHint ? '其中有的卡片没写周次，已按整学期每周处理。' : '') });

    return {
      courses: order.map(function (n) { return byName[n]; }),
      warnings: warnings,
      headerDetected: true,
      columnMap: {},
      separator: '课程信息卡片',
      layout: 'card'
    };
  }

  function parseDelimitedText(text, totalWeeks, opts) {
    // 去掉 UTF-8 BOM：Excel 另存的 CSV 常带 BOM，会粘在第一个表头单元格上
    var rawLines = String(text == null ? '' : text).replace(/^\uFEFF/, '')
      .split(/\r\n|\r|\n/);
    var lines = rawLines.map(function (l) { return l.trim(); })
      .filter(function (l) { return l !== '' && l.charAt(0) !== '#'; });
    if (!lines.length) {
      return { courses: [], warnings: [{ level: 'error', message: '没有可解析的内容' }],
               headerDetected: false, columnMap: {}, separator: '无' };
    }

    // ★ 先试「课程信息卡片」：一行一个字段的那种，没有表格结构
    var card = parseCardText(lines, totalWeeks, opts);
    if (card) return card;

    var sep = detectSeparator(lines);
    var grid = lines.map(function (l) { return splitTextLine(l, sep); });
    var res = coursesFromGrid(grid, totalWeeks, opts);
    res.separator = { tab: '制表符', pipe: '竖线', comma: '逗号', space: '连续空格' }[sep];
    return res;
  }

  /* ============================================================
     十一、XLSX 解析（原生 DecompressionStream，零依赖）
     ============================================================ */

  function readU16(dv, off) { return dv.getUint16(off, true); }
  function readU32(dv, off) { return dv.getUint32(off, true); }

  /** 找 ZIP 中央目录并解压所有条目 */
  async function unzipAll(buf) {
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);

    // End of Central Directory：从后往前找签名 0x06054b50
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 65558); i--) {
      if (readU32(dv, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP / XLSX 文件');

    var count = readU16(dv, eocd + 10);
    var cdOffset = readU32(dv, eocd + 16);
    var files = {};
    var p = cdOffset;

    for (var n = 0; n < count; n++) {
      if (readU32(dv, p) !== 0x02014b50) break;
      var method = readU16(dv, p + 10);
      var compSize = readU32(dv, p + 20);
      var nameLen = readU16(dv, p + 28);
      var extraLen = readU16(dv, p + 30);
      var commentLen = readU16(dv, p + 32);
      var localOff = readU32(dv, p + 42);
      var name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));

      // 读本地文件头拿到数据起点
      if (readU32(dv, localOff) === 0x04034b50) {
        var lNameLen = readU16(dv, localOff + 26);
        var lExtraLen = readU16(dv, localOff + 28);
        var dataStart = localOff + 30 + lNameLen + lExtraLen;
        var raw = u8.subarray(dataStart, dataStart + compSize);
        if (method === 0) {
          files[name] = raw;
        } else if (method === 8) {
          files[name] = await inflateRaw(raw);
        }
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持 DecompressionStream，无法解析 .xlsx（请改用 Chrome/Edge/Safari 16.4+，或把表格另存为 CSV）');
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function decodeXML(bytes) {
    var text = new TextDecoder('utf-8').decode(bytes);
    return text;
  }

  function colIndex(ref) {
    var m = /^([A-Z]+)/.exec(ref);
    if (!m) return 0;
    var s = m[1], n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  /** 列序号 -> 列名：0 -> A, 25 -> Z, 26 -> AA */
  function colName(i) {
    var s = '', n = i + 1;
    while (n > 0) {
      var r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function parseSharedStrings(xml) {
    if (!xml) return [];
    var out = [];
    var siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    var m;
    while ((m = siRe.exec(xml)) !== null) {
      var inner = m[1];
      var tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      var t, buf = '';
      while ((t = tRe.exec(inner)) !== null) buf += unescapeXML(t[1]);
      out.push(buf);
    }
    return out;
  }

  function unescapeXML(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(+d); })
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&amp;/g, '&');
  }

  function parseSheetGrid(xml, shared) {
    var grid = [];
    var rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    var rm;
    while ((rm = rowRe.exec(xml)) !== null) {
      var rowXml = rm[1];
      var cells = [];
      var cRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      var cm;
      while ((cm = cRe.exec(rowXml)) !== null) {
        var attrs = cm[1] || cm[2] || '';
        var body = cm[3] || '';
        var refM = /\br="([A-Z]+\d+)"/.exec(attrs);
        var ci = refM ? colIndex(refM[1]) : cells.length;
        var typeM = /\bt="([^"]+)"/.exec(attrs);
        var type = typeM ? typeM[1] : 'n';
        var vM = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        var value = '';

        if (type === 's') {
          value = vM ? (shared[+vM[1]] || '') : '';
        } else if (type === 'inlineStr') {
          var tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g, t, buf = '';
          while ((t = tRe.exec(body)) !== null) buf += unescapeXML(t[1]);
          value = buf;
        } else if (type === 'str') {
          value = vM ? unescapeXML(vM[1]) : '';
        } else {
          value = vM ? vM[1] : '';
        }

        while (cells.length < ci) cells.push('');
        cells[ci] = value;
      }
      grid.push(cells);
    }
    return grid;
  }

  async function parseXlsxBuffer(buf, totalWeeks, opts) {
    var files = await unzipAll(buf);
    var shared = parseSharedStrings(files['xl/sharedStrings.xml']
      ? decodeXML(files['xl/sharedStrings.xml']) : '');

    var paths = Object.keys(files).filter(function (k) {
      return /^xl\/worksheets\/sheet\d*\.xml$/.test(k);
    }).sort(function (a, b) {
      var na = parseInt((a.match(/(\d+)\.xml$/) || [0, '0'])[1], 10);
      var nb = parseInt((b.match(/(\d+)\.xml$/) || [0, '0'])[1], 10);
      return na - nb;
    });
    if (!paths.length) throw new Error('这个 .xlsx 里没有找到工作表');

    // 逐个工作表试解析，取「解析出课程最多」的那个。
    // 这样即使文件里有「填写说明」这类辅助表，也能自动跳过。
    var best = null;
    paths.forEach(function (p, idx) {
      var grid;
      try { grid = parseSheetGrid(decodeXML(files[p]), shared); } catch (e) { return; }
      var res = coursesFromGrid(grid, totalWeeks, opts);
      res.sheetName = p.split('/').pop();
      res.sheetIndex = idx + 1;
      res.sheetCount = paths.length;
      if (!best || res.courses.length > best.courses.length) {
        res.grid = grid;
        best = res;
      }
    });
    if (!best) throw new Error('无法解析这个 .xlsx');
    return best;
  }

  /* ============================================================
     十一之二、XLSX 生成（用于产出「课表模板」给用户下载）
     同一套 ZIP 结构，只是方向反过来：写而不是读。
     ============================================================ */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持生成 .xlsx，请改用 CSV 模板');
    }
    var cs = new CompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** 把若干 {name, data} 打成 ZIP（DEFLATE） */
  async function buildZip(entries) {
    var enc = new TextEncoder();
    var chunks = [];
    var central = [];
    var offset = 0;

    for (var i = 0; i < entries.length; i++) {
      var nameBytes = enc.encode(entries[i].name);
      var raw = entries[i].data;
      var comp = await deflateRaw(raw);
      var crc = crc32(raw);

      var lh = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);   // 文件名 UTF-8
      dv.setUint16(8, 8, true);        // deflate
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true);    // 1980-01-01
      dv.setUint32(14, crc, true);
      dv.setUint32(18, comp.length, true);
      dv.setUint32(22, raw.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      chunks.push(lh, comp);

      var cd = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 8, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, comp.length, true);
      cv.setUint32(24, raw.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += lh.length + comp.length;
    }

    var cdSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    var out = new Uint8Array(offset + cdSize + 22);
    var p = 0;
    chunks.forEach(function (x) { out.set(x, p); p += x.length; });
    central.forEach(function (x) { out.set(x, p); p += x.length; });
    out.set(eocd, p);
    return out;
  }

  function xmlEsc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/\r?\n/g, '&#10;');
  }

  function safeSheetName(name, fallback) {
    var n = String(name || '').replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31);
    return n || fallback;
  }

  /**
   * 生成 .xlsx 字节。
   * sheets: [{ name: '长表型', rows: [[cell, ...], ...] }]
   */
  /**
   * 生成 .xlsx。
   *
   * sheet.rows 里的单元格可以有两种写法：
   *   '文本'                -> 默认样式
   *   { v: '文本', s: 1 }   -> 指定内置样式（见 XLSX_STYLES 的编号）
   * 这样模板文件在 Excel / WPS 里打开时表头是有底色、有对齐的，不是一片白。
   *
   * 可选 sheet.colWidths  列宽（字符数）
   * 可选 sheet.freezeFirstRow  冻结首行
   */
  async function buildXlsx(sheets) {
    var enc = new TextEncoder();
    var shared = [];
    var index = {};
    function sid(text) {
      if (!(text in index)) { index[text] = shared.length; shared.push(text); }
      return index[text];
    }

    var sheetXmls = sheets.map(function (sheet) {
      var rowsXml = [];
      sheet.rows.forEach(function (row, r) {
        var cells = [];
        (row || []).forEach(function (val, c) {
          var text = val, style = 0;
          if (val && typeof val === 'object') { text = val.v; style = val.s || 0; }
          if (text == null || text === '') return;
          cells.push('<c r="' + colName(c) + (r + 1) + '" t="s"'
            + (style ? ' s="' + style + '"' : '')
            + '><v>' + sid(String(text)) + '</v></c>');
        });
        if (cells.length) rowsXml.push('<row r="' + (r + 1) + '">' + cells.join('') + '</row>');
      });

      // XML 子元素顺序有规范要求：sheetViews 必须在 cols 之前，cols 必须在 sheetData 之前
      var viewsXml = sheet.freezeFirstRow
        ? '<sheetViews><sheetView workbookViewId="0">'
          + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
          + '</sheetView></sheetViews>'
        : '';

      var colsXml = (sheet.colWidths && sheet.colWidths.length)
        ? '<cols>' + sheet.colWidths.map(function (w, i) {
            return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w
              + '" customWidth="1"/>';
          }).join('') + '</cols>'
        : '';

      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + viewsXml + colsXml
        + '<sheetData>' + rowsXml.join('') + '</sheetData></worksheet>';
    });

    var sst = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="'
      + shared.length + '" uniqueCount="' + shared.length + '">'
      + shared.map(function (t) {
          return '<si><t xml:space="preserve">' + xmlEsc(t) + '</t></si>';
        }).join('')
      + '</sst>';

    var names = sheets.map(function (s, i) { return safeSheetName(s.name, 'Sheet' + (i + 1)); });

    var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + names.map(function (n, i) {
          return '<sheet name="' + xmlEsc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
        }).join('')
      + '</sheets></workbook>';

    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + names.map(function (n, i) {
          return '<Relationship Id="rId' + (i + 1) + '" '
            + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            + 'Target="worksheets/sheet' + (i + 1) + '.xml"/>';
        }).join('')
      + '<Relationship Id="rId' + (names.length + 1) + '" '
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
      + 'Target="styles.xml"/>'
      + '<Relationship Id="rId' + (names.length + 2) + '" '
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" '
      + 'Target="sharedStrings.xml"/></Relationships>';

    var types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + names.map(function (n, i) {
          return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" '
            + 'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
        }).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
      + '</Types>';

    var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" '
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
      + 'Target="xl/workbook.xml"/></Relationships>';

    var entries = [
      { name: '[Content_Types].xml', data: enc.encode(types) },
      { name: '_rels/.rels', data: enc.encode(rootRels) },
      { name: 'xl/workbook.xml', data: enc.encode(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
      { name: 'xl/styles.xml', data: enc.encode(stylesXml()) },
      { name: 'xl/sharedStrings.xml', data: enc.encode(sst) }
    ];
    sheetXmls.forEach(function (xml, i) {
      entries.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: enc.encode(xml) });
    });

    return buildZip(entries);
  }

  /**
   * 模板用的内置单元格样式。
   *
   * ⚠️ Excel 对 fills 的顺序有硬要求：索引 0 必须是 none、索引 1 必须是 gray125，
   * 否则文件会被判定为损坏。自定义填充只能从索引 2 开始。
   *
   * 编号对应 sheet.rows 里 { v, s } 的 s：
   *   0 普通  1 表头  2 灰色说明  3 首列强调  4 大标题  5 小标题
   */
  function stylesXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="5">'
      + '<font><sz val="11"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'
      + '<font><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="11"/><color rgb="FF4338CA"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="14"/><color rgb="FF4F46E5"/><name val="Calibri"/></font>'
      + '</fonts>'
      + '<fills count="4">'
      + '<fill><patternFill patternType="none"/></fill>'
      + '<fill><patternFill patternType="gray125"/></fill>'
      + '<fill><patternFill patternType="solid"><fgColor rgb="FF4F46E5"/>'
      + '<bgColor indexed="64"/></patternFill></fill>'
      + '<fill><patternFill patternType="solid"><fgColor rgb="FFEEF2FF"/>'
      + '<bgColor indexed="64"/></patternFill></fill>'
      + '</fills>'
      + '<borders count="2">'
      + '<border><left/><right/><top/><bottom/><diagonal/></border>'
      + '<border>'
      + '<left style="thin"><color rgb="FFD1D5DB"/></left>'
      + '<right style="thin"><color rgb="FFD1D5DB"/></right>'
      + '<top style="thin"><color rgb="FFD1D5DB"/></top>'
      + '<bottom style="thin"><color rgb="FFD1D5DB"/></bottom>'
      + '<diagonal/></border>'
      + '</borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="7">'
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      // 1 表头：白字 + 品牌蓝底 + 边框 + 居中
      + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0"'
      + ' applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
      + '<alignment horizontal="center" vertical="center"/></xf>'
      // 2 灰色说明文字
      + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
      // 3 首列强调：蓝字 + 浅蓝底 + 边框
      + '<xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0"'
      + ' applyFont="1" applyFill="1" applyBorder="1"/>'
      // 4 大标题
      + '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
      // 5 小标题
      + '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
      // 6 课程格：边框 + 自动换行 + 顶端对齐。矩阵型一格是好几个字段（换行分隔），
      //   不加 wrapText 的话 Excel 里只显示第一行，看着像模板坏了。
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"'
      + ' applyBorder="1" applyAlignment="1">'
      + '<alignment vertical="top" wrapText="1"/></xf>'
      + '</cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>';
  }

  /* ---------- 内置的课表模板内容 ---------- */

  /** 表头单元格（白字蓝底居中） */
  function tplHead(v) { return { v: v, s: 1 }; }
  /** 灰色说明文字 */
  function tplNote(v) { return (v == null || v === '') ? '' : { v: v, s: 2 }; }
  /** 以 # 开头的是填写说明 */
  function tplIsNote(v) { return String(v || '').charAt(0) === '#'; }

  /**
   * 组装「课表模板.xlsx」的 3 张工作表（含样式、列宽、冻结行）。
   *
   * 放在内核而不是界面层，是为了让界面和测试跑的是同一份定义 ——
   * 之前测试自己拼了一遍 rows，加了样式之后两边就悄悄分叉了。
   *
   * 样式编号见 stylesXml()：1 表头 / 2 灰说明 / 3 首列强调 / 4 大标题 / 5 小标题
   */
  function buildTemplateSheets() {
    var T = TEMPLATES;

    var guide = T.guide.map(function (r, ri) {
      if (ri === 0) return [{ v: r[0], s: 4 }];        // 首行大标题
      if (!r.filter(function (c) { return c; }).length) return [];
      var head = /^【/.test(r[0]);                     // 【…】是分节小标题
      return r.map(function (c, ci) {
        if (!c) return '';
        if (head) return { v: c, s: 5 };
        return ci === 0 ? { v: c, s: 2 } : c;
      });
    });

    var longRows = [T.longTable.headers.map(tplHead)]
      .concat(T.longTable.sample.map(function (r) { return r.slice(); }))
      .concat(T.longTable.footer.map(function (r) { return r.map(tplNote); }));

    var matrix = T.matrix.rows.map(function (r, ri) {
      if (ri === 0) return r.map(tplHead);
      return r.map(function (c, ci) {
        if (!c) return '';
        if (tplIsNote(c)) return { v: c, s: 2 };
        // 行首两列是「上午/下午/晚上」分组列与节次列，都做成强调样式
        if (ci <= 1) return { v: c, s: 3 };
        return { v: c, s: 6 };
      });
    });

    return [
      { name: '填写说明', rows: guide, colWidths: [20, 30, 46], freezeFirstRow: false },
      { name: '长表型', rows: longRows, colWidths: [20, 10, 14, 8, 10, 16], freezeFirstRow: true },
      { name: '矩阵型', rows: matrix, colWidths: [10, 11, 30, 30, 30, 30, 30], freezeFirstRow: true }
    ];
  }

  var TEMPLATES = {
    /** 长表型：每行一门课 */
    longTable: {
      headers: ['课程名称', '教师', '周次', '星期', '节次', '教室'],
      sample: [
        ['高等数学', '张老师', '1-16周', '周一', '1-2', '教一301'],
        ['线性代数', '李老师', '1-16周(单)', '周二', '3-4', '教二205'],
        ['大学英语', '王老师', '1-16周(双)', '周二', '3-4', '教二206'],
        ['数据结构', '陈老师', '3-15周', '周三', '2-3', '教三101'],
        ['大学物理实验', '刘老师', '4-14周', '周四', '7-8', '实验楼B203'],
        ['体育', '赵老师', '1-16周', '周五', '7-8', '操场']
      ],
      /* 示例行刻意只用 1…12 这种数字节次：默认作息表就是标准 12 节，
         新用户不改任何东西下载模板也能整表解析成功。具名节次写在说明里。 */
      footer: [
        ['', '', '', '', '', ''],
        ['# ↓↓↓ 以下是填写说明，可整行删除 ↓↓↓', '', '', '', '', ''],
        ['# 周次写法：1-16周（连续）｜1-16周(单)（单周）｜1-8,10-16周（多段）｜3-15周', '', '', '', '', ''],
        ['# 注意：「单双周」/「隔周」是隔周上一次（课时减半），不是每周', '', '', '', '', ''],
        ['# 星期写法：周一 或 星期一 或 1', '', '', '', '', ''],
        ['# 节次写法：1-2 或 1,2 或 第1-2节；连上三节写 1-3，跳着上写 1,3', '', '', '', '', ''],
        ['# 具名节次（中午、早读、晚自习）：先在页面「上下课时间」里加一行，', '', '', '', '', ''],
        ['# 名字直接写成 中午1 这样的文字；之后这一栏就能写 中午2-6 或 中午第1节课', '', '', '', '', ''],
        ['# 「中午2-6」= 按作息表里的位置连着数：中午2、第5节、第6节（不是数字 2 到 6）', '', '', '', '', ''],
        ['# 必填列：课程名称、星期、节次、周次；其余可留空', '', '', '', '', ''],
        ['# 「节次」对应几点，由导入页面的「上下课时间」决定，不写在这个文件里', '', '', '', '', '']
      ]
    },

    /**
     * 矩阵型：行 = 节次，列 = 星期。
     *
     * 这一张表刻意照研究生教务的导出形态来做：行首两列（上午/下午/晚上 分组列
     * + 节次列）、格子里带「课程: / 班级: / 主讲教师:」字段名、教室单独一行、
     * 周次和节次写在同一句里。用户从教务系统复制过来基本就是这个样子。
     */
    matrix: {
      rows: [
        ['节次', '', '星期一', '星期二', '星期三', '星期四', '星期五'],
        ['上午', '1', '', '', '', '', ''],
        ['', '2', '', '', '', '', ''],
        ['', '3', '', '课程:大学英语\n班级:英语1班\n(教二205)\n3-18周 星期二 3-4节\n主讲教师:李老师',
             '', '', ''],
        ['', '4', '', '', '', '', ''],
        ['中午', '中午1', '', '', '', '', ''],
        ['', '中午2', '课程:数据结构\n班级:计算机2班\n(计算中心A302)\n3-18周 星期一 中午2-6节\n主讲教师:陈老师',
              '', '', '课程:高等数学\n班级:数学1班\n(教一301)\n13-13周 星期四 中午2-6节\n主讲教师:张老师', ''],
        ['下午', '5', '', '', '', '', ''],
        ['', '6', '', '', '', '', ''],
        ['', '7', '课程:概率论\n张老师\n1-16周\n教一301', '', '', '', ''],
        ['', '8', '', '', '课程:离散数学\n陈老师\n3-15周\n教三101', '', ''],
        ['晚上', '9', '', '', '', '', ''],
        ['', '10', '', '', '', '', ''],
        ['', '11', '', '', '', '课程:大学物理实验\n班级:物理1班\n(实验楼B203)\n3-18周 星期四 11节\n主讲教师:刘老师', ''],
        ['', '', '', '', '', '', ''],
        ['# ↓↓↓ 以下是填写说明，可整行删除 ↓↓↓', '', '', '', '', '', ''],
        ['# 一格 = 一次课。一门课跨几节时，把这些行合并成一个单元格即可。', '', '', '', '', '', ''],
        ['# 格子里按行写，带不带字段名都认：', '', '', '', '', '', ''],
        ['#   课程:高等数学 ／ 班级:数学1班 ／ (教一301) ／ 13-13周 星期四 中午2-6节 ／ 主讲教师:张老师', '', '', '', '', '', ''],
        ['#   也可以只写四行：课程名 ／ 教师 ／ 周次 ／ 教室', '', '', '', '', '', ''],
        ['# 节次以格子里写的那一句为准（如「中午2-6节」），行首只作定位。', '', '', '', '', '', ''],
        ['# 示例里的「中午1 / 中午2」需要页面上那套「11 节 + 中午 2 节」的作息；', '', '', '', '', '', ''],
        ['# 你学校名字不同的话，先在「上下课时间」里改成你学校的叫法，再往格子里写。', '', '', '', '', '', ''],
        ['# 行 = 节次，列 = 星期（写成 周一 或 星期一）。', '', '', '', '', '', '']
      ]
    },

    /** 课程信息卡片：一行一个字段，教务里点开一门课复制出来的原文 */
    card: {
      sample: [
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
      ]
    },

    /** Excel 模板里单独放一张说明表 */
    guide: [
      ['课表导入器 · 填写说明', '', ''],
      ['', '', ''],
      ['这个文件里有 3 张工作表：「填写说明」「长表型」「矩阵型」。', '', ''],
      ['两种格式任选其一填写，用不上的那张表可以整张删掉。', '', ''],
      ['', '', ''],
      ['【格式一】长表型 —— 见「长表型」工作表', '', ''],
      ['每行一门课，第一行是表头。这是教务系统导出 Excel 最常见的形态。', '', ''],
      ['必填列：课程名称、星期、节次、周次', '', ''],
      ['可选列：教师、教室、学分', '', ''],
      ['', '', ''],
      ['周次', '1-16周', '连续 16 周'],
      ['', '1-16周(单)', '单周'],
      ['', '1-16周(双)', '双周'],
      ['', '1-8,10-16周', '多段，中间第 9 周没有课'],
      ['', '单双周', '隔周上一次（第 1、3、5… 周），不是每周'],
      ['星期', '周一 或 星期一 或 1', ''],
      ['节次', '1-2 或 1,2 或 第1-2节', ''],
      ['', '1-3', '连上三节'],
      ['', '1,3', '跳过第 2 节'],
      ['', '', ''],
      ['【格式二】矩阵型 —— 见「矩阵型」工作表', '', ''],
      ['行 = 节次，列 = 星期，一格 = 一次课。', '', ''],
      ['一门课跨几节时，把这些行合并成一个单元格，', '', ''],
      ['节次以格子里写的那一句为准（如「中午2-6节」）。', '', ''],
      ['', '', ''],
      ['【格子里怎么写】', '', ''],
      ['教务系统导出的格子通常带字段名，照抄即可：', '', ''],
      ['', '课程:高等数学', '这一行是课程名'],
      ['', '班级:数学1班', '可选，会忽略'],
      ['', '(教一301)', '单独一行的括号 = 上课地点'],
      ['', '13-13周 星期四 中午2-6节', '周次与节次写在同一句也行'],
      ['', '主讲教师:张老师', '教师'],
      ['不带字段名（只有课程名 / 教师 / 周次 / 教室四行）也认。', '', ''],
      ['', '', ''],
      ['【具名节次（中午、早读、晚自习）】', '', ''],
      ['有些学校在午休里排课，那些节次不在 1…N 的编号里。', '', ''],
      ['先在页面上的「上下课时间」里加一行，名字直接写「中午1」这样的文字。', '', ''],
      ['之后课表里就能写：中午1、中午2-6、中午第1节课 —— 这几种写法都认。', '', ''],
      ['「中午2-6」是按作息表里的位置连着数：中午2、第5节、第6节，', '', ''],
      ['不是数字上的 2 到 6。作息表里没有的写法会提示你补，不会乱猜成第 1 节。', '', ''],
      ['', '', ''],
      ['【格式三】课程信息卡片 —— 不用做成 Excel，直接粘贴', '', ''],
      ['在教务系统里点开一门课，把「课程信息」那一块整段复制出来，', '', ''],
      ['直接粘到网页的「粘贴文本」框就行。它长这样：', '', ''],
      ['', '课程:高等数学（A班）', ''],
      ['', '班级:高等数学（A班）3', ''],
      ['', '(教一301)', '地点'],
      ['', '5,9,13周 星期四 中午2-6节', '← 周次 / 星期 / 节次常写在同一行'],
      ['', '主讲教师:张老师', ''],
      ['多门课就把几张卡片连着贴，卡片之间不用留空行。', '', ''],
      ['', '', ''],
      ['【关于「节次」对应几点】', '', ''],
      ['这个文件里只写节次（如 1-2、中午2-6），不写具体时间。', '', ''],
      ['第几节是几点，由导入页面的「上下课时间」那一栏决定 —— 每个学校作息不同，', '', ''],
      ['导入前先在页面上把它调成你学校的作息，导出的日历时间才是对的。', '', ''],
      ['', '', ''],
      ['【填好之后】', '', ''],
      ['把文件拖进课表导入器，或复制粘贴到「粘贴文本」。', '', ''],
      ['如果识别不出来，先检查星期列是否写了「周一」这类能识别的写法。', '', ''],
      ['', '', ''],
      ['本文件由课表导入器生成，不含任何外部链接或宏。', '', '']
    ]
  };

  /* ============================================================
     导出
     ============================================================ */

  return {
    // 日期
    wallDate: wallDate, wallAddDays: wallAddDays, wallStartOfDay: wallStartOfDay,
    wallDiffDays: wallDiffDays, wallDowIso: wallDowIso, wallISO: wallISO,
    wallHHMM: wallHHMM, wallDateCN: wallDateCN, wallToUTC: wallToUTC,
    utcStamp: utcStamp, parseISODate: parseISODate, parseTimeOfDay: parseTimeOfDay,
    // 标识
    ID: ID, uuidV5: uuidV5, sha1Hex: sha1Hex,
    // 周次
    WeekMask: WeekMask, parseWeekMask: parseWeekMask, normalizeWeekText: normalizeWeekText,
    detectModifier: detectModifier,
    // 节次
    makeStandard12: makeStandard12, makeSlotTable: makeSlotTable,
    SLOT_PRESETS: SLOT_PRESETS, regenerateSlots: regenerateSlots,
    serializeSlotTable: serializeSlotTable, deserializeSlotTable: deserializeSlotTable,
    resolveSlots: resolveSlots, slotOf: slotOf, posOf: posOf, slotName: slotName,
    slotAliases: slotAliases, parseSlotRefs: parseSlotRefs, refsToText: refsToText,
    extractSlotSegment: extractSlotSegment, stripWeekAndDayNoise: stripWeekAndDayNoise,
    parseBellSchedule: parseBellSchedule,
    previewSlots: previewSlots,
    slotTimeText: slotTimeText, slotGroups: slotGroups,
    // 学期与展开
    buildSemester: buildSemester, weekIndexOf: weekIndexOf, dateInWeek: dateInWeek,
    expandCourse: expandCourse, detectConflicts: detectConflicts,
    // 计划与输出
    planEvents: planEvents, buildICS: buildICS, foldLine: foldLine, escapeICS: escapeICS,
    // 解析
    coursesFromGrid: coursesFromGrid, parseDelimitedText: parseDelimitedText,
    parseCardText: parseCardText, looksLikeCardText: looksLikeCardText,
    parseXlsxBuffer: parseXlsxBuffer, buildXlsx: buildXlsx, TEMPLATES: TEMPLATES,
    buildTemplateSheets: buildTemplateSheets,
    crc32: crc32, colName: colName,
    parseSlotIndices: parseSlotIndices, parseWeekday: parseWeekday,
    inferCourseType: inferCourseType, splitCSVLine: splitCSVLine,
    FIELD_LABEL: FIELD_LABEL, TYPE_LABEL: TYPE_LABEL, TYPE_EMOJI: TYPE_EMOJI,
    _internals: { sha1: sha1, inflateRaw: inflateRaw, unzipAll: unzipAll,
                  parseMatrixCell: parseMatrixCell, parseMatrixGrid: parseMatrixGrid,
                  deflateRaw: deflateRaw, buildZip: buildZip,
                  parseSharedStrings: parseSharedStrings, parseSheetGrid: parseSheetGrid,
                  colIndex: colIndex, unescapeXML: unescapeXML, xmlEsc: xmlEsc,
                  safeSheetName: safeSheetName }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Core;
