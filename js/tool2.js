/* ============================================================
   tool2.js —— 数据聚合（0717 反馈调整）
   保留上传表原样，按 cid 分组、round_id 排序，把每个 session 的
   多轮内容聚合成一段 JSON（[{"user prompt","image_url","location",...}]），
   写入「从左往右第一个空白列」（表头命名 session），其它列/行内容不变。
   聚合 JSON 写在每个 session 的第一行。
   ============================================================ */
(function () {
  'use strict';
  var T = window.iTools;

  var FIELDS = [
    { key: 'cid', label: 'cid（分组主键）', required: true, desc: '按其分组聚合',
      aliases: ['cid', 'session_id', 'session', 'sessionid'] },
    { key: 'round_id', label: 'round_id', required: false, desc: '轮次序号，缺失按原顺序',
      aliases: ['round_id', 'roundid', 'round', '轮次'] },
    { key: 'contents', label: '聚合内容列', required: true, multi: true,
      desc: '每轮写入 JSON 的列（默认除 cid/round_id 外全部）',
      aliases: [] }
  ];

  var state = { headers: [], aoa: [], sheetName: 'Sheet1', mapping: null, sessions: [], targetCol: -1 };
  var el = {};
  ['dropzone', 'pick-btn', 'file-input', 'file-name', 'status', 'out-section',
   'download-btn', 'preview', 'summary', 'remap-btn'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  function setStatus(msg, kind) {
    el.status.hidden = false;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    el.status.textContent = msg;
  }

  // 默认聚合内容列 = 除 cid/round_id 外的全部非空表头
  function defaultContents(headers, autoMap) {
    var skip = {};
    if (autoMap.cid) skip[autoMap.cid] = 1;
    if (autoMap.round_id) skip[autoMap.round_id] = 1;
    return headers.filter(function (h) { return h && !skip[h]; });
  }

  T.bindFileInput({
    dropzone: el.dropzone, fileInput: el['file-input'], pickBtn: el['pick-btn'],
    onFile: onFile
  });
  el['remap-btn'].addEventListener('click', function () {
    Mapping.open({ fields: FIELDS, headers: state.headers, mapping: state.mapping, title: '数据聚合 · 列映射', onConfirm: applyMapping });
  });
  el['download-btn'].addEventListener('click', download);

  function onFile(file) {
    el['file-name'].hidden = false;
    el['file-name'].textContent = '已选择：' + file.name;
    state.fileName = file.name;
    setStatus('正在解析…');
    T.parseFileMatrix(file).then(function (res) {
      if (!res.aoa.length) { setStatus('未读到任何行。', 'error'); return; }
      state.aoa = res.aoa;
      state.sheetName = res.sheetName;
      state.headers = (res.aoa[0] || []).map(function (h) { return String(h == null ? '' : h).trim(); });
      if (res.aoa.length < 2) { setStatus('只读到表头，没有数据行。', 'warn'); return; }
      el['remap-btn'].hidden = false;
      setStatus('已读取 ' + (res.aoa.length - 1) + ' 行，' + state.headers.filter(Boolean).length + ' 列。正在识别列…');
      // 预填 contents 默认值
      var autoMap = Mapping.auto(FIELDS, state.headers);
      autoMap.contents = defaultContents(state.headers, autoMap);
      Mapping.open({ fields: FIELDS, headers: state.headers, mapping: autoMap, title: '数据聚合 · 列映射', onConfirm: applyMapping });
    }).catch(function (e) { setStatus('解析失败：' + e.message, 'error'); });
  }

  /* ---------- 工具函数 ---------- */
  function parseRound(v) {
    if (v == null || v === '') return null;
    var n = parseFloat(String(v).trim());
    return isNaN(n) ? null : Math.trunc(n);
  }
  // 输出 JSON 的 key：user_prompt / user_query / 用户提问 → "user prompt"，其余保留原表头
  function outKey(header) {
    var n = T.normalize(header);
    if (n === 'userprompt' || n === 'userquery' || n === '用户提问' || n === '用户问题') return 'user prompt';
    return header;
  }

  function colIndex(header) { return state.headers.indexOf(header); }

  // 找“从左往右第一个空白列”：表头为空且该列所有数据单元格都为空；找不到则在末尾追加
  function firstBlankCol() {
    var width = state.headers.length;
    for (var c = 0; c < width; c++) {
      var headerBlank = !state.headers[c];
      if (!headerBlank) continue;
      var allBlank = true;
      for (var r = 1; r < state.aoa.length; r++) {
        if (state.aoa[r][c] != null && String(state.aoa[r][c]).trim() !== '') { allBlank = false; break; }
      }
      if (allBlank) return c;
    }
    return width; // 追加到末尾
  }

  function applyMapping(mapping) {
    state.mapping = mapping;
    var cidCol = mapping.cid, rCol = mapping.round_id;
    var contentCols = (mapping.contents || []).filter(function (h) { return h && h !== cidCol && h !== rCol; });
    var cidIdx = colIndex(cidCol), rIdx = rCol ? colIndex(rCol) : -1;
    var contentIdx = contentCols.map(function (h) { return { key: outKey(h), idx: colIndex(h) }; });

    // 收集每行 → 记录（保留原始行号，用于定位 session 第一行）
    var records = [];
    for (var r = 1; r < state.aoa.length; r++) {
      var row = state.aoa[r];
      records.push({
        rowIdx: r,
        cid: cidIdx >= 0 ? String(row[cidIdx] == null ? '' : row[cidIdx]).trim() : '',
        rid: rIdx >= 0 ? parseRound(row[rIdx]) : null,
        row: row
      });
    }

    // 按 cid 分组（保序）
    var order = [], groups = {};
    records.forEach(function (rec) {
      var key = rec.cid || ('__row_' + rec.rowIdx);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(rec);
    });

    var sessions = [];
    order.forEach(function (key) {
      var grp = groups[key].slice();
      if (rIdx >= 0) grp.sort(function (a, b) { return (a.rid == null ? 1e9 : a.rid) - (b.rid == null ? 1e9 : b.rid); });
      var turns = grp.map(function (rec) {
        var obj = {};
        contentIdx.forEach(function (c) {
          var v = c.idx >= 0 ? rec.row[c.idx] : '';
          obj[c.key] = v == null ? '' : String(v);
        });
        return obj;
      });
      var firstRowIdx = groups[key].reduce(function (min, rec) { return rec.rowIdx < min ? rec.rowIdx : min; }, groups[key][0].rowIdx);
      sessions.push({ cid: groups[key][0].cid || key, turns: grp.length, firstRowIdx: firstRowIdx, json_data: JSON.stringify(turns) });
    });

    state.sessions = sessions;
    state.targetCol = firstBlankCol();
    el['out-section'].hidden = false;
    el['download-btn'].disabled = !sessions.length;
    var colLetter = numToCol(state.targetCol + 1);
    el.summary.textContent = '共 ' + sessions.length + ' 个 session，写入第 ' + colLetter + ' 列（session）';
    setStatus('聚合完成：' + sessions.length + ' 个 session，将写入原表第 ' + colLetter + ' 列（表头 session），其它列不变。', 'ok');
    renderPreview();
  }

  function numToCol(n) {
    var s = '';
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function renderPreview() {
    // 预览：原表头 + session 列，仅展示前 30 数据行
    var cols = state.headers.slice();
    while (cols.length <= state.targetCol) cols.push('');
    cols[state.targetCol] = 'session';
    var sessJsonByRow = {};
    state.sessions.forEach(function (s) { sessJsonByRow[s.firstRowIdx] = s.json_data; });

    var head = '<thead><tr><th class="col-idx">#</th>';
    cols.forEach(function (c, i) { head += '<th>' + T.escapeHtml(c || numToCol(i + 1)) + '</th>'; });
    head += '</tr></thead>';
    var body = '<tbody>';
    var limit = Math.min(state.aoa.length, 31);
    for (var r = 1; r < limit; r++) {
      body += '<tr><td class="col-idx">' + r + '</td>';
      for (var c = 0; c < cols.length; c++) {
        var v;
        if (c === state.targetCol) v = sessJsonByRow[r] || '';
        else v = state.aoa[r][c] == null ? '' : state.aoa[r][c];
        body += '<td' + (c === state.targetCol ? ' class="mono"' : '') + '><div class="cell-clip">' + T.escapeHtml(v) + '</div></td>';
      }
      body += '</tr>';
    }
    body += '</tbody>';
    el.preview.innerHTML = head + body;
  }

  function download() {
    // 复制原 aoa，补齐宽度，写入 session 列
    var out = state.aoa.map(function (row) { return row.slice(); });
    var width = state.targetCol + 1;
    out.forEach(function (row) { while (row.length < width) row.push(''); });
    out[0][state.targetCol] = 'session';
    state.sessions.forEach(function (s) {
      if (out[s.firstRowIdx]) out[s.firstRowIdx][state.targetCol] = s.json_data;
    });
    var base = (state.fileName || 'sessions').replace(/\.(xlsx|xls|csv|json)$/i, '');
    T.downloadBlob(base + '_with_session.xlsx', T.aoaToXlsxBlob(out, state.sheetName || 'Sheet1'));
  }
})();
