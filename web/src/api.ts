import type {
  AppConfig,
  ApplyResult,
  AuthMe,
  AuthStatus,
  BrowseResult,
  Journal,
  PlanResult,
  Rule,
  RuleSet,
  RuleTypeMeta,
  ScanResult,
  Settings,
  WatchConfig,
} from './types';

export interface SettingsPatch {
  theme?: 'dark' | 'light';
  watch?: Partial<WatchConfig>;
}

/** 带状态码的请求错误，便于上层识别 401 / 429 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: any = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // 只有真的带 body 时才声明 JSON 类型：
  // 否则 Fastify 对「Content-Type: application/json 但空 body」会直接返回 400
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = (data && (data.error || data.message)) || `请求失败 (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  return data as T;
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const api = {
  getAuthStatus: () => request<AuthStatus>('/api/auth/status'),

  login: (username: string, password: string) =>
    request<{ ok: true; username: string; isDefault: boolean }>('/api/auth/login', {
      method: 'POST',
      ...json({ username, password }),
    }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  getMe: () => request<AuthMe>('/api/auth/me'),

  updateCredentials: (body: {
    currentPassword: string;
    username?: string;
    newPassword?: string;
    logoutOtherSessions?: boolean;
  }) => request<{ ok: true; username: string }>('/api/auth/credentials', { method: 'PUT', ...json(body) }),

  getConfig: () => request<AppConfig>('/api/config'),

  getRuleTypes: () => request<RuleTypeMeta[]>('/api/rule-types'),

  browse: (path?: string) =>
    request<BrowseResult>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  /** 递归扫描目录（含子目录）收集文件 */
  scan: (path: string, opts: { recursive?: boolean; includeHidden?: boolean; limit?: number } = {}) =>
    request<ScanResult>('/api/scan', { method: 'POST', ...json({ path, ...opts }) }),

  preview: (files: string[], rules: Rule[]) =>
    request<PlanResult>('/api/preview', { method: 'POST', ...json({ files, rules }) }),

  apply: (files: string[], rules: Rule[], recordHistory = true) =>
    request<ApplyResult>('/api/apply', { method: 'POST', ...json({ files, rules, recordHistory }) }),

  meta: (path: string) => request<{ path: string; meta: Record<string, string> }>(
    `/api/meta?path=${encodeURIComponent(path)}`,
  ),

  getRuleSets: () => request<RuleSet[]>('/api/rulesets'),

  saveRuleSet: (rs: Partial<RuleSet>) =>
    rs.id
      ? request<RuleSet>(`/api/rulesets/${rs.id}`, { method: 'PUT', ...json(rs) })
      : request<RuleSet>('/api/rulesets', { method: 'POST', ...json(rs) }),

  deleteRuleSet: (id: string) => request<{ ok: true }>(`/api/rulesets/${id}`, { method: 'DELETE' }),

  getHistory: () => request<Journal[]>('/api/history'),

  undoHistory: (id: string) =>
    request<ApplyResult>(`/api/history/${id}/undo`, { method: 'POST' }),

  clearHistory: () => request<{ ok: true }>('/api/history', { method: 'DELETE' }),

  getSettings: () => request<Settings>('/api/settings'),

  updateSettings: (patch: SettingsPatch) =>
    request<Settings>('/api/settings', { method: 'PUT', ...json(patch) }),
};
