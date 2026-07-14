/* ============================================================
   tool1.js —— Excel 图片转 URL（移植 excel2url.py 的 ZIP 方案到浏览器）
   1) JSZip 解压 xlsx，解析 drawings 锚点 → (sheet, 列, 行, media 路径)
   2) 预览每张图 + 所在单元格；打包下载
   3) 可配置上传端点：逐图上传取回 URL，把单元格写成 URL、移除图片，
      导出 _with_urls.xlsx（尽力实现，受 CORS 限制）
   ============================================================ */
(function () {
  'use strict';
  var T = window.iTools;
  var NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

  var state = { zip: null, fileName: '', images: [] };
  // images: [{sheetNum, sheetPath, drawingPath, col0, row0, cellRef, media, bytes, blob, dataUrl, url}]
  var el = {};
  ['dropzone', 'pick-btn', 'file-input', 'file-name', 'status', 'imgs-section', 'img-grid',
   'dl-zip', 'norm-header', 'upload-section', 'up-url', 'up-headers', 'up-field', 'up-path',
   'do-upload', 'dl-mapping', 'dl-xlsx', 'up-status'].forEach(function (id) { el[id] = document.getElementById(id); });

  function setStatus(node, msg, kind) {
    node.hidden = false;
    node.className = 'status' + (kind ? ' is-' + kind : '');
    node.textContent = msg;
  }

  T.bindFileInput({ dropzone: el.dropzone, fileInput: el['file-input'], pickBtn: el['pick-btn'], onFile: onFile });
  el['dl-zip'].addEventListener('click', downloadImagesZip);
  el['do-upload'].addEventListener('click', doUpload);
  el['dl-mapping'].addEventListener('click', downloadMapping);
  el['dl-xlsx'].addEventListener('click', downloadRewritten);

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
    if (!/\.xlsx$/i.test(file.name)) { setStatus(el.status, '仅支持 .xlsx（xls 需先另存为 xlsx）。', 'error'); return; }
    el['file-name'].hidden = false; el['file-name'].textContent = '已选择：' + file.name;
    state.fileName = file.name;
    setStatus(el.status, '正在解压并解析图片…');
    T.readArrayBuffer(file).then(function (buf) {
      return JSZip.loadAsync(buf);
    }).then(function (zip) {
      state.zip = zip;
      return extractImages(zip);
    }).then(function (imgs) {
      state.images = imgs;
      if (!imgs.length) { setStatus(el.status, '未在该 xlsx 中找到内嵌图片（图片可能是浮动/链接形式）。', 'warn'); return; }
      setStatus(el.status, '共提取 ' + imgs.length + ' 张图片。', 'ok');
      el['imgs-section'].hidden = false;
      el['upload-section'].hidden = false;
      return loadPreviews(imgs).then(renderGrid);
    }).catch(function (e) { setStatus(el.status, '解析失败：' + e.message, 'error'); });
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

  function loadPreviews(imgs) {
    return Promise.all(imgs.map(function (im) {
      var f = state.zip.file(im.media);
      if (!f) return Promise.resolve();
      return f.async('blob').then(function (blob) {
        im.blob = blob;
        im.dataUrl = URL.createObjectURL(blob);
      });
    }));
  }

  function renderGrid() {
    var html = '';
    state.images.forEach(function (im, i) {
      html += '<div class="img-item"><img src="' + (im.dataUrl || '') + '" alt="" />' +
        '<div class="img-item__meta"><span class="img-item__cell">Sheet' + im.sheetNum + ' · ' + im.cellRef + '</span>' +
        '<div class="img-item__url" id="url-' + i + '">' + (im.url ? T.escapeHtml(im.url) : '') + '</div></div></div>';
    });
    el['img-grid'].innerHTML = html;
  }

  /* ---------- 下载所有图片 zip ---------- */
  function downloadImagesZip() {
    var zip = new JSZip();
    state.images.forEach(function (im, i) {
      var ext = (im.media.split('.').pop() || 'png');
      zip.file('Sheet' + im.sheetNum + '_' + im.cellRef + '_' + (i + 1) + '.' + ext, im.blob);
    });
    zip.generateAsync({ type: 'blob' }).then(function (b) {
      T.downloadBlob(state.fileName.replace(/\.xlsx$/i, '') + '_images.zip', b);
    });
  }

  /* ---------- 上传 ---------- */
  function getByPath(obj, path) {
    if (!path) return null;
    return path.split('.').reduce(function (o, k) { return (o == null) ? null : o[k]; }, obj);
  }

  function uploadOne(im, cfg) {
    var opts = { method: 'POST', headers: {} };
    Object.keys(cfg.headers).forEach(function (k) { opts.headers[k] = cfg.headers[k]; });
    if (cfg.mode === 'multipart') {
      var fd = new FormData();
      fd.append(cfg.field || 'file', im.blob, im.cellRef + '.' + (im.media.split('.').pop() || 'png'));
      opts.body = fd;
    } else {
      opts.body = im.blob;
    }
    return fetch(cfg.url, opts).then(function (r) {
      var ct = r.headers.get('content-type') || '';
      if (ct.indexOf('json') !== -1) return r.json().then(function (j) { return { json: j, text: '' }; });
      return r.text().then(function (t) { return { json: null, text: t }; });
    }).then(function (res) {
      if (res.json) {
        var u = cfg.path ? getByPath(res.json, cfg.path) : (res.json.url || res.json.resource_url || res.json);
        return u ? String(u) : '';
      }
      return (res.text || '').trim();
    });
  }

  function doUpload() {
    var cfg = { url: el['up-url'].value.trim(), field: el['up-field'].value.trim(),
      path: el['up-path'].value.trim(),
      mode: document.querySelector('input[name="up-mode"]:checked').value, headers: {} };
    if (!cfg.url) { setStatus(el['up-status'], '请先填写上传端点 URL。', 'error'); return; }
    var ht = el['up-headers'].value.trim();
    if (ht) { try { cfg.headers = JSON.parse(ht); } catch (e) { setStatus(el['up-status'], '请求头不是合法 JSON。', 'error'); return; } }

    var total = state.images.length, done = 0, ok = 0;
    setStatus(el['up-status'], '开始上传… 0/' + total);
    var chain = Promise.resolve();
    state.images.forEach(function (im, i) {
      chain = chain.then(function () {
        return uploadOne(im, cfg).then(function (url) {
          im.url = url || '';
          if (url) { ok++; var c = document.getElementById('url-' + i); if (c) c.textContent = url; }
          done++;
          setStatus(el['up-status'], '上传中… ' + done + '/' + total + '（成功 ' + ok + '）');
        }).catch(function (e) {
          done++;
          setStatus(el['up-status'], '上传中… ' + done + '/' + total + '（成功 ' + ok + '，最近错误：' + e.message + '）', 'warn');
        });
      });
    });
    chain.then(function () {
      var hasUrl = state.images.some(function (im) { return im.url; });
      el['dl-mapping'].disabled = !hasUrl;
      el['dl-xlsx'].disabled = !hasUrl;
      if (!ok) setStatus(el['up-status'], '全部上传失败（多为 CORS/鉴权问题）。可改用「下载所有图片」再走 itools 外网转链接服务。', 'error');
      else setStatus(el['up-status'], '完成：成功 ' + ok + '/' + total + '。可下载映射 csv 或 _with_urls.xlsx。', 'ok');
    });
  }

  function downloadMapping() {
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
    setStatus(el['up-status'], '正在重写 xlsx…');
    var zip = state.zip;
    // 按 sheetPath 分组待写单元格
    var bySheet = {};
    state.images.forEach(function (im) {
      if (!im.url) return;
      (bySheet[im.sheetPath] = bySheet[im.sheetPath] || []).push(im);
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
      T.downloadBlob(state.fileName.replace(/\.xlsx$/i, '') + '_with_urls.xlsx', blob);
      setStatus(el['up-status'], '已生成 _with_urls.xlsx（图片已替换为 URL）。若 Excel 打开报错，可改用映射 csv。', 'ok');
    }).catch(function (e) { setStatus(el['up-status'], '重写失败：' + e.message, 'error'); });
  }
})();
