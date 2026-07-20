/* ============================================================
   common.js —— iTools 共享库
   - 文件解析（CSV / XLSX / JSON），编码回退 UTF-8 → GBK/GB18030
   - 列名归一化、别名自动匹配
   - 会话 messages 解析（工具三用）
   - xlsx / jsonl 写出、文件下载、拖拽绑定
   依赖 CDN：PapaParse、SheetJS(XLSX)
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 编码解码：UTF-8 → GBK 回退 ---------- */
  function decodeBuffer(buffer) {
    var bytes = new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      for (var i = 0; i < 2; i++) {
        var enc = i === 0 ? 'gbk' : 'gb18030';
        try { return new TextDecoder(enc).decode(bytes); } catch (e2) { /* next */ }
      }
      return new TextDecoder('utf-8').decode(bytes);
    }
  }

  function readArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(file);
    });
  }

  /* ---------- 解析：CSV / XLSX / JSON ---------- */
  function parseCSV(text) {
    var res = Papa.parse(text, { header: true, skipEmptyLines: 'greedy', dynamicTyping: false });
    return { headers: res.meta.fields || [], rows: res.data || [] };
  }

  function parseXLSX(buffer) {
    var wb = XLSX.read(buffer, { type: 'array' });
    var ws = wb.Sheets[wb.SheetNames[0]];
    var arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    if (!arr.length) return { headers: [], rows: [] };
    var headers = arr[0].map(function (h) { return String(h == null ? '' : h).trim(); });
    var rows = [];
    for (var i = 1; i < arr.length; i++) {
      var obj = {};
      var allEmpty = true;
      for (var c = 0; c < headers.length; c++) {
        if (!headers[c]) continue;
        var v = arr[i][c];
        obj[headers[c]] = v == null ? '' : String(v);
        if (obj[headers[c]] !== '') allEmpty = false;
      }
      if (!allEmpty) rows.push(obj);
    }
    return { headers: headers.filter(Boolean), rows: rows };
  }

  function parseJSON(text) {
    var data = JSON.parse(text);
    var arr;
    if (Array.isArray(data)) arr = data;
    else if (data && Array.isArray(data.data)) arr = data.data;
    else if (data && Array.isArray(data.rows)) arr = data.rows;
    else if (data && typeof data === 'object') arr = [data];
    else arr = [];
    var headerSet = [], seen = {};
    arr.forEach(function (o) {
      if (o && typeof o === 'object') {
        Object.keys(o).forEach(function (k) { if (!seen[k]) { seen[k] = true; headerSet.push(k); } });
      }
    });
    var rows = arr.map(function (o) {
      var out = {};
      headerSet.forEach(function (k) {
        var v = o ? o[k] : '';
        if (v == null) out[k] = '';
        else if (typeof v === 'object') out[k] = JSON.stringify(v);
        else out[k] = String(v);
      });
      return out;
    });
    return { headers: headerSet, rows: rows };
  }

  function parseFile(file) {
    var name = (file.name || '').toLowerCase();
    return readArrayBuffer(file).then(function (buffer) {
      if (name.endsWith('.xlsx') || name.endsWith('.xls')) return parseXLSX(buffer);
      var text = decodeBuffer(buffer);
      if (name.endsWith('.json')) return parseJSON(text);
      return parseCSV(text);
    });
  }

  /* ---------- 解析为原始二维矩阵（保留全部列/空列，供“写回原表”用）---------- */
  // 返回 { aoa: [[...header], [...row], ...], sheetName }
  function parseFileMatrix(file) {
    var name = (file.name || '').toLowerCase();
    return readArrayBuffer(file).then(function (buffer) {
      if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        var wb = XLSX.read(buffer, { type: 'array' });
        var sheetName = wb.SheetNames[0];
        var ws = wb.Sheets[sheetName];
        var arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
        return { aoa: normalizeAoa(arr), sheetName: sheetName || 'Sheet1' };
      }
      var text = decodeBuffer(buffer);
      if (name.endsWith('.json')) {
        var p = parseJSON(text);
        var aoa = [p.headers.slice()];
        p.rows.forEach(function (r) { aoa.push(p.headers.map(function (h) { return r[h] == null ? '' : r[h]; })); });
        return { aoa: normalizeAoa(aoa), sheetName: 'Sheet1' };
      }
      var res = Papa.parse(text, { header: false, skipEmptyLines: 'greedy', dynamicTyping: false });
      return { aoa: normalizeAoa(res.data || []), sheetName: 'Sheet1' };
    });
  }

  // 把每行补齐到相同列数，并统一为字符串
  function normalizeAoa(arr) {
    var width = 0;
    arr.forEach(function (r) { if (r && r.length > width) width = r.length; });
    return arr.map(function (r) {
      r = r || [];
      var out = [];
      for (var c = 0; c < width; c++) out.push(r[c] == null ? '' : String(r[c]));
      return out;
    });
  }

  /* ---------- 列名归一化与别名自动匹配 ---------- */
  function normalize(s) {
    return String(s || '').toLowerCase().replace(/[\s_\-]+/g, '').trim();
  }

  // 在 headers 中按别名列表找到第一个匹配的原始列名，找不到返回 null
  function matchHeader(headers, aliases) {
    var norm = headers.map(function (h) { return { raw: h, n: normalize(h) }; });
    var na = (aliases || []).map(normalize);
    for (var i = 0; i < norm.length; i++) {
      if (na.indexOf(norm[i].n) !== -1) return norm[i].raw;
    }
    return null;
  }

  // 找出所有匹配某组前缀 图1..10/洗后图1..10/image1..10 的列（保序）
  function matchIndexedColumns(headers, prefixes) {
    for (var p = 0; p < prefixes.length; p++) {
      var cols = [];
      for (var i = 1; i <= 20; i++) {
        var target = normalize(prefixes[p] + i);
        for (var h = 0; h < headers.length; h++) {
          if (normalize(headers[h]) === target) { cols.push(headers[h]); break; }
        }
      }
      if (cols.length) return cols;
    }
    return [];
  }

  /* ---------- 会话 messages 解析（工具三）---------- */
  function uniq(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (x) {
      if (x == null) return;
      var k = String(x);
      if (!seen[k]) { seen[k] = true; out.push(x); }
    });
    return out;
  }

  function parseImages(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val.filter(Boolean).map(String);
    var s = String(val).trim();
    if (!s || s === '[]' || s === 'null') return [];
    try {
      var arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.filter(function (x) { return x != null && String(x).trim(); }).map(String);
      if (typeof arr === 'string') return [arr];
    } catch (e) {
      if (/^https?:\/\//i.test(s)) return s.split(/[\n,]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    }
    return [];
  }

  function collectMediaImages(obj) {
    if (!obj || typeof obj !== 'object') return [];
    var urls = parseImages(obj.images);
    ['multimedias', 'multimedia', 'media', 'attachments'].forEach(function (key) {
      if (Array.isArray(obj[key])) {
        obj[key].forEach(function (mm) {
          if (mm && mm.url && (mm.type == null || mm.type === 'image')) urls.push(String(mm.url));
          else if (typeof mm === 'string' && /^https?:\/\//i.test(mm)) urls.push(mm);
        });
      }
    });
    return uniq(urls);
  }

  // OpenAI 风格 messages 数组 → [{role, text, images, trace_id}]
  function parseMessages(val) {
    var arr = toArray(val);
    if (!arr.length) return [];
    return arr.map(function (m) {
      m = m || {};
      var role = (m.role === 'assistant' || m.role === 'ai' || m.role === 'bot' || m.role === 'model')
        ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
      var text = '', images = [];
      var content = m.content;
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        content.forEach(function (seg) {
          if (seg == null) return;
          if (typeof seg === 'string') { text += (text ? '\n' : '') + seg; return; }
          if (seg.type === 'text' || seg.text != null) {
            if (seg.text != null) text += (text ? '\n' : '') + String(seg.text);
          } else if (seg.type === 'image_url' || seg.image_url != null) {
            var iu = seg.image_url;
            var url = iu && typeof iu === 'object' ? iu.url : iu;
            if (url) images.push(String(url));
          } else if (seg.type === 'image' && seg.url) {
            images.push(String(seg.url));
          }
        });
      } else if (content != null && typeof content === 'object') {
        if (content.text != null) text = String(content.text);
        images = images.concat(parseImages(content.images));
      }
      images = uniq(images.concat(collectMediaImages(m)));
      return { role: role, text: text, images: images, trace_id: (m.trace_id || m.x_traceid || '') };
    }).filter(function (m) { return m.role !== 'system' || m.text; });
  }

  function toArray(val) {
    if (val == null || val === '') return [];
    if (Array.isArray(val)) return val;
    var s = String(val).trim();
    if (!s || s === '[]' || s === 'null') return [];
    var parsed = tryParse(s);
    if (parsed == null) return [];
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.messages)) return parsed.messages;
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  }

  // JSON.parse，失败时把裸控制字符（如字符串内的真实换行/制表符）转义后重试。
  // 部分表格导出的 messages 单元格含未转义换行，导致严格 JSON.parse 报错。
  function tryParse(s) {
    try { return JSON.parse(s); } catch (e) { /* retry */ }
    try {
      var fixed = s.replace(/[\u0000-\u001f]/g, function (c) {
        var code = c.charCodeAt(0);
        if (code === 9) return '\\t';
        if (code === 10) return '\\n';
        if (code === 13) return '\\r';
        return '\\u' + ('000' + code.toString(16)).slice(-4);
      });
      return JSON.parse(fixed);
    } catch (e2) { return null; }
  }

  /* ---------- 输出：xlsx / jsonl / 下载 ---------- */
  // rows: 二维数组（含表头行）→ xlsx Blob
  function aoaToXlsxBlob(aoa, sheetName) {
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // records: 对象数组 → jsonl（每行 JSON，保留 key 顺序）
  function jsonlBlob(records) {
    var lines = records.map(function (r) { return JSON.stringify(r); }).join('\n');
    return new Blob([lines + (records.length ? '\n' : '')], { type: 'application/x-ndjson;charset=utf-8' });
  }

  function downloadBlob(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- 拖拽 + 点击选择文件绑定 ---------- */
  // opts: { dropzone, fileInput, pickBtn, onFile(file), accept }
  function bindFileInput(opts) {
    var dz = opts.dropzone, input = opts.fileInput, pick = opts.pickBtn;
    function trigger() { input.click(); }
    if (pick) pick.addEventListener('click', function (e) { e.stopPropagation(); trigger(); });
    if (dz) dz.addEventListener('click', trigger);
    if (input) input.addEventListener('change', function () {
      if (input.files && input.files[0]) opts.onFile(input.files[0]);
      input.value = '';
    });
    // 整页拖拽
    var overlay = document.getElementById('drop-overlay');
    var depth = 0;
    window.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; if (overlay) overlay.hidden = false; });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function (e) { e.preventDefault(); depth--; if (depth <= 0 && overlay) { overlay.hidden = true; depth = 0; } });
    window.addEventListener('drop', function (e) {
      e.preventDefault(); depth = 0; if (overlay) overlay.hidden = true;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) opts.onFile(f);
    });
  }

  global.iTools = {
    decodeBuffer: decodeBuffer,
    readArrayBuffer: readArrayBuffer,
    parseFile: parseFile,
    parseFileMatrix: parseFileMatrix,
    normalize: normalize,
    matchHeader: matchHeader,
    matchIndexedColumns: matchIndexedColumns,
    parseImages: parseImages,
    parseMessages: parseMessages,
    toArray: toArray,
    uniq: uniq,
    aoaToXlsxBlob: aoaToXlsxBlob,
    jsonlBlob: jsonlBlob,
    downloadBlob: downloadBlob,
    escapeHtml: escapeHtml,
    bindFileInput: bindFileInput
  };
})(window);
