/* ============================================================
   mapping.js —— 可复用「自定义列映射」组件（Beacon 风格弹窗）
   4 个工具共用。支持单列(select)与多列(checkbox)字段、别名自动识别。

   字段定义 field: {
     key:      字段标识
     label:    显示名
     required: 是否必选
     desc:     说明
     aliases:  别名数组（归一化匹配，命中即自动选中）
     multi:    true = 多选（复选框列表），返回数组；否则返回单个列名
     prefixes: 多选时的序号前缀（如 ['洗后图','图','image']），优先于 aliases
   }

   API:
     Mapping.auto(fields, headers)            -> 自动检测得到的 mapping
     Mapping.isComplete(fields, mapping)      -> 必选字段是否都已选
     Mapping.open({fields, headers, mapping, title, note, onConfirm})
     Mapping.run({fields, headers, title, note, forceModal, onConfirm})
   ============================================================ */
(function (global) {
  'use strict';
  var T = global.iTools;

  function auto(fields, headers) {
    var map = {};
    fields.forEach(function (f) {
      if (f.multi) {
        var cols = [];
        if (f.prefixes) cols = T.matchIndexedColumns(headers, f.prefixes);
        if (!cols.length && f.matchPrefixes) {
          var normalizedPrefixes = f.matchPrefixes.map(T.normalize);
          cols = headers.filter(function (header) {
            var normalizedHeader = T.normalize(header);
            return normalizedPrefixes.some(function (prefix) {
              return normalizedHeader.indexOf(prefix) === 0;
            });
          });
        }
        if (!cols.length && f.aliases) {
          headers.forEach(function (h) {
            var n = T.normalize(h);
            if (f.aliases.map(T.normalize).indexOf(n) !== -1) cols.push(h);
          });
        }
        map[f.key] = cols;
      } else {
        map[f.key] = T.matchHeader(headers, f.aliases || [f.key]);
      }
    });
    return map;
  }

  function isComplete(fields, mapping) {
    return fields.every(function (f) {
      if (!f.required) return true;
      var v = mapping[f.key];
      return f.multi ? (v && v.length) : !!v;
    });
  }

  /* ---------- 弹窗 DOM（懒创建，全局唯一）---------- */
  var modal = null;
  function ensureModal() {
    if (modal) return modal;
    var wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="modal__mask" data-close></div>' +
      '<div class="modal__dialog">' +
      '  <div class="modal__header"><span class="modal__title" id="mp-title">选择字段映射</span>' +
      '    <button class="modal__close" type="button" data-close>✕</button></div>' +
      '  <div class="modal__body">' +
      '    <p class="mapping-note" id="mp-note"></p>' +
      '    <div id="mp-fields"></div>' +
      '  </div>' +
      '  <div class="modal__footer">' +
      '    <button class="btn btn--ghost" type="button" data-close>取消</button>' +
      '    <button class="btn btn--primary" type="button" id="mp-confirm">确认并继续</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) {
      if (e.target.hasAttribute('data-close')) close();
    });
    modal = wrap;
    return wrap;
  }

  function close() { if (modal) modal.hidden = true; }

  function renderFields(fields, headers, mapping) {
    var box = modal.querySelector('#mp-fields');
    var html = '';
    fields.forEach(function (f) {
      html += '<div class="mapping-field">';
      html += '<div class="mapping-field__row">';
      html += '<span class="mapping-field__name">' + T.escapeHtml(f.label) + '</span>';
      html += '<span class="mapping-field__req' + (f.required ? ' is-required' : '') + '">' +
        (f.required ? '必选' : '可选') + (f.desc ? ' · ' + T.escapeHtml(f.desc) : '') + '</span>';
      html += '</div>';
      if (f.multi) {
        var cur = mapping[f.key] || [];
        html += '<div class="field-checks" data-field="' + f.key + '">';
        headers.forEach(function (h) {
          var on = cur.indexOf(h) !== -1;
          html += '<label class="field-check' + (on ? ' is-on' : '') + '">' +
            '<input type="checkbox" value="' + encodeURIComponent(h) + '"' + (on ? ' checked' : '') + '>' +
            T.escapeHtml(h) + '</label>';
        });
        html += '</div>';
      } else {
        html += '<select class="field-select" data-field="' + f.key + '">';
        html += '<option value="">— 从数据集选择列 —</option>';
        headers.forEach(function (h) {
          var sel = (h === mapping[f.key]) ? ' selected' : '';
          html += '<option value="' + encodeURIComponent(h) + '"' + sel + '>' + T.escapeHtml(h) + '</option>';
        });
        html += '</select>';
      }
      html += '</div>';
    });
    box.innerHTML = html;
    // checkbox 高亮联动
    box.querySelectorAll('.field-check input').forEach(function (cb) {
      cb.addEventListener('change', function () { cb.parentNode.classList.toggle('is-on', cb.checked); });
    });
  }

  function open(opts) {
    ensureModal();
    var fields = opts.fields, headers = opts.headers;
    var mapping = opts.mapping || auto(fields, headers);
    modal.querySelector('#mp-title').textContent = opts.title || '选择字段映射';
    var note = modal.querySelector('#mp-note');
    note.textContent = opts.note || '系统已尝试自动识别列名。若不正确，请手动把数据列对应到下方字段。';
    renderFields(fields, headers, mapping);
    var confirm = modal.querySelector('#mp-confirm');
    confirm.onclick = function () {
      var result = {};
      var ok = true;
      fields.forEach(function (f) {
        if (f.multi) {
          var checks = modal.querySelectorAll('.field-checks[data-field="' + f.key + '"] input:checked');
          var vals = Array.prototype.map.call(checks, function (c) { return decodeURIComponent(c.value); });
          result[f.key] = vals;
          if (f.required && !vals.length) ok = false;
        } else {
          var sel = modal.querySelector('.field-select[data-field="' + f.key + '"]');
          var v = sel.value ? decodeURIComponent(sel.value) : null;
          result[f.key] = v;
          var invalid = f.required && !v;
          sel.classList.toggle('is-invalid', !!invalid);
          if (invalid) ok = false;
        }
      });
      if (!ok) { note.textContent = '请为所有必选字段选择对应的数据列。'; note.style.color = 'var(--beacon-danger)'; return; }
      note.style.color = '';
      close();
      opts.onConfirm(result);
    };
    modal.hidden = false;
  }

  // 自动检测；完整且未强制则直接回调，否则弹窗
  function run(opts) {
    var mapping = auto(opts.fields, opts.headers);
    if (!opts.forceModal && isComplete(opts.fields, mapping)) {
      opts.onConfirm(mapping);
    } else {
      open({
        fields: opts.fields, headers: opts.headers, mapping: mapping,
        title: opts.title, note: opts.note, onConfirm: opts.onConfirm
      });
    }
  }

  global.Mapping = { auto: auto, isComplete: isComplete, open: open, run: run, close: close };
})(window);
