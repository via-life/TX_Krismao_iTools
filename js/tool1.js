/* ============================================================
   tool1.js —— Excel 图片转 URL（移植 excel2url.py 的 ZIP 方案到浏览器）
   1) JSZip 解压 xlsx，解析 drawings 锚点 → (sheet, 列, 行, media 路径)
   2) 预览每张图 + 所在单元格；打包下载
   3) 网页模式通过 Chrome 助手逐图上传；本地页面保留 127.0.0.1 服务回退。
      取回 URL 后写回单元格、移除图片并导出 _with_urls.xlsx
   ============================================================ */
(function () {
  'use strict';
  var T = window.iTools;
  var NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  var TOOL1_PAGE_SOURCE = 'itools-tool1-page';
  var TOOL1_EXTENSION_SOURCE = 'itools-tool1-extension';
  var HELPER_PING = 'PING';
  var HELPER_PONG = 'PONG';
  var HELPER_UPLOAD = 'UPLOAD_TOOL1_IMAGE';
  var HELPER_UPLOAD_RESULT = 'TOOL1_UPLOAD_RESULT';
  var HELPER_MAX_IMAGE_BYTES = 30 * 1024 * 1024;
  var HELPER_REQUEST_TIMEOUT_MS = 60000;

  var state = { zip: null, fileName: '', images: [], imagesReady: false, uploading: false, generating: false, fileGeneration: 0 };
  var service = {
    allowed: window.location.protocol === 'http:' && window.location.hostname === '127.0.0.1',
    checked: false,
    failed: false,
    environments: { test: false, prod: false }
  };
  var uploadHelper = {
    connected: false,
    status: 'checking',
    version: '',
    capabilities: { tool1UploadReady: false, testReady: false, prodReady: false },
    pending: Object.create(null),
    requestSequence: 0,
    pingSequence: 0,
    lastPongSequence: 0,
    pingTimer: null
  };
  // images: [{sheetNum, sheetPath, drawingPath, col0, row0, cellRef, media, bytes, blob, url}]
  var el = {};
  ['dropzone', 'pick-btn', 'file-input', 'file-name', 'status', 'service-notice',
   'upload-section', 'env-hint', 'upload-helper-status', 'upload-helper-install',
   'upload-helper-connected', 'upload-helper-version', 'upload-helper-capabilities',
   'copy-extensions-url',
   'norm-header', 'do-upload', 'dl-mapping', 'dl-xlsx', 'up-status'].forEach(function (id) { el[id] = document.getElementById(id); });

  function setStatus(node, msg, kind) {
    node.hidden = false;
    node.className = 'status' + (kind ? ' is-' + kind : '');
    node.textContent = msg;
  }

  function envMode() { var r = document.querySelector('input[name="env"]:checked'); return r ? r.value : 'test'; }
  function envLabel(mode) { return mode === 'prod' ? '正式环境' : '测试环境'; }

  function successfulCount() {
    return state.images.filter(function (im) { return !!im.url; }).length;
  }

  function allUploaded() {
    return state.images.length > 0 && successfulCount() === state.images.length;
  }

  function helperEnvReady(mode) {
    return uploadHelper.connected &&
      uploadHelper.capabilities.tool1UploadReady === true &&
      uploadHelper.capabilities[mode === 'prod' ? 'prodReady' : 'testReady'] === true;
  }

  function localEnvReady(mode) {
    return service.allowed && service.checked && !service.failed && service.environments[mode] === true;
  }

  function activeTransport(mode) {
    if (helperEnvReady(mode)) return 'extension';
    if (localEnvReady(mode)) return 'local';
    return '';
  }

  function helperPageSupported() {
    return window.location.protocol === 'https:' &&
      window.location.hostname === 'via-life.github.io' &&
      window.location.pathname === '/TX_Krismao_iTools/tool1.html';
  }

  function resetUploadResults(message) {
    state.images.forEach(function (im) { im.url = ''; });
    el['dl-mapping'].disabled = true;
    el['dl-xlsx'].disabled = true;
    if (message) setStatus(el['up-status'], message, 'warn');
    else el['up-status'].hidden = true;
    updateUploadButton();
  }

  function updateUploadButton() {
    var ready = !!activeTransport(envMode());
    el['do-upload'].disabled = state.uploading || state.generating || !state.imagesReady || !ready || allUploaded();
    if (state.uploading) el['do-upload'].textContent = '正在上传…';
    else if (allUploaded()) el['do-upload'].textContent = '上传已完成';
    else if (successfulCount()) el['do-upload'].textContent = '继续上传失败项';
    else el['do-upload'].textContent = '开始上传图片';
  }

  function applyEnv() {
    var mode = envMode();
    if (helperEnvReady(mode)) {
      el['service-notice'].hidden = true;
      setStatus(el['env-hint'], 'Chrome 上传助手已连接，' + envLabel(mode) + '已就绪。上传会使用当前浏览器的内网能力。', 'ok');
    } else if (localEnvReady(mode)) {
      el['service-notice'].hidden = true;
      setStatus(el['env-hint'], 'Chrome 助手未就绪，已回退到本地上传服务；' + envLabel(mode) + '配置就绪。', 'ok');
    } else if (uploadHelper.connected && !uploadHelper.capabilities.tool1UploadReady) {
      setStatus(el['env-hint'], 'Chrome 助手已连接，但当前安装包未配置需求一上传。请安装管理员提供的本机私有扩展包，或从“启动.bat”进入。', 'warn');
    } else if (uploadHelper.connected) {
      setStatus(el['env-hint'], 'Chrome 助手已连接，但' + envLabel(mode) + '凭据未就绪。请更新本机私有扩展包或切换环境。', 'warn');
    } else if (uploadHelper.status === 'checking' || (service.allowed && !service.checked)) {
      setStatus(el['env-hint'], '正在检测 Chrome 上传助手和可用上传通道…');
    } else if (service.allowed && service.failed) {
      setStatus(el['env-hint'], 'Chrome 助手与本地上传服务均不可用。请确认扩展已启用，或重新双击“启动.bat”。', 'error');
    } else if (service.allowed) {
      setStatus(el['env-hint'], envLabel(mode) + '配置未就绪。请更新 Chrome 私有扩展包，或检查 config.local.json。', 'error');
    } else {
      setStatus(el['env-hint'], '网页上传需要 Chrome 上传助手。请按上方步骤安装；需求一还需管理员提供的本机私有配置。', 'warn');
    }
    if (!service.allowed && !helperEnvReady(mode)) {
      setStatus(el['service-notice'], helperPageSupported() ?
        '当前为 GitHub Pages 模式：需求一只能通过已配置的 Chrome 私有上传助手使用内网能力，不会连接 127.0.0.1。' :
        '当前页面来源不能使用 Chrome 上传助手。请打开 GitHub Pages，或从“启动.bat”进入。', 'warn');
    }
    updateUploadButton();
  }

  function updateUploadHelperStatus(status, version) {
    uploadHelper.status = status;
    uploadHelper.connected = status === 'connected';
    if (uploadHelper.connected) uploadHelper.version = String(version || '未知');
    var ready = uploadHelper.connected && uploadHelper.capabilities.tool1UploadReady;
    el['upload-helper-status'].className = 't1-helper-status is-' +
      (uploadHelper.connected && !ready ? 'unready' : status);
    if (uploadHelper.connected) {
      el['upload-helper-status'].textContent = ready ? 'Chrome 上传助手已连接。' : 'Chrome 助手已连接，但需求一上传尚未配置。';
    } else if (status === 'checking') {
      el['upload-helper-status'].textContent = '正在检测 Chrome 上传助手…';
    } else if (status === 'local') {
      el['upload-helper-status'].textContent = '当前为 127.0.0.1 本地页面，将使用本地上传服务，无需 Chrome 助手。';
    } else if (status === 'unsupported') {
      el['upload-helper-status'].textContent = '当前页面来源不受 Chrome 助手支持。请打开 GitHub Pages，或从“启动.bat”进入。';
    } else {
      el['upload-helper-status'].textContent = '未检测到可用于需求一的 Chrome 上传助手，请安装管理员提供的本机私有扩展包。';
    }
    el['upload-helper-install'].hidden = uploadHelper.connected || status === 'checking' || status === 'local' || status === 'unsupported';
    el['upload-helper-connected'].hidden = !uploadHelper.connected;
    if (uploadHelper.connected) {
      el['upload-helper-version'].textContent = uploadHelper.version;
      el['upload-helper-capabilities'].textContent = ready ?
        ('测试环境：' + (uploadHelper.capabilities.testReady ? '已就绪' : '未配置') +
         '；正式环境：' + (uploadHelper.capabilities.prodReady ? '已就绪' : '未配置')) :
        '当前为公开无凭据包；需求一请使用管理员提供的本机私有扩展包。';
    }
    applyEnv();
  }

  function pingUploadHelper() {
    if (!helperPageSupported()) {
      updateUploadHelperStatus(service.allowed ? 'local' : 'unsupported');
      return;
    }
    var pingSequence = ++uploadHelper.pingSequence;
    if (!uploadHelper.connected) updateUploadHelperStatus('checking');
    window.postMessage({ source: TOOL1_PAGE_SOURCE, type: HELPER_PING }, window.location.origin);
    clearTimeout(uploadHelper.pingTimer);
    uploadHelper.pingTimer = setTimeout(function () {
      if (uploadHelper.lastPongSequence < pingSequence) updateUploadHelperStatus('missing');
    }, 1200);
  }

  function checkLocalService() {
    if (!service.allowed) {
      service.checked = true;
      service.failed = false;
      applyEnv();
      return;
    }
    setStatus(el['service-notice'], '正在连接本地上传服务…');
    fetch('/api/tool1/health', { method: 'GET', headers: { 'Accept': 'application/json' }, cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) { return { response: r, data: data }; });
    }).then(function (result) {
      if (!result.response.ok || !result.data || result.data.ok !== true) throw new Error('健康检查失败');
      var environments = result.data.environments || {};
      service.environments.test = !!(environments.test && environments.test.ready);
      service.environments.prod = !!(environments.prod && environments.prod.ready);
      service.checked = true;
      service.failed = false;
      el['service-notice'].hidden = true;
      applyEnv();
    }).catch(function () {
      service.checked = false;
      service.failed = true;
      setStatus(el['service-notice'], '未连接到需求一本地上传服务。请关闭当前静态服务器后双击“启动.bat”，不要使用 python -m http.server。', 'error');
      applyEnv();
    });
  }

  T.bindFileInput({ dropzone: el.dropzone, fileInput: el['file-input'], pickBtn: el['pick-btn'], onFile: onFile });
  el['do-upload'].addEventListener('click', doUpload);
  el['dl-mapping'].addEventListener('click', downloadMapping);
  el['dl-xlsx'].addEventListener('click', downloadRewritten);
  el['copy-extensions-url'].addEventListener('click', function () {
    var value = 'chrome://extensions';
    function copied() {
      el['copy-extensions-url'].textContent = '已复制';
      setTimeout(function () { el['copy-extensions-url'].textContent = '复制 chrome://extensions'; }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(copied).catch(function () {
        window.prompt('请复制并粘贴到 Chrome 地址栏：', value);
      });
    } else {
      window.prompt('请复制并粘贴到 Chrome 地址栏：', value);
    }
  });
  [].forEach.call(document.querySelectorAll('input[name="env"]'), function (r) {
    r.addEventListener('change', function () {
      resetUploadResults('已切换至' + envLabel(envMode()) + '，上一环境的上传结果已清空。');
      applyEnv();
    });
  });
  window.addEventListener('message', onUploadHelperMessage);
  window.addEventListener('focus', pingUploadHelper);
  checkLocalService();
  pingUploadHelper();

  /* ---------- 列号 ↔ 字母 ---------- */
  function colLetter(col1) {
    var s = '';
    while (col1 > 0) { var m = (col1 - 1) % 26; s = String.fromCharCode(65 + m) + s; col1 = Math.floor((col1 - 1) / 26); }
    return s;
  }

  /* ---------- 路径解析（相对 xl/drawings/ ）---------- */
  function resolvePath(base, target) {
    if (target.charAt(0) === '/') return target.slice(1);
    var parts = base.split('/'); parts.pop(); // 去掉文件名，保留目录
    target.split('/').forEach(function (seg) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    });
    return parts.join('/');
  }

  function xml(str) { return new DOMParser().parseFromString(str, 'application/xml'); }

  function onFile(file) {
    if (state.uploading || state.generating) { setStatus(el.status, '正在处理当前文件，请等待完成后再更换文件。', 'warn'); return; }
    var generation = ++state.fileGeneration;
    resetUploadResults();
    state.zip = null;
    state.fileName = '';
    state.images = [];
    state.imagesReady = false;
    el['upload-section'].hidden = true;
    el['file-name'].hidden = true;
    el['file-name'].textContent = '';
    updateUploadButton();
    if (!/\.xlsx$/i.test(file.name)) { setStatus(el.status, '仅支持 .xlsx（xls 需先另存为 xlsx）。旧文件的上传结果已清空。', 'error'); return; }
    el['file-name'].hidden = false; el['file-name'].textContent = '已选择：' + file.name;
    state.fileName = file.name;
    setStatus(el.status, '正在解压并解析图片…');
    var selectedZip = null;
    var selectedImages = null;
    T.readArrayBuffer(file).then(function (buf) {
      if (generation !== state.fileGeneration) throw { staleFile: true };
      return JSZip.loadAsync(buf);
    }).then(function (zip) {
      if (generation !== state.fileGeneration) throw { staleFile: true };
      selectedZip = zip;
      return extractImages(zip);
    }).then(function (imgs) {
      if (generation !== state.fileGeneration) throw { staleFile: true };
      selectedImages = imgs;
      return imgs.length ? loadBlobs(imgs, selectedZip) : Promise.resolve();
    }).then(function () {
      if (generation !== state.fileGeneration) throw { staleFile: true };
      state.zip = selectedZip;
      state.images = selectedImages;
      if (selectedImages.length) {
        el['upload-section'].hidden = false;
        state.imagesReady = true;
        setStatus(el.status, '共提取 ' + selectedImages.length + ' 张图片。请选择测试或正式环境后上传。', 'ok');
      } else {
        setStatus(el.status, '未在该 xlsx 中找到内嵌图片（图片可能是浮动/链接形式）。', 'warn');
      }
      updateUploadButton();
    }).catch(function (e) {
      if (e && e.staleFile) return;
      if (generation !== state.fileGeneration) return;
      state.zip = null;
      state.images = [];
      state.imagesReady = false;
      el['upload-section'].hidden = true;
      updateUploadButton();
      setStatus(el.status, '解析失败：' + e.message, 'error');
    });
  }

  /* ---------- 解析 sheet→drawing→图片锚点 ---------- */
  function extractImages(zip) {
    var names = Object.keys(zip.files);
    // sheetN → drawingM
    var sheetDrawing = [];
    var relRe = /^xl\/worksheets\/_rels\/sheet(\d+)\.xml\.rels$/;
    var tasks = [];
    names.forEach(function (n) {
      var m = n.match(relRe);
      if (!m) return;
      tasks.push(zip.file(n).async('string').then(function (s) {
        var doc = xml(s);
        var partPath = 'xl/worksheets/sheet' + m[1] + '.xml'; // rels 的 Target 相对于所属 part（sheet 文件），非 .rels 文件
        var rels = doc.getElementsByTagName('Relationship');
        for (var i = 0; i < rels.length; i++) {
          var tgt = rels[i].getAttribute('Target') || '';
          var dm = tgt.match(/drawing(\d+)\.xml/);
          if (dm) sheetDrawing.push({ sheetNum: parseInt(m[1], 10), sheetPath: partPath,
            drawingPath: resolvePath(partPath, tgt) });
        }
      }));
    });

    return Promise.all(tasks).then(function () {
      var imgTasks = sheetDrawing.map(function (sd) {
        var relPath = sd.drawingPath.replace(/drawings\/(drawing\d+\.xml)$/, 'drawings/_rels/$1.rels');
        return Promise.all([
          zip.file(sd.drawingPath) ? zip.file(sd.drawingPath).async('string') : Promise.resolve(''),
          zip.file(relPath) ? zip.file(relPath).async('string') : Promise.resolve('')
        ]).then(function (r) { return parseDrawing(sd, r[0], r[1]); });
      });
      return Promise.all(imgTasks).then(function (lists) {
        var all = [];
        lists.forEach(function (l) { all = all.concat(l); });
        return all;
      });
    });
  }

  var R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  // 按 local name 取元素，忽略前缀（Excel 用 xdr:/a:，openpyxl 无前缀）
  function byLocal(node, local) { return [].slice.call(node.getElementsByTagNameNS('*', local)); }

  function parseDrawing(sd, drawingXml, relsXml) {
    if (!drawingXml) return [];
    var relMap = {};
    if (relsXml) {
      var rd = xml(relsXml).getElementsByTagName('Relationship');
      for (var i = 0; i < rd.length; i++) relMap[rd[i].getAttribute('Id')] = rd[i].getAttribute('Target');
    }
    var doc = xml(drawingXml);
    var out = [];
    var anchors = byLocal(doc, 'twoCellAnchor').concat(byLocal(doc, 'oneCellAnchor'));
    anchors.forEach(function (anc) {
      var from = byLocal(anc, 'from')[0];
      if (!from) return;
      var colEl = byLocal(from, 'col')[0];
      var rowEl = byLocal(from, 'row')[0];
      if (!colEl || !rowEl) return;
      var col0 = parseInt(colEl.textContent, 10), row0 = parseInt(rowEl.textContent, 10);
      var blip = byLocal(anc, 'blip')[0];
      if (!blip) return;
      var embed = blip.getAttributeNS(R_NS, 'embed') || blip.getAttribute('r:embed');
      var tgt = relMap[embed];
      if (!tgt) return;
      var media = resolvePath(sd.drawingPath, tgt);
      out.push({ sheetNum: sd.sheetNum, sheetPath: sd.sheetPath, drawingPath: sd.drawingPath,
        col0: col0, row0: row0, cellRef: colLetter(col0 + 1) + (row0 + 1), media: media, url: '' });
    });
    return out;
  }

  function loadBlobs(imgs, zip) {
    return Promise.all(imgs.map(function (im) {
      var f = zip.file(im.media);
      if (!f) return Promise.resolve();
      return f.async('blob').then(function (blob) { im.blob = blob; });
    }));
  }

  /* ---------- 上传 ---------- */
  function setUploading(uploading) {
    state.uploading = uploading;
    el['pick-btn'].disabled = uploading;
    el['file-input'].disabled = uploading;
    [].forEach.call(document.querySelectorAll('input[name="env"]'), function (r) { r.disabled = uploading; });
    updateUploadButton();
  }

  function setGenerating(generating) {
    state.generating = generating;
    el['pick-btn'].disabled = generating;
    el['file-input'].disabled = generating;
    el['norm-header'].disabled = generating;
    [].forEach.call(document.querySelectorAll('input[name="env"]'), function (r) { r.disabled = generating; });
    el['dl-mapping'].disabled = generating || !allUploaded();
    el['dl-xlsx'].disabled = generating || !allUploaded();
    updateUploadButton();
  }

  function helperCapabilitiesFromMessage(message) {
    var capabilities = message && message.capabilities;
    if (!capabilities || typeof capabilities !== 'object') capabilities = message || {};
    return {
      tool1UploadReady: capabilities.tool1UploadReady === true,
      testReady: capabilities.testReady === true,
      prodReady: capabilities.prodReady === true
    };
  }

  function validUploadedUrl(value) {
    try {
      var parsed = new URL(String(value || '').trim());
      return parsed.protocol === 'https:' && !!parsed.hostname ? parsed.href : '';
    } catch (_) {
      return '';
    }
  }

  function onUploadHelperMessage(event) {
    var message = event.data;
    if (!helperPageSupported() || event.source !== window || event.origin !== window.location.origin || !message ||
        message.source !== TOOL1_EXTENSION_SOURCE) return;
    if (message.type === HELPER_PONG) {
      clearTimeout(uploadHelper.pingTimer);
      uploadHelper.lastPongSequence = uploadHelper.pingSequence;
      uploadHelper.capabilities = helperCapabilitiesFromMessage(message);
      updateUploadHelperStatus('connected', message.version);
      return;
    }
    if (message.type !== HELPER_UPLOAD_RESULT || !message.requestId) return;
    var pending = uploadHelper.pending[message.requestId];
    if (!pending) return;
    clearTimeout(pending.timer);
    delete uploadHelper.pending[message.requestId];
    if (!message.ok) {
      var helperError = message.error || {};
      pending.reject(new Error(helperError.message || 'Chrome 上传助手处理失败，请重试。'));
      return;
    }
    var url = validUploadedUrl(message.url);
    if (!url) {
      pending.reject(new Error('Chrome 上传助手未返回有效的 HTTPS URL。'));
      return;
    }
    pending.resolve(url);
  }

  function blobToBase64(blob) {
    if (blob.size > HELPER_MAX_IMAGE_BYTES) {
      return Promise.reject(new Error('单张图片超过 Chrome 上传助手的 30 MiB 限制。'));
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || '');
        var comma = result.indexOf(',');
        if (comma < 0 || !result.slice(comma + 1)) {
          reject(new Error('图片内容编码失败，请重新选择 Excel。'));
          return;
        }
        resolve(result.slice(comma + 1));
      };
      reader.onerror = function () { reject(new Error('图片内容读取失败，请重新选择 Excel。')); };
      reader.onabort = function () { reject(new Error('图片内容读取已取消。')); };
      reader.readAsDataURL(blob);
    });
  }

  function mimeForExtension(extension) {
    var types = {
      bmp: 'image/bmp', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg',
      png: 'image/png', tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp'
    };
    return types[String(extension || '').toLowerCase()] || 'application/octet-stream';
  }

  function uploadWithExtension(im, mode, filename, extension) {
    if (!helperEnvReady(mode)) {
      return Promise.reject(new Error('Chrome 上传助手或当前环境已断开，请刷新页面后重试。'));
    }
    return blobToBase64(im.blob).then(function (base64) {
      return new Promise(function (resolve, reject) {
        var requestId = 'tool1-' + Date.now() + '-' + (++uploadHelper.requestSequence);
        var timer = setTimeout(function () {
          delete uploadHelper.pending[requestId];
          reject(new Error('Chrome 上传助手响应超时，请确认扩展已启用且内网连接正常。'));
        }, HELPER_REQUEST_TIMEOUT_MS);
        uploadHelper.pending[requestId] = { resolve: resolve, reject: reject, timer: timer };
        window.postMessage({
          source: TOOL1_PAGE_SOURCE,
          type: HELPER_UPLOAD,
          requestId: requestId,
          env: mode,
          filename: filename,
          mime: im.blob.type || mimeForExtension(extension),
          base64: base64
        }, window.location.origin);
      });
    });
  }

  function uploadWithLocalService(im, mode, filename) {
    var endpoint = '/api/tool1/upload?env=' + encodeURIComponent(mode) + '&filename=' + encodeURIComponent(filename);
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': im.blob.type || 'application/octet-stream'
      },
      body: im.blob
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) { return { response: r, data: data }; });
    }).then(function (result) {
      var data = result.data;
      if (!result.response.ok || !data || data.ok !== true) {
        var message = data && data.error && data.error.message;
        throw new Error(message || ('本地上传服务返回 HTTP ' + result.response.status + '。'));
      }
      var url = validUploadedUrl(data.url);
      if (!url) throw new Error('本地上传服务未返回有效的 HTTPS URL。');
      return url;
    });
  }

  function uploadOne(im, mode, transport) {
    if (!im.blob) return Promise.reject(new Error(im.cellRef + ' 对应的图片内容读取失败。'));
    var extension = (im.media.split('.').pop() || 'png').replace(/[^a-zA-Z0-9]/g, '') || 'png';
    var filename = 'Sheet' + im.sheetNum + '_' + im.cellRef + '.' + extension;
    return transport === 'extension' ?
      uploadWithExtension(im, mode, filename, extension) :
      uploadWithLocalService(im, mode, filename);
  }

  function doUpload() {
    if (state.uploading) return;
    if (!state.imagesReady || !state.images.length) { setStatus(el['up-status'], '请先选择并解析含图片的 xlsx。', 'error'); return; }
    var mode = envMode();
    var transport = activeTransport(mode);
    if (!transport) {
      setStatus(el['up-status'], envLabel(mode) + '上传通道未就绪。请安装并配置 Chrome 上传助手；本地页面也可检查 config.local.json。', 'error');
      return;
    }
    if (mode === 'prod' && !window.confirm('即将把图片上传到正式环境。请确认文件和环境无误，是否继续？')) return;

    var total = state.images.length;
    var ok = successfulCount();
    var done = ok;
    var failed = 0;
    var lastError = '';
    el['dl-mapping'].disabled = true;
    el['dl-xlsx'].disabled = true;
    setUploading(true);
    setStatus(el['up-status'], ok ? ('继续上传未完成图片… 已保留 ' + ok + '/' + total + ' 个成功结果。') : ('开始上传… 0/' + total));
    var chain = Promise.resolve();
    state.images.forEach(function (im) {
      if (im.url) return;
      chain = chain.then(function () {
        return uploadOne(im, mode, transport).then(function (url) {
          im.url = url;
          ok++;
          done++;
          setStatus(el['up-status'], '上传中… ' + done + '/' + total + '（成功 ' + ok + '）');
        }).catch(function (e) {
          done++;
          failed++;
          lastError = (e && e.message) ? e.message : '未知错误';
          if (/Failed to fetch|NetworkError|Load failed/i.test(lastError)) {
            lastError = transport === 'extension' ?
              'Chrome 上传助手无法连接内网接口，请确认本机私有扩展配置和内网连接。' :
              '无法连接本地上传服务，请确认“启动.bat”窗口仍在运行且当前内网可用。';
          }
          setStatus(el['up-status'], '上传中… ' + done + '/' + total + '（成功 ' + ok + '，最近错误：' + lastError + '）', 'warn');
        });
      });
    });
    chain.then(function () {
      setUploading(false);
      var complete = allUploaded();
      el['dl-mapping'].disabled = !complete;
      el['dl-xlsx'].disabled = !complete;
      if (complete) setStatus(el['up-status'], '全部上传完成：成功 ' + total + '/' + total + '。现在可以下载映射 CSV 或 _with_urls.xlsx。', 'ok');
      else if (ok) setStatus(el['up-status'], '本轮完成：成功 ' + ok + '/' + total + '，失败 ' + failed + '。成功结果已保留；点击“继续上传失败项”只会重试失败图片。最近错误：' + lastError, 'warn');
      else setStatus(el['up-status'], '全部上传失败。' + (lastError ? '最近错误：' + lastError : '请检查本地服务与内网连接。'), 'error');
    });
  }

  function downloadMapping() {
    if (state.generating) return;
    if (!allUploaded()) { setStatus(el['up-status'], '仍有图片未上传成功，暂不能生成映射文件。请先重试失败项。', 'error'); return; }
    var lines = ['sheet,cell,url'];
    state.images.forEach(function (im) {
      if (im.url) lines.push('Sheet' + im.sheetNum + ',' + im.cellRef + ',"' + im.url.replace(/"/g, '""') + '"');
    });
    T.downloadBlob(state.fileName.replace(/\.xlsx$/i, '') + '_url_mapping.csv',
      new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
  }

  /* ---------- 重写 xlsx：单元格写 URL + 移除图片 ---------- */
  function setCellInline(doc, col0, row0, value) {
    var ref = colLetter(col0 + 1) + (row0 + 1);
    var sheetData = doc.getElementsByTagName('sheetData')[0];
    if (!sheetData) return;
    var rows = sheetData.getElementsByTagName('row'), targetRow = null;
    for (var i = 0; i < rows.length; i++) { if (rows[i].getAttribute('r') === String(row0 + 1)) { targetRow = rows[i]; break; } }
    if (!targetRow) {
      targetRow = doc.createElementNS(NS, 'row');
      targetRow.setAttribute('r', String(row0 + 1));
      // 按行号有序插入
      var inserted = false;
      for (var j = 0; j < rows.length; j++) {
        if (parseInt(rows[j].getAttribute('r'), 10) > row0 + 1) { sheetData.insertBefore(targetRow, rows[j]); inserted = true; break; }
      }
      if (!inserted) sheetData.appendChild(targetRow);
    }
    var cells = targetRow.getElementsByTagName('c'), cell = null;
    for (var k = 0; k < cells.length; k++) { if (cells[k].getAttribute('r') === ref) { cell = cells[k]; break; } }
    if (!cell) {
      cell = doc.createElementNS(NS, 'c');
      cell.setAttribute('r', ref);
      targetRow.appendChild(cell);
    }
    cell.setAttribute('t', 'inlineStr');
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    var is = doc.createElementNS(NS, 'is');
    var t = doc.createElementNS(NS, 't');
    t.setAttribute('xml:space', 'preserve');
    t.textContent = value;
    is.appendChild(t); cell.appendChild(is);
  }

  function removeDrawings(doc) {
    var d = doc.getElementsByTagName('drawing');
    for (var i = d.length - 1; i >= 0; i--) d[i].parentNode.removeChild(d[i]);
  }

  function normalizeHeaderRow(doc, zip, sheetPath) {
    // 仅处理 inlineStr 表头；sharedString 表头因需改 sharedStrings 略过（保守）
    var sheetData = doc.getElementsByTagName('sheetData')[0];
    if (!sheetData) return;
    var rows = sheetData.getElementsByTagName('row');
    if (!rows.length) return;
    var first = rows[0];
    var cells = first.getElementsByTagName('c');
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (c.getAttribute('t') !== 'inlineStr') continue;
      var tEl = c.getElementsByTagName('t')[0];
      if (!tEl) continue;
      var v = (tEl.textContent || '').trim();
      var nv = renameHeader(v);
      if (nv && nv !== v) tEl.textContent = nv;
    }
  }
  function renameHeader(v) {
    var m = v.match(/^image[_\-]?(\d+)$/i);
    if (m) return '图' + (parseInt(m[1], 10) + (m[1] === '0' || parseInt(m[1], 10) === 0 ? 1 : 0));
    m = v.match(/^图[_\-](\d+)$/); if (m) return '图' + parseInt(m[1], 10);
    m = v.match(/^洗后图[_\-](\d+)$/); if (m) return '洗后图' + parseInt(m[1], 10);
    return v;
  }

  function downloadRewritten() {
    if (state.generating) return;
    if (!allUploaded()) { setStatus(el['up-status'], '仍有图片未上传成功，暂不能重写 xlsx，原表中的图片不会被删除。请先重试失败项。', 'error'); return; }
    setGenerating(true);
    setStatus(el['up-status'], '正在重写 xlsx…');
    var zip = state.zip;
    var generation = state.fileGeneration;
    var outputFileName = state.fileName.replace(/\.xlsx$/i, '') + '_with_urls.xlsx';
    // 按 sheetPath 分组待写单元格
    var bySheet = {};
    state.images.forEach(function (im) {
      if (!im.url) return;
      (bySheet[im.sheetPath] = bySheet[im.sheetPath] || []).push({ col0: im.col0, row0: im.row0, url: String(im.url) });
    });
    var ser = new XMLSerializer();
    var normHeader = el['norm-header'].checked;
    var jobs = Object.keys(bySheet).map(function (sheetPath) {
      return zip.file(sheetPath).async('string').then(function (s) {
        var doc = xml(s);
        bySheet[sheetPath].forEach(function (im) { setCellInline(doc, im.col0, im.row0, im.url); });
        removeDrawings(doc);
        if (normHeader) normalizeHeaderRow(doc, zip, sheetPath);
        zip.file(sheetPath, ser.serializeToString(doc));
      });
    });
    // 未涉及写单元格的 sheet 也做表头规范化（可选）
    Promise.all(jobs).then(function () {
      // 删除 drawing 与 media 文件
      Object.keys(zip.files).forEach(function (n) {
        if (/^xl\/drawings\/drawing\d+\.xml$/.test(n)) zip.remove(n);
        else if (/^xl\/drawings\/_rels\/drawing\d+\.xml\.rels$/.test(n)) zip.remove(n);
        else if (/^xl\/media\//.test(n)) zip.remove(n);
      });
      return zip.generateAsync({ type: 'blob' });
    }).then(function (blob) {
      if (generation !== state.fileGeneration) throw new Error('文件已更换，已取消本次下载。');
      T.downloadBlob(outputFileName, blob);
      setGenerating(false);
      setStatus(el['up-status'], '已生成 _with_urls.xlsx（图片已替换为 URL）。若 Excel 打开报错，可改用映射 csv。', 'ok');
    }).catch(function (e) {
      setGenerating(false);
      setStatus(el['up-status'], '重写失败：' + e.message, 'error');
    });
  }
})();
