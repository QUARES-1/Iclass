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
