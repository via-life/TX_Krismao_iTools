/* ============================================================
   tool3.js —— 多轮会话渲染、图片预览、截图上传与 Excel 链接写回
   ============================================================ */
(function () {
  'use strict';

  var T = window.iTools;
  var D = window.Tool3Data;
  var state = {
    headers: [],
    rows: [],
    sourceRows: [],
    mapping: null,
    sessions: [],
    active: -1,
    file: null,
    fileBuffer: null,
    screenshotUrls: [],
    service: { test: false, prod: false },
    busy: false
  };
  var captureImageCache = {};
  var el = {};

  [
    'dropzone', 'pick-btn', 'file-input', 'file-name', 'status', 'render-section',
    'sess-list', 'sess-count', 'main-title', 'main-sub', 'render-scroll',
    'export-one', 'export-all', 'generate-links', 'remap-btn', 'dual-toggle',
    'lightbox', 'lb-img', 'lb-stage', 'img-cookie', 'img-reload',
    'link-service-status', 'env-test', 'env-prod'
  ].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  function buildFields(isDual) {
    var fields = [
      {
        key: 'messages_1',
        label: isDual ? '会话列（模型 1）' : '会话列',
        required: true,
        desc: '兼容 messages 或 prompt/answer/convidx 数组',
        aliases: [
          'session_answer', 'session_anwser', 'messages', 'session_answer_1',
          'session_anwser_1', 'conversation', '对话', 'response'
        ]
      },
      {
        key: 'cid',
        label: 'session 标识列',
        required: false,
        desc: 'cid / session_id',
        aliases: ['cid', 'session_id', 'session', 'sessionid']
      },
      {
        key: 'trace_id',
        label: 'trace_id 列',
        required: false,
        desc: '用于页面标识',
        aliases: ['trace_id', 'traceid']
      }
    ];
    if (isDual) {
      fields.splice(1, 0, {
        key: 'messages_2',
        label: '会话列（模型 2）',
        required: true,
        desc: '第二模型完整会话',
        aliases: ['session_answer_2', 'session_anwser_2', 'messages_2', 'response_2']
      });
    }
    return fields;
  }

  function dual() {
    return !!el['dual-toggle'].checked;
  }

  function currentEnv() {
    return el['env-prod'].checked ? 'prod' : 'test';
  }

  function isLocalApp() {
    return location.protocol === 'http:' && location.hostname === '127.0.0.1';
  }

  function setStatus(message, kind) {
    el.status.hidden = false;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    el.status.textContent = message;
  }

  function safeErrorMessage(error, fallback) {
    var message = error && error.message ? String(error.message) : '';
    return message && message.length <= 300 ? message : fallback;
  }

  function safeName(value) {
    return String(value || 'session').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'session';
  }

  function outputFilename() {
    var name = state.file ? state.file.name : 'sessions.xlsx';
    return name.replace(/\.xlsx$/i, '') + '_with_png_urls.xlsx';
  }

  function revokeCaptureCache() {
    Object.keys(captureImageCache).forEach(function (key) {
      var item = captureImageCache[key];
      if (item && item.objectUrl) URL.revokeObjectURL(item.objectUrl);
    });
    captureImageCache = {};
  }

  function resetGeneratedLinks() {
    state.screenshotUrls = state.sessions.map(function () { return ''; });
    updateGenerateButton();
  }

  function setBusy(on) {
    state.busy = !!on;
    [
      el['pick-btn'], el['dual-toggle'], el['remap-btn'], el['export-one'],
      el['export-all'], el['img-reload'], el['img-cookie'],
      el['env-test'], el['env-prod']
    ].forEach(function (node) {
      if (node) node.disabled = state.busy;
    });
    updateGenerateButton();
  }

  function updateGenerateButton() {
    var ready = isLocalApp() && state.service[currentEnv()];
    var isXlsx = state.file && /\.xlsx$/i.test(state.file.name);
    el['generate-links'].disabled = state.busy || !ready || !isXlsx || !state.sessions.length;
  }

  function updateServiceStatus() {
    var box = el['link-service-status'];
    var envLabel = currentEnv() === 'prod' ? '正式' : '测试';
    if (!isLocalApp()) {
      box.className = 't3-service-status is-warn';
      box.textContent = '当前是静态网页：可预览和导出 PNG；生成链接 Excel 请双击“启动.bat”后进入。';
      updateGenerateButton();
      return;
    }
    if (state.service[currentEnv()]) {
      box.className = 't3-service-status is-ok';
      box.textContent = '本地服务已连接，' + envLabel + '环境配置就绪。';
    } else {
      box.className = 't3-service-status is-warn';
      box.textContent = '本地服务已连接，但' + envLabel + '环境配置未就绪，请检查 config.local.json。';
    }
    updateGenerateButton();
  }

  function checkHealth() {
    if (!isLocalApp()) {
      updateServiceStatus();
      return Promise.resolve();
    }
    return fetch('api/tool1/health', { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('health');
      return response.json();
    }).then(function (data) {
      state.service.test = !!(data.environments && data.environments.test && data.environments.test.ready);
      state.service.prod = !!(data.environments && data.environments.prod && data.environments.prod.ready);
      updateServiceStatus();
    }).catch(function () {
      state.service.test = false;
      state.service.prod = false;
      el['link-service-status'].className = 't3-service-status is-warn';
      el['link-service-status'].textContent = '未连接本地服务，请关闭页面后重新双击“启动.bat”。';
      updateGenerateButton();
    });
  }

  function parseSpreadsheet(buffer) {
    var wb = XLSX.read(buffer, { type: 'array' });
    var ws = wb.Sheets[wb.SheetNames[0]];
    var matrix = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: true
    });
    if (!matrix.length) return { headers: [], rows: [], sourceRows: [] };
    var headers = matrix[0].map(function (value) {
      return String(value == null ? '' : value).trim();
    });
    var rows = [];
    var sourceRows = [];
    for (var r = 1; r < matrix.length; r++) {
      var row = {};
      var nonEmpty = false;
      headers.forEach(function (header, column) {
        if (!header) return;
        var value = matrix[r][column];
        row[header] = value == null ? '' : String(value);
        if (row[header] !== '') nonEmpty = true;
      });
      if (nonEmpty) {
        rows.push(row);
        sourceRows.push(r + 1);
      }
    }
    return { headers: headers.filter(Boolean), rows: rows, sourceRows: sourceRows };
  }

  function onFile(file) {
    var lower = String(file.name || '').toLowerCase();
    if (!/\.(xlsx|xls|csv|json)$/.test(lower)) {
      setStatus('请选择 .xlsx、.xls、.csv 或 .json 文件。', 'error');
      return;
    }
    setBusy(true);
    revokeCaptureCache();
    state.file = file;
    state.fileBuffer = null;
    state.mapping = null;
    state.sessions = [];
    state.active = -1;
    state.screenshotUrls = [];
    el['render-section'].hidden = true;
    el['file-name'].hidden = false;
    el['file-name'].textContent = '已选择：' + file.name;
    setStatus('正在解析…');

    T.readArrayBuffer(file).then(function (buffer) {
      state.fileBuffer = buffer.slice(0);
      if (/\.(xlsx|xls)$/.test(lower)) return parseSpreadsheet(buffer);
      return T.parseFile(file).then(function (parsed) {
        parsed.sourceRows = parsed.rows.map(function (_, index) { return index + 2; });
        return parsed;
      });
    }).then(function (parsed) {
      if (!parsed.rows.length) throw new Error('未读到数据行。');
      state.headers = parsed.headers;
      state.rows = parsed.rows;
      state.sourceRows = parsed.sourceRows;
      el['remap-btn'].hidden = false;
      setStatus('已读取 ' + parsed.rows.length + ' 行，正在识别会话列…');
      Mapping.run({
        fields: buildFields(dual()),
        headers: parsed.headers,
        title: '会话渲染 · 列映射',
        note: '请选择包含完整多轮会话的列。支持 messages，以及 prompt/answer/convidx 形式。',
        onConfirm: applyMapping
      });
    }).catch(function (error) {
      setStatus('解析失败：' + safeErrorMessage(error, '文件格式无效。'), 'error');
    }).then(function () {
      setBusy(false);
    });
  }

  function messagesToRecord(value) {
    var messages = D.parseConversation(value);
    var turns = [];
    var current = null;
    var traceId = '';
    messages.forEach(function (message) {
      if (message.trace_id) traceId = String(message.trace_id);
      if (message.role === 'user') {
        current = {
          user_query: message.text || '',
          user_images: message.images || [],
          model_response: '',
          ai_images: []
        };
        turns.push(current);
        return;
      }
      if (message.role === 'assistant') {
        if (!current || current.model_response || current.ai_images.length) {
          current = { user_query: '', user_images: [], model_response: '', ai_images: [] };
          turns.push(current);
        }
        current.model_response = message.text || '';
        current.ai_images = message.images || [];
      }
    });
    return {
      turns: turns,
      trace_id: traceId,
      count: turns.length,
      empty: turns.length === 0
    };
  }

  function applyMapping(mapping) {
    state.mapping = mapping;
    var isDual = dual();
    state.sessions = state.rows.map(function (row, index) {
      var cid = mapping.cid ? String(row[mapping.cid] || '').trim() : '';
      var traceId = mapping.trace_id ? String(row[mapping.trace_id] || '').trim() : '';
      var first = messagesToRecord(row[mapping.messages_1]);
      var models = [{ name: isDual ? '模型 1' : '模型', rec: first }];
      if (isDual) models.push({ name: '模型 2', rec: messagesToRecord(row[mapping.messages_2]) });
      return {
        idx: index,
        sourceRow: state.sourceRows[index],
        cid: cid || ('行 ' + state.sourceRows[index]),
        trace_id: traceId || first.trace_id,
        models: models
      };
    });
    resetGeneratedLinks();
    el['render-section'].hidden = false;
    el['sess-count'].textContent = '会话（' + state.sessions.length + '）';
    setStatus(
      '已加载 ' + state.sessions.length + ' 个会话。' +
      (/\.xlsx$/i.test(state.file.name) ? '' : ' 当前格式仅支持预览/PNG 导出；链接写回请使用 .xlsx。'),
      'ok'
    );
    renderList();
    if (state.sessions.length) show(0);
  }

  function renderList() {
    var html = '';
    state.sessions.forEach(function (session, index) {
      var invalid = session.models.every(function (model) { return model.rec.empty; });
      var turns = session.models.map(function (model) { return model.rec.count; }).join('/');
      var uploaded = !!state.screenshotUrls[index];
      html += '<button type="button" class="sess-item' +
        (invalid ? ' is-bad' : '') + (uploaded ? ' is-done' : '') +
        '" data-index="' + index + '">' +
        '<span class="sess-item__id">' + T.escapeHtml(session.cid) + '</span>' +
        '<span class="sess-item__meta">' +
        (invalid ? '无有效对话' : turns + ' 轮') +
        (uploaded ? ' · 已生成链接' : '') +
        (session.trace_id ? ' · ' + T.escapeHtml(session.trace_id.slice(0, 12)) : '') +
        '</span></button>';
    });
    el['sess-list'].innerHTML = html;
    el['sess-list'].querySelectorAll('.sess-item').forEach(function (node) {
      node.addEventListener('click', function () {
        show(parseInt(node.getAttribute('data-index'), 10));
      });
    });
  }

  function show(index) {
    state.active = index;
    var items = el['sess-list'].children;
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('is-active', i === index);
    var session = state.sessions[index];
    el['main-title'].textContent = 'session: ' + session.cid;
    el['main-sub'].textContent =
      'Excel 第 ' + session.sourceRow + ' 行 · trace_id: ' +
      (session.trace_id || '(无)') + ' · ' +
      session.models.map(function (model) {
        return model.name + ' ' + model.rec.count + ' 轮';
      }).join(' · ');
    el['render-scroll'].innerHTML = buildShot(session);
    el['render-scroll'].scrollTop = 0;
    bindPreviewImages(el['render-scroll']);
    return Promise.resolve();
  }

  function buildShot(session) {
    var columns = session.models.map(function (model) {
      var body = model.rec.empty
        ? '<div class="empty-hint">无有效对话轮次</div>'
        : buildChat(model.rec.turns);
      var title = session.models.length > 1
        ? '<div class="shot__col-title">' + T.escapeHtml(model.name) + '</div>'
        : '';
      return '<div class="shot__col">' + title + '<div class="chat-list">' + body + '</div></div>';
    }).join('');
    return '<div class="shot" id="shot">' +
      (session.models.length > 1 ? '<div class="shot__models">' + columns + '</div>' : columns) +
      '</div>';
  }

  function buildChat(turns) {
    var html = '';
    turns.forEach(function (turn, index) {
      var current = index === turns.length - 1;
      html += '<div class="turn-sep' + (current ? ' turn-sep--current' : '') + '"><span>第 ' +
        (index + 1) + ' 轮' + (current ? '（当前）' : '') + '</span></div>';
      if (turn.user_query || turn.user_images.length) {
        html += '<div class="msg msg--human"><div class="bubble-human">' +
          imageGallery(turn.user_images) + T.escapeHtml(turn.user_query) + '</div></div>';
      }
      if (turn.model_response || turn.ai_images.length) {
        html += '<div class="msg msg--ai"><div class="msg__avatar">元</div><div class="ai-content">' +
          imageGallery(turn.ai_images) +
          '<div class="md">' + renderMarkdown(turn.model_response || '') + '</div></div></div>';
      }
    });
    return html;
  }

  function imageGallery(images) {
    if (!images || !images.length) return '';
    var safeImages = images.filter(D.isSafeImageUrl);
    if (!safeImages.length) return '';
    return '<div class="t3-img-gallery">' + safeImages.map(function (url) {
      var escaped = T.escapeHtml(url);
      return '<figure class="t3-img-item">' +
        '<a class="t3-img-item__link" href="' + escaped + '" target="_blank" rel="noopener noreferrer">' +
        '<img class="t3-chat-img" data-url="' + escaped + '" alt="会话图片" referrerpolicy="no-referrer" />' +
        '</a>' +
        '<a class="t3-img-item__fallback" href="' + escaped +
        '" target="_blank" rel="noopener noreferrer" hidden>图片加载失败，查看原图</a>' +
        '</figure>';
    }).join('') + '</div>';
  }

  function bindPreviewImages(root) {
    root.querySelectorAll('.t3-chat-img').forEach(function (image) {
      var link = image.closest('.t3-img-item__link');
      var fallback = image.closest('.t3-img-item').querySelector('.t3-img-item__fallback');
      image.addEventListener('load', function () {
        link.hidden = false;
        fallback.hidden = true;
      });
      image.addEventListener('error', function () {
        link.hidden = true;
        fallback.hidden = false;
      });
      link.addEventListener('click', function (event) {
        if (image.naturalWidth > 0) {
          event.preventDefault();
          openLightbox(image.currentSrc || image.src);
        }
      });
      image.src = image.getAttribute('data-url');
    });
  }

  function escape(value) {
    return T.escapeHtml(value);
  }

  function inlineMarkdown(source) {
    var placeholders = [];
    var text = String(source || '').replace(/`([^`]+)`/g, function (_, code) {
      placeholders.push('<code>' + escape(code) + '</code>');
      return '\u0000' + (placeholders.length - 1) + '\u0000';
    });
    text = escape(text);
    text = text.replace(/\[\]\(@[^)]*\)/g, '');
    text = text.replace(/\[citation:(\d+)\]/g, '<sup class="cite">[$1]</sup>');
    text = text.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    text = text.replace(/\u0000(\d+)\u0000/g, function (_, index) {
      return placeholders[parseInt(index, 10)];
    });
    return text.replace(/\n/g, '<br>');
  }

  function splitTableRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) {
      return cell.trim();
    });
  }

  function renderMarkdown(source) {
    var lines = String(source || '').replace(/\r\n/g, '\n').replace(/\[\]\(@[^)]*\)/g, '').split('\n');
    var html = '';
    var index = 0;
    function isSeparator(line) {
      return line != null && /\|/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && /-/.test(line);
    }
    function isRow(line) {
      return line != null && line.indexOf('|') !== -1 && line.trim() !== '';
    }
    function isStrictRow(line) {
      return line != null && /^\s*\|.*\|\s*$/.test(line) && line.trim() !== '';
    }
    while (index < lines.length) {
      var line = lines[index];
      if (/^```/.test(line)) {
        var code = [];
        index++;
        while (index < lines.length && !/^```/.test(lines[index])) {
          code.push(lines[index]);
          index++;
        }
        if (index < lines.length) index++;
        html += '<pre><code>' + escape(code.join('\n')) + '</code></pre>';
        continue;
      }
      var nextIsSeparator = isSeparator(lines[index + 1]);
      var nextIsRow = isStrictRow(line) && isStrictRow(lines[index + 1]) &&
        splitTableRow(lines[index + 1]).length === splitTableRow(line).length;
      if (isRow(line) && (nextIsSeparator || nextIsRow)) {
        var header = splitTableRow(line);
        index++;
        if (isSeparator(lines[index])) index++;
        var tableRows = [];
        while (index < lines.length) {
          if (isSeparator(lines[index])) { index++; continue; }
          if (lines[index].trim() === '') { index++; continue; }
          if (!isRow(lines[index])) break;
          tableRows.push(splitTableRow(lines[index]));
          index++;
        }
        html += '<table><thead><tr>';
        header.forEach(function (cell) { html += '<th>' + inlineMarkdown(cell) + '</th>'; });
        html += '</tr></thead><tbody>';
        tableRows.forEach(function (row) {
          html += '<tr>';
          row.forEach(function (cell) { html += '<td>' + inlineMarkdown(cell) + '</td>'; });
          html += '</tr>';
        });
        html += '</tbody></table>';
        continue;
      }
      var heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        html += '<h' + heading[1].length + '>' + inlineMarkdown(heading[2]) + '</h' + heading[1].length + '>';
        index++;
        continue;
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        var tag = /^\s*\d+\.\s+/.test(line) ? 'ol' : 'ul';
        html += '<' + tag + '>';
        while (index < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[index])) {
          html += '<li>' + inlineMarkdown(lines[index].replace(/^\s*([-*+]|\d+\.)\s+/, '')) + '</li>';
          index++;
        }
        html += '</' + tag + '>';
        continue;
      }
      if (line.trim() === '') { index++; continue; }
      if (/^>\s?/.test(line)) {
        html += '<blockquote>' + inlineMarkdown(line.replace(/^>\s?/, '')) + '</blockquote>';
        index++;
        continue;
      }
      var paragraph = [line];
      index++;
      while (index < lines.length && lines[index].trim() !== '' &&
        !/^(#{1,4}\s|```|\s*([-*+]|\d+\.)\s|>\s?)/.test(lines[index]) &&
        !/\|/.test(lines[index])) {
        paragraph.push(lines[index]);
        index++;
      }
      html += '<p>' + inlineMarkdown(paragraph.join('\n')) + '</p>';
    }
    return html;
  }

  var lightboxState = { scale: 1, rotate: 0, x: 0, y: 0 };
  var lightboxDrag = { active: false, moved: false, startX: 0, startY: 0, baseX: 0, baseY: 0 };

  function applyLightboxTransform() {
    el['lb-img'].style.transform =
      'translate(' + lightboxState.x + 'px,' + lightboxState.y + 'px) ' +
      'rotate(' + lightboxState.rotate + 'deg) scale(' + lightboxState.scale + ')';
  }

  function resetLightbox() {
    lightboxState = { scale: 1, rotate: 0, x: 0, y: 0 };
    applyLightboxTransform();
  }

  function zoomLightbox(direction) {
    var factor = direction > 0 ? 1.2 : (1 / 1.2);
    lightboxState.scale = Math.max(0.1, Math.min(8, lightboxState.scale * factor));
    applyLightboxTransform();
  }

  function openLightbox(src) {
    resetLightbox();
    el['lb-img'].src = src;
    el.lightbox.hidden = false;
    document.body.classList.add('t3-lbx-open');
  }

  function closeLightbox() {
    el.lightbox.hidden = true;
    el['lb-img'].src = '';
    document.body.classList.remove('t3-lbx-open');
  }

  function bindLightbox() {
    el.lightbox.querySelectorAll('[data-lbx-close]').forEach(function (node) {
      node.addEventListener('click', closeLightbox);
    });
    el.lightbox.querySelectorAll('[data-lbx-action]').forEach(function (button) {
      button.addEventListener('click', function () {
        var action = button.getAttribute('data-lbx-action');
        if (action === 'zoom-in') zoomLightbox(1);
        else if (action === 'zoom-out') zoomLightbox(-1);
        else if (action === 'rotate-left') {
          lightboxState.rotate -= 90;
          applyLightboxTransform();
        } else if (action === 'rotate-right') {
          lightboxState.rotate += 90;
          applyLightboxTransform();
        } else if (action === 'reset') resetLightbox();
      });
    });
    el.lightbox.addEventListener('wheel', function (event) {
      if (el.lightbox.hidden) return;
      event.preventDefault();
      zoomLightbox(event.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    el['lb-img'].addEventListener('mousedown', function (event) {
      if (event.button !== 0) return;
      lightboxDrag.active = true;
      lightboxDrag.moved = false;
      lightboxDrag.startX = event.clientX;
      lightboxDrag.startY = event.clientY;
      lightboxDrag.baseX = lightboxState.x;
      lightboxDrag.baseY = lightboxState.y;
      el['lb-img'].classList.add('is-dragging');
      event.preventDefault();
    });
    el['lb-stage'].addEventListener('click', function (event) {
      if (event.target === el['lb-stage'] && !lightboxDrag.moved) closeLightbox();
    });
    document.addEventListener('mousemove', function (event) {
      if (!lightboxDrag.active) return;
      var dx = event.clientX - lightboxDrag.startX;
      var dy = event.clientY - lightboxDrag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) lightboxDrag.moved = true;
      lightboxState.x = lightboxDrag.baseX + dx;
      lightboxState.y = lightboxDrag.baseY + dy;
      applyLightboxTransform();
    });
    document.addEventListener('mouseup', function () {
      lightboxDrag.active = false;
      el['lb-img'].classList.remove('is-dragging');
    });
    document.addEventListener('keydown', function (event) {
      if (!el.lightbox.hidden && event.key === 'Escape') closeLightbox();
    });
  }

  function responseError(response, fallback) {
    return response.json().catch(function () { return {}; }).then(function (data) {
      var message = data && data.error && data.error.message;
      throw new Error(message || data.message || fallback || ('HTTP ' + response.status));
    });
  }

  function imageBlobFromBrowser(url) {
    return fetch(url, { credentials: 'include' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType.indexOf('image/') !== 0) throw new Error('响应不是图片');
      return response.blob();
    });
  }

  function imageBlobFromLocal(url) {
    if (!isLocalApp()) throw new Error('当前不是本地页面');
    return fetch('api/tool3/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, cookie: el['img-cookie'].value || '' })
    }).then(function (response) {
      if (!response.ok) return responseError(response, '本地图片读取失败');
      var contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType.indexOf('image/') !== 0) throw new Error('本地服务未返回图片');
      return response.blob();
    });
  }

  function captureImageUrl(url) {
    if (captureImageCache[url]) return captureImageCache[url].promise;
    var entry = {};
    entry.promise = imageBlobFromBrowser(url).catch(function () {
      return imageBlobFromLocal(url);
    }).then(function (blob) {
      if (!blob || !blob.size) throw new Error('图片内容为空');
      entry.objectUrl = URL.createObjectURL(blob);
      return entry.objectUrl;
    }).catch(function (error) {
      delete captureImageCache[url];
      throw error;
    });
    captureImageCache[url] = entry;
    return entry.promise;
  }

  function setImageSource(image, src) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('图片加载超时'));
      }, 15000);
      image.onload = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      image.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error('图片解码失败'));
      };
      image.src = src;
      if (image.complete && image.naturalWidth > 0) image.onload();
    });
  }

  function prepareCaptureImages(root) {
    var images = [].slice.call(root.querySelectorAll('.t3-chat-img'));
    return Promise.all(images.map(function (image) {
      var original = image.getAttribute('data-url');
      return captureImageUrl(original).then(function (localUrl) {
        var item = image.closest('.t3-img-item');
        item.querySelector('.t3-img-item__link').hidden = false;
        item.querySelector('.t3-img-item__fallback').hidden = true;
        return setImageSource(image, localUrl);
      }).catch(function (error) {
        throw new Error('图片无法写入截图：' + safeErrorMessage(error, '请检查图片权限或填写 Cookie。'));
      });
    }));
  }

  function nextPaint() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(resolve); });
    });
  }

  function captureVisibleSession() {
    var node = document.getElementById('shot');
    if (!node) return Promise.reject(new Error('无渲染内容'));
    return prepareCaptureImages(node).then(nextPaint).then(function () {
      return html2canvas(node, {
        backgroundColor: '#faf9f7',
        scale: 2,
        useCORS: false,
        logging: false
      });
    });
  }

  function captureSession(index) {
    return show(index).then(captureVisibleSession);
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob && blob.size) resolve(blob);
        else reject(new Error('PNG 生成失败'));
      }, 'image/png');
    });
  }

  function exportCurrent() {
    if (state.active < 0 || state.busy) return;
    var index = state.active;
    setBusy(true);
    setStatus('正在加载图片并生成当前会话 PNG…');
    captureSession(index).then(canvasToBlob).then(function (blob) {
      T.downloadBlob('session_' + safeName(state.sessions[index].cid) + '.png', blob);
      setStatus('已导出当前会话 PNG。', 'ok');
    }).catch(function (error) {
      setStatus('导出失败：' + safeErrorMessage(error, '无法生成截图。'), 'error');
    }).then(function () {
      setBusy(false);
    });
  }

  function exportAll() {
    if (!state.sessions.length || state.busy) return;
    var zip = new JSZip();
    var originalActive = state.active;
    var index = 0;
    setBusy(true);
    function step() {
      if (index >= state.sessions.length) {
        return zip.generateAsync({ type: 'blob' }).then(function (blob) {
          T.downloadBlob('sessions_png.zip', blob);
          setStatus('已导出全部 ' + state.sessions.length + ' 张 PNG（zip）。', 'ok');
        });
      }
      setStatus('正在批量渲染…（' + (index + 1) + '/' + state.sessions.length + '）');
      var current = index;
      return captureSession(current).then(canvasToBlob).then(function (blob) {
        zip.file((current + 1) + '_' + safeName(state.sessions[current].cid) + '.png', blob);
        index++;
        return step();
      });
    }
    step().catch(function (error) {
      setStatus('批量导出在第 ' + (index + 1) + ' 个会话停止：' +
        safeErrorMessage(error, '无法生成截图。') + '；未生成缺图截图。', 'error');
    }).then(function () {
      if (originalActive >= 0 && originalActive < state.sessions.length) show(originalActive);
      setBusy(false);
    });
  }

  function uploadScreenshot(blob, index, environment) {
    var filename = 'tool3_' + String(index + 1).padStart(4, '0') + '_' +
      safeName(state.sessions[index].cid) + '.png';
    var url = 'api/tool1/upload?env=' + encodeURIComponent(environment) +
      '&filename=' + encodeURIComponent(filename);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: blob
    }).then(function (response) {
      if (!response.ok) return responseError(response, '截图上传失败');
      return response.json();
    }).then(function (data) {
      if (!data.ok || !D.isSafeImageUrl(data.url)) throw new Error('上传接口未返回有效图片链接');
      return data.url;
    });
  }

  function downloadLinkedWorkbook() {
    var pairs = state.sessions.map(function (session, index) {
      return { row: session.sourceRow, url: state.screenshotUrls[index] };
    });
    return D.appendUrlsToWorkbook(state.fileBuffer, pairs).then(function (blob) {
      T.downloadBlob(outputFilename(), blob);
    });
  }

  function generateLinkedWorkbook() {
    if (state.busy || el['generate-links'].disabled) return;
    var environment = currentEnv();
    if (environment === 'prod' && !window.confirm(
      '即将把 ' + state.sessions.length + ' 张会话截图上传到正式环境。确认继续吗？'
    )) return;
    var originalActive = state.active;
    var cursor = 0;
    setBusy(true);

    function step() {
      while (cursor < state.sessions.length && state.screenshotUrls[cursor]) cursor++;
      if (cursor >= state.sessions.length) {
        setStatus('全部截图已上传，正在保留原工作簿结构并写入 png_url…');
        return downloadLinkedWorkbook().then(function () {
          setStatus('已生成 ' + outputFilename() + '；原 Excel 未修改。', 'ok');
        });
      }
      var current = cursor;
      var completed = state.screenshotUrls.filter(Boolean).length;
      setStatus('正在生成并上传截图…（' + (completed + 1) + '/' + state.sessions.length + '）');
      return captureSession(current).then(canvasToBlob).then(function (blob) {
        return uploadScreenshot(blob, current, environment);
      }).then(function (url) {
        state.screenshotUrls[current] = url;
        renderList();
        cursor++;
        return step();
      });
    }

    step().catch(function (error) {
      var completed = state.screenshotUrls.filter(Boolean).length;
      setStatus('处理在第 ' + (cursor + 1) + ' 个会话停止：' +
        safeErrorMessage(error, '生成或上传失败。') + '；已保留 ' + completed +
        ' 个成功链接，再次点击会自动跳过。', 'error');
    }).then(function () {
      if (originalActive >= 0 && originalActive < state.sessions.length) show(originalActive);
      setBusy(false);
    });
  }

  T.bindFileInput({
    dropzone: el.dropzone,
    fileInput: el['file-input'],
    pickBtn: el['pick-btn'],
    onFile: onFile
  });

  el['remap-btn'].addEventListener('click', function () {
    if (!state.rows.length || state.busy) return;
    Mapping.open({
      fields: buildFields(dual()),
      headers: state.headers,
      mapping: state.mapping,
      title: '会话渲染 · 列映射',
      onConfirm: applyMapping
    });
  });

  el['dual-toggle'].addEventListener('change', function () {
    resetGeneratedLinks();
    if (!state.rows.length) return;
    Mapping.run({
      fields: buildFields(dual()),
      headers: state.headers,
      title: '会话渲染 · 列映射',
      onConfirm: applyMapping
    });
  });

  [el['env-test'], el['env-prod']].forEach(function (radio) {
    radio.addEventListener('change', function () {
      resetGeneratedLinks();
      updateServiceStatus();
      renderList();
    });
  });

  el['img-cookie'].addEventListener('change', function () {
    revokeCaptureCache();
    resetGeneratedLinks();
    renderList();
  });
  el['img-reload'].addEventListener('click', function () {
    revokeCaptureCache();
    if (state.active >= 0) show(state.active);
  });
  el['export-one'].addEventListener('click', exportCurrent);
  el['export-all'].addEventListener('click', exportAll);
  el['generate-links'].addEventListener('click', generateLinkedWorkbook);

  bindLightbox();
  checkHealth();
  updateGenerateButton();

  window.__tool3Test = {
    messagesToRecord: messagesToRecord,
    parseSpreadsheet: parseSpreadsheet,
    outputFilename: outputFilename
  };
})();
