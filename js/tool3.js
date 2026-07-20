/* ============================================================
   tool3.js —— 多轮会话渲染（移植 convert_to_png.py 的解析 + 渲染）
   把拉题结果里 messages 列还原成多轮对话，支持单/双模型对照，
   markdown 富文本渲染，导出 PNG（html2canvas）+ 打包 zip（JSZip）。
   ============================================================ */
(function () {
  'use strict';
  var T = window.iTools;

  function buildFields(dual) {
    var f = [
      { key: 'messages_1', label: dual ? 'messages 列（模型1）' : 'messages 列', required: true,
        desc: 'session_answer / 完整对话 JSON',
        aliases: ['session_answer', 'session_anwser', 'messages', 'session_answer_1', 'session_anwser_1', 'conversation', '对话'] },
      { key: 'cid', label: 'session 标识列', required: false, desc: 'cid / session_id',
        aliases: ['cid', 'session_id', 'session', 'sessionid'] },
      { key: 'trace_id', label: 'trace_id 列', required: false, desc: '覆盖单元格内 trace_id',
        aliases: ['trace_id', 'traceid'] }
    ];
    if (dual) {
      f.splice(1, 0, { key: 'messages_2', label: 'messages 列（模型2）', required: true,
        desc: '第二模型完整对话 JSON',
        aliases: ['session_answer_2', 'session_anwser_2', 'messages_2', 'response_2'] });
    }
    return f;
  }

  var state = { headers: [], rows: [], mapping: null, sessions: [], active: -1 };
  var imgCache = {}; // url -> { status:'ok'|'fail', objectUrl }
  var el = {};
  ['dropzone', 'pick-btn', 'file-input', 'file-name', 'status', 'render-section',
   'sess-list', 'sess-count', 'main-title', 'main-sub', 'render-scroll',
   'export-one', 'export-all', 'remap-btn', 'dual-toggle', 'lightbox', 'lb-img',
   'img-fetch', 'img-cookie', 'img-headers', 'img-reload'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  function dual() { return el['dual-toggle'].checked; }
  function setStatus(msg, kind) {
    el.status.hidden = false;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    el.status.textContent = msg;
  }

  /* ---------- 图片鉴权加载 ---------- */
  function authConfig() {
    var headers = {};
    var raw = (el['img-headers'].value || '').trim();
    if (raw) { try { headers = JSON.parse(raw); } catch (e) { /* 忽略非法 JSON */ } }
    var cookie = (el['img-cookie'].value || '').trim();
    // Cookie 头多被浏览器忽略，但内网/部分环境可用；仍附带，主要依赖 credentials:'include'
    if (cookie) headers['Cookie'] = cookie;
    return { headers: headers, useFetch: el['img-fetch'].checked };
  }

  // 通过 fetch 拉取图片为本地 blob url；带 credentials 以携带已登录 Cookie。返回 Promise。
  function fetchImage(url) {
    if (imgCache[url] && imgCache[url].status === 'ok') return Promise.resolve(imgCache[url].objectUrl);
    var cfg = authConfig();
    var opts = { credentials: 'include', mode: 'cors' };
    if (Object.keys(cfg.headers).length) opts.headers = cfg.headers;
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (blob) {
      var obj = URL.createObjectURL(blob);
      imgCache[url] = { status: 'ok', objectUrl: obj };
      return obj;
    }).catch(function (e) {
      imgCache[url] = { status: 'fail' };
      throw e;
    });
  }

  T.bindFileInput({ dropzone: el.dropzone, fileInput: el['file-input'], pickBtn: el['pick-btn'], onFile: onFile });
  el['remap-btn'].addEventListener('click', function () {
    Mapping.open({ fields: buildFields(dual()), headers: state.headers, mapping: state.mapping, title: '会话渲染 · 列映射', onConfirm: applyMapping });
  });
  el['dual-toggle'].addEventListener('change', function () {
    if (state.rows.length) { state.mapping = null; Mapping.run({ fields: buildFields(dual()), headers: state.headers, title: '会话渲染 · 列映射', onConfirm: applyMapping }); }
  });
  el['export-one'].addEventListener('click', exportCurrent);
  el['export-all'].addEventListener('click', exportAll);
  el.lightbox.addEventListener('click', function () { el.lightbox.classList.remove('is-open'); el['lb-img'].src = ''; });
  el['img-reload'].addEventListener('click', function () {
    imgCache = {}; // 清缓存，用新 Cookie/头重拉
    if (state.active >= 0) show(state.active);
  });
  el['img-fetch'].addEventListener('change', function () {
    imgCache = {};
    if (state.active >= 0) show(state.active);
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
      Mapping.run({ fields: buildFields(dual()), headers: res.headers, title: '会话渲染 · 列映射', onConfirm: applyMapping });
    }).catch(function (e) { setStatus('解析失败：' + e.message, 'error'); });
  }

  // messages 序列 → 轮次分组 turns（移植 conversation_to_record）
  function toRecord(cellVal) {
    var msgs = T.parseMessages(cellVal);
    var turns = [], cur = null, traceId = '';
    msgs.forEach(function (m) {
      if (m.trace_id) traceId = m.trace_id;
      if (m.role === 'user') {
        cur = { user_query: m.text, user_images: m.images || [], model_response: '', ai_images: [] };
        turns.push(cur);
      } else if (m.role === 'assistant') {
        if (!cur || cur.model_response) { cur = { user_query: '', user_images: [], model_response: '', ai_images: [] }; turns.push(cur); }
        cur.model_response = m.text;
        cur.ai_images = m.images || [];
      }
    });
    return { turns: turns, trace_id: traceId, count: turns.length, empty: !turns.length };
  }

  function applyMapping(mapping) {
    state.mapping = mapping;
    var isDual = dual();
    var sessions = state.rows.map(function (row, i) {
      var cid = mapping.cid ? String(row[mapping.cid] || '').trim() : '';
      var tid = mapping.trace_id ? String(row[mapping.trace_id] || '').trim() : '';
      var m1 = toRecord(row[mapping.messages_1]);
      var models = [{ name: isDual ? '模型 1' : '模型', rec: m1 }];
      if (isDual) models.push({ name: '模型 2', rec: toRecord(row[mapping.messages_2]) });
      return { idx: i, cid: cid || ('行 ' + (i + 1)), trace_id: tid || m1.trace_id, models: models };
    });
    state.sessions = sessions;
    el['render-section'].hidden = false;
    el['sess-count'].textContent = '会话（' + sessions.length + '）';
    setStatus('已加载 ' + sessions.length + ' 个会话。', 'ok');
    renderList();
    if (sessions.length) show(0);
  }

  function renderList() {
    var html = '';
    state.sessions.forEach(function (s, i) {
      var bad = s.models.every(function (m) { return m.rec.empty; });
      var turns = s.models.map(function (m) { return m.rec.count; }).join('/');
      html += '<div class="sess-item' + (bad ? ' is-bad' : '') + '" data-i="' + i + '">' +
        '<div class="sess-item__id">' + T.escapeHtml(s.cid) + '</div>' +
        '<div class="sess-item__meta">' + (bad ? '无有效对话' : (turns + ' 轮')) +
        (s.trace_id ? ' · ' + T.escapeHtml(s.trace_id.slice(0, 12)) : '') + '</div></div>';
    });
    el['sess-list'].innerHTML = html;
    el['sess-list'].querySelectorAll('.sess-item').forEach(function (node) {
      node.addEventListener('click', function () { show(parseInt(node.getAttribute('data-i'), 10)); });
    });
  }

  function show(i) {
    state.active = i;
    var items = el['sess-list'].children;
    for (var k = 0; k < items.length; k++) items[k].classList.toggle('is-active', k === i);
    var s = state.sessions[i];
    el['main-title'].textContent = 'session: ' + s.cid;
    el['main-sub'].textContent = 'trace_id: ' + (s.trace_id || '(无)') + ' · ' + s.models.map(function (m) { return m.name + ' ' + m.rec.count + ' 轮'; }).join(' · ');
    el['render-scroll'].innerHTML = buildShot(s);
    el['img-reload'].hidden = false;
    el['render-scroll'].scrollTop = 0;
    return loadImages(el['render-scroll']);
  }

  function buildShot(s) {
    var cols = s.models.map(function (m) {
      var inner = m.rec.empty ? '<div class="empty-hint">无有效对话轮次</div>' : buildChat(m.rec.turns);
      var title = s.models.length > 1 ? '<div class="shot__col-title">' + T.escapeHtml(m.name) + '</div>' : '';
      return '<div class="shot__col">' + title + '<div class="chat-list">' + inner + '</div></div>';
    }).join('');
    return '<div class="shot" id="shot">' + (s.models.length > 1 ? '<div class="shot__models">' + cols + '</div>' : cols) + '</div>';
  }

  function buildChat(turns) {
    var html = '';
    turns.forEach(function (t, i) {
      html += '<div class="turn-sep' + (i === turns.length - 1 ? ' turn-sep--current' : '') + '"><span>第 ' + (i + 1) + ' 轮' + (i === turns.length - 1 ? '（当前）' : '') + '</span></div>';
      if (t.user_query || (t.user_images && t.user_images.length)) {
        html += '<div class="msg msg--human"><div class="bubble-human">' + imgGallery(t.user_images) + T.escapeHtml(t.user_query) + '</div></div>';
      }
      if (t.model_response || (t.ai_images && t.ai_images.length)) {
        html += '<div class="msg msg--ai"><div class="msg__avatar">元</div><div class="ai-content">' +
          imgGallery(t.ai_images) + '<div class="md">' + renderMarkdown(t.model_response || '') + '</div></div></div>';
      }
    });
    return html;
  }

  function imgGallery(images) {
    if (!images || !images.length) return '';
    var h = '<div class="img-gallery">';
    images.forEach(function (u) {
      var e = T.escapeHtml(u);
      h += '<div class="img-wrap"><img class="chat-img" alt="图片" data-src="' + e + '" />' +
        '<a class="img-orig-link" href="' + e + '" target="_blank" rel="noopener">查看原图</a></div>';
    });
    return h + '</div>';
  }

  function replaceFail(img) {
    var fail = document.createElement('div');
    fail.className = 'img-fail'; fail.textContent = '[图片加载失败]';
    if (img.parentNode) img.parentNode.replaceChild(fail, img);
  }

  // 加载 root 内所有图片：勾选 fetch 时用带鉴权的 fetch→blob，否则直接 <img src>。返回全部 settled 的 Promise。
  function loadImages(root) {
    var cfg = authConfig();
    var imgs = [].slice.call(root.querySelectorAll('.chat-img'));
    return Promise.all(imgs.map(function (img) {
      var url = img.getAttribute('data-src');
      img.addEventListener('click', function () {
        el['lb-img'].src = img.getAttribute('src') || url; el.lightbox.classList.add('is-open');
      });
      function bindImg(src, tainted) {
        return new Promise(function (res) {
          img.onload = function () { res(); };
          img.onerror = function () { replaceFail(img); res(); };
          if (!tainted) img.crossOrigin = 'anonymous';
          img.src = src;
        });
      }
      if (!cfg.useFetch) return bindImg(url, false);
      return fetchImage(url).then(function (obj) { return bindImg(obj, true); })
        .catch(function () { return bindImg(url, true); }); // fetch 失败时回退直接加载（可显示，导出可能污染）
    }));
  }

  /* ---------- markdown 渲染（移植 convert_to_png.py HTML_TEMPLATE）---------- */
  function esc(s) { return T.escapeHtml(s); }
  function cleanMarks(s) {
    s = s.replace(/\[\]\(@[^)]*\)/g, '');
    s = s.replace(/\[citation:(\d+)\]/g, '<sup class="cite">[$1]</sup>');
    return s;
  }
  function inlineMd(s) {
    var ph = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) { ph.push('<code>' + esc(c) + '</code>'); return '\u0000' + (ph.length - 1) + '\u0000'; });
    s = esc(s);
    s = cleanMarks(s);
    s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return ph[+i]; });
    s = s.replace(/\n/g, '<br>');
    return s;
  }
  function splitRow(line) {
    var s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|').map(function (c) { return c.trim(); });
  }
  function renderMarkdown(src) {
    var text = String(src).replace(/\r\n/g, '\n').replace(/\[\]\(@[^)]*\)/g, '');
    var lines = text.split('\n'), html = '', i = 0;
    var isSep = function (s) { return s != null && /\|/.test(s) && /^\s*\|?[\s:|-]+\|?\s*$/.test(s) && /-/.test(s); };
    var isRow = function (s) { return s != null && s.indexOf('|') !== -1 && s.trim() !== ''; };
    var isStrictRow = function (s) { return s != null && /^\s*\|.*\|\s*$/.test(s) && s.trim() !== ''; };
    while (i < lines.length) {
      var line = lines[i];
      var fence = line.match(/^```(.*)$/);
      if (fence) {
        var buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html += '<pre><code>' + esc(buf.join('\n')) + '</code></pre>';
        continue;
      }
      var nextIsSep = isSep(lines[i + 1]);
      var nextIsRow = isStrictRow(line) && isStrictRow(lines[i + 1]) &&
        splitRow(lines[i + 1]).length >= 2 && splitRow(lines[i + 1]).length === splitRow(line).length;
      if (isRow(line) && (nextIsSep || nextIsRow)) {
        var head = splitRow(line); i++;
        if (isSep(lines[i])) i++;
        var rows = [];
        while (i < lines.length) {
          if (isSep(lines[i])) { i++; continue; }
          if (lines[i].trim() === '') { i++; continue; }
          if (!isRow(lines[i])) break;
          rows.push(splitRow(lines[i])); i++;
        }
        html += '<table><thead><tr>';
        head.forEach(function (c) { html += '<th>' + inlineMd(c) + '</th>'; });
        html += '</tr></thead><tbody>';
        rows.forEach(function (r) { html += '<tr>'; r.forEach(function (c) { html += '<td>' + inlineMd(c) + '</td>'; }); html += '</tr>'; });
        html += '</tbody></table>';
        continue;
      }
      var h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { html += '<h' + h[1].length + '>' + inlineMd(h[2]) + '</h' + h[1].length + '>'; i++; continue; }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        var ordered = /^\s*\d+\.\s+/.test(line);
        var tag = ordered ? 'ol' : 'ul';
        html += '<' + tag + '>';
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          html += '<li>' + inlineMd(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')) + '</li>'; i++;
        }
        html += '</' + tag + '>';
        continue;
      }
      if (line.trim() === '') { i++; continue; }
      if (/^>\s?/.test(line)) { html += '<blockquote>' + inlineMd(line.replace(/^>\s?/, '')) + '</blockquote>'; i++; continue; }
      var para = [line]; i++;
      while (i < lines.length && lines[i].trim() !== '' &&
        !/^(#{1,4}\s|```|\s*([-*+]|\d+\.)\s|>\s?)/.test(lines[i]) && !/\|/.test(lines[i])) { para.push(lines[i]); i++; }
      html += '<p>' + inlineMd(para.join('\n')) + '</p>';
    }
    return html;
  }

  /* ---------- 导出 PNG ---------- */
  function safeName(s) { return String(s).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'session'; }

  function capture() {
    var node = document.getElementById('shot');
    if (!node) return Promise.reject(new Error('无渲染内容'));
    return html2canvas(node, { backgroundColor: '#faf9f7', scale: 2, useCORS: true, logging: false });
  }

  function exportCurrent() {
    if (state.active < 0) return;
    setStatus('正在加载图片并生成 PNG…');
    loadImages(el['render-scroll']).then(capture).then(function (canvas) {
      canvas.toBlob(function (blob) {
        T.downloadBlob('session_' + safeName(state.sessions[state.active].cid) + '.png', blob);
        setStatus('已导出当前会话 PNG。', 'ok');
      });
    }).catch(function (e) { setStatus('导出失败：' + e.message, 'error'); });
  }

  function exportAll() {
    if (!state.sessions.length) return;
    var zip = new JSZip();
    var i = 0;
    setStatus('正在批量渲染…（0/' + state.sessions.length + '）');
    function step() {
      if (i >= state.sessions.length) {
        zip.generateAsync({ type: 'blob' }).then(function (blob) {
          T.downloadBlob('sessions_png.zip', blob);
          setStatus('已导出全部 ' + state.sessions.length + ' 张 PNG（zip）。', 'ok');
        });
        return;
      }
      setStatus('正在批量渲染…（' + (i + 1) + '/' + state.sessions.length + '）');
      // show() 返回图片加载完成的 Promise，加载完再截图
      show(i).then(capture).then(function (canvas) {
        canvas.toBlob(function (blob) {
          zip.file((i + 1) + '_' + safeName(state.sessions[i].cid) + '.png', blob);
          i++; step();
        });
      }).catch(function () { i++; step(); });
    }
    step();
  }
})();
