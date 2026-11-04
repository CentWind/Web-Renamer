# Web ReNamer

> **本仓库是自定义 fork**：在上游 v1.0.1 基础上新增「递归添加目录（含所有子目录）」和「文件夹重命名」能力，
> 并通过 GitHub Actions 构建镜像到 GHCR。改动说明、本地构建与发布步骤见 [FORK.md](./FORK.md)。

自托管的**批量文件重命名工具**（Docker / Web 版），功能对标 [ReNamer](https://renamer.com.cn/)，但没有免费版的限制：**规则数量与预设数量都不设上限**。

- 📁 **递归添加目录**（本 fork 新增）：一次把某个目录及**所有子目录**下的文件加入待处理；勾选「含文件夹」可连同文件夹本身一起加入
- 🗂 **文件夹重命名**（本 fork 新增）：文件夹可与文件混合重命名，父子目录同批处理，支持撤销
- 🧩 **17 种规则**：插入、替换、正则替换、移除、大小写、扩展名、序列号、清理空白、清理非法字符、补位、随机、重排、拼音转写、日期重格式化、元标签（音乐/图片）、用户输入、JS 脚本
- 🗂 **无限规则集与预设**，支持按分组目录管理
- 👀 **实时预览**：执行前就能看到「原名 → 新名」和冲突提示
- ↩️ **一键撤销**：每一步都有历史记录，可随时还原
- 🛰 **目录监听**：往指定文件夹丢文件就自动改名（带开关）
- 🔐 **登录鉴权 + 防爆破**：默认账号 `admin`（首次启动生成），密码错误次数超限自动锁定
- 🌓 深色 / 浅色主题，响应式界面

> 支持**文件与文件夹**重命名；目录监听功能仍只处理文件。

---

## 快速开始（Docker Compose）

1. 改一下 `docker-compose.yml` 里要处理的目录：

```yaml
volumes:
  - /你的/待处理目录:/data
  - ./renamer-config:/config     # 预设与历史，务必持久化
```

**要同时处理多个目录**（比如照片、下载、音乐分开挂）：全部挂到 `/data` 下面即可，**不需要配置 `ROOTS`**，应用里从 `/data` 逐级往下浏览：

```yaml
volumes:
  - /volume1/photos:/data/photos
  - /volume2/downloads:/data/downloads
  - ./music:/data/music
  - ./renamer-config:/config
```

> `ROOTS` 只在想把根目录放到 `/data` 之外时才需要（多个用逗号分隔，如 `/data,/music`）。

2. 启动：

```bash
docker compose up -d --build
```

3. 打开 <http://localhost:7582> ，用默认账号 `admin` 登录（默认密码见 `server/src/auth.ts` 里的 `AUTH_PASSWORD` 兜底值，或用环境变量 `AUTH_PASSWORD` 在首次启动时指定），**登录后请立即在右上角「账号」里修改用户名和密码**

### 只用 docker run

```bash
docker build -t web-renamer .
docker run -d --name web-renamer \
  -p 7582:7582 \
  -e PUID=1000 -e PGID=1000 \
  -v /你的/待处理目录:/data \
  -v $(pwd)/renamer-config:/config \
  web-renamer
```

### 用 GitHub Actions 构建并推送镜像（手动触发）

仓库里带了一个**手动触发**的构建流程：`.github/workflows/docker-publish.yml`，会把镜像推到 Docker Hub 的 `<DOCKERHUB_USERNAME>/web-renamer`。

**第一次使用前**，先去仓库 `Settings → Secrets and variables → Actions` 添加两个密钥：

| 密钥名 | 内容 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub 用户名（**全小写**） |
| `DOCKERHUB_TOKEN` | Docker Hub 的 Access Token（`Account Settings → Personal access tokens → Generate new token`，权限选 **Read & Write**），**不要用登录密码** |

然后在 `Actions → 构建并推送镜像 → Run workflow` 里按需填写：

- **tag**：镜像标签，默认 `latest`
- **platforms**：默认 `linux/amd64,linux/arm64`（多架构，NAS 上的 arm64 也能用），也可只选单架构加快速度
- **push**：取消勾选则只构建不推送 —— 用来验证 Dockerfile 能否编过
- **no_cache**：勾上则忽略构建缓存

构建完成后，如果不想在本地构建，把 `docker-compose.yml` 里的 `build: .` 一行删掉，只留 `image`：

```yaml
image: aaron2024s/web-renamer:latest
```

再 `docker compose pull && docker compose up -d` 即可。（保留 `build: .` 则 `up --build` 会在本地构建并以该名字打标签。）

### 群晖 / 威联通等 NAS 面板

在面板的「容器」里新建，关键是两件事：

- **卷映射**：`/data` → 你的共享文件夹（多个目录都挂到 `/data` 下即可，无需配 `ROOTS`）；`/config` → 一个持久化文件夹
- **环境变量**：`PUID`/`PGID` 设成共享文件夹的属主 UID/GID（群晖常见 `1026`，可在 `控制面板 → 共享文件夹 → 权限` 里查）

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ROOTS` | `/data` | 允许操作的根目录，多个用逗号分隔；目录都挂到 `/data` 下时**无需设置** |
| `CONFIG_DIR` | `/config` | 预设 / 历史 / 设置 / 账号的存放目录 |
| `PORT` | `7582` | 服务（容器内监听）端口，改动时同步端口映射 |
| `PUID` / `PGID` | `0` | 以哪个用户身份处理文件（NAS 场景建议设置） |
| `TZ` | — | 时区，如 `Asia/Shanghai` |

### 登录与防爆破

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AUTH_USER` | `admin` | 首次启动创建的默认用户名 |
| `AUTH_PASSWORD` | 见 `server/src/auth.ts` | 首次启动创建的默认密码（仅首次生效，之后以 `/config` 数据库里的为准） |
| `LOGIN_MAX_ATTEMPTS` | `5` | 计数窗口内允许的失败次数，超过即锁定 |
| `LOGIN_WINDOW_MS` | `600000` | 失败计数窗口（10 分钟） |
| `LOGIN_LOCK_MS` | `900000` | 首次锁定时长（15 分钟），连续被锁按倍数递增 |
| `LOGIN_LOCK_MAX_MS` | `3600000` | 锁定时长上限（1 小时） |
| `LOGIN_DELAY_BASE_MS` | `600` | 每次失败后的应答延迟起点，逐次翻倍 |
| `LOGIN_DELAY_MAX_MS` | `4000` | 应答延迟上限 |
| `SESSION_TTL_MS` | `604800000` | 登录会话有效期（7 天） |
| `TRUST_PROXY` | `false` | 放在反向代理后面时设为 `true`（按 `X-Forwarded-For` 识别来源） |

防爆破同时按「来源 IP」和「账号名」两个维度计数：同一 IP 换着账号试、或分布式猜同一个账号，都会触发锁定。修改用户名 / 密码在登录后右上角「账号」面板里，保存后其它设备的会话会被踢掉。

---

## 本地开发

需要 Node 20+。

```bash
npm install
npm run dev          # 前端 5173 / 后端 7582，前端自动代理 /api
```

生产构建与运行：

```bash
npm run build        # 构建前端 + 后端
npm start            # 启动（默认托管前端产物）
```

自测（规则引擎 / 执行器）：

```bash
npm run smoke
```

开发时后端默认根目录是 `./data`，可自行创建：

```bash
mkdir -p data renamer-config
ROOTS=./data CONFIG_DIR=./renamer-config npm run dev
```

Windows（PowerShell）：

```powershell
$env:ROOTS="./data"; $env:CONFIG_DIR="./renamer-config"; npm run dev
```

---

## 使用流程

1. **左侧「浏览」**：进入目录，点文件或「全部添加」把文件加入待处理列表
2. **中间「规则链」**：从「添加规则」挑规则，按从上到下的顺序依次作用；可保存为预设随时复用
3. **右侧「预览」**：确认改名结果没问题后点「执行重命名」
4. **右侧「历史」**：需要时可一键撤销
5. **右侧「监听」**：开启后，指定目录里新出现的文件会自动按所选预设改名

---

## 规则速查

| 规则 | 说明 |
| --- | --- |
| 插入 | 前缀 / 后缀 / 指定位置插入文本，也可在指定文本之前 / 之后插入或替换主名 |
| 替换 | 查找替换，支持正则与全词匹配，可选全部 / 首个 / 末个 |
| 正则替换 | 支持捕获组 `$1`、`$<name>` |
| 移除 | 指定文本（全部/首个/末个）/ 按字符集 / 按区间（可删到末尾）/ 删除两个分隔符之间的内容 |
| 大小写 | 小写 / 大写 / 每词首字母大写（可保留其余）/ 句首大写 / 反转 |
| 扩展名 | 设置 / 追加到原名后 / 删除 / 改大小写 |
| 序列号 | 自增编号，可补零、按目录重置、每个号重复 N 次，支持十进制 / 十六进制 / 字母 / 罗马数字 |
| 清理空白 | 去首尾空白、合并空格、删指定字符（可选仅开头 / 仅结尾）、去变音符号 |
| 清理非法字符 | 替换 `<>:"/\|?*` 等系统非法字符，可删括号及内容、驼峰前加空格 |
| 补位 | 补齐到指定长度或截断，可去除前导零 |
| 随机字符串 | 用随机字符替换 / 拼接，支持自定义字符集 |
| 重排 | 按分隔符拆片段后重新组合：模板重排 `$2 $1`（支持 `$-1` 从末尾引用）/ 倒序 / 排序 |
| 拼音转写 | 中文转拼音：全拼 `ni hao` 或首字母 `nh`，可带声调、可保留英文 |
| 日期重格式化 | 识别文件名里的日期并改写格式，如 `20241007` → `2024-10-07` |
| 元标签 | 从音乐 ID3 / 图片 EXIF 读信息写进文件名，如 `{artist} - {title}` |
| 脚本 | JavaScript 沙箱，可用 `name` / `ext` / `index` / `total` / `dir` / `meta` |
| 用户输入 | 每行一个名字，按文件顺序一一对应：替换 / 插到最前 / 插到最后 |

**元标签可用字段**：`{title} {artist} {album} {albumartist} {genre} {year} {track} {disc} {comment} {dateTime} {make} {model} {iso} {width} {height}`

**日期格式记号**（「日期重格式化」规则）：`YYYY` `YY` `MM` `M` `DD` `D` `HH` `mm` `SS`
源格式留空则自动识别（`2024-10-07`、`20241007`、`2024年10月7日`、`IMG_20241007_120000`…）。遇到 `07-10-2024` 这类有歧义的日期，用「日在前」开关决定按 `DD-MM-YYYY` 还是 `MM-DD-YYYY` 解析。

**几个常见搭配**：

| 想做的事 | 规则搭配 |
| --- | --- |
| `会议纪要 2024.txt` → `2024 会议纪要.txt` | 重排（分隔符 `空格`，模板 `$2 $1`） |
| `你好世界.txt` → `ni hao shi jie.txt` | 拼音转写（全拼，分隔符空格） |
| `你好世界.txt` → `nhsj.txt` | 拼音转写（首字母） |
| `IMG_20241007_draft.jpg` → `IMG_2024-10-07_draft.jpg` | 日期重格式化（原地替换，`YYYY-MM-DD`） |

**脚本示例**：

```js
// 把名字改为小写，并在结尾补上所在目录名
result = name.toLowerCase() + '_' + dir;
```

---

## 安全设计

- **登录鉴权**：所有 `/api` 接口需要登录（除健康检查与登录本身）；会话为 HttpOnly Cookie，也支持 `Authorization: Bearer <token>` 供脚本调用
- **登录防爆破**：失败计数 + 递增延迟 + 锁定，策略可用环境变量调整（见上表）
- 所有文件操作强制限制在 `ROOTS` 白名单目录内，拒绝 `..` 与符号链接逃逸
- 执行前先算好计划，存在**冲突**（多文件撞名 / 目标已存在）或**非法项**时直接阻止
- 涉及**交换 / 成环 / 仅改大小写**时自动走两阶段改名（先改临时名），不会互相覆盖丢文件
- JS 脚本在 `node:vm` 沙箱里执行，无文件/网络/进程访问权限，带 300ms 超时

---

## 常见问题

**Q：`npm install` 报 `EBUSY` 或提示找不到 `@esbuild/win32-x64`、`@rollup/rollup-win32-x64-msvc`**

Windows 上首次安装时，esbuild / rollup 的安装脚本偶尔会因文件占用（杀软扫描等）中断，导致平台二进制包没装上。标准修复方式是干净重装：

```bash
rm -rf node_modules package-lock.json   # Windows: rmdir /s /q node_modules & del package-lock.json
npm install
```

如果环境不允许删目录，可以手工把对应版本的二进制包补到指定位置：

```bash
npm pack @esbuild/win32-x64@<esbuild版本> @rollup/rollup-win32-x64-msvc@<rollup版本> --pack-destination ./_tb
mkdir -p node_modules/@esbuild/win32-x64 node_modules/@rollup/rollup-win32-x64-msvc
tar -xzf _tb/esbuild-win32-x64-*.tgz -C node_modules/@esbuild/win32-x64 --strip-components=1
tar -xzf _tb/rollup-rollup-win32-x64-msvc-*.tgz -C node_modules/@rollup/rollup-win32-x64-msvc --strip-components=1
```

版本号可用 `node -p "require('./node_modules/esbuild/package.json').version"` 查。注意 Vite 会内嵌一份自己的 esbuild（`node_modules/vite/node_modules/esbuild`），也要按同样方式补。

**Q：往监听目录里丢文件没有自动改名**

- 只在文件**新增**时触发；覆盖一个已存在的同名文件不算新增
- 开启监听的瞬间若正好有文件写入，可能被初始化扫描当成「已有文件」而跳过，稍后再丢一个即可
- 监听路径必须在 `ROOTS` 白名单内，且必须选中了规则集

**Q：改完想反悔**

右侧「历史」标签页里点「撤销」，会把那一批改名逐条还原。

---

## 目录结构

```
web-renamer/
├─ server/          # Fastify + TypeScript 后端（规则引擎 / 执行器 / 存储 / 监听）
├─ web/             # React + Vite + Tailwind v4 前端
├─ docker/          # 容器 entrypoint
├─ .github/         # 手动触发的镜像构建流程
├─ Dockerfile
├─ docker-compose.yml
└─ PLAN.md          # 方案设计文档
```

---

## 已知边界

- 只处理文件，**不处理文件夹**
- 元标签依赖文件本身带有标签；读取失败时该文件保持不变（可在规则里选择「缺字段时保留原名」）
- 脚本规则用 JavaScript，**与 ReNamer 的 Pascal 脚本不兼容**，需自行改写
