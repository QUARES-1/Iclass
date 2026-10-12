"""Download existing weights into the project; this does not train a model."""
import os
from pathlib import Path
from huggingface_hub import snapshot_download
root = Path(__file__).resolve().parent.parent
model = os.environ.get('ASR_MODEL_REPO', 'Systran/faster-whisper-small')
target = os.environ.get('ASR_MODEL', str(root / 'data/models/whisper-small'))
snapshot_download(model, local_dir=target, allow_patterns=['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.*', 'preprocessor_config.json'])
print('模型已准备：' + target)
