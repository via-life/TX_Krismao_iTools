# iTools 自动化工具集 · Web 版

把 itools 平台拉题作业流水线上的四个 Python 脚本，改造成**纯静态网页工具**：图片转链接、数据聚合、多轮会话渲染、tlabel 格式转换。免构建、无后端，数据全部在浏览器本地处理，可直接部署到 GitHub Pages。

## 在线访问

> 部署后地址：`https://via-life.github.io/TX_Krismao_iTools/`

## 四个工具

| # | 工具 | 对应脚本 | 输入 → 输出 |
|---|------|----------|-------------|
| 一 | **Excel 图片转 URL**（`tool1.html`） | `excel2url.py` | xlsx（内嵌图）→ 提取/预览/打包下载；可配置上传端点，把图片转内部链接并写回 `_with_urls.xlsx` |
| 二 | **数据聚合**（`tool2.html`） | `generate_session_json.py` | xlsx/csv/json → 按 session 聚合的 xlsx（默认列 `L1/L2/L3/用户问题`） |
| 三 | **多轮会话渲染**（`tool3.html`） | `convert_to_png.py` | xlsx（messages 列）→ 多轮对话可视化，导出 PNG（支持单/双模型对照） |
| 四 | **转 tlabel jsonl**（`tool4.html`） | `convert_xlsx_to_jsonl_GSB.py` | xlsx → jsonl（tlabel 字段顺序，DCG / GSB，单/双模型） |

## 核心增强：自定义列映射

四个工具都内置「自定义列映射」（弹窗式）：导入后先按别名**自动识别**列名（如 `用户提问 / user_prompt / prompt` 都能识别为提问列，`cid / session_id / session` 识别为 session 主键，`session_answer / session_anwser / response` 识别为回复列）；识别不全或不正确时弹窗让你**手动把数据列对应到字段**，图片列还支持多选。因此不再要求表头必须与脚本硬编码列名一致。

## 支持的数据格式

- 文件：`.xlsx` / `.xls` / `.csv` / `.json`，自动识别编码（UTF-8 / GBK / GB18030）。
- 会话内容（工具三）：OpenAI 风格 `messages` 数组（`role` + `content`，`content` 支持纯文本或 `text` / `image_url` 段），兼容 `session_answer` 列内含未转义换行的容错解析。

## 各工具说明

### 工具一 · Excel 图片转 URL
1. 导入 xlsx，浏览器本地用 JSZip 解压，按 drawing 锚点提取每张内嵌图及其所在单元格；
2. 预览全部图片 + 单元格地址，可「下载所有图片 (zip)」；
3. 选填「可配置上传」：填入上传端点 URL、请求头（对应 `excel2url.py` 的 `config.json`）、返回体中 URL 字段路径，逐图上传取回链接，把单元格写成 URL、移除图片，导出 `_with_urls.xlsx`，并可导出「单元格→URL 映射」csv。

> ⚠️ 从 GitHub Pages（github.io）向内网元宝/COS 端点上传通常被 **CORS** 拦截。该功能需端点对本页面放开跨域，或在内网环境使用；否则请使用「下载所有图片」后走 itools 现有「外网转链接服务」。

### 工具二 · 数据聚合
按 `session_id`（缺失时按 `round_id==1` 边界自动生成）分组、`round_id` 排序，把每个 session 的多轮 `prompt` + 图片链接聚合成一行 JSON（`[{prompt, files:[{url,fileName,type}]}]`），输出可上传的 xlsx，末列存放整段 JSON，输出列名可自定义。

### 工具三 · 多轮会话渲染
把每行的 messages 列还原成多轮对话（用户气泡靠右、模型回复靠左，含表格/列表/代码/`[citation:N]` 角标等 markdown 渲染），左侧可切换会话，支持单/双模型对照。可「导出当前 PNG」或「导出全部 (zip)」（html2canvas 截图）。

> ⚠️ 跨域鉴权图片（如 hunyuan 内部链接）可能因浏览器 CORS 无法计入 PNG（显示空白），此时点「查看原图」在新标签打开。本工具不把 PNG 写回 xlsx（浏览器/静态站限制）。

### 工具四 · 转 tlabel jsonl
按 `session_id` 聚合、取 `round_id` 最大（并列取靠后）那一行，严格按 tlabel 平台 KEY 顺序输出 jsonl：
`trace_id / session_id / user_query / model_1_response / model_2_response / model_1_id / model_2_id`。
勾选「双模型」追加第二模型两列（GSB 对照），否则为单模型（DCG）。

## 技术栈

- 纯静态 HTML + 原生 JS（ES5 兼容），免构建
- [PapaParse](https://www.papaparse.com/) 5.4.1（CSV，CDN）
- [SheetJS](https://sheetjs.com/) 0.18.5（XLSX 读/写，CDN）
- [JSZip](https://stuk.github.io/jszip/) 3.10.1（解压 xlsx / 打包，CDN）
- [html2canvas](https://html2canvas.hertzen.com/) 1.4.1（PNG 截图，CDN）

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
├── .nojekyll          # GitHub Pages 关闭 Jekyll
└── README.md
```

## 本地运行

```bash
cd TX_Krismao_iTools
python -m http.server 8080
# 浏览器打开 http://localhost:8080
```

## 已知限制

- **工具一上传** 与向内网服务发请求，受 github.io 的跨域（CORS）限制，多数情况需内网环境或端点放开 CORS。
- **工具三 PNG** 中的鉴权跨域图片可能空白（浏览器 canvas 污染），且不支持把截图写回 xlsx。
- 工具一仅支持 `.xlsx`（`.xls` 请先另存为 `.xlsx`）。
