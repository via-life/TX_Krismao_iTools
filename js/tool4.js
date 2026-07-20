/* ============================================================
   tool4.js —— 转 tlabel jsonl（移植 convert_xlsx_to_jsonl_GSB.py）
   按 cid 聚合，取 round_id 最大（并列取靠后）那一行，
   按 tlabel 平台 KEY 顺序输出 jsonl。支持单/双模型。
   输出字段（0717 反馈）：cid / user_prompt / model_1_response
   [/ model_2_response] / model_1_url [/ model_2_url]，
   其中 model_x_response 取 response_x 列、model_x_url 取 png_x 列。
   ============================================================ */
(function () {
  'use strict';
  var T = window.iTools;

  // 严格的输出 KEY 顺序（单模型时去掉 model_2_*）
  var OUTPUT_ORDER = ['cid', 'user_prompt', 'model_1_response', 'model_2_response', 'model_1_url', 'model_2_url'];

  function buildFields(dual) {
    var f = [
      { key: 'cid', label: 'cid', required: true, desc: '聚合主键（填入 cid 列）', aliases: ['cid', 'session_id', 'session', 'sessionid'] },
      { key: 'round_id', label: 'round_id', required: false, desc: '取最大轮次', aliases: ['round_id', 'roundid', 'round'] },
      { key: 'user_prompt', label: 'user_prompt', required: true, desc: '用户提问（填入 user prompt 列）', aliases: ['user_prompt', 'user prompt', 'user_query', 'userquery', '用户提问', '用户问题', 'prompt'] },
      { key: 'model_1_response', label: 'model_1_response ← response_1', required: true, desc: '模型1回复（取 response_1 列）', aliases: ['response_1', 'response1', 'model_1_response', 'model1response', 'session_answer_1', 'session_answer', 'session_anwser', 'response'] },
      { key: 'model_1_url', label: 'model_1_url ← png_1', required: false, desc: '模型1渲染图公网链接（取 png_1 列）', aliases: ['png_1', 'png1', 'png', 'model_1_url', 'model1url', 'model_1_id', 'model1id'] }
    ];
    if (dual) {
      f.push({ key: 'model_2_response', label: 'model_2_response ← response_2', required: true, desc: '模型2回复（取 response_2 列）', aliases: ['response_2', 'response2', 'model_2_response', 'model2response', 'session_answer_2', 'session_anwser_2'] });
      f.push({ key: 'model_2_url', label: 'model_2_url ← png_2', required: false, desc: '模型2渲染图公网链接（取 png_2 列）', aliases: ['png_2', 'png2', 'model_2_url', 'model2url', 'model_2_id', 'model2id'] });
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
    // 聚合：按 cid 保序，取 round_id 最大（>= 取靠后）
    var order = [], best = {}, bestRound = {};
    state.rows.forEach(function (row) {
      var cid = m.cid ? String(row[m.cid] || '').trim() : '';
      if (!cid) return;
      var rid = parseRound(row[m.round_id]);
      if (!(cid in best)) { order.push(cid); }
      if (!(cid in best) || rid >= bestRound[cid]) { best[cid] = row; bestRound[cid] = rid; }
    });

    var records = order.map(function (cid) {
      var row = best[cid];
      var rec = {};
      rec.cid = cid;
      rec.user_prompt = val(row, m.user_prompt);
      rec.model_1_response = val(row, m.model_1_response);
      if (isDual) rec.model_2_response = val(row, m.model_2_response);
      rec.model_1_url = val(row, m.model_1_url);
      if (isDual) rec.model_2_url = val(row, m.model_2_url);
      // 强制 KEY 顺序
      var ordered = {};
      OUTPUT_ORDER.forEach(function (k) { if (k in rec) ordered[k] = rec[k]; });
      return ordered;
    });

    state.records = records;
    el['out-section'].hidden = false;
    el['download-btn'].disabled = !records.length;
    el.summary.textContent = '共 ' + records.length + ' 个 cid（jsonl 行数）· ' + (isDual ? '双模型' : '单模型');
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
