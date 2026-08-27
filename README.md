# TwinScape 高斯在线工具

基于 Web 的 Gaussian Splat 工具，顶部可切换两种工作模式，步骤同为：**路径 → 参数 → 转换 → 三维预览**。

- **LOD 转换**：配置层数与保留率，**两段式**生成中间简化文件并合成 `lod-meta.json`
- **模型压缩**：不生成分层 LOD，按保留比例（例如 60%）简化为单个 PLY，完成后在视口中左右对比

> 转换引擎使用 [PlayCanvas splat-transform](https://github.com/playcanvas/splat-transform) CLI（或你的本地改版）。

## 功能概览

- **LOD 两段式流水线**（适合大数据）
  1. **阶段 1**：串行生成各层中间 PLY（`output/<name>/_intermediates/L*.ply`）
  2. **阶段 2**：原文件 L0 + 中间文件 → 统一空间树、`lod-meta.json` 与分块 SOG
- **模型压缩**：`-F` 保留比例简化，输出 `compressed.ply`；视口分割线左右拖动对比原始 / 压缩后
- 参数 UI：LOD 层数、保留率、分块规模 `-C`；压缩模式为单一保留比例
- 拖放导入、输出目录随输入文件名自动填充（LOD：`output/文件名`，压缩：`output/文件名-compressed`）
- 转换进度 SSE 推送；**刷新页面可恢复**配置与进度（服务进程需仍在运行）
- 三维预览：LOD 为中间结果 / 分块流式 / `lod-meta` 分层；压缩为左右对比（同一视角、可拖分割线）

## 环境要求

- **Node.js ≥ 18**
- **splat-transform CLI**（任选其一）
  - 安装 npm 包：`npm install`（会装可选依赖 `@playcanvas/splat-transform`）
  - 或指向本地仓库：设置环境变量 `SPLAT_TRANSFORM_ROOT`

## 快速开始

```bash
# 克隆
git clone https://github.com/o0pk2008/lod-online-tool.git
cd lod-online-tool

# 安装（可选：通过 npm 提供 CLI）
npm install

# 若使用本地 splat-transform 源码/改版（推荐有自定义进度等改动时）
# PowerShell:
#   $env:SPLAT_TRANSFORM_ROOT="D:\path\to\splat-transform"
# bash:
#   export SPLAT_TRANSFORM_ROOT=/path/to/splat-transform

# 启动
npm start
```

浏览器打开：**http://localhost:5178**

默认端口可用环境变量修改：

```bash
# PowerShell
$env:PORT=5178
npm start
```

## 目录结构

```text
lod-online-tool/
  server.mjs          # HTTP + SSE + 调用 splat-transform
  public/
    index.html
    app.js            # 前端 UI + PlayCanvas 视口
  input/              # 建议放置输入模型（可拖放识别）
  output/             # 转换输出（gitignore）
  package.json
  README.md
```

### 典型输出

LOD 转换：

```text
output/MyScene/
  _intermediates/
    L5.ply … L1.ply     # 阶段 1 中间简化
  lod-meta.json         # 多层索引
  0_0/ 1_0/ …           # 各层分块 SOG（meta.json + webp）
```

模型压缩：

```text
output/MyScene-compressed/
  compressed.ply        # 简化后的单文件
  compress-meta.json    # 保留比例、体积等元数据
```

## CLI 解析顺序

工具启动时按以下顺序查找 `bin/cli.mjs`：

1. 环境变量 `SPLAT_TRANSFORM_ROOT`
2. 父目录（本仓库若放在 `splat-transform/lod-online-tool-git` 下可自动找到）
3. 同级 `../splat-transform`
4. `node_modules/@playcanvas/splat-transform`

启动日志会打印：

```text
workspace : <本工具目录>
splat-cli : <CLI 所在目录>
```

## 操作流程

顶部切换 **LOD 转换** 或 **模型压缩**，随后：

1. **路径**：选择/拖入输入文件，确认输出目录  
2. **参数**：LOD 模式设置层数与各层保留率（L0 = 全量）；压缩模式设置保留比例（如 60%）  
3. **转换**：开始后查看任务列表；简化步骤的近邻搜索可能较久  
4. **预览**：LOD 查看中间结果 / 分块 / 最终分层；压缩完成后拖动视口中间分割线，左侧为原始、右侧为压缩后  

刷新页面：配置与进度会从服务端快照恢复（**不要关掉 Node 进程**）。

## 常用环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | HTTP 端口 | `5178` |
| `SPLAT_TRANSFORM_ROOT` | 本地 splat-transform 根目录 | 自动探测 |

## 与 monorepo 联调

若本仓库仍放在 `splat-transform` 目录内：

```text
splat-transform/
  bin/cli.mjs
  lod-online-tool-git/   ← 本仓库
```

通常**无需**设置 `SPLAT_TRANSFORM_ROOT`，会自动使用父目录 CLI。

独立克隆时：

```powershell
$env:SPLAT_TRANSFORM_ROOT="D:\AILAB\SpaceGS\splat-transform"
npm start
```

## 技术说明

- 后端：Node 原生 `http` + SSE
- 前端：PlayCanvas（CDN ESM）渲染 gsplat
- 分块预览使用 `unified: true` 全局深度排序，避免块间错误遮挡
- 阶段 1 中间文件体积超过约 350MB 时跳过浏览器实时预览（文件仍参与合成）

## License

见 [LICENSE](./LICENSE)。splat-transform 本身遵循其上游许可证。
