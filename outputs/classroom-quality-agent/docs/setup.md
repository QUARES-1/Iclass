# 部署说明

## 平台与下载项

历史完整验收平台是macOS 15.7、Apple Silicon，CPU推理。语音进程现按平台选择虚拟环境：Windows 使用 `.venv/Scripts/python.exe`，macOS/Linux 使用 `.venv/bin/python`，显式 `PYTHON_BIN` 配置优先。语音输出和检查点统一使用 UTF-8；Windows 不提供 Unix `resource` 内存统计，`peakResidentBytes` 为 null，不影响识别。Linux仍需要在目标机器验证。下述 shell 命令以macOS为例。

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

Windows PowerShell 可执行以下命令（无需激活虚拟环境）：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r speech/requirements.txt
npm.cmd run speech:prepare
npm.cmd start
```

`npm run speech:prepare` 在两个平台上使用同一解释器选择逻辑，并读取项目 `.env` 中的模型下载目录配置。不要将某台机器的绝对 `PYTHON_BIN` 路径复制到另一台机器；通常留空即可。每台机器分别创建虚拟环境和准备模型，`.venv` 不应跨系统复制。

运行时保留相邻 `outputs/classroom-feedback-api/`，主应用直接复用其问卷客户端和定义，无需启动第二个服务或另行安装其依赖。

进入http://127.0.0.1:3000。服务首次启动会按使用需要创建`data/`，开始时没有个人课件、录音或配置。“载入本地示例”可用于体验资源预览、编辑和导出。各工作台都会检查模型API地址、模型名称和密钥，缺失或格式不符时弹出向导；首页与反馈页同时检查可选的金数据API地址与Access Token。已有密钥留空即可保留。跳过后本标签内不再反复弹出，顶部保留“补齐配置”按钮。

检测只读取本机配置，不自动发送付费模型请求；凭据是否有效、余额是否充足需点击“测试连接”确认。测试不会保存，可取消等待。读取失败时可重新检测；遇到其他页面的配置冲突，重新检测会更新版本并保留本次输入。完整设置页保存后，其他打开的工作台会更新配置提醒；正在填写的向导不会被后台刷新覆盖。

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

金数据连接使用独立 Access Token，在设置页测试并保存，也可使用 `JINSHUJU_ACCESS_TOKEN` 和 `JINSHUJU_BASE_URL` 初始化。缺少凭据时，反馈导入、模板与统计仍可使用，在线发布和同步保留明确错误。已在专用账户和问卷上完成真实链路验证，范围见[真实联调记录](sprint3-live-validation.md)。

| 参数 | 默认值 / 作用 |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000`，本机监听 |
| `DATA_DIR` | 项目`data/`，不得放在`public/`内 |
| `DATA_MAX_BYTES` | `5368709120`，业务数据5 GiB额度，包含录音、恢复副本和归档，模型权重除外 |
| `PYTHON_BIN` | 显式配置优先；否则使用本平台`.venv`，Windows回退`python`，macOS/Linux回退`python3` |
| `ASR_MODEL` | `data/models/whisper-small/` |
| `ASR_DEVICE` / `ASR_COMPUTE_TYPE` | `cpu` / `int8` |
| `ASR_THREADS` / `ASR_CHUNK_SECONDS` | `4` / `180` |
| `ASR_TASK_TIMEOUT_MS` | `7200000`，转写任务时限 |
| `AUDIO_MAX_BYTES` / `AUDIO_MAX_SECONDS` | `536870912` / `10800` |
| `PREVIEW_BROWSER` | `chrome`，后端互动运行检查 |
| `FFMPEG_PATH` | 留空使用imageio-ffmpeg提供的可执行文件 |
| `FEEDBACK_API_INTERVAL_MS` | `1000`，所有问卷请求共用队列的最小起始间隔，创建优先；允许0～60000 |
| `FEEDBACK_MAX_IMPORT_BYTES` | `4194304`，最多5242880；JSON外层请求仍受6 MiB限制 |
| `FEEDBACK_MAX_RECORDS` | `10000`，每课堂反馈及单次同步/导入上限，最多50000 |
| `FEEDBACK_MAX_TEXT` | `4000`，单题文本回答字符数，最多20000 |
| `FEEDBACK_MAX_QUESTIONS` / `FEEDBACK_MAX_OPTIONS` | `80` / `80`，模板题数及单题选项数，各最多200 |

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

备份时保留隐藏目录 `.recovery/` 和 `.archives/`。设置页可管理空间、归档及补回历史；记录损坏时尝试恢复上一份有效保存，来源变化的浏览器草稿由教师选择恢复，详见[数据与恢复](data-recovery.md)。

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
