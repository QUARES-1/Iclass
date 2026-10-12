# 部署说明

## 平台与下载项

已验证平台是macOS 15.7、Apple Silicon，CPU推理。Linux需要在目标机器验证；Windows原生音频处理还需要适配，当前Python进程路径和[resource资源统计](https://docs.python.org/3/library/resource.html)使用Unix接口。部署命令以下述macOS环境为准。

安装[Node.js 24 LTS](https://nodejs.org/en/download)、[Python 3.11](https://www.python.org/downloads/)和[Google Chrome](https://www.google.com/chrome/)。项目的Node最低要求是20.12，建议新环境使用受支持的LTS版本。

已安装Homebrew的macOS用户可用`brew install python@3.11`准备Python，安装说明见[对应formula](https://formulae.brew.sh/formula/python@3.11)。

`npm ci`下载JavaScript依赖，包括Playwright和OpenCC。Python依赖负责音频解码、FFmpeg转换和faster-whisper识别，模型准备脚本另外下载Whisper small权重，约0.5 GB。不需要数据库、Docker或独立文本模型权重。

默认CPU推理，无需CUDA。FFmpeg可执行文件由[imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg)的pip发行包提供，音频解码使用PyAV。识别组件说明见[faster-whisper](https://github.com/SYSTRAN/faster-whisper)。

## 安装并启动

在仓库根目录执行：

```sh
cd outputs/classroom-quality-agent
npm ci
python3.11 -m venv .venv
.venv/bin/python -m pip install -r speech/requirements.lock.txt
npm run speech:prepare
npm start
```

上述Python锁文件记录实测依赖组合。更换平台后如果缺少对应wheel，需要在该平台处理安装问题并重新验证。

进入http://127.0.0.1:3000。服务首次启动会按使用需要创建`data/`，开始时没有个人课件、录音或配置。“载入本地示例”可用于体验资源预览、编辑和导出。

正常使用不需要执行测试准备或下载测试录音。使用音频功能前应完成Python依赖和模型准备。

## 配置文本模型

进入“模型与提示词设置”：

1. 填写服务商API基础地址、实际可用的模型名称和API Key。
2. 按模型能力设置最大输出token、超时、输入额度及任务预算。
3. 测试连接，再保存配置。

配置保存在`data/model-settings.json`，后续请求生效，密钥不回显。API需要联网，并具有可用额度。初始最大输出为8000 token，例如需要32768时应在设置页填写并确认服务商支持；本机已有配置不会随源码转移。

也可以用环境文件初始化：

```sh
cp .env.example .env
```

编辑`.env`填写连接参数，勿把密钥写入README、源码或教学对话。界面保存的配置优先于环境文件。修改`.env`或服务运行参数后重启，界面保存的模型配置无需重启。

## 可选运行参数

| 参数 | 默认值 / 作用 |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000`，本机监听 |
| `DATA_DIR` | 项目`data/`，不得放在`public/`内 |
| `PYTHON_BIN` | 优先`.venv/bin/python`，否则`python3` |
| `ASR_MODEL` | `data/models/whisper-small/` |
| `ASR_DEVICE` / `ASR_COMPUTE_TYPE` | `cpu` / `int8` |
| `ASR_THREADS` / `ASR_CHUNK_SECONDS` | `4` / `180` |
| `ASR_TASK_TIMEOUT_MS` | `7200000`，转写任务时限 |
| `AUDIO_MAX_BYTES` / `AUDIO_MAX_SECONDS` | `536870912` / `10800` |
| `PREVIEW_BROWSER` | `chrome`，后端互动运行检查 |
| `FFMPEG_PATH` | 留空使用imageio-ffmpeg提供的可执行文件 |

模型准备脚本读取进程环境变量。使用自定义模型目录时，下载和服务配置须指向同一目录，例如：

```sh
ASR_MODEL=/absolute/path/to/whisper-small .venv/bin/python speech/prepare.py
```

不安装Chrome时，可另行下载Playwright Chromium，并在`.env`配置`PREVIEW_BROWSER=chromium`：

```sh
npx playwright install chromium
```

浏览器自动测试仍默认使用Chrome。Linux运行浏览器还可能需要系统依赖，需要按目标环境准备。

C++编译器仅用于可选语法检查，缺少编译器不会阻止基本工作台运行。PPTX正文使用宋体，代码使用Consolas；字体不随项目提供，打开课件的电脑缺少字体时会发生替换。

## 保存、迁移与排查

停止服务使用`Ctrl+C`。迁移电脑时备份`data/`及实际使用的`.env`；模型可以随数据备份，也可以在新机重新下载。个人数据不在Git仓库内，首次下载的用户不会得到其它人的密钥、录音或课件。

| 现象 | 检查 |
| --- | --- |
| 页面无法打开 | 确认已在应用目录执行`npm start`，检查端口是否占用 |
| 模型请求失败 | 在设置页检查API地址、模型、密钥、服务额度和超时 |
| 找不到本地语音模型 | 检查模型目录并执行`npm run speech:prepare` |
| Python进程无法启动 | 检查Python 3.11、`.venv`、依赖和`PYTHON_BIN` |
| 互动运行检查失败 | 检查Chrome安装，或准备Chromium并设置运行参数 |
| 录音权限被拒绝 | 用本机地址打开页面，在浏览器允许麦克风，或上传文件 |
| 版本冲突 | 保留当前输入，重新载入最新状态后重试 |
| 识别错字 | 回听原音频、保存校正版，再更新报告 |
| 任务暂停或中断 | 输入未变化时点击继续；输入已变化时启动新任务 |
