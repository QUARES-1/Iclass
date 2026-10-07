import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { buildPresentation, slidesToExportModel } from '../src/pptExport.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const bundle = fs.readFileSync(path.join(projectDir, 'public/vendor/pptxgen.bundle.js'), 'utf8');
const PptxGenJS = new Function('require', 'Buffer', 'process', `${bundle}\nreturn PptxGenJS;`)(
  createRequire(import.meta.url), Buffer, process,
);

const slides = [
  {
    section: '讲解',
    title: '常见算法：逆置与有序表合并',
    bullets: [
      '顺序表逆置：双指针从两端向中间交换，时间复杂度 O(n)，空间复杂度 O(1)。',
      '单链表逆置：逐个反转 next 指针，需保存后继防止断链，时间复杂度 O(n)，空间复杂度 O(1)。',
      '有序表合并：双指针同步前进，每次取较小者，时间复杂度 O(m+n)。',
      '合并结果保持有序，是归并排序的基础步骤。',
    ],
    layout: 'algorithm',
    status: 'confirmed',
  },
  {
    section: '总结',
    title: '线性表核心要点',
    bullets: [
      '线性表由有限个相同数据类型的元素组成',
      '除首元素外，每个元素都有唯一直接前驱',
      '除尾元素外，每个元素都有唯一直接后继',
      '顺序存储支持随机访问，但插入删除需要移动元素',
      '链式存储便于插入删除，但定位元素需要逐个遍历',
      'InitList、Length、GetElem、LocateElem 是常用基本操作',
      'ListInsert 与 ListDelete 必须先检查位置是否合法',
      '选择存储结构时需要结合访问方式与修改频率',
    ],
    layout: 'summary',
    status: 'confirmed',
  },
];

const model = slidesToExportModel(slides, {
  coverTitle: '线性表是什么',
  coverSubtitle: '理解线性表的逻辑结构定义及其一对一前后关系特征',
  coverKeywords: [
    '线性表的定义：n 个相同数据类型数据元素组成的有限序列',
    '线性表的逻辑特征：除第一个元素外每个元素有唯一直接前驱，除最后一个元素外每个元素有唯一直接后继',
    '抽象数据类型 ADT 的概念及线性表的基本操作，包括初始化、查找、插入和删除',
  ],
});

const target = path.resolve(process.argv[2] || path.join(projectDir, 'output', 'PPT版式压力测试-线性表.pptx'));
fs.mkdirSync(path.dirname(target), { recursive: true });
const pptx = buildPresentation(model, PptxGenJS);
const data = await pptx.write({ outputType: 'nodebuffer', compression: true });
fs.writeFileSync(target, data);
console.log(target);
