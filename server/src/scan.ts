/**
 * 目录扫描 —— 递归收集可重命名的文件。
 *
 * 设计目标：
 *  - 只读：不修改任何文件；
 *  - 安全：基于白名单根目录校验，跳过符号链接与特殊文件，避免逃逸根目录或成环；
 *  - 可控：支持隐藏文件开关、递归开关、数量上限，结果按相对路径稳定排序。
 */
import fs from 'node:fs';
import path from 'node:path';
import { displayPath, realpathSafe } from './paths.js';

export interface ScanFile {
  /** 绝对路径 */
  path: string;
  /** 文件名（不含目录） */
  name: string;
  /** 相对扫描目录的路径，统一用 / 分隔，例如 `2024/01/a.jpg` */
  rel: string;
  size: number;
  mtime: number;
  /** 展示路径（含根目录名），例如 `photos/2024/01/a.jpg` */
  display: string;
  /** 是否为文件夹（includeDirs=true 时可能出现） */
  isDir?: boolean;
}

export interface ScanResult {
  /** 被扫描的目录（绝对路径） */
  path: string;
  /** 展示用目录路径（含根目录名） */
  display: string;
  recursive: boolean;
  includeHidden: boolean;
  limit: number;
  files: ScanFile[];
  /** 跳过的符号链接 / 特殊文件 / 无权限条目数 */
  skipped: number;
  /** 因是隐藏文件/目录而未添加的条目数 */
  hiddenSkipped: number;
  /** 是否包含文件夹 */
  includeDirs: boolean;
  /** 是否因为达到 limit 上限而截断 */
  truncated: boolean;
}

export class ScanError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
    this.name = 'ScanError';
  }
}

export const SCAN_DEFAULT_LIMIT = 20000;
export const SCAN_MAX_LIMIT = 50000;

export interface ScanOptions {
  /** 默认 true：包含子目录 */
  recursive?: boolean;
  /** 默认 false：跳过以 . 开头的文件/目录 */
  includeHidden?: boolean;
  /** 默认 false：是否把文件夹本身也加入结果（用于重命名文件夹） */
  includeDirs?: boolean;
  /** 最多收集多少个文件，默认 20000，上限 50000 */
  limit?: number;
}

export function scanDirectory(rawPath: string | undefined, roots: string[], options: ScanOptions = {}): ScanResult {
  const recursive = options.recursive !== false;
  const includeHidden = options.includeHidden === true;
  const includeDirs = options.includeDirs === true;
  const parsedLimit = Math.trunc(Number(options.limit ?? SCAN_DEFAULT_LIMIT));
  const limit = Math.min(Math.max(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : SCAN_DEFAULT_LIMIT, 1), SCAN_MAX_LIMIT);

  let dir: string;
  try {
    dir = realpathSafe(rawPath ?? roots[0], roots);
  } catch (e: any) {
    throw new ScanError(e?.message ?? '目录路径不合法', 400);
  }
  if (!fs.existsSync(dir)) throw new ScanError('目录不存在', 404);
  if (!fs.statSync(dir).isDirectory()) throw new ScanError('不是目录', 400);

  const files: ScanFile[] = [];
  let skipped = 0;
  let hiddenSkipped = 0;
  let truncated = false;

  // 迭代式深度优先，避免深层目录爆栈；用真实路径去重防目录成环
  const stack: { dir: string; rel: string; real: string }[] = [];
  try {
    stack.push({ dir, rel: '', real: fs.realpathSync.native(dir) });
  } catch {
    stack.push({ dir, rel: '', real: dir });
  }
  const visited = new Set<string>();

  while (stack.length > 0 && !truncated) {
    const cur = stack.pop()!;
    if (visited.has(cur.real)) continue;
    visited.add(cur.real);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      skipped++;
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

    for (const d of entries) {
      if (truncated) break;
      const full = path.join(cur.dir, d.name);
      const rel = cur.rel ? `${cur.rel}/${d.name}` : d.name;

      if (d.name.startsWith('.') && !includeHidden) {
        // 隐藏目录不展开，隐藏文件不加入；只计数，不报错
        if (d.isDirectory() || d.isFile()) hiddenSkipped++;
        continue;
      }
      // 符号链接一律跳过：既避免逃逸根目录，也避免环和重复计数
      if (d.isSymbolicLink()) {
        skipped++;
        continue;
      }
      if (d.isDirectory()) {
        // 需要重命名文件夹时，把目录本身也加入结果（根目录除外）
        if (includeDirs) {
          if (files.length >= limit) {
            truncated = true;
            break;
          }
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch {
            /* 忽略 */
          }
          files.push({ path: full, name: d.name, rel, size: 0, mtime, display: displayPath(full, roots), isDir: true });
        }
        if (!recursive) continue;
        let real: string;
        try {
          real = fs.realpathSync.native(full);
        } catch {
          skipped++;
          continue;
        }
        if (visited.has(real)) continue;
        stack.push({ dir: full, rel, real });
        continue;
      }
      if (!d.isFile()) {
        skipped++;
        continue;
      }
      if (files.length >= limit) {
        truncated = true;
        break;
      }
      let size = 0;
      let mtime = 0;
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        skipped++;
        continue;
      }
      files.push({ path: full, name: d.name, rel, size, mtime, display: displayPath(full, roots) });
    }
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));

  return {
    path: dir,
    display: displayPath(dir, roots),
    recursive,
    includeHidden,
    includeDirs,
    limit,
    files,
    skipped,
    hiddenSkipped,
    truncated,
  };
}
