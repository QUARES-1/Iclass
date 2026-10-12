#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Whisper 语音转写脚本（Sprint 2 课中课堂感知）。

优先使用 faster-whisper（轻量、支持 Python 3.13、速度快），
未安装时自动回退到 openai-whisper；两者都未安装则输出错误 JSON。

用法：
    python transcribe.py <音频/视频文件> [--model small] [--language zh] [--device cpu] [--compute int8]

输出（JSON，标准输出）：
    {"text": "完整转写文本", "segments": [{"start": 0.0, "end": 5.5, "text": "..."}]}
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))

# 国内网络默认走 HuggingFace 镜像下载模型（已设置的环境变量优先，不会被覆盖）
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# 强制 stdout/stderr 用 UTF-8 输出，避免 Windows 管道默认 GBK 导致 Node 读到乱码
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass


def emit_error(code, message):
    print(json.dumps({"error": code, "message": message}, ensure_ascii=True))
    sys.exit(0)


def resolve_model_arg(model_name):
    """优先使用本地已下载好的模型目录，否则退回模型名（触发在线下载）。"""
    local_dir = os.path.join(ROOT, "models", "faster-whisper-%s" % model_name)
    if os.path.isdir(local_dir) and os.listdir(local_dir):
        return local_dir
    return model_name


def run_faster_whisper(file, model_name, language, device, compute):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None
    try:
        model_arg = resolve_model_arg(model_name)
        model = WhisperModel(model_arg, device=device, compute_type=compute)
        segments, _info = model.transcribe(file, language=language or None, beam_size=5)
        seg_list = []
        full_text = []
        for seg in segments:
            text = (seg.text or "").strip()
            if not text:
                continue
            seg_list.append({"start": round(float(seg.start), 2), "end": round(float(seg.end), 2), "text": text})
            full_text.append(text)
        return {"text": "".join(full_text).strip(), "segments": seg_list}
    except Exception as exc:  # noqa: BLE001
        emit_error(
            "transcribe-failed",
            "faster-whisper 转写失败：%s（请先运行 python download_model.py 下载模型；若为模型下载失败，国内请先执行 set HF_ENDPOINT=https://hf-mirror.com）" % exc,
        )


def run_openai_whisper(file, model_name, language):
    try:
        import whisper
    except ImportError:
        return None
    try:
        model = whisper.load_model(model_name)
    except Exception as exc:  # noqa: BLE001
        emit_error("model-load-failed", "openai-whisper 加载模型失败：%s（首次运行会自动下载模型）" % exc)
    try:
        result = model.transcribe(file, language=language or None)
    except Exception as exc:  # noqa: BLE001
        emit_error("transcribe-failed", "openai-whisper 转写失败：%s（请确认已安装 ffmpeg）" % exc)
    segments = [
        {"start": round(float(s.get("start", 0)), 2), "end": round(float(s.get("end", 0)), 2), "text": (s.get("text") or "").strip()}
        for s in result.get("segments", [])
        if (s.get("text") or "").strip()
    ]
    return {"text": (result.get("text") or "").strip(), "segments": segments}


def main():
    parser = argparse.ArgumentParser(description="Whisper 语音转写")
    parser.add_argument("file", help="音频或视频文件路径")
    parser.add_argument("--model", default="small", help="模型：tiny/base/small/medium/large(-v3)")
    parser.add_argument("--language", default="zh", help="语言代码，默认中文 zh")
    parser.add_argument("--device", default="cpu", help="faster-whisper 运行设备：cpu/cuda")
    parser.add_argument("--compute", default="int8", help="faster-whisper 计算精度：int8/float16/float32")
    args = parser.parse_args()

    result = run_faster_whisper(args.file, args.model, args.language, args.device, args.compute)
    if result is not None:
        print(json.dumps(result, ensure_ascii=True))
        return

    result = run_openai_whisper(args.file, args.model, args.language)
    if result is not None:
        print(json.dumps(result, ensure_ascii=True))
        return

    emit_error(
        "whisper-not-installed",
        "未安装任何 Whisper 实现。请执行：pip install faster-whisper -i https://pypi.tuna.tsinghua.edu.cn/simple。",
    )


if __name__ == "__main__":
    main()