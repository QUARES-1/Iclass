# 金数据 API v1 接入说明（交接文档）

本文档面向下一轮负责「问卷统计 + 课堂诊断联动」的同学，说明金数据（Jinshuju）API v1 的接入方式，以及本交付包已经封装的能力。

## 1. 基本信息

- 基础地址：`https://jinshuju.net/api/v1`
- 鉴权：`Authorization: Bearer <ACCESS_TOKEN>`
- 请求头：`Content-Type: application/json`、`Accept: application/json`
- 官方文档：https://open.jinshuju.net/api_v1

Access Token 在「个人中心 → API → 个人 Access Token」创建，Token 仅在创建时显示一次。企业版以上可由企业管理员创建企业 Access Token，访问整个企业所有表单。

## 2. 已封装的方法

| 方法 | HTTP 接口 | 说明 |
| --- | --- | --- |
| `getMe()` | `GET /me` | 获取当前账号信息，用于连通性验证 |
| `listForms(params)` | `GET /forms` | 获取表单列表 |
| `listAllForms(params)` | `GET /forms` | 自动翻页获取全部表单 |
| `getForm(token, params)` | `GET /forms/{token}` | 获取表单结构（含字段 schema） |
| `getFormFieldRules(token)` | `GET /forms/{token}/field_rules` | 获取字段显示规则 |
| `createForm(payload)` | `POST /forms` | 创建表单 |
| `updateForm(token, patch)` | `PATCH /forms/{token}` | 编辑表单 |
| `listEntries(token, params)` | `GET /forms/{token}/entries` | 获取数据列表 |
| `listAllEntries(token, params)` | `GET /forms/{token}/entries` | 自动翻页获取全部数据 |
| `getEntry(token, serial)` | `GET /forms/{token}/entries/{serial}` | 获取单条数据 |
| `createEntry(token, entry)` | `POST /forms/{token}/entries` | 新增单条数据 |
| `batchCreateEntries(token, entries)` | `POST /forms/{token}/entries/batch` | 批量新增，单批最多 200 条 |
| `updateEntry(token, serial, patch, { replaceAll })` | `PATCH`（合并）/ `PUT`（覆盖） | 更新数据 |
| `deleteEntry(token, serial)` | `DELETE /forms/{token}/entries/{serial}` | 删除数据 |

调用示例：

```js
import { JinshujuClient } from './src/jinshuju.js';

const client = new JinshujuClient({ accessToken: process.env.JINSHUJU_ACCESS_TOKEN });
const me = await client.getMe();
const entries = await client.listAllEntries(formToken, { limit: 200 });
```

## 3. 错误与限流

- 客户端把非 2xx 响应统一抛出 `JinshujuError`，含 `status`、`body`、`method`、`url`。
- 常见状态码：`401` 未认证、`403` 无权限、`404` 表单/数据不存在、`400/422` 校验失败、`429` 超频。
- 免费版限流 100 次/小时，专业版 1000 次/小时，企业版更高。批量导入、自动翻页时请控制频率。
- 日期时间为 UTC 字符串，统计时注意转换为北京时间（UTC+8）。

## 4. Webhook（数据推送）

金数据在表单新增或修改数据时，可 POST JSON 到配置的接收地址，请求头为 `X-Requested-By: jinshuju`。推送体结构：

```json
{ "form": "表单Token", "form_name": "表单标题", "entry": { "serial_number": 1, "field_1": "value" } }
```

`src/webhook.js` 提供：

- `verifyJinshujuWebhook(headers)`：校验 `X-Requested-By`。
- `parseWebhookBody(body)`：拆出 `formToken`、`formName`、`entry`。
- `handleWebhook(rawBody, headers)`：一步完成解析与校验。

注意：V1 Webhook 文档未提供 HMAC 签名，建议生产环境叠加来源 IP 白名单（出口 IP：`52.82.74.116`、`52.82.89.22`、`52.82.100.17`），并对 `entry` 做业务校验。

## 5. 字段 Schema 关键点

- 表单字段 `api_code` 按创建时 `fields` 数组顺序固定为 `field_1..field_N`。
- 选项类字段取值用选项 `api_code`，不是中文展示值；多选为数组。
- 评分字段为 1～`rating_max` 的整数；`RatingField` 的 `rating_max` 支持 3 / 5 / 10。
- 创建表单时建议为每个选项显式指定 `api_code`，否则服务端生成随机 code，后续数据与统计难以稳定引用。

## 6. 下一轮接入建议

1. 用 `npm run create-survey` 创建正式问卷，记录返回的 `token` 与 `url`。
2. 用 `npm run import-samples` 导入样例数据，验证数据链路。
3. 在课堂质量智能体中新增「课后问卷统计」模块：调用 `listAllEntries` 拉取数据，按 `field_*` / 选项 `api_code` 聚合难度、节奏、互动、理解程度与评分分布。
4. 把问卷统计结果并入课堂复盘报告，与 Sprint 2 的音频分析一起作为下一节课优化建议的数据依据。
