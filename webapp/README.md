# 具身智能文献深读记录系统（团队版）

基于 Web 的文献阅读记录与协作工具，原 Excel 表格的升级版，支持团队多人共享编辑。

---

## 功能特性

- **8大研究方向分类**：与原 Excel 工作表一一对应，支持一篇论文归入多个方向
- **标签与阅读状态**：支持跨方向标签、未读/粗读/深读中/已分享/已复现等状态管理
- **团队协作保护**：记录创建人与最近更新人，保存时检测多人编辑冲突，避免覆盖他人修改
- **38字段完整记录**：基础信息、五维评分、论文信息、方法框架、实验设计、实验结果、创新点、启发思考
- **五维雷达图**：相关性 / 新颖性 / 证据强度 / 启发性 / 可复现性
- **综合评分自动计算**：权重与评分标准完全对齐原表
- **搜索排序**：按标题、作者、方向搜索；按日期、评分排序
- **导入导出**：支持 JSON 格式备份与恢复，导入时可选择跳过或覆盖重复记录
- **密码保护（可选）**：通过环境变量开启访问密码
- **Excel 兼容**：提供 `convert_excel.py` 一键将原有 .xlsx 导入系统

---

## 快速启动

### 方式一：直接运行（推荐测试）

```bash
pip install -r requirements.txt
python server.py
```

访问 http://localhost:8088

### 方式二：Docker 部署（推荐生产）

```bash
docker build -t embodied-papers .
docker run -d -p 8088:8088 --name embodied-papers embodied-papers
```

### 方式三：带密码保护运行

```bash
APP_PASSWORD=your_secret python server.py
```

---

## 从 Excel 迁移数据

```bash
python convert_excel.py
```

执行后会生成 `papers_from_excel.json`，重启服务器时会自动导入到 SQLite 数据库。

---

## Cloudflare 团队协作部署（推荐）

Cloudflare 版本使用 **Worker + Static Assets + D1**：

- 前端 `index.html` 作为静态资源发布
- `/api/*` 由 `src/worker.js` 处理
- 文献数据保存在 Cloudflare D1，团队成员访问同一个线上数据库
- 可用 `APP_PASSWORD` 给团队设置统一访问密码

### 1. 安装依赖

```bash
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
npx wrangler whoami
```

### 3. 创建 D1 数据库

```bash
npm run d1:create
```

命令输出里会包含 `database_id`，把它填入 `wrangler.jsonc`：

```jsonc
"database_id": "00000000-0000-0000-0000-000000000000"
```

### 4. 初始化线上表结构

```bash
npm run d1:migrate:remote
```

### 5. 设置团队访问密码（推荐）

```bash
npx wrangler secret put APP_PASSWORD
```

输入一个团队共享密码。之后团队成员首次打开网页时输入该密码即可。

### 6. 部署

```bash
npm run deploy
```

部署完成后，Wrangler 会输出 `*.workers.dev` 访问地址。把这个地址发给团队成员即可共同编辑同一份数据。

### 7. 导入现有 Excel 数据

当前仓库已经有 `papers_from_excel.json`。部署后在网页右上角点击“导入”，选择该 JSON 文件，即可一次性导入线上 D1。

也可以先本地预览：

```bash
npm run d1:migrate:local
npm run dev
```

访问 Wrangler 输出的本地地址。

### Cloudflare 目录说明

```
webapp/
├── src/worker.js                 # Cloudflare Worker API
├── migrations/0001_initial_schema.sql
├── wrangler.jsonc                # Cloudflare 配置
├── .assetsignore                 # 发布静态资源时排除后端/数据文件
└── package.json                  # Wrangler 脚本
```

> 旧的 Flask + SQLite 版本仍然保留，可继续用于本地单机运行或 Docker 部署。

---

## 免费云端部署（Render / Railway）

### Render 部署

1. 将 `webapp/` 文件夹推送到 GitHub
2. 在 [Render](https://render.com) 创建 **Web Service**
3. Build Command: `pip install -r requirements.txt`
4. Start Command: `python server.py`
5. 添加环境变量（可选）: `APP_PASSWORD = your_password`

### Railway 部署

1. 将代码推送到 GitHub
2. 在 [Railway](https://railway.app) 导入项目
3. 自动识别 Python 项目并部署
4. 在 Variables 中添加 `APP_PASSWORD`（如需密码保护）

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 原生 HTML5 + CSS3 + JavaScript + Chart.js |
| 本地后端 | Python Flask |
| 本地数据库 | SQLite（单文件，零配置） |
| 团队云端 | Cloudflare Worker + Static Assets + D1 |
| 容器 | Docker |

---

## 目录结构

```
webapp/
├── index.html              # 前端单页应用
├── server.py               # Flask 后端 + SQLite
├── requirements.txt        # Python 依赖
├── Dockerfile              # 容器化构建
├── convert_excel.py        # Excel → JSON 转换工具
├── papers_from_excel.json  # 初始数据（由 convert_excel.py 生成）
├── papers.db               # SQLite 数据库（运行时自动生成）
└── README.md
```

---

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/papers` | 获取所有文献 |
| POST | `/api/papers` | 新增文献 |
| PUT | `/api/papers/<id>` | 更新文献 |
| DELETE | `/api/papers/<id>` | 删除文献 |
| POST | `/api/import` | 批量导入 JSON |
| GET | `/api/export` | 导出全部 JSON |
| GET | `/api/stats` | 统计数据 |
