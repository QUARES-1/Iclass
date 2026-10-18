import path from 'node:path';
import { existsSync } from 'node:fs';

export function pythonExecutable(root, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (env.PYTHON_BIN) return env.PYTHON_BIN;
  const local = path.join(root, platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  return exists(local) ? local : platform === 'win32' ? 'python' : 'python3';
}

export const pythonEnvironment = (env = process.env) => ({
  ...env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
});
