#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 gen-preview.js 产出的预览副本，按 iPhone 的真实逻辑分辨率渲染成设备效果图。

为什么不能直接 `--window-size=393,H`：无头 Chrome 有约 500px 的最小窗口宽度，
393 会被顶到 500，拍出来的图右边缺一块。所以走 iframe：外层窗口开 500 宽，
里面套一个 393px 宽的 iframe —— iframe 的视口才是真正的 393pt。

用法：先 `node gen-preview.js`，再 `python3 phone-shot.py`
"""

import io
import os
import subprocess
import sys

from PIL import Image, ImageDraw

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DEVICE_W = 393          # iPhone 15 / 16 / 17 的逻辑宽度
BEZEL = 13              # 边框
OUTER_R = 58            # 外圆角
INNER_R = 46            # 屏幕圆角
CAP_H = 34              # 底部标题条

HARNESS = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{{margin:0;padding:0;background:#fff}}
  .dev{{width:{ow}px;height:{oh}px;background:#0b0b0f;border-radius:{orad}px;
        padding:{bez}px;box-sizing:border-box;position:relative}}
  .screen{{width:{dw}px;height:{dh}px;border-radius:{irad}px;overflow:hidden;
           background:#fff;position:relative}}
  iframe{{border:0;display:block;width:{dw}px;height:{dh}px}}
  /* 灵动岛 */
  .island{{position:absolute;top:{itop}px;left:50%;transform:translateX(-50%);
           width:112px;height:33px;background:#0b0b0f;border-radius:18px;z-index:9}}
  /* 状态栏 */
  .sb{{position:absolute;top:{sbtop}px;left:0;right:0;height:26px;z-index:8;
       display:flex;align-items:center;justify-content:space-between;
       padding:0 26px;color:#fff;font:600 13.5px/1 -apple-system,
       "SF Pro Text",system-ui,sans-serif;letter-spacing:.2px;pointer-events:none}}
  .sb .r{{display:flex;align-items:center;gap:4px}}
  .sig{{display:flex;align-items:flex-end;gap:1.5px;height:11px}}
  .sig i{{display:block;width:3px;background:#fff;border-radius:1px}}
  .sig i:nth-child(1){{height:4px}} .sig i:nth-child(2){{height:6.5px}}
  .sig i:nth-child(3){{height:9px}} .sig i:nth-child(4){{height:11px}}
  .bat{{width:23px;height:11.5px;border:1.4px solid rgba(255,255,255,.85);
        border-radius:3.5px;padding:1.4px;position:relative}}
  .bat::after{{content:'';position:absolute;right:-3.4px;top:3.4px;width:1.8px;
        height:4px;background:rgba(255,255,255,.55);border-radius:0 2px 2px 0}}
  .bat i{{display:block;height:100%;width:72%;background:#fff;border-radius:1.6px}}
</style></head><body>
<div class="dev">
  <div class="screen">
    <iframe src="file://{src}"></iframe>
    <div class="island"></div>
    <div class="sb"><span>9:41</span><span class="r">
      <span class="sig"><i></i><i></i><i></i><i></i></span>
      <span class="bat"><i></i></span></span></div>
  </div>
</div>
</body></html>
"""


def shoot(name, height, out):
    dw, dh = DEVICE_W, height
    ow, oh = dw + BEZEL * 2, dh + BEZEL * 2
    html = HARNESS.format(
        ow=ow, oh=oh, orad=OUTER_R, irad=INNER_R, bez=BEZEL,
        dw=dw, dh=dh, itop=BEZEL + 11, sbtop=BEZEL + 15,
        src="/tmp/" + name + ".html")
    hp = "/tmp/_phone-%s.html" % name
    io.open(hp, "w", encoding="utf-8").write(html)

    win_w = max(ow + 40, 520)      # 避开无头 Chrome 的最小窗口宽度
    win_h = oh + 20
    raw = "/tmp/_raw-%s.png" % name
    subprocess.run([
        CHROME, "--headless=new", "--no-sandbox", "--disable-gpu",
        "--disable-software-rasterizer", "--hide-scrollbars",
        "--force-device-scale-factor=2",
        "--screenshot=" + raw,
        "--window-size=%d,%d" % (win_w, win_h),
        "--virtual-time-budget=9000",
        "file://" + hp,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)

    if not os.path.exists(raw):
        print("  ✗ %s 截图失败" % name)
        return False

    im = Image.open(raw).convert("RGB")
    im = im.crop((0, 0, ow * 2, oh * 2))     # 去掉右侧空白
    im = im.resize((ow, oh), Image.LANCZOS)  # 还原成 1x（边缘更干净）
    im.save(out, "PNG")
    print("  ✓ %-18s %-22s %dx%d" % (name, os.path.basename(out), ow, oh))
    for tmp in (raw,):
        try:
            os.remove(tmp)
        except OSError:
            pass
    return True


JOBS = [
    # (预览副本, 逻辑高度, 输出文件名)
    # 输出名与 docs/screenshots/ 里已入库的截图一致 —— 重新生成即可原地覆盖
    ("preview-phone1", 1000, "10-schedule-editor-iphone.png"),
    ("preview-phone2", 1320, "07-review-courses-iphone.png"),
    ("preview-phone3", 1180, "11-holidays-iphone.png"),
    ("preview-phone4", 1820, "08-export-events-iphone.png"),
    ("preview-phonepaste", 1120, "06-import-empty-iphone.png"),
    ("preview-dark4", 1600, "09-dark-mode-iphone.png"),
]


def main():
    if not os.path.exists(CHROME):
        print("找不到 Chrome，跳过手机截图")
        return 1
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    out_dir = os.path.join(root, 'docs', 'screenshots')
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    print("iPhone %dpt 设备效果图：" % DEVICE_W)
    ok = 0
    for name, h, out in JOBS:
        if not os.path.exists("/tmp/%s.html" % name):
            print("  - %s 不存在，先跑 `node tools/gen-preview.js`" % name)
            continue
        if shoot(name, h, os.path.join(out_dir, out)):
            ok += 1
    print("完成 %d 张 -> docs/screenshots/" % ok)
    return 0


if __name__ == "__main__":
    sys.exit(main())
