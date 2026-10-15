#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 xlsx 测试样本（纯标准库，无需 openpyxl）

产出三个文件到 tests/fixtures/：
  long-table.xlsx   长表型：每行一门课
  matrix.xlsx       矩阵型：行 = 节次、列 = 星期（教务系统最常见的导出形态）
  labeled-matrix.xlsx
                    研究生教务导出的真实形态：格内带「课程:/班级:/主讲教师:」标签、
                    节次列含具名的中午1/中午2、课程格是跨多行的合并单元格
"""

import os
import zipfile
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'tests', 'fixtures')

CT = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>'''

RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>'''

WB = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="课表" sheetId="1" r:id="rId1"/></sheets>
</workbook>'''

WB_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>'''


def col_name(i):
    """0 -> A, 1 -> B, 25 -> Z, 26 -> AA"""
    s = ''
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def write_xlsx(path, grid, merges=None):
    """grid: 二维列表，None / '' 表示空单元格
       merges: [(r1, c1, r2, c2), ...] 1-based 闭区间，写成真正的合并单元格

    合并区域里只有左上角那格有值 —— 这正是解析器必须处理好的形态。"""
    shared, index = [], {}

    def sid(text):
        if text not in index:
            index[text] = len(shared)
            shared.append(text)
        return index[text]

    rows_xml = []
    for r, row in enumerate(grid, start=1):
        cells = []
        for c, val in enumerate(row):
            if val is None or val == '':
                continue
            ref = '%s%d' % (col_name(c), r)
            cells.append('<c r="%s" t="s"><v>%d</v></c>' % (ref, sid(str(val))))
        if cells:
            rows_xml.append('<row r="%d">%s</row>' % (r, ''.join(cells)))

    merge_xml = ''
    if merges:
        # merges 里的行列都是 1-based；col_name 收的是 0-based 列号
        cells = ''.join('<mergeCell ref="%s%d:%s%d"/>'
                        % (col_name(c1 - 1), r1, col_name(c2 - 1), r2)
                        for (r1, c1, r2, c2) in merges)
        merge_xml = '<mergeCells count="%d">%s</mergeCells>' % (len(merges), cells)

    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             '<sheetData>%s</sheetData>%s</worksheet>' % (''.join(rows_xml), merge_xml))

    sst = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
           '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
           'count="%d" uniqueCount="%d">%s</sst>'
           % (len(shared), len(shared),
              ''.join('<si><t xml:space="preserve">%s</t></si>' % escape(t) for t in shared)))

    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CT)
        z.writestr('_rels/.rels', RELS)
        z.writestr('xl/workbook.xml', WB)
        z.writestr('xl/_rels/workbook.xml.rels', WB_RELS)
        z.writestr('xl/sharedStrings.xml', sst)
        z.writestr('xl/worksheets/sheet1.xml', sheet)


LONG_TABLE = [
    ['课程名称', '教师', '周次', '星期', '节次', '教室'],
    ['高等数学', '张老师', '1-16周', '周一', '1-2', '教一301'],
    [None, None, None, None, None, None],
    ['线性代数', '李老师', '1-16周(单)', '周二', '3-4', '教二205'],
    ['大学英语', '王老师', '1-16周(双)', '周二', '3-4', '教二206'],
    ['数据结构', '陈老师', '3-15周', '周三', '2-3', '教三101'],
    ['大学物理实验', '刘老师', '4-14周', '周四', '7-8', '实验楼B203'],
    ['体育', '赵老师', '1-16周', '周五', '7-8', '操场'],
]

# 矩阵型：一格 = 一次课，格内用换行堆着「课程名 / 教师 / 周次 / 教室」
MATRIX = [
    [None, '周一', '周二', '周三', '周四', '周五'],
    ['第1-2节', '高等数学\n张老师\n1-16周\n教一301', None, None, None, None],
    ['第3-4节', None, '线性代数\n李老师\n1-16周(单)\n教二205', None, None, None],
    ['第5-6节', None, None, '数据结构\n陈老师\n3-15周\n教三101', None, None],
    ['第7-8节', None, None, None, '大学物理实验\n刘老师\n4-14周\n实验楼B203', '体育\n赵老师\n1-16周\n操场'],
]


# 研究生教务导出的真实课表（含具名中午节次 + 合并单元格 + 带标签的格子）
_ENG = ('课程:高等数学（A班）\n班级:高等数学（A班）3\n(教一301)\n'
        '13–13周:连续周 星期四 中午2–6节\n主讲教师:张老师')
_IC = ('课程:数据结构\n班级:计算机2班\n(计算中心A302)\n'
       '3–18周:连续周 星期一 中午2–6节\n主讲教师:陈老师')
_ENG2 = ('课程:大学英语\n班级:大学英语5\n(教二205)\n'
         '3–18周:连续周 星期二 3–4节\n主讲教师:李老师')
_NUM = ('课程:线性代数\n班级:数学2班\n(教三101)\n'
        '3–18周:单周 星期五 3–4节\n主讲教师:王老师')
_LAB = ('课程:大学物理实验\n班级:物理1班\n(实验楼B203)\n'
        '3–18周:连续周 星期四 11节\n主讲教师:刘老师')

LABELED_MATRIX = [
    ['节次', None, '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日期'],
    ['上午', '1', None, None, None, None, None, None, None],
    [None, '2', None, None, None, None, None, None, None],
    [None, '3', None, _ENG2, None, None, _NUM, None, None],
    [None, '4', None, None, None, None, None, None, None],
    [None, '中午1', None, None, None, None, None, None, None],
    ['下午', '中午2', _IC, None, None, _ENG, None, None, None],
    [None, '5', None, None, None, None, None, None, None],
    [None, '6', None, None, None, None, None, None, None],
    [None, '7', None, None, None, None, None, None, None],
    [None, '8', None, None, None, None, None, None, None],
    ['晚上', '9', None, None, None, _LAB, None, None, None],
    [None, '10', None, None, None, None, None, None, None],
    [None, '11', None, None, None, None, None, None, None],
]

# (行, 列, 行, 列) —— 1-based；节次分组列与跨多行的课程格
LABELED_MERGES = [
    (2, 1, 5, 1),    # 上午
    (7, 1, 11, 1),   # 下午
    (12, 1, 14, 1),  # 晚上
    (4, 4, 5, 4),    # 大学英语 3–4 节
    (4, 7, 5, 7),    # 线性代数 3–4 节
    (7, 3, 9, 3),    # 数据结构 中午2–6 节
    (7, 6, 9, 6),    # 高等数学 中午2–6 节
    (12, 6, 14, 6),  # 大学物理实验 跨 9–11 行，但格子里写的是 11 节
]

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    write_xlsx(os.path.join(OUT, 'long-table.xlsx'), LONG_TABLE)
    write_xlsx(os.path.join(OUT, 'matrix.xlsx'), MATRIX)
    write_xlsx(os.path.join(OUT, 'labeled-matrix.xlsx'), LABELED_MATRIX, LABELED_MERGES)
    print('已生成:')
    for f in ('long-table.xlsx', 'matrix.xlsx', 'labeled-matrix.xlsx'):
        p = os.path.join(OUT, f)
        print('  tests/fixtures/%s  (%d 字节)' % (f, os.path.getsize(p)))
