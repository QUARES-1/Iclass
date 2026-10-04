// 前沿补充模块（Sprint 1 功能切片③）。
// 围绕课程主题补充“最新技术、行业案例与应用场景”，并标注来源与待核验状态。
// 原型阶段用一个可维护的本地知识库来模拟“备课生成智能体”的前沿检索能力。
// 知识库覆盖数据结构、算法以及操作系统/网络/数据库/人工智能等常见课程主题，
// 避免只能命中排序算法示例，从而对不同教学内容都能给出有价值的前沿补充。

// 前沿知识库：keywords 用于与知识点做匹配，needsVerify 表示该条是否需要人工核验。
export const FRONTIER_KB = [
  // ---------- 排序（保留示例相关条目） ----------
  { id: 'f-01', keywords: ['快速排序', '排序', 'quicksort'], title: '工业级运行时排序：Timsort 与 Dual-Pivot QuickSort', type: '技术', description: 'Python、Java 等现代语言采用混合排序策略，通过小规模插入排序与分治思想提升真实数据下的性能。', source: 'CPython 源码 / JDK Arrays.sort', needsVerify: true },
  { id: 'f-02', keywords: ['归并排序', '外部排序', '大数据', '归并'], title: '外部排序与 MapReduce 归并思想', type: '技术', description: '当数据无法全部装入内存时，采用分块排序加多路归并；MapReduce 的 Shuffle/Sort 阶段即借鉴该思想。', source: 'MapReduce 论文', needsVerify: true },
  { id: 'f-03', keywords: ['排序', '推荐', '搜索', '算法', '比较'], title: '推荐与搜索系统中的排序层', type: '案例', description: '电商、短视频平台在召回之后用排序模型（LTR、粗排/精排）决定内容展示顺序，直接影响用户体验。', source: '行业公开技术博客', needsVerify: true },
  { id: 'f-04', keywords: ['复杂度', '时间复杂度', '空间复杂度', '分析'], title: '算法复杂度分析工具与基准测试', type: '技术', description: '通过大 O 分析配合实测基准（Benchmark）验证算法在真实数据规模下的表现，避免纸上谈兵。', source: '《算法导论》', needsVerify: false },
  { id: 'f-05', keywords: ['堆排序', '优先队列', '调度', '选择'], title: '优先队列在任务调度中的应用', type: '案例', description: '操作系统与任务调度器使用堆实现优先队列，动态选取最高优先级任务，保证实时性。', source: '操作系统教材', needsVerify: true },
  { id: 'f-06', keywords: ['基数排序', '稳定', '桶', '线性'], title: '稳定排序在数据库与文件系统中的应用', type: '案例', description: '稳定排序保证相同键值的记录保持原顺序，广泛用于数据库多列排序与文件索引。', source: '数据库系统实现', needsVerify: true },

  // ---------- 线性表 / 栈 / 队列 ----------
  { id: 'f-07', keywords: ['线性表', '顺序表', '数组', '动态数组'], title: '动态数组与 ArrayList 的底层实现', type: '技术', description: '主流语言的内置列表通过动态扩容与内存复制，在随机访问与尾部追加之间取得平衡。', source: 'JDK ArrayList / CPython list', needsVerify: false },
  { id: 'f-08', keywords: ['链表', '单链表', '双向链表', '指针'], title: '链表在 LRU 缓存与内存管理中的应用', type: '案例', description: '双向链表配合哈希表可实现 O(1) 的 LRU 淘汰；操作系统也用链表管理空闲内存块。', source: 'Redis 设计与实现', needsVerify: true },
  { id: 'f-09', keywords: ['栈', '括号匹配', '表达式', '逆波兰'], title: '调用栈与表达式求值', type: '技术', description: '编译器通过栈实现函数调用与表达式求值，后缀表达式（逆波兰）求值即栈的经典应用。', source: '编译原理教材', needsVerify: false },
  { id: 'f-10', keywords: ['队列', '消息队列', '生产者', '消费者'], title: '消息队列在分布式系统中的应用', type: '案例', description: 'Kafka、RabbitMQ 等消息中间件用队列解耦生产与消费，实现削峰填谷与异步处理。', source: 'Kafka 官方文档', needsVerify: true },

  // ---------- 字符串 / 树 ----------
  { id: 'f-11', keywords: ['字符串', '模式匹配', 'KMP', '文本'], title: 'KMP 与全文检索', type: '技术', description: 'KMP 通过前缀函数避免重复比较，搜索引擎的倒排索引与分词也依赖高效的字符串处理。', source: '《算法导论》', needsVerify: false },
  { id: 'f-12', keywords: ['二叉树', '二叉搜索树', 'BST', '树'], title: '二叉搜索树与有序符号表', type: '技术', description: 'BST 提供 O(log n) 的查找与插入，是数据库索引、有序集合等结构的基础。', source: '《算法》第4版', needsVerify: false },
  { id: 'f-13', keywords: ['树', '二叉树', '遍历', '表达式树'], title: '表达式树与编译器的语法树', type: '案例', description: '编译器把表达式解析为树结构后递归求值，抽象语法树（AST）是现代语言工具链的核心。', source: '编译原理教材', needsVerify: true },
  { id: 'f-14', keywords: ['平衡树', 'AVL', '红黑树', '旋转'], title: '红黑树在标准库容器中的应用', type: '技术', description: 'C++ 的 map/set、Java 的 TreeMap 使用红黑树保证最坏 O(log n) 的增删查。', source: 'C++ STL / JDK', needsVerify: false },
  { id: 'f-15', keywords: ['B树', 'B+树', '索引', '数据库'], title: 'B+ 树与数据库索引', type: '技术', description: 'MySQL InnoDB 等数据库用 B+ 树组织索引，配合磁盘页读写减少 IO 次数。', source: '《数据库系统概念》', needsVerify: false },

  // ---------- 图 ----------
  { id: 'f-16', keywords: ['图', '遍历', 'DFS', 'BFS', '广度优先', '深度优先'], title: '图的遍历与社交网络分析', type: '案例', description: 'BFS/DFS 用于好友推荐、连通性判断与路径搜索，是社交网络与知识图谱的基础算法。', source: '图论教材', needsVerify: true },
  { id: 'f-17', keywords: ['最短路径', 'Dijkstra', '导航', '路径'], title: '地图导航与最短路径算法', type: '案例', description: 'Dijkstra 与 A* 算法驱动地图导航、物流配送与路由规划，实时计算两点间最优路径。', source: '高德/Google Maps 技术博客', needsVerify: true },
  { id: 'f-18', keywords: ['最小生成树', '网络', '布线', '连通'], title: '最小生成树与网络布线优化', type: '案例', description: 'Prim/Kruskal 用于通信网络、电力管网的布线优化，以最小成本连通所有节点。', source: '网络工程教材', needsVerify: true },
  { id: 'f-19', keywords: ['拓扑排序', '依赖', '任务', '编译'], title: '拓扑排序与依赖解析', type: '技术', description: '构建系统（Maven/Gradle）与任务调度用拓扑排序处理模块依赖，并检测循环依赖。', source: '构建系统实现', needsVerify: true },

  // ---------- 哈希 / 查找 / 算法思想 ----------
  { id: 'f-20', keywords: ['哈希表', '散列表', '哈希', '查找', '去重'], title: '哈希表在缓存与去重中的应用', type: '技术', description: '哈希表以 O(1) 期望时间支撑缓存、去重、索引与路由，是工程中最高频的数据结构。', source: '《算法》第4版', needsVerify: false },
  { id: 'f-21', keywords: ['一致性哈希', '分布式', '缓存', '哈希'], title: '一致性哈希与分布式缓存', type: '技术', description: '一致性哈希在节点增减时最小化数据迁移，是 Memcached/Redis 集群等分布式系统的基石。', source: '分布式系统教材', needsVerify: true },
  { id: 'f-22', keywords: ['二分查找', '查找', '有序', '索引'], title: '二分查找与有序索引', type: '技术', description: '二分查找将查找复杂度降到 O(log n)，广泛应用于有序数组检索与各类索引结构。', source: '《算法导论》', needsVerify: false },
  { id: 'f-23', keywords: ['递归', '分治', '归并', '快速'], title: '递归、分治与并行计算', type: '技术', description: '分治把大问题拆为子问题递归求解，MapReduce、并行归并排序都体现了这一思想。', source: '《算法导论》', needsVerify: false },
  { id: 'f-24', keywords: ['动态规划', 'DP', '最优化', '状态转移'], title: '动态规划在路径规划与推荐中的应用', type: '案例', description: 'DP 通过状态转移求解最优化问题，广泛用于路径规划、文本对齐与序列决策。', source: '《算法导论》', needsVerify: true },
  { id: 'f-25', keywords: ['贪心', '贪心算法', '最优', '调度'], title: '贪心算法与实时决策', type: '案例', description: '贪心策略在区间调度、哈夫曼编码、任务分配等场景中给出高效近似或最优解。', source: '《算法导论》', needsVerify: true },
  { id: 'f-26', keywords: ['回溯', '搜索', '剪枝', '枚举'], title: '回溯与约束求解', type: '技术', description: '回溯通过剪枝遍历解空间，用于八皇后、数独、排班等组合与约束满足问题。', source: '算法竞赛教程', needsVerify: true },

  // ---------- 系统与前沿 ----------
  { id: 'f-27', keywords: ['操作系统', '进程', '线程', '调度', '并发'], title: '操作系统进程调度与并发控制', type: '技术', description: '调度器用优先级队列分配 CPU，锁与信号量解决并发冲突，是系统软件的核心。', source: '《现代操作系统》', needsVerify: true },
  { id: 'f-28', keywords: ['网络', '路由', '协议', 'TCP'], title: '网络路由算法与拥塞控制', type: '技术', description: '路由器用最短路径算法计算路由表，TCP 通过拥塞控制保证网络稳定性。', source: '《计算机网络》', needsVerify: true },
  { id: 'f-29', keywords: ['人工智能', '机器学习', '大模型', '智能体'], title: '大模型与 AI 智能体在教育场景的落地', type: '案例', description: '生成式 AI 与智能体已用于自动备课、智能答疑与个性化学习，是本项目的核心前沿方向。', source: '行业研究报告', needsVerify: true },
  { id: 'f-30', keywords: ['大数据', '分布式', '云计算', 'MapReduce'], title: '大数据与分布式计算框架', type: '技术', description: 'Hadoop、Spark 等框架通过分布式存储与计算处理海量数据，依赖排序、分区与容错机制。', source: 'Spark 官方文档', needsVerify: true },
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