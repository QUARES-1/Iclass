# 课堂质量改进智能体 · Sprint 1 课前智能备课

> 爱教学项目 · 软件项目管理实验二（Sprint 1，代号“蜂鸟”）· 人机协同编码网页版原型

## 一、项目背景

本项目面向高校课堂教学质量提升场景，围绕“课前、课中、课后”全过程为教师提供服务。本仓库实现的是 **Sprint 1「课前智能备课」** 切片，承接实验一产出的用户故事地图中第一个发布切片。

Sprint 1 覆盖 4 条 Must 用户故事：

- 作为教师，我想上传历史教案、教学用书、教学大纲和往年 PPT，以便 AI 理解课程背景；
- 作为教师，我想让 AI 根据资料整理知识点、重点难点和教学目标；
- 作为教师，我想让 AI 结合前沿技术和行业案例生成 PPT 初稿；
- 作为教师，我想修改和确认 AI 生成的 PPT，以便保证内容准确。

对应 5 个功能切片：**资料上传 → 内容理解 → 前沿补充 → PPT 生成 → 人工审核**。

## 二、技术方案

- 前端：原生 HTML + CSS + ES Module（无框架、无打包），浏览器直接运行。
- 后端：`server.js` 使用 Node.js 内置 `http` 模块托管静态文件，并提供安全的 AI 内容理解与 LLM 大纲生成接口。
- 核心逻辑：`src/` 下的纯函数模块，浏览器与单元测试共用同一份实现。
- 测试：Node.js 内置 `node:test`，覆盖关键路径的单元测试。
- AI 能力：后端通过 OpenAI 兼容协议调用 DeepSeek，完成教学资料语义理解与 PPT 大纲生成；密钥仅从服务器环境变量读取，前端不会接触 API Key。调用失败时内容理解自动回退本地规则，PPT 生成自动回退本地模板。
- PPT 导出：使用浏览器端 PptxGenJS（见 `public/vendor/pptxgen.bundle.js`，MIT 协议），
  在页面内直接生成并下载真正的 PowerPoint（`.pptx`），一页一页可放映。

> 说明：内容理解优先使用 DeepSeek，并保留本地规则兜底；前沿匹配仍使用本地知识库；PPT 大纲既可使用本地模板，也可由后端调用 DeepSeek 生成。

## 三、快速开始

环境要求：Node.js ≥ 20.12。

```bash
# 1) 启动网页版原型
npm start
# 打开浏览器访问 http://localhost:3000

# 2) 运行单元测试
npm test
```

### DeepSeek 安全配置

1. 将 `.env.example` 复制为 `.env`。
2. 只在服务器端的 `.env` 中填写 `LLM_API_KEY`；`.env` 已被 `.gitignore` 排除。
3. 保持 `LLM_BASE_URL=https://api.deepseek.com`、`LLM_MODEL=deepseek-chat`，再执行 `npm start`。

浏览器会把已提取的教学资料文本发送到本项目后端，由后端调用 DeepSeek；浏览器不会获得或发送 API Key、Base URL 或模型配置。未配置 Key 时，内容理解和 PPT 生成都会自动使用本地实现。

请通过 `npm start` 使用本系统；ES Module 和后端 AI 接口不能通过直接双击 HTML 正常工作。

## 四、使用流程

1. **资料上传**：粘贴资料，或上传 `.txt`、`.md`、`.docx`、`.pptx` 教学文件，也可点击“填入示例资料”。PPTX 由后端提取文字，单个文件上限为 15 MB；旧版 `.ppt` 请先另存为 `.pptx`。
2. **内容理解**：后端优先调用 DeepSeek，根据资料语义提取章节、教学目标、知识点、重点与难点；失败时回退本地规则。教师可勾选纳入 PPT 的知识点。
3. **前沿补充**：查看匹配到的最新技术与行业案例及其来源，勾选要纳入的内容。
4. **PPT 生成**：按“导入 → 讲解 → 案例 → 互动 → 总结”生成 PPT 初稿；可点击“AI 生成 PPT”，也可导出 Markdown 或下载 `.pptx`。
5. **人工审核**：修改、删除或确认每一页内容；未经确认的内容不能用于正式授课；确认后可下载最终 `.pptx`。

## 五、目录结构

```text
classroom-quality-agent/
├── server.js                 # 静态文件服务器（npm start）
├── package.json
├── src/
│   ├── analyzer.js           # 内容理解：结构化解析资料
│   ├── frontier.js           # 前沿补充：技术/案例知识库与匹配
│   ├── pptGenerator.js       # PPT 生成：大纲与 Markdown 导出
│   ├── pptExport.js          # PPT 导出：生成 PowerPoint（.pptx）
│   └── review.js             # 人工审核：修改/删除/确认状态管理
├── public/
│   ├── index.html            # 页面结构
│   ├── styles.css            # 样式
│   ├── main.js               # 交互与流程串联
│   ├── sample.js             # 示例教学资料
│   └── vendor/               # 第三方库（PptxGenJS）
├── test/                     # 单元、接口与流程测试（node --test）
│   ├── analyzer.test.js
│   ├── fileParser.test.js
│   ├── frontier.test.js
│   ├── llm.test.js
│   ├── pptGenerator.test.js
│   ├── pptExport.test.js
│   ├── review.test.js
│   ├── server.test.js
│   ├── sprint1-flow.test.js
│   └── ui-contract.test.js
└── test-support/             # 测试夹具与辅助函数
```

## 六、DoD（完成定义）

- ① 代码能跑：`npm start` 可启动，浏览器可完整走完 5 步流程。
- ② 有完整测试：`npm test` 共 88 项测试，覆盖资料解析、AI 回退、前沿匹配、PPT 生成与正式导出、人工审核、服务端接口、页面契约和 Sprint 1 主流程。
- ③ 有代码注释：`src/` 与 `server.js` 关键函数/模块均有中文注释。
- ④ 代码已审查：所有 AI 生成内容均通过人工审核步骤合入。

## 七、分支策略与提交建议

建议按用户故事创建功能分支，审核后合入主干：

```bash
git init
git checkout -b feature/US-01-upload        # 资料上传
git checkout -b feature/US-02-understand    # 内容理解
git checkout -b feature/US-03-frontier      # 前沿补充
git checkout -b feature/US-04-ppt           # PPT 生成
git checkout -b feature/US-05-review        # 人工审核
```

每个功能分支完成后提交，例如：

```text
feat: 新增资料上传与示例数据填充
feat: 实现内容理解规则式解析
feat: 增加前沿补充知识库与匹配
feat: 生成 PPT 大纲并支持 Markdown 导出
feat: 实现人工审核的确认/删除/编辑
test: 补充关键路径单元测试
docs: 编写 README 运行指南
```

## 八、团队信息

- 团队编号 / 队名：Team11
- 项目背景：爱教学
- 本轮 DRI（第 2 位轮值，兼任 PO / Scrum Master）：赵易

| 成员 | 学号 | 分工 |
| --- | --- | --- |
| 金涵雨 | 20245946 | 产品与需求负责人 |
| 赵易 | 20246166 | 质量与风险负责人（本轮 DRI） |
| 衣婉宁 | 20245977 | 数据与架构负责人 |
| 王耀辉 | 20246130 | AI 工具整合负责人 |
