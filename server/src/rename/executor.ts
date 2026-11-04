import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { addJournal } from '../db.js';
import type { JournalEntry, PlanItem } from '../types.js';

export interface ApplyResult {
  journalId: string | null;
  renamed: JournalEntry[];
  failed: { from: string; to: string; error: string }[];
  /** 是否需要两阶段（交换 / 成环 / 仅改大小写） */
  usedStaging: boolean;
}

/** 执行顺序：deep-first 用于改名（先子后父），shallow-first 用于撤销（先父后子） */
type GroupOrder = 'deep-first' | 'shallow-first';

function pathDepth(p: string): number {
  return p.split(path.sep).filter(Boolean).length;
}

/** 判断同一目录下是否存在「目标与源互相占用」的风险，需要先改到临时名 */
function needsStaging(pairs: JournalEntry[]): boolean {
  const srcSet = new Set(pairs.map((p) => p.from.toLowerCase()));
  for (const p of pairs) {
    const to = p.to.toLowerCase();
    const from = p.from.toLowerCase();
    if (from === to && p.from !== p.to) return true; // 仅大小写不同
    if (srcSet.has(to)) return true; // 目标名撞上其它源（交换 / 成环）
  }
  return false;
}

function tempName(dir: string, original: string, isDir: boolean): string {
  // 文件夹用不带扩展名的临时名，避免与文件扩展名规则混淆
  const ext = isDir ? '' : path.extname(original);
  return path.join(dir, `.wr-tmp-${randomUUID()}${ext}`);
}

/** 执行同一目录下的一批改名 */
function applyGroup(items: PlanItem[]): { renamed: JournalEntry[]; failed: ApplyResult['failed']; staged: boolean } {
  const pairs: JournalEntry[] = items.map((i) => ({ from: i.src, to: i.dst }));
  const failed: ApplyResult['failed'] = [];
  const renamed: JournalEntry[] = [];
  const staging = needsStaging(pairs);

  if (staging) {
    // 阶段一：源 → 临时名（同一目录内，父目录后续才会被改名，因此临时路径在此期间有效）
    const staged: { tmp: string; from: string; to: string }[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      const tmp = tempName(path.dirname(p.from), p.from, items[i].isDir === true);
      try {
        fs.renameSync(p.from, tmp);
        staged.push({ tmp, from: p.from, to: p.to });
      } catch (e: any) {
        failed.push({ from: p.from, to: p.to, error: e.message });
      }
    }
    // 阶段二：临时名 → 目标
    for (const s of staged) {
      try {
        fs.renameSync(s.tmp, s.to);
        renamed.push({ from: s.from, to: s.to });
      } catch (e: any) {
        // 尽力回滚这一项
        try {
          fs.renameSync(s.tmp, s.from);
        } catch {
          /* 回滚失败也无法再做什么 */
        }
        failed.push({ from: s.from, to: s.to, error: e.message });
      }
    }
  } else {
    for (const p of pairs) {
      try {
        fs.renameSync(p.from, p.to);
        renamed.push({ from: p.from, to: p.to });
      } catch (e: any) {
        failed.push({ from: p.from, to: p.to, error: e.message });
      }
    }
  }

  return { renamed, failed, staged: staging };
}

/** 按父目录分组：同目录内处理冲突，目录之间按深度排序（先子目录后父目录 / 反向） */
function applyGroups(items: PlanItem[], order: GroupOrder): {
  renamed: JournalEntry[];
  failed: ApplyResult['failed'];
  staged: boolean;
} {
  const groups = new Map<string, PlanItem[]>();
  for (const it of items) {
    const parent = path.dirname(it.src);
    const arr = groups.get(parent);
    if (arr) arr.push(it);
    else groups.set(parent, [it]);
  }

  const parents = [...groups.keys()].sort((a, b) =>
    order === 'deep-first' ? pathDepth(b) - pathDepth(a) : pathDepth(a) - pathDepth(b),
  );

  const renamed: JournalEntry[] = [];
  const failed: ApplyResult['failed'] = [];
  let staged = false;
  for (const parent of parents) {
    const res = applyGroup(groups.get(parent)!);
    staged = staged || res.staged;
    renamed.push(...res.renamed);
    failed.push(...res.failed);
  }
  return { renamed, failed, staged };
}

export interface ApplyOptions {
  /** 默认 deep-first（先改子项再改父目录）；撤销时用 shallow-first */
  order?: GroupOrder;
}

/**
 * 执行改名计划。只处理 status === 'ok' 的项。
 * 文件和文件夹都支持；同一父目录内的交换 / 成环 / 仅改大小写走两阶段。
 * 跨目录时按深度排序，保证父目录改名不会让子项路径失效。
 */
export function applyPlan(items: PlanItem[], root: string, recordHistory: boolean, options: ApplyOptions = {}): ApplyResult {
  const okItems = items.filter((i) => i.status === 'ok');
  const { renamed, failed, staged } = applyGroups(okItems, options.order ?? 'deep-first');

  let journalId: string | null = null;
  if (recordHistory && renamed.length > 0) {
    journalId = randomUUID();
    addJournal({
      id: journalId,
      root,
      createdAt: new Date().toISOString(),
      entries: renamed,
      undone: false,
    });
  }

  return { journalId, renamed, failed, usedStaging: staged };
}

/** 撤销一次改名：把 to 改回 from（父目录先还原，再还原里面的子项） */
export function undoJournal(entries: JournalEntry[]): ApplyResult {
  const reversed: PlanItem[] = entries.map((e) => ({
    src: e.to,
    dst: e.from,
    srcName: path.basename(e.to),
    dstName: path.basename(e.from),
    status: 'ok',
  }));
  return applyPlan(reversed, '', false, { order: 'shallow-first' });
}
