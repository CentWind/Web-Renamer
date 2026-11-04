# Web ReNamer · 自定义 Fork

本仓库是 [aaron2024S/web-renamer](https://github.com/aaron2024S/web-renamer)（MIT）的 fork，用于在 NAS / 自托管环境下做独立增强。

- 上游：`upstream` remote（保留完整 git 历史，可随时同步）
- 稳定分支：`main`（跟踪 `origin/main`，构建 `latest` 镜像）
- 开发分支：`dev`（日常开发集成，构建 `dev` 镜像）
- 功能分支：`feat/<功能名>`、`fix/<问题>`（从 `dev` 切出，构建 `feat-xxx` 镜像，自测后合并回 `dev`）
- 版本：v1.2.0

## 相对上游的改动

### 1. 递归添加目录（核心需求）

上游只能「添加当前目录下的文件」；本 fork 支持**一次添加某个目录及其所有子目录下的文件**：

- 后端新增 `server/src/scan.ts` 与 `POST /api/scan`
  - 递归遍历（迭代式 DFS，深层目录不爆栈）
  - 跳过符号链接与特殊文件（防目录成环 / 逃逸白名单根目录）
  - 默认跳过隐藏文件（`.` 开头），API 支持 `includeHidden: true`
  - 单次扫描上限 20000 个文件（可传 `limit`，上限 50000），超限返回 `truncated`
  - 结果按相对路径稳定排序，返回 `rel` 与展示路径 `display`
- 前端
  - 浏览工具栏新增「**含子目录**」按钮：递归添加当前目录
  - 目录行悬停出现「添加此目录及所有子目录」按钮：无需进入目录即可递归添加
  - 「待处理」列表显示文件相对路径（同名文件可区分）
  - 预览表「原文件名」下方显示所在子目录
- 测试
  - `server/src/smoke.ts` 新增第 12 组：递归 / 隐藏文件 / 符号链接 / 上限截断 / 跨目录同名不冲突 / 改名与撤销

### 2. 文件夹重命名（文件 + 文件夹）

上游只处理文件；本 fork 支持把文件夹也加入待处理并重命名：

- 后端
  - 预览/执行计划支持目录（`PlanItem.isDir`）；文件夹没有扩展名概念，扩展名规则自动跳过，`scope=ext` 按整体处理
  - 执行器按父目录分组执行，跨层级时**先子后父**（撤销时反向），保证父子目录/目录与内部文件同批改名不会路径失效
  - 冲突检测覆盖目录撞名、目标已存在；符号链接与特殊文件拒绝
  - `/api/scan` 新增 `includeDirs`：递归扫描时可选把文件夹本身也加入结果
- 前端
  - 目录行悬停出现「**加入待处理（重命名文件夹本身）**」按钮
  - 工具栏新增「**含文件夹**」勾选项；勾选后点「含子目录」可把整个目录树（文件夹 + 文件）一次性加入
  - 「待处理」与「预览」用文件夹图标和「文件夹」标记区分
- 测试
  - `server/src/smoke.ts` 新增第 13 组：单文件夹改名、父子目录同批、文件+目录同批、撤销、`includeDirs`、符号链接拒绝、撞名冲突
  - 当前冒烟测试共 18 项全部通过

### 3. 构建与发布

- `.github/workflows/docker-publish.yml` 改为 **GitHub Actions + GHCR 自动构建**：
  - push 到 `main` / `dev` / `feat/**` / `fix/**` 分支或 `v*` 标签时自动构建 `linux/amd64,linux/arm64` 双架构镜像
  - 推送至 `ghcr.io/<仓库所有者小写>/web-renamer:<latest|分支名|版本号|sha-xxxxxxx>`
  - 无需 Docker Hub 账号，使用仓库自带 `GITHUB_TOKEN`（需在 Settings → Actions → General 把 Workflow permissions 设为 Read and write）
  - 也支持手动 `workflow_dispatch`（可只构建不推送）
- 版本号提升到 1.2.0

## 本地开发

```bash
npm install
npm run dev        # 后端 7582 + 前端 5173
npm run smoke      # 规则引擎 / 扫描 / 执行 / 撤销冒烟测试
npm run build      # 构建前端与后端
```

> 仓库里的 `package-lock.json` 由上游生成，未包含各平台的可选原生依赖（rollup/esbuild/lightningcss）。
> 若在本地 `npm ci` 后构建报 `Cannot find module '@rollup/rollup-linux-x64-gnu'` 之类错误，执行
> `rm -rf node_modules package-lock.json && npm install` 重新生成即可（Dockerfile 不复制 lockfile，不受影响）。

## 本地构建镜像

```bash
docker build -t web-renamer:custom .
docker run --rm -p 7582:7582 \
  -e PUID=1000 -e PGID=1000 -e TZ=Asia/Shanghai \
  -v /path/to/data:/data \
  -v /path/to/config:/config \
  web-renamer:custom
```

## 发布到你自己的 GitHub + GHCR

> ✅ 已完成：仓库为 <https://github.com/CentWind/Web-Renamer>，镜像为 `ghcr.io/centwind/web-renamer`（公开可拉取）。
> 以下步骤供换机 / 重建仓库时参考。

1. 在 GitHub 新建一个**空仓库**（建议 public；私有仓库也能构建，但 NAS 拉取需要 `docker login`），不要勾选初始化 README。
2. 添加远程并推送：

   ```bash
   git remote add origin git@github.com:CentWind/Web-Renamer.git
   git push -u origin main
   git push -u origin dev
   ```

3. 仓库 **Settings → Actions → General → Workflow permissions** 选择 **Read and write permissions**（GHCR 推送需要）。
4. push 后自动触发构建，完成后在仓库 **Actions** 页查看；镜像地址：
   `ghcr.io/centwind/web-renamer:latest`
5. 首次构建后到 **Packages** → `web-renamer` → **Package settings** → 把可见性改为 **Public**（NAS 免登录拉取）。
   若保持私有，在 NAS 上执行：`docker login ghcr.io -u <用户名> -p <具有 read:packages 权限的 PAT>`。
6. NAS 的 compose 里把镜像改成：

   ```yaml
   image: ghcr.io/centwind/web-renamer:latest
   ```

7. 发版：`git tag v1.1.0 && git push origin v1.1.0`，会额外构建 `v1.1.0` 标签。

## 分支与发布流程

```
main（稳定，= 部署分支）
 └── dev（日常开发集成分支）
      ├── feat/xxx（新功能）
      └── fix/xxx（问题修复）
```

- 新功能：从 `dev` 切 `feat/xxx` → 开发 + 自测 → 合并回 `dev`
- 修复：从 `dev` 切 `fix/xxx` → 合并回 `dev`
- 发布：`dev` 稳定后合并到 `main` 并推送 → Actions 自动更新 `latest`
- 镜像标签：`main` → `latest`；`dev` → `dev`；`feat/xxx` → `feat-xxx`（`/` 会被替换成 `-`）；另有 `sha-<7位>`
- 功能分支/开发分支的镜像可以用于预览验证，但 NAS 部署请指向 `latest`

## 同步上游

```bash
git fetch upstream
git checkout dev
git merge upstream/main        # 把上游更新合并进开发分支
npm run smoke                  # 回归测试
# 稳定后再发布：
git checkout main && git merge --no-ff dev && git push origin main
```

## 已知限制

- 递归扫描单次上限 20000 个文件；超过请分批处理
- 默认跳过隐藏文件与符号链接（API 支持 `includeHidden`，前端暂未提供开关）
- 文件夹重命名只改文件夹名，内部内容原样保留；符号链接文件夹会被拒绝
- 文件夹没有扩展名概念，「扩展名」规则对文件夹自动跳过
- 上游项目为 v1.0.1 快照，代码结构与 API 契约保持兼容，方便后续同步
