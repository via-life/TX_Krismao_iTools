# iTools 需求三图片助手

该 Chrome Manifest V3 扩展让线上工具三使用当前浏览器的元宝登录态读取资源图片。扩展不会读取、保存或输出 Cookie，也不会把图片上传到其他服务。

## 安装

1. 下载并解压扩展包。
2. 在 Chrome 打开 `chrome://extensions/`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择本目录。
5. 刷新工具三页面：
   `https://via-life.github.io/TX_Krismao_iTools/tool3.html`

## 权限范围

- 只注入上述工具三页面。
- 只允许访问 `https://hunyuan.tencent.com/`。
- 不申请 `cookies` 权限。
- 后台只接受 `resourceId`，并固定构造
  `https://hunyuan.tencent.com/api/resource/download?resourceId=...`。
- `resourceId` 只允许 8–160 位英文字母、数字、下划线或连字符。
- 单张图片最大为 30 MiB，且响应必须是受支持的图片 MIME 类型。

## 页面通信协议

页面通过 `window.postMessage` 发送：

```js
{ source: "itools-tool3-page", type: "PING" }
```

```js
{
  source: "itools-tool3-page",
  type: "FETCH_HUNYUAN_IMAGE",
  requestId: "页面生成的请求标识",
  resourceId: "元宝资源标识"
}
```

扩展返回：

```js
{
  source: "itools-tool3-extension",
  type: "PONG",
  version: "1.0.0"
}
```

```js
{
  source: "itools-tool3-extension",
  type: "IMAGE_RESULT",
  requestId: "原请求标识",
  ok: true,
  mime: "image/png",
  base64: "..."
}
```

失败时只返回脱敏错误：

```js
{
  source: "itools-tool3-extension",
  type: "IMAGE_RESULT",
  requestId: "原请求标识",
  ok: false,
  error: {
    code: "IMAGE_AUTH_REQUIRED",
    message: "图片需要有效的元宝登录状态，请登录后重试。"
  }
}
```

扩展不会接受或转发页面传入的任意 URL。
