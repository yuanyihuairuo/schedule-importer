#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
表头 / 内容对齐检查（真浏览器量像素，jsdom 量不了布局）。

背景：课程表里每个可编辑单元格装的是 <input> / <select>，控件自带 1px 边框和
内边距，单元格本身又有内边距 —— 两者叠加会让输入框里的文字比表头文字右移，
肉眼看就是「表头和内容不齐」。这个数字用肉眼很难估准，所以用脚本量。

顺带量一下下拉框箭头和文字之间的空隙（太小就是「箭头贴着字」）。

用法：先 `npm run build && node tools/gen-preview.js`，再 `python3 tools/check-align.py`
"""

import io
import os
import re
import subprocess
import sys

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PREVIEW = "/tmp/preview-step2.html"

DIAG = r"""
<script>
window.addEventListener('load', function () { setTimeout(function () {
  function textLeft(el) {
    var r = document.createRange(); r.selectNodeContents(el);
    return r.getBoundingClientRect().left;
  }
  var out = [];
  var ths = document.querySelectorAll('#panel2 thead th');
  var tr = document.querySelector('#courseBody tr');
  var tds = tr.children;
  var worst = 0;

  out.push('  列名        表头文字x   内容x     偏差');
  out.push('  ' + '-'.repeat(46));
  for (var i = 0; i < ths.length; i++) {
    var th = ths[i], td = tds[i];
    /* 表头为空的列（操作列）没有可对齐的参照物，跳过 */
    var thText = (th.textContent || '').trim();
    if (!thText) continue;
    var tx = textLeft(th), cx, kind;
    var el = td.querySelector('input,select');
    if (el) {
      var cs = getComputedStyle(el), r = el.getBoundingClientRect();
      cx = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      kind = el.tagName;
    } else {
      cx = textLeft(td); kind = '文本';
    }
    var d = Math.round(cx - tx);
    if (Math.abs(d) > Math.abs(worst)) worst = d;
    out.push('  ' + thText.padEnd(9) + 'x=' + String(Math.round(tx)).padEnd(9)
             + 'x=' + String(Math.round(cx)).padEnd(9)
             + (d === 0 ? '✅ 0px' : '⚠️ ' + d + 'px'));
  }

  var sel = tr.querySelector('select');
  if (sel) {
    var cf = getComputedStyle(sel);
    var sw = Math.round(sel.getBoundingClientRect().width);
    var arrowRight = parseFloat(cf.backgroundPosition.split(' ').slice(-2)[0].replace('calc(100% - ', '')) || 13;
    var padR = parseFloat(cf.paddingRight);
    var gap = Math.round(padR - (arrowRight + 12));   // 12 = 箭头宽度
    out.push('');
    out.push('  星期下拉框：宽 ' + sw + 'px · 右侧留白 ' + padR
             + 'px · 箭头距右 ' + arrowRight + 'px');
    out.push('  文字与箭头空隙 = ' + gap + 'px '
             + (gap >= 4 ? '✅' : '⚠️ 太挤'));
  }
  out.push('');
  out.push('  结论：' + (worst === 0 ? '✅ 表头与内容完全对齐' : '⚠️ 最大偏差 ' + worst + 'px'));
  try { parent.postMessage(out.join('|'), '*'); } catch (e) {}
}, 1500); });
</script>
</body>"""

HARNESS = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#fff}
  iframe{border:0;display:block;width:1120px;height:1200px}
  pre{font:13px/1.7 ui-monospace,Menlo,monospace;padding:14px;margin:0;
      color:#111;background:#fff}
</style></head><body>
<iframe src="file://%s"></iframe>
<pre id="out">（等待测量…）</pre>
<script>
window.addEventListener('message', function (e) {
  document.getElementById('out').textContent = String(e.data).split('|').join('\\n');
});
</script>
</body></html>""" % "/tmp/_align-inner.html"


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    if not os.path.exists(CHROME):
        print("找不到 Chrome，跳过")
        return 1
    if not os.path.exists(PREVIEW):
        print("缺少 %s，先跑 node gen-preview.js" % PREVIEW)
        return 1

    src = io.open(PREVIEW, encoding="utf-8").read()
    io.open("/tmp/_align-inner.html", "w", encoding="utf-8").write(
        src.replace("</body>", DIAG))
    io.open("/tmp/_align-outer.html", "w", encoding="utf-8").write(HARNESS)

    r = subprocess.run([
        CHROME, "--headless=new", "--no-sandbox", "--disable-gpu",
        "--window-size=1140,1500", "--virtual-time-budget=9000", "--dump-dom",
        "file:///tmp/_align-outer.html",
    ], capture_output=True, text=True, errors="ignore")

    m = re.search(r'<pre id="out">(.*?)</pre>', r.stdout or "", re.S)
    if not m:
        print("没拿到测量结果")
        return 1
    import html as _html
    body = _html.unescape(m.group(1))
    print(body)
    return 0 if "完全对齐" in body else 1


if __name__ == "__main__":
    sys.exit(main())
