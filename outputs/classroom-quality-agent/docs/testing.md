# 测试说明

以下命令在`outputs/classroom-quality-agent/`执行。先按[部署说明](setup.md)准备Node依赖、Python环境、Whisper权重和Chrome。

## 准备音频夹具

```sh
.venv/bin/python scripts/prepare-test-audio.py
```

脚本下载公开的中文短语音样本，并生成用于编码兼容检查的ADPCM WAV。文件位于`artifacts/audio/`，不加入Git。已有样本会复用，也可以使用本地副本：

```sh
.venv/bin/python scripts/prepare-test-audio.py --source /path/to/asr-example-zh.wav
```

样本来源是[FunASR](https://github.com/modelscope/FunASR)使用的公开中文短音频。ADPCM录音为合成测试夹具，用于验证回放转换，不代表课堂内容。

## 自动回归

```sh
npm test
npm run test:browser
```

单元及接口测试覆盖资料、版本、模型配置、智能体执行、导出和音频任务边界。语音进程时限测试需要Python环境。

浏览器测试启动独立服务和本地模型接口夹具，数据位于`artifacts/browser-data/`，不会使用教师的工作区或真实文本模型密钥。测试录音使用模拟音频设备；短WAV转写仍调用本地Whisper。默认需要3107、3108端口空闲。

浏览器测试的报告位于`playwright-report/`，失败截图和轨迹位于`test-results/`。运行期间不要同时启动另一套使用相同测试端口的测试服务。

## Sprint 2 专项回归

```sh
npm run test:sprint2
```

Windows PowerShell 若拦截 `npm.ps1`，使用 `npm.cmd run test:sprint2`。只运行新增流程测试可用 `node --test test/sprint2-flow.test.js`。

新增 `test/sprint2-flow.test.js` 通过真实 HTTP 接口、异步任务和独立临时存储验证以下流程：

| 验收项 | 新增覆盖 |
| --- | --- |
| S2-02、S2-03 | 上传后显式启动转写、范围回放、校正保留原稿及时间、分析读取校正版 |
| S2-04、S2-08 | 生成总结建议、人工修订确认、证据与版本导出、重建服务恢复、Sprint 1 数据隔离 |
| S2-05 | 构造48分钟时间轴，验证长转写分段完整覆盖、整课汇总与末段证据导出 |
| S2-06 | 更改课程说明、校正转写、替换录音后标记旧报告待更新并拒绝旧下载快照 |
| S2-07 | 无语音、语音模型不可用、AI 服务失败、无效证据均保留已有数据，支持重新提交成功 |
| S2-09 | 完整流程导出的报告不含已移除的指标与派生结论 |

这些新增用例使用注入的语音与文本模型夹具，不请求外部模型、不读取个人录音，不代表真实识别准确率或完整课堂音频解码验收。S2-01 的模拟麦克风与录音保存仍由 `e2e/audio.spec.js` 覆盖；物理设备、真实长音频听校和资源压力仍按[验证状态](acceptance.md)单独验收。旧数据清理由 `test/classroom.test.js` 覆盖。

2026-10-18 本次验证：新增9项流程测试通过，Sprint 2 专项51项通过。检查旧测试时，为临时目录清理加入有限重试，并修正任务完成后立即断言异步检查点已删除的竞态。全量串行回归278项中277项通过；剩余旧智能体测试在Windows临时目录原子替换文件时遇到 `EPERM rename`，本次未修改业务存储实现。完整回归命令为 `npm.cmd test -- --test-concurrency=1`，本地日志为 `test-sprint2-regression.log`。本次未重跑浏览器测试。

## Sprint 3 专项验证

```sh
node --test test/feedback.test.js test/feedback-api.test.js
npx playwright test e2e/feedback.spec.js
```

领域、服务与真实本地 HTTP 测试覆盖模板/逐题统计、缺凭据发布、创建防重与待核实、映射修复、同步更新与结构变化、导入归属与限制、截止精度、样例隔离、问候直答、并发编辑保护、长输入暂停续跑及输出额度自适应、快照复用、历史依据与音频范围回放。文本模型和问卷服务由夹具替代。

浏览器专项模拟桌面和手机操作，覆盖编辑模板、结束发布、二维码、同步、整体报告、导出与建议导航；检查四个入口的缺密钥向导、坏文件使旧预览失效、等待中输入保护和交接草稿刷新。截图在 `artifacts/sprint3-desktop.png`、`artifacts/sprint3-mobile.png`。

配置引导专项：`npx playwright test e2e/setup.spec.js`。覆盖模型与可选问卷逐项填写、已有密钥保留、缺地址/名称、跳过后的跨页提醒、部分接口失败、冲突后保留输入、取消测试、手机键盘退出、十次重复打开、跨标签完整设置保存、15秒检测超时、恢复提醒和保存响应丢失。全部使用模拟服务；通用浏览器夹具预设两种模拟连接，缺配置场景独立覆盖读取结果。

另在相邻 `outputs/classroom-feedback-api/` 执行 `npm test`，保留原16项并补充响应正文超时、非法成功响应、DELETE空响应和重复游标边界。所有自动验证均不需要真实凭据。

2026-10-21 macOS多轮验证：配置引导轮主应用373项单元/接口测试通过，Chrome完整回归及补跑累计96个场景验证通过；问卷包此前19项测试通过。配置引导新增2项空白凭据检查和12项浏览器场景，日志为 `artifacts/setup-all-unit-final.log`、`artifacts/setup-full-browser.log` 和 `artifacts/setup-browser-rerun.log`，最后一份含首页与全部引导的16项补跑。上一轮26项存储测试和6项浏览器恢复流程见[数据恢复说明](data-recovery.md)；此前 Sprint 1、2 的15项单元/接口测试与5项浏览器测试见[前两阶段记录](sprint12-resilience.md)，反馈故障检查见[多角度记录](multi-angle-validation.md)。千轮重复操作报告为 `artifacts/storage-repetition.json`。反馈专项此前连续两轮26次通过。验收边界见[验证状态](acceptance.md)。

真实链路已使用专用测试问卷与合成课堂资料完成验证，另补测真实模型连续两次写入报告、中间读取以及最终稿追问，范围见[真实联调记录](sprint3-live-validation.md)。准备独立工作区可执行 `node scripts/prepare-feedback-live.mjs --refresh-credentials`，再用独立 `PORT`、`DATA_DIR` 启动服务；该准备脚本复制当前凭据及默认提示词到忽略目录，不启动模型调用。真实联调会调用服务商并可能创建测试表单，记录与截图位于 `artifacts/sprint3-real/`。

## 重复操作与内存专项

```sh
REPETITION_CYCLES=1000 node --expose-gc --max-old-space-size=256 scripts/verify-repetition.mjs
npx playwright test e2e/repetition.spec.js
```

服务探针执行1000轮相同内容操作及100个离线问答任务；浏览器实际载入示例与刷新各210次，另检查编辑器连续点击、慢请求不叠加、搜索合并和失败回听监听器释放。使用隔离夹具，不请求真实模型。修复前后的增长数据、内存指标及规模限制见[专项记录](repetition-validation.md)。本轮报告为 `artifacts/repetition-after-1000.json`、`artifacts/repetition-browser-result.json`。真实新增内容仍会增长，这些有限次数检查不等于任意规模或无限运行保证。

## 本地语音检查

```sh
.venv/bin/python scripts/verify-speech.py
.venv/bin/python scripts/verify-upload-boundaries.py
node scripts/verify-audio-resume.mjs
```

检查范围包括格式解码、无语音、坏文件、视频伪装、时长限制、分段偏移和暂停恢复。结果写入`artifacts/`，不调用在线文本模型。

## 真实模型和人工验证

真实模型验证需要另行配置API，会产生服务商调用费用。`scripts/verify-classroom-summary-synthetic.mjs`使用构造内容和默认提示词测试整课汇总；其它`verify-*-live`脚本可能读写正在运行的工作区，应先阅读脚本并准备专用测试数据。

自动测试不能代替课堂准确性与教学内容检查。物理麦克风、代表性长录音听校及资源压力测试仍须在实际使用环境完成，当前范围见[验证状态](acceptance.md)。

## 课程结构回归

课程与课次是当前入口结构；此前的阶段测试继续验证各能力。`test/courses.test.js`有24项接口/领域测试，`e2e/courses.spec.js`有14项浏览器场景，覆盖隔离、资源库、上传并发及去重、失败释放、跨课次建议、共享额度、归档竞态、非法课次及原资料保护。边界修复、千轮重复操作和界面检查见[专项记录](course-boundary-validation.md)。

2026-10-21本轮复测：主应用397项单元/接口测试、问卷包19项测试通过。三次完整Chrome回归分别通过107、109和最终110项；课程专项14个场景连续三轮共42次通过。原有三阶段与新增课程重复操作探针各执行1000轮，均通过。最终日志为 `artifacts/recheck-unit-final.log`、`artifacts/recheck-browser-complete.log` 和 `artifacts/recheck-courses-final-three-rounds.log`，均使用本地隔离夹具。
