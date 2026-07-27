# iTools 自动化工具集 · Web 版

把 itools 平台拉题作业流水线上的四个 Python 脚本改造成网页工具：图片转链接、数据聚合、多轮会话渲染、tlabel 格式转换。四个工具都可从免构建的 GitHub Pages 打开；需求一通过同一个 iTools Chrome 助手使用本机内网能力完成测试/正式上传，需求三由助手复用当前浏览器登录态读取受保护图片。需求三会在浏览器本地生成 PNG，并直接嵌入原 Excel 最右侧新增的 `png` 列，不上传云端、不生成链接。`127.0.0.1` 本地服务仍作为需求一上传的回退方式。

## 在线访问

> 部署后地址：`https://via-life.github.io/TX_Krismao_iTools/`

GitHub Pages 可直接使用四个工具。需求一、三页面会自动检测同一个 Chrome 助手：仓库中的公开 ZIP 不含凭据，只能支持需求三读取受保护图片；需求一需先在本机从已被 Git 忽略的 `config.local.json` 构建私有 ZIP，解压并加载后即可在线选择测试/正式环境上传。私有 ZIP 只供生成它的电脑使用，不得提交、上传或对外分发。无法使用扩展时，仍可双击 `启动.bat` 从 `127.0.0.1` 本地页面完成需求一。

## 四个工具

| # | 工具 | 对应脚本 | 输入 → 输出 |
|---|------|----------|-------------|
| 一 | **Excel 图片转 URL**（`tool1.html`） | `excel2url.py` | xlsx（内嵌图）→ 选择测试/正式环境一键上传，把图片转内部链接并写回 `_with_urls.xlsx`（线上使用私有 Chrome 助手，`127.0.0.1` 本地服务可回退） |
| 二 | **数据聚合**（`tool2.html`） | `generate_session_json.py` | xlsx/csv/json → 保留原表，按 `cid` 聚合的 JSON 写入第一个空白列（`session`） |
| 三 | **多轮会话渲染**（`tool3.html`） | `convert_to_png.py` | xlsx（会话数据）→ Chrome 图片助手读取受保护图片，浏览器本地生成完整会话 PNG，嵌入原表最右侧新增的 `png` 列并输出新 xlsx；不上传云端、不生成链接 |
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
2. 选择**测试环境**（默认）或**正式环境**。GitHub Pages 会检测 Chrome 助手是否具备对应环境能力；`127.0.0.1` 页面则通过 `GET /api/tool1/health` 检查本地配置。正式上传前都会再次确认；
3. 在线模式由私有 Chrome 助手接收单张图片，固定调用对应环境的元宝上传信息接口，再上传到固定的广州内网 COS 域名；本地回退模式则通过 `POST /api/tool1/upload?env=test|prod&filename=...` 完成同一流程；
4. 图片按顺序逐张上传。失败后已成功 URL 会保留，再次点击只重试失败图片；切换环境或重新选择文件会清空旧 URL，避免不同环境结果混用；
5. 只有全部图片上传成功后，才可下载「单元格→URL 映射」CSV 和 `_with_urls.xlsx`。因此不会出现部分失败却删除整表图片的情况。

上传凭据源只保存在本机的 `config.local.json`，该文件已被 Git 忽略；仓库仅提供不含真实值的 `config.example.json`。构建脚本会把本机配置写入同样被 Git 忽略的私有扩展 ZIP，网页只接收“测试/正式是否就绪”的能力状态，不读取或展示凭据。本地回退服务仅监听 `127.0.0.1`、拒绝跨域来源，健康检查也只返回配置是否就绪。

在线使用需求一前，先在仓库根目录执行：

```powershell
python scripts/build_private_extension.py
```

脚本会从 `config.local.json` 生成 `downloads/private/itools-browser-helper-private.zip`。解压后在 `chrome://extensions/` 开启开发者模式并“加载已解压的扩展程序”，刷新 GitHub Pages 的需求一页面即可。该私有 ZIP 含本机上传配置，**不得提交 Git、上传到网页、发送给他人或放入共享目录**；`downloads/private/` 已被 Git 忽略。配置轮换后应重新构建并在扩展页重新加载。

> ⚠️ 仓库公开提供的 `downloads/itools-tool3-image-helper.zip` 是无凭据包，只支持需求三图片读取，不能启用需求一上传。`file://`、`localhost` 和其他站点不会获得扩展上传能力；无法安装私有扩展时，请双击 `启动.bat`，并从 `http://127.0.0.1:8080` 进入需求一。

### 工具二 · 数据聚合
保留上传表原样，按 `cid` 分组、`round_id` 排序，把每个 session 的多轮内容聚合成一段 JSON（`[{"user prompt","image_url","location",…}]`，即除 `cid/round_id` 外的内容列，`user_prompt` 输出为 `user prompt`），写入**从左往右第一个空白列**（表头命名 `session`，写在该 session 第一行），其它列/行内容不变，导出 `_with_session.xlsx`。

### 工具三 · 多轮会话渲染
把每行的 messages 列还原成多轮对话（用户气泡靠右、模型回复靠左，含表格/列表/代码/`[citation:N]` 角标等 markdown 渲染），左侧可切换会话，支持单/双模型对照。会话图片会直接显示；加载失败时降级为「查看原图」链接，点击已显示的图片可进入灯箱查看。GitHub Pages 可用于预览，以及「导出当前 PNG」和「导出全部 (zip)」。

需求三的 Excel 输出全程在浏览器本地完成：

1. 上传 xlsx，页面按行解析并还原完整会话；
2. 按会话顺序在浏览器本地生成 PNG，不向测试、正式或其他云端环境上传；单张图片过期或无权限时显示原链接并继续处理；
3. 保留原工作簿内容，在最右侧新增 `png` 列并嵌入每行对应的 PNG，下载为新 xlsx；不会生成图片链接，也不会覆盖用户选择的源文件。

受保护图片由与需求一共用的 **iTools Chrome 助手**读取。打开 GitHub Pages 上的需求三页面后，网页会自动检测扩展；如果尚未安装，页面会提供不含上传凭据的公开 ZIP 下载入口。仅使用需求三时安装公开包即可；已经安装本机私有包的用户无需重复安装。首次使用按以下步骤操作：

1. 在需求三页面下载 [Chrome 图片助手 ZIP](downloads/itools-tool3-image-helper.zip)，并解压到一个固定目录；
2. 打开 `chrome://extensions/`，开启右上角的「开发者模式」；
3. 点击「加载已解压的扩展程序」，选择刚才解压后的扩展目录；
4. 返回需求三页面并刷新。扩展检测成功后，受保护图片会自动使用当前浏览器登录态加载。

如果页面提示版本过旧，请重新下载 2.1.0 或更高版本，覆盖原解压目录后在 `chrome://extensions/` 点击该扩展的「重新加载」。2.1.0 会把图片响应读取权限临时限制在当前需求三标签页和固定元宝下载端点。

Chrome 禁止普通网页静默安装扩展，因此首次使用必须手动完成上述「加载已解压的扩展程序」步骤；之后网页会自动检测，无需重复安装。公开包不包含需求一凭据；私有包由同一份扩展源码在本机生成，并同时支持需求一和需求三。两种包都不申请 Cookie 读取权限，不读取、显示或保存 Cookie；需求三图片请求由浏览器自动复用当前登录态。

> ⚠️ 需求三不需要 `启动.bat`，也不需要手填 Cookie。它不会上传截图，也不会生成或写回图片链接；GitHub Pages 可直接完成图片加载、预览、PNG/zip 导出和 Excel 嵌图。

批量内嵌采用内存受控的流水线：单张 PNG/zip 导出保留 2× 清晰度，Excel 内嵌使用适合表格查看的 1× 清晰度，并针对 1000+ 行减少重复页面重绘和 ZIP 压缩开销。

### 工具四 · 转 tlabel jsonl
按 `cid` 聚合、取 `round_id` 最大（并列取靠后）那一行，严格按 tlabel 平台 KEY 顺序输出 jsonl：
`cid / user_prompt / model_1_response / model_2_response / model_1_url / model_2_url`。
其中 `model_x_response` 取 `response_x` 列、`model_x_url` 取 `png_x` 列（渲染图公网链接）。勾选「双模型」追加第二模型两列（GSB 对照），否则为单模型（DCG，仅 `model_1_*`）。

## 技术栈

- 前端为静态 HTML + 原生 JS（现代浏览器），免构建；四个工具均可从 GitHub Pages 打开，需求一、三通过同一个 Chrome 助手访问受限资源
- 扩展只注入 GitHub Pages 的需求一/三页面，固定 host 权限为元宝图片域名、测试/正式上传信息域名和广州内网 COS 域名；不申请 `cookies` 权限，不读取或输出 Cookie
- 需求一上传中的 COS JavaScript SDK 只用于生成 COS 请求签名，实际网络上传由浏览器 `fetch` 发往固定 COS host，不开放页面传入任意 URL
- Python 本地服务作为需求一的 `127.0.0.1` 回退通道；依赖版本固定在 `requirements.txt`（`requests` 与腾讯云 COS SDK）
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
├── css/tool1.css      # 需求一 Chrome 助手安装与状态样式
├── css/tool3.css      # 需求三图片预览、导出状态与灯箱样式
├── js/common.js       # 文件解析/编码/messages 解析/xlsx·jsonl 写出/下载
├── js/mapping.js      # 可复用「自定义列映射」组件
├── js/tool1.js ~ tool4.js
├── js/tool3-data.js   # 需求三会话兼容解析与原结构 xlsx 图片嵌入
├── js/lib/            # 本地化依赖库（PapaParse / SheetJS / JSZip / html2canvas）
├── chrome-extension/tool3-image-helper/ # iTools 浏览器助手源码（目录名为历史兼容）
├── scripts/build_private_extension.py # 从本机配置构建私有助手 ZIP
├── downloads/itools-tool3-image-helper.zip # 公开无凭据包，仅支持需求三
├── downloads/private/ # 私有助手输出目录（已被 Git 忽略）
├── local_server.py    # 仅监听 127.0.0.1 的静态页面与需求一上传接口
├── requirements.txt   # 本地服务依赖及固定版本
├── config.example.json # 不含真实值的配置模板
├── config.local.json  # 本机测试/正式凭据（已被 Git 忽略）
├── 启动.bat            # Windows 一键启动本地服务
├── .nojekyll          # GitHub Pages 关闭 Jekyll
└── README.md
```

## 构建线上需求一私有助手

先在被 Git 忽略的 `config.local.json` 中填写本机测试/正式配置，再执行：

```powershell
python scripts/build_private_extension.py
```

输出文件为 `downloads/private/itools-browser-helper-private.zip`。解压后打开 `chrome://extensions/`，开启「开发者模式」，点击「加载已解压的扩展程序」并选择解压目录；刷新线上需求一页面后，页面会显示测试/正式环境的就绪状态。Chrome 不允许网页静默安装扩展，因此首次安装和配置轮换后的重新加载需要用户手动完成。

私有 ZIP 包含从本机配置生成的上传凭据，只能保存在本机，**不得提交、上传或对外分发**。公开 ZIP 不含这些值，不能用于需求一上传。

## 本地运行（需求一回退）

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

> 说明：线上需求一优先使用本机私有 Chrome 助手；`启动.bat` 是无需安装私有扩展时的回退方式。不要用 `python -m http.server` 运行需求一上传，它只能提供静态文件，没有对应 API。需求二、三、四始终可直接使用 GitHub Pages。

## 已知限制

- **工具一线上上传** 只允许 GitHub Pages 的固定需求一页面通过已配置的本机私有扩展发起；`file://`、`localhost`、其他站点和公开无凭据包均不能启用上传。当前电脑仍需接入对应内网。
- **工具一本地回退** 使用 `http://127.0.0.1` 和 `config.local.json`；扩展不可用时可继续双击 `启动.bat`。局域网地址不会开放本地接口。
- **工具一凭据** 若过期或被服务端拒绝，请只更新本机 `config.local.json`，随后重新构建并加载私有扩展；使用本地回退时还需重启服务。私有 ZIP 与已在聊天或其他渠道出现过的凭据都应妥善处置并及时轮换。
- **工具三图片** 会优先直接展示；受鉴权图片由 Chrome 图片助手复用浏览器当前登录态读取。首次使用需下载 ZIP，并在 `chrome://extensions/` 开启开发者模式后加载已解压扩展；Chrome 不允许网页静默安装扩展。
- **Chrome 助手权限** 固定为 `https://hunyuan.tencent.com/*`、`https://yuanbao.test.hunyuan.woa.com/*`、`https://yuanbao.tencent.com/*` 与 `https://*.cos-internal.ap-guangzhou.tencentcos.cn/*`；不申请 `cookies` 权限，不读取、显示或保存 Cookie。公开包虽声明同一固定权限集合，但不含需求一凭据，页面会将其标记为上传未就绪。
- **工具三 Excel 嵌图** 在浏览器本地生成并嵌入 PNG，不上传云端、不生成链接；输出会保留原表内容，在最右侧新增 `png` 列并下载为新文件。
- 工具一仅支持 `.xlsx`（`.xls` 请先另存为 `.xlsx`）。
