# iTools 自动化工具集 · Web 版

把 itools 平台拉题作业流水线上的四个 Python 脚本，改造成**纯静态网页工具**：图片转链接、数据聚合、多轮会话渲染、tlabel 格式转换。免构建、无后端，数据全部在浏览器本地处理，可直接部署到 GitHub Pages。

## 在线访问

> 部署后地址：`https://via-life.github.io/TX_Krismao_iTools/`

## 四个工具

| # | 工具 | 对应脚本 | 输入 → 输出 |
|---|------|----------|-------------|
| 一 | **Excel 图片转 URL**（`tool1.html`） | `excel2url.py` | xlsx（内嵌图）→ 上传文件 + 输入配置信息（区分内部/公网环境），把图片转内部链接并写回 `_with_urls.xlsx` |
| 二 | **数据聚合**（`tool2.html`） | `generate_session_json.py` | xlsx/csv/json → 保留原表，按 `cid` 聚合的 JSON 写入第一个空白列（`session`） |
| 三 | **多轮会话渲染**（`tool3.html`） | `convert_to_png.py` | xlsx（messages 列）→ 多轮对话可视化，可携带 Cookie/鉴权头加载内网图片，导出 PNG（单/双模型） |
| 四 | **转 tlabel jsonl**（`tool4.html`） | `convert_xlsx_to_jsonl_GSB.py` | xlsx → jsonl（`cid/user_prompt/model_x_response/model_x_url`，DCG / GSB，单/双模型） |

## 核心增强：自定义列映射

四个工具都内置「自定义列映射」（弹窗式）：导入后先按别名**自动识别**列名（如 `用户提问 / user_prompt / prompt` 都能识别为提问列，`cid / session_id / session` 识别为 session 主键，`session_answer / session_anwser / response` 识别为回复列）；识别不全或不正确时弹窗让你**手动把数据列对应到字段**，图片列还支持多选。因此不再要求表头必须与脚本硬编码列名一致。

## 支持的数据格式

- 文件：`.xlsx` / `.xls` / `.csv` / `.json`，自动识别编码（UTF-8 / GBK / GB18030）。
- 会话内容（工具三）：OpenAI 风格 `messages` 数组（`role` + `content`，`content` 支持纯文本或 `text` / `image_url` 段），兼容 `session_answer` 列内含未转义换行的容错解析。

## 各工具说明

### 工具一 · Excel 图片转 URL
页面只保留两个模块：**上传文件** 与 **输入配置信息**。
1. 上传 xlsx，浏览器本地用 JSZip 解压，按 drawing 锚点提取每张内嵌图及其所在单元格（无预览列表，仅提示提取数量）；
2. 输入配置信息：选择**环境**（内部 / 公网）、填写上传端点 URL 与鉴权信息（`x-id / x-token / x-route-env`，对应 `excel2url.py` 的 `config.json`）、返回体中 URL 字段路径；
3. 「开始上传并写回」逐图上传取回链接，把单元格写成 URL、移除图片，导出 `_with_urls.xlsx`，并可导出「单元格→URL 映射」csv。

> ⚠️ **公网环境**（github.io）向内网元宝/COS 端点上传通常被 **CORS** 拦截，`x-route-env` 会自动置为 `--`；请在**内部环境**使用，或让端点对本页面放开跨域。

### 工具二 · 数据聚合
保留上传表原样，按 `cid` 分组、`round_id` 排序，把每个 session 的多轮内容聚合成一段 JSON（`[{"user prompt","image_url","location",…}]`，即除 `cid/round_id` 外的内容列，`user_prompt` 输出为 `user prompt`），写入**从左往右第一个空白列**（表头命名 `session`，写在该 session 第一行），其它列/行内容不变，导出 `_with_session.xlsx`。

### 工具三 · 多轮会话渲染
把每行的 messages 列还原成多轮对话（用户气泡靠右、模型回复靠左，含表格/列表/代码/`[citation:N]` 角标等 markdown 渲染），左侧可切换会话，支持单/双模型对照。可「导出当前 PNG」或「导出全部 (zip)」（html2canvas 截图）。

> 🔑 **hunyuan 内网图片鉴权（403）**：勾选「通过 fetch 携带 Cookie/鉴权头加载图片」，在同一浏览器登录 hunyuan（自动带 Cookie，`credentials:'include'`）或填入 Cookie / 附加请求头。加载成功的图片转为本地 blob，可正常计入导出的 PNG。注意浏览器安全策略可能忽略脚本设置的 `Cookie` 头，登录态是最可靠方式；仍失败时点「查看原图」打开。

### 工具四 · 转 tlabel jsonl
按 `cid` 聚合、取 `round_id` 最大（并列取靠后）那一行，严格按 tlabel 平台 KEY 顺序输出 jsonl：
`cid / user_prompt / model_1_response / model_2_response / model_1_url / model_2_url`。
其中 `model_x_response` 取 `response_x` 列、`model_x_url` 取 `png_x` 列（渲染图公网链接）。勾选「双模型」追加第二模型两列（GSB 对照），否则为单模型（DCG，仅 `model_1_*`）。

## 技术栈

- 纯静态 HTML + 原生 JS（ES5 兼容），免构建
- 依赖库已**本地化**到 `js/lib/`（离线可用，内网无需访问公网 CDN）：
  - [PapaParse](https://www.papaparse.com/) 5.4.1（CSV）
  - [SheetJS](https://sheetjs.com/) 0.18.5（XLSX 读/写）
  - [JSZip](https://stuk.github.io/jszip/) 3.10.1（解压 xlsx / 打包）
  - [html2canvas](https://html2canvas.hertzen.com/) 1.4.1（PNG 截图）

## 目录结构

```
TX_Krismao_iTools/
├── index.html         # 门户：四个工具卡片
├── tool1.html         # 需求一 图片转URL
├── tool2.html         # 需求二 数据聚合
├── tool3.html         # 需求三 多轮会话渲染
├── tool4.html         # 需求四 转 tlabel jsonl
├── css/styles.css     # 共享设计系统
├── js/common.js       # 文件解析/编码/messages 解析/xlsx·jsonl 写出/下载
├── js/mapping.js      # 可复用「自定义列映射」组件
├── js/tool1.js ~ tool4.js
├── js/lib/            # 本地化依赖库（PapaParse / SheetJS / JSZip / html2canvas）
├── .nojekyll          # GitHub Pages 关闭 Jekyll
└── README.md
```

## 本地运行

**方式一：一键启动（Windows 推荐）**

双击目录下的 `启动.bat`：它会自动用 Python 起本地服务并打开浏览器。**保持那个黑色命令行窗口开着**即可使用；关闭窗口即停止服务。（需已安装 Python 3。默认端口 8080，被占用时请改 `启动.bat` 里的 `PORT`。）

**方式二：手动命令**

```bash
cd TX_Krismao_iTools
python -m http.server 8080
# 浏览器打开 http://localhost:8080
```

> 说明：浏览器出于安全限制，网页自身无法启动本地服务，因此用 `启动.bat` 一键代劳。工具一上传、工具三加载内网图片等**网络类功能请务必通过 `http://localhost`（而非双击 `file://` 的 html）访问**，否则会被同源策略/CORS 拦截。

## 已知限制

- **工具一上传** 向内网服务发请求受跨域（CORS）限制，公网环境多数需内网或端点放开 CORS；`x-route-env` 在公网环境自动置为 `--`。
- **工具三 PNG** 中的鉴权图片需勾选 fetch 加载并具备登录态/Cookie 才能计入截图；浏览器可能忽略脚本设置的 `Cookie` 头，且本工具不支持把截图写回 xlsx。
- 工具一仅支持 `.xlsx`（`.xls` 请先另存为 `.xlsx`）。
