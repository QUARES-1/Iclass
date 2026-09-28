// 前沿补充模块（Sprint 1 功能切片③）。
// 围绕课程主题补充“最新技术、行业案例与应用场景”，并标注来源与待核验状态。
// 原型阶段用一个可维护的本地知识库来模拟“备课生成智能体”的前沿检索能力。

// 前沿知识库：keywords 用于与知识点做匹配，needsVerify 表示该条是否需要人工核验。
export const FRONTIER_KB = [
  {
    id: 'f-01',
    keywords: ['快速排序', '排序', 'quicksort'],
    title: '工业级运行时排序：Timsort 与 Dual-Pivot QuickSort',
    type: '技术',
    description: 'Python、Java 等现代语言采用混合排序策略，通过小规模插入排序与分治思想提升真实数据下的性能。',
    source: 'CPython 源码 / JDK Arrays.sort',
    needsVerify: true,
  },
  {
    id: 'f-02',
    keywords: ['归并排序', '外部排序', '大数据', '归并'],
    title: '外部排序与 MapReduce 归并思想',
    type: '技术',
    description: '当数据无法全部装入内存时，采用分块排序加多路归并；MapReduce 的 Shuffle/Sort 阶段即借鉴该思想。',
    source: 'MapReduce 论文',
    needsVerify: true,
  },
  {
    id: 'f-03',
    keywords: ['排序', '推荐', '搜索', '算法', '比较'],
    title: '推荐与搜索系统中的排序层',
    type: '案例',
    description: '电商、短视频平台在召回之后用排序模型（LTR、粗排/精排）决定内容展示顺序，直接影响用户体验。',
    source: '行业公开技术博客',
    needsVerify: true,
  },
  {
    id: 'f-04',
    keywords: ['复杂度', '时间复杂度', '空间复杂度', '分析'],
    title: '算法复杂度分析工具与基准测试',
    type: '技术',
    description: '通过大 O 分析配合实测基准（Benchmark）验证算法在真实数据规模下的表现，避免纸上谈兵。',
    source: '《算法导论》',
    needsVerify: false,
  },
  {
    id: 'f-05',
    keywords: ['堆排序', '优先队列', '调度', '选择'],
    title: '优先队列在任务调度中的应用',
    type: '案例',
    description: '操作系统与任务调度器使用堆实现优先队列，动态选取最高优先级任务，保证实时性。',
    source: '操作系统教材',
    needsVerify: true,
  },
  {
    id: 'f-06',
    keywords: ['基数排序', '稳定', '桶', '线性'],
    title: '稳定排序在数据库与文件系统中的应用',
    type: '案例',
    description: '稳定排序保证相同键值的记录保持原顺序，广泛用于数据库多列排序与文件索引。',
    source: '数据库系统实现',
    needsVerify: true,
  },
];

// 判断知识点是否命中某条前沿知识的关键词。
function hitKeyword(text, keywords) {
  const lower = String(text || '').toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

// 根据结构化知识点列表匹配前沿补充，返回带 matchedBy 字段的结果数组。
export function matchSupplements(knowledgePoints = [], kb = FRONTIER_KB) {
  const matched = [];
  const seen = new Set();

  for (const point of knowledgePoints) {
    for (const item of kb) {
      if (hitKeyword(point, item.keywords) && !seen.has(item.id)) {
        seen.add(item.id);
        matched.push({ ...item, matchedBy: point });
      }
    }
  }
  return matched;
}

// 按“技术 / 案例”分组，便于前端分别渲染。
export function groupSupplements(supplements = []) {
  return {
    tech: supplements.filter((item) => item.type === '技术'),
    cases: supplements.filter((item) => item.type === '案例'),
  };
}
