import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  buildPresentation,
  deriveCoverContent,
  slidesToExportModel,
} from '../src/pptExport.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');

function loadBrowserPptxGenJS() {
  const bundle = fs.readFileSync(path.join(projectDir, 'public/vendor/pptxgen.bundle.js'), 'utf8');
  const loadBundle = new Function(
    'require',
    'Buffer',
    'process',
    `${bundle}\nreturn PptxGenJS;`,
  );
  return loadBundle(createRequire(import.meta.url), Buffer, process);
}

const analysis = {
  chapters: ['第5章 排序算法'],
  objectives: ['理解排序稳定性，能比较并选择常见内部排序算法'],
  knowledgePoints: ['排序与稳定性', '快速排序的划分过程', '常见排序算法的比较与选择'],
};

const slides = [
  {
    section: '导入',
    title: '为什么系统总在“排序”？',
    bullets: [
      '成绩榜：按总分与提交时间确定展示顺序',
      '电商列表：按价格、销量或综合评分排列',
      '任务队列：按优先级与截止时间组织处理次序',
      '本课问题：面对不同数据，应该选择哪一种排序算法？',
    ],
    notes: ['请学生先说出一个日常使用排序功能的产品，再追问它可能采用什么排序依据。'],
    layout: 'intro',
    status: 'confirmed',
  },
  {
    section: '讲解',
    title: '排序与稳定性',
    bullets: [
      '排序：将记录按一个或多个关键字重新排列，使其满足递增或递减关系。',
      '稳定：关键字相同的记录，排序后仍保持原有相对次序。',
      '示例：先按姓名排序，再按班级稳定排序，可保留班级内姓名次序。',
      '反例：若相同关键字记录的相对次序被打乱，则该排序不稳定。',
    ],
    notes: ['稳定性是算法性质，不等于结果“看起来有序”。'],
    example: '两名学生分数相同，排序后仍保持原来的登记顺序，这次排序具有稳定性。',
    counterExample: '如果同分学生排序后的先后次序发生交换，就不能称该排序稳定。',
    layout: 'concept',
    status: 'confirmed',
  },
  {
    section: '讲解',
    title: '快速排序的划分过程',
    bullets: ['选择枢轴并确定比较区间', '移动左右指针寻找错位元素', '交换错位元素，直到指针相遇', '递归处理枢轴两侧的子序列'],
    steps: ['选择枢轴并标记左右边界', '左右指针向中间扫描', '交换不符合分区规则的元素', '对左右子序列重复划分'],
    metrics: {
      平均时间: 'O(n log n)',
      最坏时间: 'O(n²)',
      平均空间: 'O(log n)',
      稳定性: '不稳定',
    },
    notes: ['示例数组只用于指针和交换操作演示；教师可在 PowerPoint 中直接修改数组元素。'],
    layout: 'algorithm',
    status: 'confirmed',
  },
  {
    section: '讲解',
    title: '常见排序算法的比较与选择',
    bullets: [],
    comparisonRows: [
      ['数据基本有序', '直接插入排序：移动次数较少，思路直观'],
      ['大规模内存数据', '快速排序：平均性能较好，但需关注最坏情况'],
      ['要求稳定且性能可预测', '归并排序：时间复杂度为 O(n log n)，需要额外空间'],
      ['额外空间受限', '堆排序：可原地完成，但不稳定'],
      ['数据范围较小且可分配桶', '可评估计数排序或基数排序等非比较方法'],
    ],
    notes: ['算法选择还应结合数据分布、实现成本与具体运行环境，不宜只看一个复杂度指标。'],
    layout: 'comparison',
    status: 'confirmed',
  },
  {
    section: '案例',
    title: '电商商品列表如何选择排序策略',
    bullets: [
      '业务场景：用户需要按价格、销量或上架时间浏览商品',
      '排序依据：明确主关键字，并约定同值商品的次级顺序',
      '技术选择：根据数据规模、稳定性要求与更新频率评估算法',
      '实际价值：让展示顺序可解释，并兼顾响应速度与结果一致性',
    ],
    notes: ['本页是教学化场景，不包含特定平台的真实业务数据或技术实现声明。'],
    layout: 'case',
    status: 'confirmed',
  },
  {
    section: '互动',
    title: '课堂讨论：你会怎样选择？',
    bullets: [
      '如果数据量较小且已经基本有序，你会优先考虑哪一种排序算法？为什么？',
      '先明确数据规模、初始有序程度和稳定性要求',
      '用时间与空间复杂度说明选择依据',
      '给出一种不适用的算法并解释原因',
    ],
    notes: ['建议先独立思考 1 分钟，再两人互评，最后由小组给出结论。'],
    layout: 'interaction',
    status: 'confirmed',
  },
  {
    section: '总结',
    title: '从问题特征到算法选择',
    bullets: [
      '先看数据规模与初始状态',
      '再看时间、空间和稳定性要求',
      '用步骤示意理解算法，而非只记结论',
      '在真实场景中综合评估并验证选择',
      '稳定性要求会影响算法选择',
      '复杂度需要结合数据规模解释',
    ],
    notes: ['课后可选择两种算法，用同一组数据手工演示并比较操作次数。'],
    layout: 'summary',
    status: 'confirmed',
  },
];

const cover = deriveCoverContent(analysis, slides);
const model = slidesToExportModel(slides, cover);
const PptxGenJS = loadBrowserPptxGenJS();
const sampleLimit = Number(process.env.ICLASS_PPT_SAMPLE_LIMIT || 0);
const exportModel = sampleLimit > 0 ? model.slice(0, sampleLimit) : model;
const pptx = buildPresentation(exportModel, PptxGenJS);
const target = path.resolve(process.argv[2] || path.join(projectDir, 'output', 'PPT视觉改进-排序算法示例.pptx'));
fs.mkdirSync(path.dirname(target), { recursive: true });
const data = await pptx.write({ outputType: 'nodebuffer', compression: true });
fs.writeFileSync(target, data);
console.log(target);
