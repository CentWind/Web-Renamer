import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { displayPath, isInsideRoot, realpathSafe, resolveSafe } from './paths.js';
import {
  addJournal,
  clearJournals,
  deleteRuleSet,
  getJournal,
  getRuleSet,
  getSettings,
  listJournals,
  listRuleSets,
  markJournalUndone,
  saveRuleSet,
  setSettings,
} from './db.js';
import { RULE_TYPES, defaultParams } from './rules/schema.js';
import { buildPlan } from './rename/planner.js';
import { applyPlan, undoJournal } from './rename/executor.js';
import { extractMeta } from './rules/meta.js';
import { getWatchState, updateWatcherConfig } from './watcher.js';
import { ScanError, scanDirectory } from './scan.js';
import type { Rule, RuleSet, WatchConfig } from './types.js';

const rulesSchema = z.array(z.any());

function sanitizeRule(raw: any): Rule {
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : randomUUID(),
    type: raw?.type,
    enabled: raw?.enabled !== false,
    label: typeof raw?.label === 'string' ? raw.label : undefined,
    scope: ['name', 'ext', 'full'].includes(raw?.scope) ? raw.scope : 'name',
    params: raw?.params && typeof raw.params === 'object' ? raw.params : {},
  };
}

function sanitizeRuleSet(raw: any): RuleSet {
  const now = new Date().toISOString();
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : randomUUID(),
    name: String(raw?.name ?? '未命名预设').slice(0, 200),
    folder: raw?.folder ? String(raw.folder).slice(0, 120) : null,
    rules: Array.isArray(raw?.rules) ? raw.rules.map(sanitizeRule) : [],
    createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: now,
  };
}

export async function registerRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  /* ------------------------------ 基础信息 ------------------------------ */

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  app.get('/api/config', async () => ({
    roots: config.roots.map((r) => ({ path: r, name: path.basename(r) || r })),
    configDir: config.configDir,
    watch: getWatchState(),
    settings: getSettings(),
  }));

  app.get('/api/rule-types', async () => RULE_TYPES);

  /* ------------------------------ 文件浏览 ------------------------------ */

  app.get('/api/roots', async () => config.roots.map((r) => ({ path: r, name: path.basename(r) || r })));

  app.get('/api/browse', async (req, reply) => {
    const { path: rawPath } = req.query as { path?: string };
    let dir: string;
    try {
      dir = rawPath ? resolveSafe(rawPath, config.roots) : config.roots[0];
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    if (!fs.existsSync(dir)) return reply.code(404).send({ error: '目录不存在' });
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return reply.code(400).send({ error: '不是目录' });

    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
      const full = path.join(dir, d.name);
      let size = 0;
      let mtime = 0;
      try {
        const s = fs.statSync(full);
        size = s.size;
        mtime = s.mtimeMs;
      } catch {
        /* 忽略读取失败的条目 */
      }
      return {
        name: d.name,
        path: full,
        display: displayPath(full, config.roots),
        dir: d.isDirectory(),
        size,
        mtime,
        hidden: d.name.startsWith('.'),
      };
    });

    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1));

    const parent = path.dirname(dir);
    return {
      path: dir,
      display: displayPath(dir, config.roots),
      parent: isInsideRoot(parent, config.roots) && parent !== dir ? parent : null,
      entries,
    };
  });

  /**
   * 递归扫描目录，把目录（含所有子目录）下的文件一次性加入待处理列表。
   * 只读操作；跳过符号链接与特殊文件。
   */
  app.post('/api/scan', async (req, reply) => {
    const body = (req.body ?? {}) as { path?: string; recursive?: boolean; includeHidden?: boolean; limit?: number };
    try {
      return scanDirectory(body.path ?? config.roots[0], config.roots, {
        recursive: body.recursive,
        includeHidden: body.includeHidden,
        limit: body.limit,
      });
    } catch (e: any) {
      const status = e instanceof ScanError ? e.status : 500;
      if (status === 500) app.log.error(e);
      return reply.code(status).send({ error: e?.message ?? '扫描目录失败' });
    }
  });

  app.get('/api/meta', async (req, reply) => {
    const { path: rawPath } = req.query as { path?: string };
    if (!rawPath) return reply.code(400).send({ error: '缺少 path' });
    let abs: string;
    try {
      abs = realpathSafe(rawPath, config.roots);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    const meta = await extractMeta(abs);
    return { path: abs, meta };
  });

  /* ------------------------------ 预览与执行 ------------------------------ */

  app.post('/api/preview', async (req, reply) => {
    const body = req.body as { files?: string[]; rules?: any[] };
    const parsed = rulesSchema.safeParse(body?.rules ?? []);
    if (!parsed.success) return reply.code(400).send({ error: '规则格式不正确' });
    const files = Array.isArray(body?.files) ? body.files : [];
    if (files.length === 0) {
      return { root: config.roots[0], items: [], summary: { total: 0, ok: 0, unchanged: 0, conflict: 0, invalid: 0, canApply: false } };
    }
    const rules = (body.rules as any[]).map(sanitizeRule);
    const result = await buildPlan(files, rules, config.roots);
    return result;
  });

  app.post('/api/apply', async (req, reply) => {
    const body = req.body as { files?: string[]; rules?: any[]; recordHistory?: boolean };
    const files = Array.isArray(body?.files) ? body.files : [];
    if (files.length === 0) return reply.code(400).send({ error: '没有待处理的文件' });
    const rules = (body?.rules ?? []).map(sanitizeRule);
    const plan = await buildPlan(files, rules, config.roots);
    if (plan.summary.conflict > 0 || plan.summary.invalid > 0) {
      return reply.code(409).send({
        error: '存在冲突或非法项，已阻止执行',
        summary: plan.summary,
        items: plan.items.filter((i) => i.status === 'conflict' || i.status === 'invalid'),
      });
    }
    const result = applyPlan(plan.items, plan.root, body.recordHistory !== false);
    return { ...result, plan: { root: plan.root, summary: plan.summary } };
  });

  /* -------------------------------- 历史 -------------------------------- */

  app.get('/api/history', async () => listJournals());

  app.post('/api/history/:id/undo', async (req, reply) => {
    const { id } = req.params as { id: string };
    const journal = getJournal(id);
    if (!journal) return reply.code(404).send({ error: '记录不存在' });
    if (journal.undone) return reply.code(409).send({ error: '该记录已经撤销过' });
    const result = undoJournal(journal.entries);
    markJournalUndone(id);
    return result;
  });

  app.delete('/api/history', async () => {
    clearJournals();
    return { ok: true };
  });

  /* ------------------------------ 规则集 / 预设 ------------------------------ */

  app.get('/api/rulesets', async () => listRuleSets());

  app.get('/api/rulesets/:id', async (req, reply) => {
    const rs = getRuleSet((req.params as any).id);
    if (!rs) return reply.code(404).send({ error: '预设不存在' });
    return rs;
  });

  app.post('/api/rulesets', async (req) => saveRuleSet(sanitizeRuleSet(req.body)));

  app.put('/api/rulesets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = getRuleSet(id);
    if (!existing) return reply.code(404).send({ error: '预设不存在' });
    const data = sanitizeRuleSet({ ...(req.body as any), id });
    return saveRuleSet({ ...data, createdAt: existing.createdAt });
  });

  app.delete('/api/rulesets/:id', async (req) => {
    deleteRuleSet((req.params as any).id);
    return { ok: true };
  });

  /* -------------------------------- 设置 -------------------------------- */

  app.get('/api/settings', async () => getSettings());

  app.put('/api/settings', async (req, reply) => {
    const body = req.body as { theme?: 'dark' | 'light'; watch?: Partial<WatchConfig> };
    const current = getSettings();
    const patch: any = {};
    if (body.theme === 'dark' || body.theme === 'light') patch.theme = body.theme;
    if (body.watch) {
      const watch: WatchConfig = { ...current.watch, ...body.watch };
      // 校验监听路径必须在白名单根目录内
      watch.paths = (watch.paths ?? []).filter((p) => {
        try {
          resolveSafe(p, config.roots);
          return true;
        } catch {
          return false;
        }
      });
      if (watch.ruleSetId && !getRuleSet(watch.ruleSetId)) watch.ruleSetId = null;
      patch.watch = watch;
    }
    const settings = setSettings(patch);
    // 重启监听
    updateWatcherConfig(settings.watch, config.roots);
    return settings;
  });

  /* ------------------------------ 规则模板 ------------------------------ */

  app.get('/api/rule-types/:type/defaults', async (req, reply) => {
    const { type } = req.params as { type: string };
    const meta = RULE_TYPES.find((r) => r.type === type);
    if (!meta) return reply.code(404).send({ error: '未知规则类型' });
    return defaultParams(type as any);
  });
}

/** 供外部（如启动时）复用的导出 */
export { addJournal };
