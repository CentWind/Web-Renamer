import fs from 'node:fs';
import path from 'node:path';
import { applyRules, EvalCtx, RuleError, splitName } from '../rules/engine.js';
import { extractMeta, rulesNeedMeta } from '../rules/meta.js';
import type { PlanItem, Rule } from '../types.js';
import { displayPath, realpathSafe } from '../paths.js';

const ILLEGAL_NAME = /[<>:"/\\|?*\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 稳定的字符串哈希，用于可复现的随机源 */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlanResult {
  root: string;
  items: PlanItem[];
  summary: {
    total: number;
    ok: number;
    unchanged: number;
    conflict: number;
    invalid: number;
    canApply: boolean;
  };
}

export async function buildPlan(files: string[], rules: Rule[], roots: string[]): Promise<PlanResult> {
  const needMeta = rulesNeedMeta(rules);
  const items: PlanItem[] = [];

  // 校验 + 归一化源路径
  const valid: { src: string; dir: string }[] = [];
  for (const f of files) {
    let src: string;
    try {
      src = realpathSafe(f, roots);
    } catch (e: any) {
      items.push({
        src: f,
        dst: f,
        srcName: path.basename(f),
        dstName: path.basename(f),
        status: 'invalid',
        reason: e.message,
      });
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(src);
    } catch {
      items.push({ src, dst: src, srcName: path.basename(src), dstName: path.basename(src), status: 'invalid', reason: '文件不存在' });
      continue;
    }
    if (!stat.isFile()) {
      items.push({ src, dst: src, srcName: path.basename(src), dstName: path.basename(src), status: 'invalid', reason: '不是文件（本工具只处理文件）' });
      continue;
    }
    valid.push({ src, dir: path.dirname(src) });
  }

  // 按目录统计序号
  const dirCount = new Map<string, number>();
  for (const v of valid) dirCount.set(v.dir, (dirCount.get(v.dir) ?? 0) + 1);
  const dirSeen = new Map<string, number>();

  for (let i = 0; i < valid.length; i++) {
    const { src, dir } = valid[i];
    const srcName = path.basename(src);
    dirSeen.set(dir, (dirSeen.get(dir) ?? 0) + 1);

    const ctx: EvalCtx = {
      index: i + 1,
      total: valid.length,
      dirIndex: dirSeen.get(dir)!,
      dirTotal: dirCount.get(dir)!,
      dir: path.basename(dir),
      path: src,
      meta: needMeta ? await extractMeta(src) : {},
      random: mulberry32(hashString(src)),
    };

    let dstName: string;
    try {
      dstName = applyRules(srcName, rules, ctx);
    } catch (e: any) {
      const reason = e instanceof RuleError ? e.message : e.message ?? '规则执行失败';
      items.push({ src, dst: src, srcName, dstName: srcName, status: 'invalid', reason });
      continue;
    }

    const dst = path.join(dir, dstName);

    if (dstName === srcName) {
      items.push({ src, dst, srcName, dstName, status: 'unchanged' });
      continue;
    }

    let reason: string | undefined;
    if (!dstName || dstName === '.' || dstName === '..') reason = '新文件名不能为空';
    else if (ILLEGAL_NAME.test(dstName)) reason = '包含系统不允许的字符 < > : " / \\ | ? *';
    else if (dstName !== dstName.trim() || dstName.endsWith('.')) reason = '文件名不能以空格或点结尾';
    else if (WINDOWS_RESERVED.test(splitName(dstName).name)) reason = '是系统保留名（如 CON、NUL）';

    if (reason) {
      items.push({ src, dst, srcName, dstName, status: 'invalid', reason });
      continue;
    }

    items.push({ src, dst, srcName, dstName, status: 'ok' });
  }

  // 冲突检测：目标名彼此重复，或目标已存在且不是本次的源文件
  const srcSet = new Set(valid.map((v) => v.src.toLowerCase()));
  const dstCount = new Map<string, number>();
  for (const it of items) {
    if (it.status !== 'ok') continue;
    const key = it.dst.toLowerCase();
    dstCount.set(key, (dstCount.get(key) ?? 0) + 1);
  }
  for (const it of items) {
    if (it.status !== 'ok') continue;
    const key = it.dst.toLowerCase();
    if ((dstCount.get(key) ?? 0) > 1) {
      it.status = 'conflict';
      it.reason = '多个文件会被改成同一个名字';
      continue;
    }
    if (fs.existsSync(it.dst) && !srcSet.has(key)) {
      it.status = 'conflict';
      it.reason = '目标文件已存在';
    }
  }

  // 展示用路径：让跨子目录的预览能区分同名文件
  for (const it of items) {
    it.srcDisplay = displayPath(it.src, roots);
    it.dstDisplay = displayPath(it.dst, roots);
  }

  const summary = {
    total: items.length,
    ok: items.filter((i) => i.status === 'ok').length,
    unchanged: items.filter((i) => i.status === 'unchanged').length,
    conflict: items.filter((i) => i.status === 'conflict').length,
    invalid: items.filter((i) => i.status === 'invalid').length,
    canApply: false,
  };
  summary.canApply = summary.ok > 0 && summary.conflict === 0 && summary.invalid === 0;

  // 决定 journal 使用哪个根
  let root = roots[0];
  if (valid.length) {
    for (const r of roots) {
      if (valid.every((v) => v.src.toLowerCase().startsWith(r.toLowerCase()))) {
        root = r;
        break;
      }
    }
  }

  return { root, items, summary };
}
