/* ============================================================
   tool2.js —— 数据聚合（移植 generate_session_json.py）
   按 session_id 分组、round_id 排序，把每个 session 的多轮
   prompt+图片聚合成一行 JSON，输出 xlsx（默认列 L1/L2/L3/用户问题）。
   ============================================================ */
(function () {
  'use strict';
  var T = window.iTools;

  var FIELDS = [
    { key: 'prompt', label: '提问列', required: true, desc: '用户提问 / prompt',
      aliases: ['用户提问', '用户问题', 'prompt', 'user_prompt', 'user prompt', 'userquery', 'query', 'question'] },
    { key: 'session_id', label: 'session_id', required: false, desc: '缺失时自动生成',
      aliases: ['session_id', 'cid', 'session', 'sessionid'] },
    { key: 'round_id', label: 'round_id', required: false, desc: '轮次序号，缺失按原顺序',
      aliases: ['round_id', 'roundid', 'round', '轮次'] },
    { key: 'images', label: '图片列', required: false, multi: true, desc: '可多选：图1~10 / 洗后图1~10 / image_url',
      prefixes: ['洗后图', '图', 'image'], aliases: ['image_url', 'imageurl', '图片链接', 'images'] }
  ];

  var state = { headers: [], rows: [], mapping: null, sessions: [] };
  var el = {};
  ['dropzone', 'pick-btn', 'file-input', 'file-name', 'status', 'out-section',
   'download-btn', 'preview', 'summary', 'out-cols', 'remap-btn'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  function setStatus(msg, kind) {
    el.status.hidden = false;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    el.status.textContent = msg;
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
    setStatus('正在解析…');
    T.parseFile(file).then(function (res) {
      if (!res.rows.length) { setStatus('未读到数据行。', 'error'); return; }
      state.headers = res.headers; state.rows = res.rows;
      el['remap-btn'].hidden = false;
      setStatus('已读取 ' + res.rows.length + ' 行，' + res.headers.length + ' 列。正在识别列…');
      Mapping.run({ fields: FIELDS, headers: res.headers, title: '数据聚合 · 列映射', onConfirm: applyMapping });
    }).catch(function (e) { setStatus('解析失败：' + e.message, 'error'); });
  }

  /* ---------- 工具函数（移植 py）---------- */
  function parseRound(v) {
    if (v == null || v === '') return null;
    var n = parseFloat(String(v).trim());
    return isNaN(n) ? null : Math.trunc(n);
  }
  function getFileType(url) {
    var u = url.toLowerCase();
    if (u.indexOf('pdf') !== -1) return 'pdf';
    if (u.indexOf('.doc') !== -1) return 'doc';
    return 'image';
  }
  function extractFilename(url) {
    try {
      if (url.indexOf('fileName=') !== -1) return url.split('fileName=')[1].split('&')[0];
      if (url.indexOf('/') !== -1) {
        var fn = url.split('/').pop().split('?')[0];
        if (fn && fn.indexOf('.') !== -1) return fn;
      }
    } catch (e) { /* ignore */ }
    var rnd = Math.abs((url.length * 2654435761) % 1e8).toString(36);
    return 'image_' + rnd + '.jpg';
  }

  function applyMapping(mapping) {
    state.mapping = mapping;
    var pCol = mapping.prompt, sCol = mapping.session_id, rCol = mapping.round_id;
    var imgCols = mapping.images || [];

    // 生成带 sid 的记录（缺失 session_id 时按 round_id==1 边界自动分组）
    var records = state.rows.map(function (row) {
      return {
        sid: sCol && row[sCol] != null ? String(row[sCol]).trim() : '',
        rid: rCol ? parseRound(row[rCol]) : null,
        prompt: row[pCol] != null ? String(row[pCol]).trim() : '',
        row: row
      };
    });
    var autoCounter = 0, curAuto = null, missing = 0;
    records.forEach(function (r) {
      if (r.sid) { curAuto = null; return; }
      missing++;
      if (curAuto === null || r.rid === 1 || r.rid == null) {
        autoCounter++; curAuto = 'auto_session_' + autoCounter;
      }
      r.sid = curAuto;
    });

    // 按 sid 分组（保序）
    var order = [], groups = {};
    records.forEach(function (r) {
      if (!groups[r.sid]) { groups[r.sid] = []; order.push(r.sid); }
      groups[r.sid].push(r);
    });

    var sessions = [];
    order.forEach(function (sid) {
      var grp = groups[sid].slice();
      if (rCol) grp.sort(function (a, b) { return (a.rid == null ? 1e9 : a.rid) - (b.rid == null ? 1e9 : b.rid); });
      var arr = grp.map(function (r) {
        var files = [];
        imgCols.forEach(function (c) {
          var v = r.row[c];
          if (v != null && String(v).trim()) {
            var url = String(v).trim();
            files.push({ url: url, fileName: extractFilename(url), type: getFileType(url) });
          }
        });
        return { prompt: r.prompt, files: files };
      });
      sessions.push({ session_id: sid, turns: arr.length, json_data: JSON.stringify(arr) });
    });

    state.sessions = sessions;
    el['out-section'].hidden = false;
    el['download-btn'].disabled = !sessions.length;
    var extra = missing ? '（自动生成 ' + autoCounter + ' 个 session_id）' : '';
    el.summary.textContent = '共 ' + sessions.length + ' 个 session' + extra;
    setStatus('聚合完成：' + sessions.length + ' 个 session。' + extra, 'ok');
    renderPreview();
  }

  function renderPreview() {
    var cols = outCols();
    var head = '<thead><tr><th class="col-idx">#</th>';
    cols.forEach(function (c) { head += '<th>' + T.escapeHtml(c) + '</th>'; });
    head += '<th>轮次</th></tr></thead>';
    var body = '<tbody>';
    state.sessions.slice(0, 50).forEach(function (s, i) {
      body += '<tr><td class="col-idx">' + (i + 1) + '</td>';
      cols.forEach(function (c, ci) {
        if (ci === cols.length - 1) body += '<td class="mono"><div class="cell-clip">' + T.escapeHtml(s.json_data) + '</div></td>';
        else body += '<td></td>';
      });
      body += '<td>' + s.turns + '</td></tr>';
    });
    body += '</tbody>';
    el.preview.innerHTML = head + body;
  }

  function outCols() {
    var cols = el['out-cols'].value.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
    return cols.length ? cols : ['L1', 'L2', 'L3', '用户问题'];
  }
  el['out-cols'].addEventListener('input', function () { if (state.sessions.length) renderPreview(); });

  function download() {
    var cols = outCols();
    var aoa = [cols];
    state.sessions.forEach(function (s) {
      var r = [];
      for (var i = 0; i < cols.length; i++) r.push(i === cols.length - 1 ? s.json_data : '');
      aoa.push(r);
    });
    T.downloadBlob('aggregated_sessions.xlsx', T.aoaToXlsxBlob(aoa, 'sessions'));
  }
})();
