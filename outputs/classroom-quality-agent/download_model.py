#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""预下载 Whisper 模型（优先 hf-mirror，失败自动切换 ModelScope 魔搭）。

用法：
    python download_model.py                 # 默认 small（约 460MB）
    python download_model.py --model base    # 约 145MB，精度略低
    python download_model.py --model tiny    # 约 75MB，精度最低但最快
"""
import argparse
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")


def try_hf(model, device, compute):
    import time
    from faster_whisper import WhisperModel
    for attempt in range(1, 5):
        try:
            WhisperModel(model, device=device, compute_type=compute)
            return True
        except Exception as e:  # noqa: BLE001
            print("  [hf-mirror] 第 %d 次失败：%s" % (attempt, str(e)[:180]))
            if attempt < 4:
                wait = 3 * attempt
                print("  %d 秒后自动重试…" % wait)
                time.sleep(wait)
    return False


def try_modelscope(model):
    try:
        from modelscope import snapshot_download
    except ImportError:
        try:
            from modelscope.hub.snapshot_download import snapshot_download
        except ImportError:
            return None

    dest = os.path.join(ROOT, "models", "faster-whisper-%s" % model)
    os.makedirs(dest, exist_ok=True)
    candidates = [
        "AI-ModelScope/Systran--faster-whisper-%s" % model,
        "Systran/faster-whisper-%s" % model,
        "keepitsimple/faster-whisper-%s" % model,
    ]
    for cid in candidates:
        try:
            print("  [modelscope] 尝试下载 %s …" % cid)
            src = snapshot_download(cid)
            copied = 0
            for name in os.listdir(src):
                s = os.path.join(src, name)
                if os.path.isfile(s):
                    shutil.copy2(s, os.path.join(dest, name))
                    copied += 1
            if copied > 0:
                print("  [modelscope] 成功，已复制 %d 个文件到 %s" % (copied, dest))
                return dest
        except Exception as e:  # noqa: BLE001
            print("  [modelscope] %s 失败：%s" % (cid, str(e)[:180]))
    return None


def main():
    parser = argparse.ArgumentParser(description="预下载 Whisper 模型")
    parser.add_argument("--model", default="small", help="tiny/base/small/medium")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute", default="int8")
    args = parser.parse_args()

    print("目标模型：%s" % args.model)
    print("第 1 步：尝试从 hf-mirror.com 下载（带自动重试）…")
    if try_hf(args.model, args.device, args.compute):
        print("")
        print("模型下载完成（hf-mirror）！现在回到网页重新上传音频即可转写。")
        return

    print("")
    print("hf-mirror 多次失败，改用 ModelScope（阿里云）下载…")
    dest = try_modelscope(args.model)
    if dest:
        print("")
        print("模型已下载到本地目录：%s" % dest)
        print("现在回到网页重新上传音频即可转写（无需联网）。")
        return

    print("")
    print("两种方式都失败了。请检查网络后重试，或把上面完整报错发给我。")
    sys.exit(1)


if __name__ == "__main__":
    main()