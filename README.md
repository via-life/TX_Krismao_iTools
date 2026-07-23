# iTools 自动化工具集 · Web 版

把 itools 平台拉题作业流水线上的四个 Python 脚本改造成网页工具：图片转链接、数据聚合、多轮会话渲染、tlabel 格式转换。需求二、四仍是免构建的静态页面；需求三的对话预览与 PNG 导出也可直接在静态页面使用。需求一上传，以及需求三上传截图并把链接写回 Excel，需通过只监听 `127.0.0.1` 的本地服务使用当前电脑的内网能力。

## 在线访问

> 部署后地址：`https://via-life.github.io/TX_Krismao_iTools/`

GitHub Pages 可直接使用需求二、四，以及需求三的对话预览和 PNG 导出。由于浏览器对内网接口的预检会返回 `403`，需求一上传、需求三截图上传及 Excel 链接写回必须双击本地的 `启动.bat` 后使用。

## 四个工具

| # | 工具 | 对应脚本 | 输入 → 输出 |
|---|------|----------|-------------|
| 一 | **Excel 图片转 URL**（`tool1.html`） | `excel2url.py` | xlsx（内嵌图）→ 选择测试/正式环境一键上传，把图片转内部链接并写回 `_with_urls.xlsx`（需本地启动器） |
| 二 | **数据聚合**（`tool2.html`） | `generate_session_json.py` | xlsx/csv/json → 保留原表，按 `cid` 聚合的 JSON 写入第一个空白列（`session`） |
| 三 | **多轮会话渲染**（`tool3.html`） | `convert_to_png.py` | xlsx（messages 列）→ 展示含图片的多轮对话并导出 PNG；本地可选测试/正式环境逐会话上传截图，在原表最右侧新增 `png_url` 并输出新 xlsx |
| 四 | **转 tlabel jsonl**（`tool4.html`） | `convert_xlsx_to_jsonl_GSB.py` | xlsx → jsonl（`cid/user_prompt/model_x_response/model_x_url`，DCG / GSB，单/双模型） |

## 核心增强：自定义列映射

四个工具都内置「自定义列映射」（弹窗式）：导入后先按别名**自动识别**列名（如 `用户提问 / user_prompt / prompt` 都能识别为提问列，`cid / session_id / session` 识别为 session 主键，`session_answer / session_anwser / response` 识别为回复列）；识别不全或不正确时弹窗让你**手动把数据列对应到字段**，图片列还支持多选。因此不再要求表头必须与脚本硬编码列名一致。

## 支持的数据格式

- 文件：`.xlsx` / `.xls` / `.csv` / `.json`，自动识别编码（UTF-8 / GBK / GB18030）。
- 会话内容（工具三）：OpenAI 风格 `messages` 数组（`role` + `content`，`content` 支持纯文本或 `text` / `image_url` 段），兼容 `session_answer` 列内含未转义换行的容错解析。

## 各工具说明

### 工具一 · Excel 图片转 URL
页面只保留两个模块：**上传文件**与**选择环境并上传**，不再要求用户手填 URL、鉴权头、route 或返回字段路径。

1. 上传 xlsx，浏览器本地用 JSZip 解压，按 drawing 锚点提取每张内嵌图及其所在单元格；
2. 选择**测试环境**（默认）或**正式环境**。页面通过 `GET /api/tool1/health` 检查对应本地配置是否就绪，正式上传前会再次确认；
3. 本地服务通过 `POST /api/tool1/upload?env=test|prod&filename=...` 接收单张图片 Blob，并完成元宝上传信息申请与 COS 上传；
4. 图片按顺序逐张上传。失败后已成功 URL 会保留，再次点击只重试失败图片；切换环境或重新选择文件会清空旧 URL，避免不同环境结果混用；
5. 只有全部图片上传成功后，才可下载「单元格→URL 映射」CSV 和 `_with_urls.xlsx`。因此不会出现部分失败却删除整表图片的情况。

上传凭据只保存在本机的 `config.local.json`，该文件已被 Git 忽略；仓库仅提供不含真实值的 `config.example.json`。本地服务仅监听 `127.0.0.1`、拒绝跨域来源，健康检查也只返回测试/正式配置是否就绪，不会把凭据发送给前端。

> ⚠️ GitHub Pages、`file://`、`localhost` 或其他非 `127.0.0.1` 地址不会尝试直连内网上传接口。请双击项目目录中的 `启动.bat`，并从它打开的 `http://127.0.0.1:8080` 页面进入需求一。

### 工具二 · 数据聚合
保留上传表原样，按 `cid` 分组、`round_id` 排序，把每个 session 的多轮内容聚合成一段 JSON（`[{"user prompt","image_url","location",…}]`，即除 `cid/round_id` 外的内容列，`user_prompt` 输出为 `user prompt`），写入**从左往右第一个空白列**（表头命名 `session`，写在该 session 第一行），其它列/行内容不变，导出 `_with_session.xlsx`。

### 工具三 · 多轮会话渲染
把每行的 messages 列还原成多轮对话（用户气泡靠右、模型回复靠左，含表格/列表/代码/`[citation:N]` 角标等 markdown 渲染），左侧可切换会话，支持单/双模型对照。会话图片会直接显示；加载失败时降级为「查看原图」链接，点击已显示的图片可进入灯箱查看。GitHub Pages 可用于预览，以及「导出当前 PNG」和「导出全部 (zip)」。

从 `启动.bat` 打开的本地页面还可完成截图链接写回：

1. 上传 xlsx 并选择**测试环境**（默认）或**正式环境**，正式环境执行前会再次确认；
2. 按会话顺序生成截图并逐张上传，上传成功后保留对应链接；
3. 全部完成后，在原 Excel 最右侧新增 `png_url` 列并写入链接，下载为新 xlsx，原文件不会被覆盖。

> 🔑 **内网图片导出增强**：可选填当前登录态的 Cookie，供本地服务在生成截图时加载受鉴权保护的图片。Cookie 仅用于本次本地处理，不会保存；普通网页预览不需要填写。若图片仍无法加载，页面继续提供原图链接。

> ⚠️ GitHub Pages 只提供需求三的预览与 PNG/zip 导出，不会尝试截图上传或 Excel 链接写回。请双击 `启动.bat`，并从它打开的 `http://127.0.0.1:8080` 页面使用测试/正式上传功能。

### 工具四 · 转 tlabel jsonl
按 `cid` 聚合、取 `round_id` 最大（并列取靠后）那一行，严格按 tlabel 平台 KEY 顺序输出 jsonl：
`cid / user_prompt / model_1_response / model_2_response / model_1_url / model_2_url`。
其中 `model_x_response` 取 `response_x` 列、`model_x_url` 取 `png_x` 列（渲染图公网链接）。勾选「双模型」追加第二模型两列（GSB 对照），否则为单模型（DCG，仅 `model_1_*`）。

## 技术栈

- 前端为静态 HTML + 原生 JS（现代浏览器），免构建；需求二、四及需求三预览/PNG 导出可直接部署到 GitHub Pages
- 需求一上传、需求三截图上传及 Excel 链接写回使用 Python 本地服务，依赖版本固定在 `requirements.txt`（`requests` 与腾讯云 COS SDK）
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
├── css/tool3.css      # 需求三图片预览、环境状态与灯箱样式
├── js/common.js       # 文件解析/编码/messages 解析/xlsx·jsonl 写出/下载
├── js/mapping.js      # 可复用「自定义列映射」组件
├── js/tool1.js ~ tool4.js
├── js/tool3-data.js   # 需求三会话兼容解析与原结构 xlsx 链接写回
├── js/lib/            # 本地化依赖库（PapaParse / SheetJS / JSZip / html2canvas）
├── local_server.py    # 仅监听 127.0.0.1 的静态页面、需求一/三本地接口
├── requirements.txt   # 本地服务依赖及固定版本
├── config.example.json # 不含真实值的配置模板
├── config.local.json  # 本机测试/正式凭据（已被 Git 忽略）
├── 启动.bat            # Windows 一键启动本地服务
├── .nojekyll          # GitHub Pages 关闭 Jekyll
└── README.md
```

## 本地运行

**方式一：一键启动（Windows 推荐）**

双击目录下的 `启动.bat`：它会启动 `local_server.py`（仅监听 `127.0.0.1:8080`）并打开浏览器。**保持那个黑色命令行窗口开着**即可使用；关闭窗口即停止服务。

启动器不会自动安装缺失依赖。若窗口提示缺少依赖，请按提示在项目目录执行：

```powershell
python -m pip install -r requirements.txt
```

本机配置使用 `config.local.json`。新环境可复制 `config.example.json` 后填写测试/正式配置；不要提交、粘贴到前端或写入日志。修改配置后请重启本地服务。

**方式二：手动命令**

```bash
cd TX_Krismao_iTools
python local_server.py --port 8080 --open-browser
# 浏览器打开 http://127.0.0.1:8080
```

> 说明：浏览器出于安全限制，网页自身无法启动本地服务，因此用 `启动.bat` 一键代劳。不要用 `python -m http.server` 运行需求一上传或需求三链接写回，它只能提供静态文件，没有对应 API。需求二、四及需求三预览/PNG 导出仍可直接使用 GitHub Pages。

## 已知限制

- **工具一上传** 仅在 `http://127.0.0.1` 本地服务页面开放，并要求当前电脑已接入对应内网；GitHub Pages、`file://`、`localhost` 与局域网地址均禁用上传。
- **工具一凭据** 若过期或被服务端拒绝，请只更新本机 `config.local.json` 并重启。已在聊天或其他渠道出现过的凭据建议联调后轮换。
- **工具三图片** 会优先直接展示，失败时降级为原图链接；如需把受鉴权图片计入导出，可在本地页面临时填写 Cookie，该值不会保存。
- **工具三链接写回** 仅在 `http://127.0.0.1` 本地服务页面开放；GitHub Pages 只能预览和导出，不能上传截图或写回 xlsx。正式环境上传前必须确认，输出会新增最右侧 `png_url` 列并另存新文件，不覆盖原文件。
- 工具一仅支持 `.xlsx`（`.xls` 请先另存为 `.xlsx`）。
