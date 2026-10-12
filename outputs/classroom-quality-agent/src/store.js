import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(message, statusCode = 422) { super(message); this.statusCode = statusCode; }
}
export const id = () => randomUUID();
export const clone = value => structuredClone(value);

// Serializes read-modify-write per document. Revision checks also cover concurrent tabs.
export class Store {
  constructor(root) { this.root = path.resolve(root); this.queues = new Map(); }
  file(key) {
    if (!/^[a-z0-9-]+$/i.test(key)) throw new AppError('无效记录 ID。', 400);
    return path.join(this.root, key + '.json');
  }
  async read(key, fallback) {
    try { return JSON.parse(await readFile(this.file(key), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return clone(fallback); throw error; }
  }
  async update(key, revision, fallback, change, { skipUnchanged = false } = {}) {
    const previous = this.queues.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const current = await this.read(key, fallback);
      if (revision !== undefined && revision !== current.revision) throw new AppError('内容已在其他操作中更新，请刷新后重试；本次未覆盖任何成果。', 409);
      const next = await change(clone(current));
      if (skipUnchanged && JSON.stringify(next) === JSON.stringify(current)) return current;
      if (Buffer.byteLength(JSON.stringify(next)) > 100 * 1024 * 1024) throw new AppError('保存记录超过 100 MB，请删除不再需要的资源后重试。', 413);
      next.revision = current.revision + 1;
      next.savedAt = new Date().toISOString();
      await mkdir(this.root, { recursive: true });
      const temp = this.file(key) + '.' + id() + '.tmp';
      try { await writeFile(temp, JSON.stringify(next), { mode: 0o600 }); await rename(temp, this.file(key)); }
      finally { await rm(temp, { force: true }); }
      return next;
    });
    this.queues.set(key, task);
    task.finally(() => { if (this.queues.get(key) === task) this.queues.delete(key); }).catch(() => {});
    return task;
  }
}
