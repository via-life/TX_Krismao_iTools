/* ============================================================
   tool4.js —— 转 tlabel jsonl（移植 convert_xlsx_to_jsonl_GSB.py）
   按 session_id 聚合，取 round_id 最大（并列取靠后）那一行，
   按 tlabel 平台 KEY 顺序输出 jsonl。支持单/双模型。
   ============================================================ */
(function () {
  'use strict';
  var T = window.iTools;

  // 严格的输出 KEY 顺序（单模型时去掉 model_2_*）
  var OUTPUT_ORDER = ['trace_id', 'session_id', 'user_query', 'model_1_response', 'model_2_response', 'model_1_id', 'model_2_id'];

  function buildFields(dual) {
    var f = [
      { key: 'session_id', label: 'session_id', required: true, desc: '聚合主键', aliases: ['session_id', 'cid', 'session', 'sessionid'] },
      { key: 'round_id', label: 'round_id', required: false, desc: '取最大轮次', aliases: ['round_id', 'roundid', 'round'] },
      { key: 'trace_id', label: 'trace_id', required: false, desc: '主键', aliases: ['trace_id', 'traceid'] },
      { key: 'user_query', label: 'user_query', required: true, desc: '用户提问', aliases: ['user_query', 'user_prompt', 'user prompt', 'userquery', '用户提问', '用户问题', 'prompt'] },
      { key: 'model_1_response', label: 'model_1_response', required: true, desc: '模型1回复', aliases: ['model_1_response', 'model1response', 'session_answer', 'session_anwser', 'response', 'response_1', 'session_answer_1'] },
      { key: 'model_1_id', label: 'model_1_id', required: false, desc: '模型1标识/trace', aliases: ['model_1_id', 'model1id', 'trace_id_1', 'model_1_traceid'] }
    ];
    if (dual) {
      f.push({ key: 'model_2_response', label: 'model_2_response', required: true, desc: '模型2回复', aliases: ['model_2_response', 'model2response', 'response_2', 'session_answer_2', 'session_anwser_2'] });
      f.push({ key: 'model_2_id', label: 'model_2_id', required: false, desc: '模型2标识/trace', aliases: ['model_2_id', 'model2id', 'trace_id_2', 'model_2_traceid'] });
    }
    return f;
  }

  var state = { headers: [], rows: [], mapping: null, records: [] };
  var el = {};
  ['dropzone', 'pick-btn', 'file-input', 'file-name', 'status', 'out-section',
   'download-btn', 'preview', 'summary', 'remap-btn', 'dual-toggle'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  function dual() { return el['dual-toggle'].checked; }
  function setStatus(msg, kind) {
    el.status.hidden = false;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    el.status.textContent = msg;
  }

  T.bindFileInput({ dropzone: el.dropzone, fileInput: el['file-input'], pickBtn: el['pick-btn'], onFile: onFile });
  el['remap-btn'].addEventListener('click', function () {
    Mapping.open({ fields: buildFields(dual()), headers: state.headers, mapping: state.mapping, title: '转 jsonl · 列映射', onConfirm: applyMapping });
  });
  el['download-btn'].addEventListener('click', download);
  el['dual-toggle'].addEventListener('change', function () {
    if (state.rows.length) { state.mapping = null; Mapping.run({ fields: buildFields(dual()), headers: state.headers, title: '转 jsonl · 列映射', onConfirm: applyMapping }); }
  });

  function onFile(file) {
    el['file-name'].hidden = false;
    el['file-name'].textContent = '已选择：' + file.name;
    setStatus('正在解析…');
    T.parseFile(file).then(function (res) {
      if (!res.rows.length) { setStatus('未读到数据行。', 'error'); return; }
      state.headers = res.headers; state.rows = res.rows;
      el['remap-btn'].hidden = false;
      setStatus('已读取 ' + res.rows.length + ' 行。正在识别列…');
      Mapping.run({ fields: buildFields(dual()), headers: res.headers, title: '转 jsonl · 列映射', onConfirm: applyMapping });
    }).catch(function (e) { setStatus('解析失败：' + e.message, 'error'); });
  }

  function parseRound(v) {
    if (v == null || v === '') return -1;
    var n = parseFloat(String(v).trim());
    return isNaN(n) ? -1 : Math.trunc(n);
  }
  function val(row, col) { return (col && row[col] != null) ? String(row[col]) : ''; }

  function applyMapping(mapping) {
    state.mapping = mapping;
    var m = mapping, isDual = dual();
    // 聚合：按 session_id 保序，取 round_id 最大（>= 取靠后）
    var order = [], best = {}, bestRound = {};
    state.rows.forEach(function (row) {
      var sid = m.session_id ? String(row[m.session_id] || '').trim() : '';
      if (!sid) return;
      var rid = parseRound(row[m.round_id]);
      if (!(sid in best)) { order.push(sid); }
      if (!(sid in best) || rid >= bestRound[sid]) { best[sid] = row; bestRound[sid] = rid; }
    });

    var records = order.map(function (sid) {
      var row = best[sid];
      var rec = {};
      rec.trace_id = val(row, m.trace_id);
      rec.session_id = sid;
      rec.user_query = val(row, m.user_query);
      rec.model_1_response = val(row, m.model_1_response);
      if (isDual) rec.model_2_response = val(row, m.model_2_response);
      rec.model_1_id = val(row, m.model_1_id);
      if (isDual) rec.model_2_id = val(row, m.model_2_id);
      // 强制 KEY 顺序
      var ordered = {};
      OUTPUT_ORDER.forEach(function (k) { if (k in rec) ordered[k] = rec[k]; });
      return ordered;
    });

    state.records = records;
    el['out-section'].hidden = false;
    el['download-btn'].disabled = !records.length;
    el.summary.textContent = '共 ' + records.length + ' 个 session（jsonl 行数）· ' + (isDual ? '双模型' : '单模型');
    setStatus('转换完成：' + records.length + ' 行 jsonl。', 'ok');
    renderPreview();
  }

  function renderPreview() {
    if (!state.records.length) { el.preview.innerHTML = ''; return; }
    var keys = Object.keys(state.records[0]);
    var head = '<thead><tr><th class="col-idx">#</th>';
    keys.forEach(function (k) { head += '<th>' + T.escapeHtml(k) + '</th>'; });
    head += '</tr></thead>';
    var body = '<tbody>';
    state.records.slice(0, 50).forEach(function (r, i) {
      body += '<tr><td class="col-idx">' + (i + 1) + '</td>';
      keys.forEach(function (k) { body += '<td><div class="cell-clip">' + T.escapeHtml(r[k]) + '</div></td>'; });
      body += '</tr>';
    });
    body += '</tbody>';
    el.preview.innerHTML = head + body;
  }

  function download() {
    T.downloadBlob('tlabel_' + (dual() ? 'GSB' : 'DCG') + '.jsonl', T.jsonlBlob(state.records));
  }
})();
