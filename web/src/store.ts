import { create } from 'zustand';
import { ApiError, api } from './api';
import type {
  AppConfig,
  AuthMe,
  AuthStatus,
  BrowseResult,
  Journal,
  PlanResult,
  QueueItem,
  Rule,
  RuleSet,
  RuleTypeMeta,
  RuleType,
  Scope,
  Settings,
  WatchConfig,
} from './types';

export type ToastKind = 'success' | 'error' | 'info';
export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

/** 可以加入待处理列表的条目（浏览条目或扫描结果） */
export interface AddableEntry {
  path: string;
  name: string;
  size: number;
  /** 展示路径；缺省时回退为文件名 */
  display?: string;
}

let toastSeq = 0;
const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const scopeOf = (meta?: RuleTypeMeta): Scope => (meta?.scope ? 'name' : 'name');

interface State {
  ready: boolean;
  config: AppConfig | null;
  ruleTypes: RuleTypeMeta[];
  settings: Settings | null;
  theme: 'dark' | 'light';

  // 登录
  auth: AuthStatus | null;
  me: AuthMe | null;
  loggingIn: boolean;
  browse: BrowseResult | null;
  browsing: boolean;
  loadingDir: string | null;
  /** 正在递归扫描目录 */
  scanningDirectory: boolean;

  queue: QueueItem[];
  rules: Rule[];
  presetId: string | null;
  presetName: string;
  presets: RuleSet[];

  preview: PlanResult | null;
  previewing: boolean;

  history: Journal[];

  toasts: Toast[];

  // actions
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string; retryAfterSec?: number }>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  changeCredentials: (body: {
    currentPassword: string;
    username?: string;
    newPassword?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  handleUnauthorized: () => void;
  navigate: (path?: string) => Promise<void>;
  addEntries: (entries: AddableEntry[]) => void;
  /** 递归扫描目录（含所有子目录）并加入待处理列表，返回新增文件数 */
  addDirectory: (targetPath?: string) => Promise<number>;
  removeFromQueue: (path: string) => void;
  clearQueue: () => void;

  addRule: (type: RuleType) => void;
  replaceRules: (rules: Rule[]) => void;
  updateRule: (id: string, patch: Partial<Rule>) => void;
  updateParam: (id: string, key: string, value: any) => void;
  moveRule: (id: string, dir: -1 | 1) => void;
  duplicateRule: (id: string) => void;
  removeRule: (id: string) => void;

  runPreview: () => Promise<void>;
  applyNow: () => Promise<void>;
  undo: (id: string) => Promise<void>;
  refreshHistory: () => Promise<void>;
  clearHistory: () => Promise<void>;

  refreshPresets: () => Promise<void>;
  newRuleSet: () => void;
  openPreset: (id: string) => void;
  savePreset: (name: string, folder: string | null) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  duplicatePreset: () => Promise<void>;

  setTheme: (theme: 'dark' | 'light') => Promise<void>;
  saveWatch: (patch: Partial<WatchConfig>) => Promise<void>;

  toast: (kind: ToastKind, message: string) => void;
  dismissToast: (id: string) => void;
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  config: null,
  ruleTypes: [],
  settings: null,
  theme: 'dark',

  auth: null,
  me: null,
  loggingIn: false,

  browse: null,
  browsing: false,
  loadingDir: null,
  scanningDirectory: false,

  queue: [],
  rules: [],
  presetId: null,
  presetName: '未命名预设',
  presets: [],

  preview: null,
  previewing: false,
  history: [],
  toasts: [],

  async bootstrap() {
    try {
      // 先确认登录态：未登录时只渲染登录页，不拉业务数据
      const auth = await api.getAuthStatus();
      set({ auth });
      if (!auth.authenticated) {
        // 登录页也要用配置里的主题
        document.documentElement.classList.toggle('dark', get().theme === 'dark');
        set({ ready: true });
        return;
      }
      const [config, ruleTypes, presets, history] = await Promise.all([
        api.getConfig(),
        api.getRuleTypes(),
        api.getRuleSets(),
        api.getHistory(),
      ]);
      const theme = config.settings.theme ?? 'dark';
      document.documentElement.classList.toggle('dark', theme === 'dark');
      set({ config, ruleTypes, presets, history, settings: config.settings, theme, ready: true });
      void get().refreshMe();
      await get().navigate(config.roots[0]?.path);
    } catch (e: any) {
      set({ ready: true });
      get().toast('error', `初始化失败：${e.message}`);
    }
  },

  async login(username, password) {
    set({ loggingIn: true });
    try {
      const res = await api.login(username, password);
      set({
        auth: { authenticated: true, username: res.username, defaultCredentials: res.isDefault },
      });
      await get().bootstrap();
      if (res.isDefault) {
        get().toast('info', '当前仍是默认密码，建议在右上角「账号」里尽快修改');
      }
      return { ok: true };
    } catch (e: any) {
      const retryAfterSec = e instanceof ApiError ? e.payload?.retryAfterSec : undefined;
      return { ok: false, error: e.message, retryAfterSec };
    } finally {
      set({ loggingIn: false });
    }
  },

  async logout() {
    try {
      await api.logout();
    } catch {
      /* 会话可能已失效，忽略 */
    }
    set({ auth: { authenticated: false, username: null, defaultCredentials: false }, me: null });
    // 清掉业务态，避免下一个登录者看到上一个账号的数据
    set({
      config: null,
      queue: [],
      rules: [],
      presets: [],
      preview: null,
      history: [],
      browse: null,
      presetId: null,
      presetName: '未命名预设',
    });
  },

  async refreshMe() {
    try {
      set({ me: await api.getMe() });
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 401) get().handleUnauthorized();
    }
  },

  async changeCredentials(body) {
    try {
      const res = await api.updateCredentials({ ...body, logoutOtherSessions: true });
      set({ auth: { authenticated: true, username: res.username, defaultCredentials: false } });
      await get().refreshMe();
      return { ok: true };
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 401) {
        // 改密接口返回 401 属于「当前密码错误」，不能当成掉线
        return { ok: false, error: e.message };
      }
      return { ok: false, error: e.message };
    }
  },

  handleUnauthorized() {
    set({ auth: { authenticated: false, username: null, defaultCredentials: false }, me: null });
    get().toast('error', '登录已失效，请重新登录');
  },

  async navigate(path) {
    set({ browsing: true, loadingDir: path ?? null });
    try {
      const res = await api.browse(path);
      set({ browse: res });
    } catch (e: any) {
      get().toast('error', e.message);
    } finally {
      set({ browsing: false, loadingDir: null });
    }
  },

  addEntries(entries) {
    const { queue } = get();
    const map = new Map(queue.map((q) => [q.path, q]));
    for (const e of entries) {
      map.set(e.path, {
        path: e.path,
        name: e.name,
        size: e.size,
        dir: e.path.slice(0, Math.max(0, e.path.length - e.name.length - 1)),
        display: e.display ?? e.name,
      });
    }
    set({ queue: [...map.values()] });
  },

  async addDirectory(targetPath) {
    const path = targetPath ?? get().browse?.path ?? get().config?.roots[0]?.path;
    if (!path) return 0;
    if (get().scanningDirectory) return 0;
    set({ scanningDirectory: true });
    try {
      const res = await api.scan(path, { recursive: true });
      if (res.files.length === 0) {
        get().toast('info', '该目录及子目录下没有可添加的文件');
        return 0;
      }
      get().addEntries(res.files);
      const extra: string[] = [];
      if (res.hiddenSkipped > 0) extra.push(`${res.hiddenSkipped} 个隐藏文件未添加`);
      if (res.skipped > 0) extra.push(`${res.skipped} 个符号链接/无法访问的文件已跳过`);
      if (res.truncated) extra.push(`已达 ${res.limit} 个上限，请分批处理`);
      get().toast(
        'success',
        `已递归添加 ${res.files.length} 个文件${extra.length ? `（${extra.join('，')}）` : ''}`,
      );
      return res.files.length;
    } catch (e: any) {
      get().toast('error', `扫描目录失败：${e.message}`);
      return 0;
    } finally {
      set({ scanningDirectory: false });
    }
  },

  removeFromQueue(path) {
    set({ queue: get().queue.filter((q) => q.path !== path) });
  },

  clearQueue() {
    set({ queue: [], preview: null });
  },

  addRule(type) {
    const meta = get().ruleTypes.find((r) => r.type === type);
    const rule: Rule = {
      id: uid(),
      type,
      enabled: true,
      scope: meta && !meta.scope ? 'name' : scopeOf(meta),
      params: { ...(meta?.defaults ?? {}) },
    };
    set({ rules: [...get().rules, rule] });
  },

  replaceRules(rules) {
    set({ rules });
  },

  updateRule(id, patch) {
    set({ rules: get().rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  },

  updateParam(id, key, value) {
    set({
      rules: get().rules.map((r) =>
        r.id === id ? { ...r, params: { ...r.params, [key]: value } } : r,
      ),
    });
  },

  moveRule(id, dir) {
    const rules = [...get().rules];
    const i = rules.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= rules.length) return;
    [rules[i], rules[j]] = [rules[j], rules[i]];
    set({ rules });
  },

  duplicateRule(id) {
    const rules = [...get().rules];
    const i = rules.findIndex((r) => r.id === id);
    if (i < 0) return;
    const copy = { ...rules[i], id: uid(), params: { ...rules[i].params } };
    rules.splice(i + 1, 0, copy);
    set({ rules });
  },

  removeRule(id) {
    set({ rules: get().rules.filter((r) => r.id !== id) });
  },

  async runPreview() {
    const { queue, rules } = get();
    if (queue.length === 0) {
      set({ preview: null });
      return;
    }
    set({ previewing: true });
    try {
      const res = await api.preview(
        queue.map((q) => q.path),
        rules,
      );
      set({ preview: res });
    } catch (e: any) {
      get().toast('error', `预览失败：${e.message}`);
    } finally {
      set({ previewing: false });
    }
  },

  async applyNow() {
    const { queue, rules, preview } = get();
    if (!preview || !preview.summary.canApply) {
      get().toast('error', '当前没有可执行的项目');
      return;
    }
    try {
      const res = await api.apply(
        queue.map((q) => q.path),
        rules,
      );
      if (res.failed.length > 0) {
        get().toast('error', `完成 ${res.renamed.length} 个，失败 ${res.failed.length} 个`);
      } else {
        get().toast('success', `已重命名 ${res.renamed.length} 个文件`);
      }
      // 刷新队列与目录（保留展示路径，重命名只改文件名）
      const previous = new Map(queue.map((q) => [q.path, q]));
      set({
        queue: res.renamed.map((r) => {
          const name = r.to.split(/[\\/]/).pop() ?? r.to;
          const old = previous.get(r.from);
          const oldName = old?.name ?? '';
          const display =
            old?.display && oldName && old.display.endsWith(oldName)
              ? old.display.slice(0, -oldName.length) + name
              : name;
          return {
            path: r.to,
            name,
            size: old?.size ?? 0,
            dir: r.to.slice(0, Math.max(0, r.to.length - name.length - 1)),
            display,
          };
        }),
      });
      await get().navigate(get().browse?.path);
      await get().refreshHistory();
      await get().runPreview();
    } catch (e: any) {
      get().toast('error', `执行失败：${e.message}`);
    }
  },

  async undo(id) {
    try {
      const res = await api.undoHistory(id);
      get().toast('success', `已撤销 ${res.renamed.length} 个文件`);
      await get().refreshHistory();
      await get().navigate(get().browse?.path);
      await get().runPreview();
    } catch (e: any) {
      get().toast('error', `撤销失败：${e.message}`);
    }
  },

  async refreshHistory() {
    try {
      set({ history: await api.getHistory() });
    } catch {
      /* ignore */
    }
  },

  async clearHistory() {
    await api.clearHistory();
    await get().refreshHistory();
    get().toast('info', '历史记录已清空');
  },

  async refreshPresets() {
    set({ presets: await api.getRuleSets() });
  },

  newRuleSet() {
    set({ rules: [], presetId: null, presetName: '未命名预设', preview: null });
    get().toast('info', '已新建空白规则集');
  },

  openPreset(id) {
    const rs = get().presets.find((p) => p.id === id);
    if (!rs) return;
    set({
      rules: rs.rules.map((r) => ({ ...r, params: { ...r.params }, id: uid() })),
      presetId: rs.id,
      presetName: rs.name,
    });
    get().toast('info', `已载入预设「${rs.name}」`);
  },

  async savePreset(name, folder) {
    const { rules, presetId } = get();
    const saved = await api.saveRuleSet({
      id: presetId ?? undefined,
      name,
      folder,
      rules,
    });
    set({ presetId: saved.id, presetName: saved.name });
    await get().refreshPresets();
    get().toast('success', `已保存预设「${saved.name}」`);
  },

  async deletePreset(id) {
    await api.deleteRuleSet(id);
    if (get().presetId === id) set({ presetId: null, presetName: '未命名预设' });
    await get().refreshPresets();
    get().toast('info', '预设已删除');
  },

  async duplicatePreset() {
    const { rules, presetName } = get();
    const saved = await api.saveRuleSet({
      name: `${presetName} 副本`,
      folder: null,
      rules,
    });
    await get().refreshPresets();
    set({ presetId: saved.id, presetName: saved.name });
    get().toast('success', '已另存为副本');
  },

  async setTheme(theme) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    set({ theme });
    set({ settings: await api.updateSettings({ theme }) });
  },

  async saveWatch(patch) {
    const settings = await api.updateSettings({ watch: patch });
    set({ settings });
    const config = await api.getConfig();
    set({ config });
    get().toast('success', patch.enabled ? '目录监听已开启' : '目录监听设置已更新');
  },

  toast(kind, message) {
    const id = `t-${++toastSeq}`;
    set({ toasts: [...get().toasts, { id, kind, message }] });
    setTimeout(() => get().dismissToast(id), 4200);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
