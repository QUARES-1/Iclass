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
