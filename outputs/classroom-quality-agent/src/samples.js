// Explicit demo fixtures; never used as an inference fallback.
export const samplePpt = { slides: [
  { section: '导入', title: '排序与稳定性', bullets: ['排序按关键字组织数据', '稳定排序保留同值元素的原有顺序'], notes: ['这是本地示例，非 AI 生成。'], example: '同分学生按提交时间保持顺序', counterExample: '同分项相对顺序被交换' },
  { section: '讲解', title: '冒泡排序', bullets: ['比较相邻元素', '仅在逆序时交换', '一轮后最大值位于末尾'], notes: ['让学生观察每次相邻交换。'], example: '[3, 2, 1] → [2, 3, 1] → [2, 1, 3]' },
  { section: '总结', title: '选用合适的排序方法', bullets: ['比较时间与空间复杂度', '根据数据量与稳定性要求选择'], notes: [] },
] };
export const sampleActivities = [
  { mode: 'quiz', title: '排序稳定性 · 点击答题示例', description: '选择正确答案；答错时查看解释后重试。', hint: '稳定性关注相同关键字元素的相对顺序。', explanation: '判断算法是否保持同值元素的原有相对顺序。', questions: [{ prompt: '稳定排序保证什么？', options: ['相同关键字元素的相对顺序保持', '任意输入都只比较一次', '一定不需要额外空间'], answer: 0, explanation: '稳定性只说明同值元素的相对顺序，与比较次数和空间复杂度无直接关系。' }] },
  { mode: 'order', rule: 'bubble', title: '冒泡排序 · 拖拽示例', description: '拖动相邻逆序数字进行交换，将数字按升序排列；每次交换后可检查答案。', hint: '从左向右比较相邻数字，左大右小才交换。', explanation: '相邻逆序交换消去逆序对，重复比较后获得升序序列。', items: ['1','2','3','4'] },
  { mode: 'match', title: '排序概念 · 配对示例', description: '先选左侧概念，再选右侧对应解释。', hint: '分治是拆分子问题；稳定性关注相同值的顺序。', explanation: '概念与其定义需要一一对应。', pairs: [{ left: '分治', right: '拆分子问题再合并' }, { left: '稳定性', right: '保持同值元素相对顺序' }] },
  { mode: 'steps', title: '归并排序 · 步骤演示示例', description: '点击下一步，观察分治过程。', hint: '先拆分，递归排序，再合并。', explanation: '归并排序通过有序子序列的合并得到完整有序序列。', items: ['将数组拆分为两个子数组', '分别递归排序左右子数组', '依次比较并合并有序子数组'] },
];
