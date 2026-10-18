import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pythonExecutable, pythonEnvironment } from '../src/python.js';

const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const result = spawnSync(pythonExecutable(root), [path.join(root, 'speech/prepare.py')], {
  cwd: root, env: pythonEnvironment(), stdio: 'inherit',
});
if (result.error) console.error('Python could not start: ' + result.error.message);
process.exitCode = result.status ?? 1;
