import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPresentation,
  deriveCoverContent,
  selectSlideLayout,
  slidesToExportModel,
} from '../src/pptExport.js';

const SLIDES = [
  { id: 's1', section: '导入', title: '课程导入', bullets: ['目标1'], notes: ['备注'], status: 'confirmed' },
  { id: 's2', section: '讲解', title: '知识点', bullets: ['要点'], notes: [], status: 'pending' },
  { id: 's3', section: '总结', title: '本章总结', bullets: ['回顾'], notes: [], status: 'deleted' },
];

test('导出模型会过滤已删除的幻灯片', () => {
  const model = slidesToExportModel(SLIDES);
  assert.equal(model.length, 2);
  assert.ok(model.every((item) => item.section !== '总结'));
});

test('导出模型正确映射字段', () => {
  const model = slidesToExportModel(SLIDES);
  assert.deepEqual(model[0], {
    section: '导入',
    title: '课程导入',
    bullets: ['目标1'],
    notes: ['备注'],
  });
});

test('可生成封面页', () => {
  const model = slidesToExportModel(SLIDES, { coverTitle: '第5章 排序算法' });
  assert.equal(model[0].section, '封面');
  assert.equal(model[0].title, '第5章 排序算法');
  assert.equal(model.length, 3);
});

test('正式导出只保留已确认内容', () => {
  const model = slidesToExportModel(SLIDES, { confirmedOnly: true });
  assert.equal(model.length, 1);
  assert.equal(model[0].title, '课程导入');
});

test('封面标题优先使用章节且不会出现 Sprint 1', () => {
  const cover = deriveCoverContent({
    chapters: ['第2章 线性表'],
    objectives: ['理解线性表的逻辑结构'],
    knowledgePoints: ['线性表的定义', '顺序表', '链表'],
  }, SLIDES);
  assert.equal(cover.coverTitle, '第2章 线性表');
  assert.equal(cover.coverSubtitle, '理解线性表的逻辑结构');
  assert.ok(!cover.coverTitle.includes('Sprint'));
  assert.deepEqual(cover.coverKeywords, ['线性表的定义', '顺序表', '链表']);
});

test('布局选择支持显式布局和语义推断', () => {
  assert.equal(selectSlideLayout({ layout: 'interaction' }), 'interaction');
  assert.equal(selectSlideLayout({ section: '总结' }), 'summary');
  assert.equal(selectSlideLayout({ section: '讲解', title: '算法复杂度比较' }), 'comparison');
  assert.equal(selectSlideLayout({ section: '讲解', title: '快速排序算法' }), 'algorithm');
  assert.equal(selectSlideLayout({ section: '讲解', title: '线性表的定义' }), 'concept');
});

test('总结页八个要点保持一页，超过八个才分页', () => {
  const eight = slidesToExportModel([{
    section: '总结',
    title: '核心要点',
    bullets: Array.from({ length: 8 }, (_, index) => `要点 ${index + 1}`),
    notes: [],
    status: 'confirmed',
    layout: 'summary',
  }]);
  assert.equal(eight.length, 1);
  assert.equal(eight[0].bullets.length, 8);

  const nine = slidesToExportModel([{
    section: '总结',
    title: '核心要点',
    bullets: Array.from({ length: 9 }, (_, index) => `要点 ${index + 1}`),
    notes: [],
    status: 'confirmed',
    layout: 'summary',
  }]);
  assert.equal(nine.length, 2);
  assert.ok(nine.every((slide) => slide.title === '核心要点'));
  assert.ok(nine.every((slide) => !slide.title.includes('续')));
});

test('过长算法步骤会安全分页且标题不添加续页文字', () => {
  const model = slidesToExportModel([{
    section: '讲解',
    title: '链表逆置算法',
    bullets: Array.from({ length: 4 }, (_, index) =>
      (`步骤 ${index + 1}：保存当前结点的后继指针并调整链接方向，同时检查边界条件避免链表断裂。`).repeat(3)),
    notes: [],
    status: 'confirmed',
    layout: 'algorithm',
  }]);
  assert.ok(model.length >= 2);
  assert.ok(model.every((slide) => slide.title === '链表逆置算法'));
});

test('导出模型保留向后兼容的视觉字段', () => {
  const model = slidesToExportModel([{
    section: '讲解',
    title: '快速排序',
    bullets: ['选择枢轴'],
    notes: ['备注'],
    status: 'confirmed',
    layout: 'algorithm',
    visualType: 'array',
    steps: ['选择枢轴', '移动指针'],
    metrics: { 时间复杂度: 'O(n log n)' },
    comparisonRows: [['平均时间', 'O(n log n)']],
    emphasis: ['重点'],
    example: '数组 5,2,4,1',
    counterExample: '未划分边界',
  }]);
  assert.equal(model[0].layout, 'algorithm');
  assert.equal(model[0].visualType, 'array');
  assert.deepEqual(model[0].metrics, { 时间复杂度: 'O(n log n)' });
  assert.equal(model[0].example, '数组 5,2,4,1');
  assert.equal(model[0].counterExample, '未划分边界');
});

class FakeSlide {
  constructor() {
    this.texts = [];
    this.shapes = [];
    this.notes = [];
  }

  addText(text, options) {
    this.texts.push({ text, options });
  }

  addShape(type, options) {
    this.shapes.push({ type, options });
  }

  addNotes(notes) {
    this.notes.push(notes);
  }
}

class FakePptxGenJS {
  constructor() {
    this.ShapeType = { line: 'line', rect: 'rect', ellipse: 'ellipse' };
    this.slides = [];
  }

  defineLayout(layout) {
    this.layoutDefinition = layout;
  }

  addSlide() {
    const slide = new FakeSlide();
    this.slides.push(slide);
    return slide;
  }
}

test('构建 16:9 可编辑演示文稿并保留备注', () => {
  const slides = [
    {
      section: '讲解', title: '线性表操作', bullets: ['初始化', '插入', '删除'],
      notes: ['强调边界条件'], status: 'confirmed', layout: 'algorithm',
    },
    {
      section: '互动', title: '课堂讨论', bullets: ['如何选择存储结构？', '比较访问方式'],
      notes: [], status: 'confirmed', layout: 'interaction',
    },
  ];
  const cover = deriveCoverContent({ chapters: ['第2章 线性表'] }, slides);
  const pptx = buildPresentation(slidesToExportModel(slides, cover), FakePptxGenJS);

  assert.deepEqual(pptx.layoutDefinition, {
    name: 'TEACHING_16X9', width: 13.333, height: 7.5,
  });
  assert.equal(pptx.slides.length, 3);
  assert.ok(pptx.slides.every((slide) => slide.texts.length > 0));
  assert.ok(pptx.slides[1].notes.includes('强调边界条件'));
  const allText = pptx.slides.flatMap((slide) => slide.texts.map((entry) => entry.text)).join('\n');
  assert.ok(!allText.includes('讲解关注'));
  assert.ok(!allText.includes('课堂记录'));
  assert.ok(!allText.includes('续 2/2'));
});
