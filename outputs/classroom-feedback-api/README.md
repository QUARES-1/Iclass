# 课堂反馈问卷（金数据）API 交付包

课后学生反馈问卷的前置设计、样例数据与金数据 API v1 客户端。相邻 [主应用](../classroom-quality-agent/README.md)已复用这里的定义、样例和客户端，提供动态模板、发布、同步、统计与课堂综合复盘，无需另启问卷服务。

## 交付内容

- `docs/questionnaire-design.md`：问卷设计说明（题目、选项、字段对照、设计依据）。
- `data/survey-form.json`：可直接调用金数据“创建表单”接口的问卷定义。
- `data/sample-entries.json`：8 份样例填写数据，取值与问卷定义一致。
- `src/jinshuju.js`：金数据 API v1 客户端（Bearer 鉴权、分页、错误处理）。
- `src/survey.js`：问卷定义 / 样例数据的加载、校验与字段 `api_code` 约定。
- `src/webhook.js`：Webhook 请求校验与解析（用于表单数据自动推送）。
- `scripts/`：创建问卷、导入样例、拉取数据的命令行工具。

## 快速开始

```sh
cd outputs/classroom-feedback-api
cp .env.example .env   # 填写 JINSHUJU_ACCESS_TOKEN
npm run create-survey
npm run import-samples
npm run list-responses
```

`npm run create-survey` 会把创建成功的表单 Token、填写链接与字段对照写入 `data/form-instance.local.json`（已加入 `.gitignore`，不会进入 Git 仓库）。

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `JINSHUJU_ACCESS_TOKEN` | 金数据个人 / 企业 Access Token（必填） | 无 |
| `JINSHUJU_BASE_URL` | API 基础地址 | `https://jinshuju.net/api/v1` |
| `JINSHUJU_FORM_TOKEN` | 目标表单 Token（导入 / 查询时使用） | 无 |

## 运行测试

```sh
npm test
```

测试使用注入的 mock fetch，不访问网络，也不依赖真实 Token。

## 与主应用的关系

1. 阅读 `docs/questionnaire-design.md` 了解问卷口径与字段 `api_code`。
2. 阅读 `docs/api-handoff.md` 了解接口封装与 Webhook。
3. 原始定义仍保留固定课程字段供独立脚本使用；主应用适配为9题默认模板并自动绑定课堂，不覆盖这些原始数据。
4. `scripts/import-samples.mjs` 会写入远端，仅用于专用测试表单；主应用“载入问卷示例”只在本地建立隔离课堂。
5. 已在专用测试问卷上验证真实创建、匿名填写、回流和截止关闭；实际响应适配与验收边界见主应用的[真实联调记录](../classroom-quality-agent/docs/sprint3-live-validation.md)。
