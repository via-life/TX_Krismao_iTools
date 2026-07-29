# iTools 自动化工具集 · Web 版

四个免构建的静态网页工具，用于图片转链接、数据聚合、多轮会话渲染和 tlabel 格式转换。

在线地址：<https://via-life.github.io/TX_Krismao_iTools/>

## 工具

| 工具 | 输入与输出 |
|---|---|
| 需求一：Excel 图片转 URL | `.xlsx` 内嵌图片 → 测试/正式环境内部 URL → `_with_urls.xlsx` |
| 需求二：数据聚合 | `.xlsx/.xls/.csv/.json` → 按 `cid` 聚合并写入 `session` 列 |
| 需求三：多轮会话渲染 | 会话表格 → 当前 PNG、全部 PNG ZIP、最右侧新增内嵌 `png` 列的 Excel |
| 需求四：转 tlabel jsonl | 表格 → DCG/GSB 所需 jsonl |

## Chrome / Edge 助手

需求一和需求三共用本地安装的 iTools Chromium 浏览器助手 2.1.4：

- 需求一由扩展后台访问固定测试/正式上传接口及广州内网 COS；网页不能传入任意接口或主机。
- 需求三先以无 Cookie 模式读取固定元宝下载端点；401/403 时，扩展只读取固定元宝域名的匹配 Cookie，并通过仅匹配该张图片 URL 的临时规则完成后台请求，再把图片转为本地 Blob。
- `cookies` 权限只用于上述 Edge/Chrome 登录态回退；Cookie 不返回网页、不写日志、不写文件，临时请求规则在请求结束后立即删除。
- 插件源码、私有配置、安装 ZIP、构建脚本和 `启动.bat` 回退包只存放在本地交付目录，不在本仓库提供下载。

首次使用时，从本地交付目录选择 `iTools浏览器助手-v2.1.4`：在 Chrome 打开 `chrome://extensions/`，或在 Edge 打开 `edge://extensions/`，开启开发者模式，点击“加载已解压的扩展程序”，然后刷新需求一或需求三页面。

## 需求三图片导出

预览中的跨域图片可以直接显示，但 Canvas 导出必须先取得图片字节。页面会依次尝试：

1. 使用当前页面和扩展提供的标签页级响应头规则读取图片；
2. 页面读取失败时，由扩展后台按 `resourceId` 从固定下载端点读取；
3. 将返回的 PNG/JPEG/GIF/WebP 二进制转成同源 `blob:` 地址；
4. 等待图片加载和页面绘制后再交给 html2canvas。

图片确实过期、无权限或格式不受支持时，导出会保留原链接并明确报告失败图片数量；失败记录不会永久缓存，可在修复登录态或扩展状态后重新导出。

## GitHub 仓库边界

本仓库只包含 GitHub Pages 必需的静态网页文件：

```text
index.html
tool1.html ~ tool4.html
css/
js/
.nojekyll
README.md
```

不得提交以下内容：Chrome 扩展源码或 ZIP、`config.local.json`、构建脚本、本地 Python 服务、`requirements.txt`、`启动.bat`、私有凭据或测试交付文件。

## 已知限制

- 需求一必须在连接相应内网的电脑上使用包含本机配置的私有扩展。
- 需求三必须使用已登录且有图片权限的 Chrome 或 Edge；过期或无权限图片只能降级为原链接。
- Chromium 浏览器不允许普通网页静默安装本地扩展，首次安装、升级和凭据轮换后均需在扩展页手动重新加载。
- 需求一仅支持 `.xlsx`；`.xls` 请先另存为 `.xlsx`。
