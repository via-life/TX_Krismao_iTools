# iTools 浏览器助手

该 Chrome Manifest V3 扩展同时服务于 iTools 需求一和需求三：

- 需求一：使用私有包中的测试/正式配置申请临时 COS 凭据，并从当前电脑的内网环境上传 Excel 内嵌图片。
- 需求三：使用当前 Chrome 登录态读取元宝受保护图片，供网页在浏览器本地生成并嵌入 PNG。

扩展不申请 `cookies` 权限，不读取、显示或保存 Cookie，也不会把长期上传凭据或临时 COS 密钥返回给网页。

## 两种安装包

- 公开包 `downloads/itools-tool3-image-helper.zip`：不含上传凭据，仅支持需求三。
- 本机私有包 `downloads/private/itools-browser-helper-private.zip`：由仓库根目录的 `config.local.json` 本地生成，同时支持需求一和需求三。

构建私有包：

```powershell
python scripts/build_private_extension.py
```

私有 ZIP 包含本机上传凭据，只能保存在本机，不得提交、上传、共享或对外分发。

## 安装

1. 解压公开或私有 ZIP 到固定文件夹。
2. 在 Chrome 打开 `chrome://extensions/`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择解压目录。
5. 刷新对应的 iTools 页面。

升级到 2.1.0 或更高版本时，请覆盖旧解压目录，并在 `chrome://extensions/` 点击该扩展的「重新加载」。Chrome 不允许普通网页静默安装扩展，因此首次安装、版本升级和凭据轮换后的重新加载需要手动完成。

## 权限范围

内容脚本只注入：

- `https://via-life.github.io/TX_Krismao_iTools/tool1.html`
- `https://via-life.github.io/TX_Krismao_iTools/tool3.html`

固定 host 权限：

- `https://hunyuan.tencent.com/*`
- `https://yuanbao.test.hunyuan.woa.com/*`
- `https://yuanbao.tencent.com/*`
- `https://*.cos-internal.ap-guangzhou.tencentcos.cn/*`

后台不接受页面传入的 URL、接口地址或 host。需求一只调用固定的 `genUploadInfo` 接口；腾讯云 COS JavaScript SDK只用于 `COS.getAuthorization` 签名，实际图片 PUT 使用 Service Worker 原生 `fetch` 发往固定广州内网 COS 后缀。需求三仅在当前工具三标签页存活期间，为固定的元宝图片下载端点补充可读响应头；规则按标签页限制，离开或关闭页面后撤销。

## 凭据文件

仓库中的 `credentials.js` 必须始终保持空模板：

```js
globalThis.ITOOLS_PRIVATE_CONFIG = {};
```

打包脚本只在私有 ZIP 内存数据中替换该文件，不会把真实值写回扩展源码。公开 ZIP也只包含空模板。

## 页面通信

需求一页面：

```js
{ source: "itools-tool1-page", type: "PING" }
```

```js
{
  source: "itools-tool1-page",
  type: "UPLOAD_TOOL1_IMAGE",
  requestId: "页面生成的请求标识",
  env: "test",
  filename: "Sheet1_A1.png",
  mime: "image/png",
  base64: "..."
}
```

扩展仅返回版本、环境就绪状态，以及上传成功后的 `resourceUrl` 或脱敏错误。需求三继续使用 `itools-tool3-page` / `itools-tool3-extension` 的 `FETCH_HUNYUAN_IMAGE` 协议。