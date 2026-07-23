/* Demand 3 data helpers: conversation normalization and in-place XLSX URL appending. */
(function (global) {
  'use strict';

  var REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

  function uniq(values) {
    var seen = Object.create(null);
    var output = [];
    (values || []).forEach(function (value) {
      var key = String(value);
      if (!seen[key]) {
        seen[key] = true;
        output.push(key);
      }
    });
    return output;
  }

  function parseLooseJson(value) {
    var parsed = value;
    for (var i = 0; i < 3 && typeof parsed === 'string'; i++) {
      var text = parsed.trim();
      if (!text || text === 'null') return null;
      if (text[0] !== '[' && text[0] !== '{' && text[0] !== '"') return parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return parsed;
      }
    }
    return parsed;
  }

  function isSafeImageUrl(value) {
    if (typeof value !== 'string') return false;
    try {
      var url = new URL(value.trim());
      return (url.protocol === 'http:' || url.protocol === 'https:') &&
        !!url.hostname && !url.username && !url.password;
    } catch (error) {
      return false;
    }
  }

  function addImageCandidate(output, candidate) {
    if (candidate == null) return;
    if (typeof candidate === 'string') {
      var parsed = parseLooseJson(candidate);
      if (parsed !== candidate && (Array.isArray(parsed) || (parsed && typeof parsed === 'object'))) {
        collectImages(parsed, output);
        return;
      }
      candidate.split(/[\n,]+/).forEach(function (part) {
        var value = part.trim();
        if (isSafeImageUrl(value)) output.push(value);
      });
      return;
    }
    collectImages(candidate, output);
  }

  function collectImages(value, output) {
    output = output || [];
    if (value == null) return output;
    if (Array.isArray(value)) {
      value.forEach(function (item) { addImageCandidate(output, item); });
      return output;
    }
    if (typeof value === 'string') {
      addImageCandidate(output, value);
      return output;
    }
    if (typeof value !== 'object') return output;

    var mediaType = String(value.type || value.media_type || value.mime_type || '').toLowerCase();
    var explicitlyNotImage = mediaType &&
      mediaType !== 'image' &&
      mediaType !== 'image_url' &&
      mediaType.indexOf('image/') !== 0;
    var direct = [
      value.url,
      value.src,
      value.image,
      value.imageUrl,
      value.image_url
    ];
    direct.forEach(function (candidate) {
      if (explicitlyNotImage) return;
      if (candidate && typeof candidate === 'object' && candidate.url) {
        candidate = candidate.url;
      }
      if (typeof candidate === 'string' && isSafeImageUrl(candidate.trim())) {
        output.push(candidate.trim());
      }
    });

    ['images', 'image_urls', 'imageUrls', 'multimedias', 'multimedia', 'media', 'attachments'].forEach(function (key) {
      if (value[key] != null && value[key] !== value) addImageCandidate(output, value[key]);
    });
    return output;
  }

  function normalizeRole(role) {
    var normalized = String(role || '').toLowerCase();
    if (normalized === 'assistant' || normalized === 'ai' || normalized === 'bot' || normalized === 'model') {
      return 'assistant';
    }
    if (normalized === 'system') return 'system';
    return 'user';
  }

  function normalizeMessage(message) {
    if (message == null) return null;
    if (typeof message === 'string') {
      return { role: 'user', text: message, images: [] };
    }
    if (typeof message !== 'object' || Array.isArray(message)) return null;

    var textParts = [];
    var images = [];
    var content = message.content;
    if (typeof content === 'string') {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      content.forEach(function (segment) {
        if (segment == null) return;
        if (typeof segment === 'string') {
          textParts.push(segment);
          return;
        }
        if (typeof segment !== 'object') return;
        if (segment.text != null) textParts.push(String(segment.text));
        if (segment.type === 'image_url' || segment.image_url != null) {
          addImageCandidate(images, segment.image_url);
        } else if (segment.type === 'image' || segment.url != null || segment.src != null) {
          addImageCandidate(images, segment);
        }
      });
    } else if (content && typeof content === 'object') {
      if (content.text != null) textParts.push(String(content.text));
      collectImages(content, images);
    }

    if (!textParts.length) {
      ['text', 'message', 'prompt', 'answer', 'response'].some(function (key) {
        if (message[key] != null && typeof message[key] !== 'object') {
          textParts.push(String(message[key]));
          return true;
        }
        return false;
      });
    }
    collectImages(message, images);
    return {
      role: normalizeRole(message.role),
      text: textParts.join('\n'),
      images: uniq(images),
      trace_id: message.trace_id || message.traceId || message.x_traceid || ''
    };
  }

  function normalizeTurn(turn, index) {
    if (typeof turn === 'string') {
      return { prompt: turn, answer: '', images: [], answerImages: [], convidx: index * 2 };
    }
    turn = turn && typeof turn === 'object' ? turn : {};
    var rawIndex = turn.convidx != null ? Number(turn.convidx) : index * 2;
    return {
      prompt: turn.prompt != null ? String(turn.prompt) :
        (turn.query != null ? String(turn.query) :
          (turn.question != null ? String(turn.question) : '')),
      answer: turn.answer != null ? String(turn.answer) :
        (turn.response != null ? String(turn.response) :
          (turn.output != null ? String(turn.output) : '')),
      images: uniq(collectImages({
        images: turn.images,
        image_url: turn.image_url,
        multimedias: turn.multimedias,
        multimedia: turn.multimedia,
        media: turn.media,
        attachments: turn.attachments
      })),
      answerImages: uniq(collectImages(
        turn.answer_images || turn.answerImages || turn.response_images || turn.responseImages
      )),
      convidx: Number.isFinite(rawIndex) ? rawIndex : index * 2
    };
  }

  function turnsToMessages(turns) {
    var messages = [];
    turns.map(normalizeTurn).sort(function (a, b) {
      return a.convidx - b.convidx;
    }).forEach(function (turn) {
      if (turn.prompt || turn.images.length) {
        messages.push({ role: 'user', text: turn.prompt, images: turn.images });
      }
      if (turn.answer || turn.answerImages.length) {
        messages.push({ role: 'assistant', text: turn.answer, images: turn.answerImages });
      }
    });
    return messages;
  }

  function parseConversation(value) {
    var parsed = parseLooseJson(value);
    if (parsed == null || parsed === '') return [];

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.messages != null) return parseConversation(parsed.messages);
      if (parsed.conversation != null) return parseConversation(parsed.conversation);
      if (parsed.turns != null) return parseConversation(parsed.turns);

      var combinedTurns = [];
      var history = parseLooseJson(parsed.history);
      if (Array.isArray(history)) combinedTurns = history.slice();
      else if (history && typeof history === 'object') combinedTurns = [history];
      if (parsed.prompt != null || parsed.query != null || parsed.question != null ||
          parsed.answer != null || parsed.response != null || parsed.output != null) {
        combinedTurns.push(parsed);
      }
      if (combinedTurns.length) return turnsToMessages(combinedTurns);
      parsed = [parsed];
    }

    if (!Array.isArray(parsed)) return [];
    var hasRole = parsed.some(function (item) {
      return item && typeof item === 'object' && !Array.isArray(item) && item.role != null;
    });
    var hasTurns = parsed.some(function (item) {
      return item && typeof item === 'object' && !Array.isArray(item) &&
        (item.prompt != null || item.answer != null || item.convidx != null ||
          item.query != null || item.response != null);
    });
    if (!hasRole && hasTurns) return turnsToMessages(parsed);
    return parsed.map(normalizeMessage).filter(function (message) {
      return message && (message.text || message.images.length);
    });
  }

  function xmlEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function columnNumberToName(number) {
    var value = Number(number);
    if (!Number.isInteger(value) || value < 1) throw new Error('列号必须是大于 0 的整数');
    var name = '';
    while (value > 0) {
      value -= 1;
      name = String.fromCharCode(65 + (value % 26)) + name;
      value = Math.floor(value / 26);
    }
    return name;
  }

  function columnNameToNumber(name) {
    var normalized = String(name || '').toUpperCase();
    if (!/^[A-Z]+$/.test(normalized)) throw new Error('无效的 Excel 列名');
    var number = 0;
    for (var i = 0; i < normalized.length; i++) {
      number = number * 26 + normalized.charCodeAt(i) - 64;
    }
    return number;
  }

  function parseCellReference(reference) {
    var match = /^\$?([A-Z]+)\$?(\d+)$/i.exec(String(reference || ''));
    return match ? { column: columnNameToNumber(match[1]), row: Number(match[2]) } : null;
  }

  function parseRange(reference) {
    var parts = String(reference || '').split(':');
    var start = parseCellReference(parts[0]);
    var end = parseCellReference(parts[1] || parts[0]);
    return start && end ? { start: start, end: end } : null;
  }

  function formatRange(range) {
    return columnNumberToName(range.start.column) + range.start.row + ':' +
      columnNumberToName(range.end.column) + range.end.row;
  }

  function getElements(root, localName) {
    return Array.prototype.slice.call(root.getElementsByTagNameNS('*', localName));
  }

  function parseXml(text, path) {
    var documentNode = new DOMParser().parseFromString(text, 'application/xml');
    if (getElements(documentNode, 'parsererror').length) {
      throw new Error('无法解析工作簿 XML：' + path);
    }
    return documentNode;
  }

  function serializeXml(documentNode) {
    return new XMLSerializer().serializeToString(documentNode);
  }

  function normalizeZipPath(basePath, targetPath) {
    var target = String(targetPath || '').replace(/\\/g, '/');
    var parts = target.charAt(0) === '/' ? [] : String(basePath).split('/').slice(0, -1);
    target.replace(/^\/+/, '').split('/').forEach(function (part) {
      if (!part || part === '.') return;
      if (part === '..') parts.pop();
      else parts.push(part);
    });
    return parts.join('/');
  }

  function relationshipTarget(relsDocument, relationshipId, basePath) {
    var relationships = getElements(relsDocument, 'Relationship');
    for (var i = 0; i < relationships.length; i++) {
      if (relationships[i].getAttribute('Id') === relationshipId) {
        return normalizeZipPath(basePath, relationships[i].getAttribute('Target'));
      }
    }
    return null;
  }

  function relationshipFilePath(partPath) {
    var pieces = partPath.split('/');
    var filename = pieces.pop();
    return pieces.concat(['_rels', filename + '.rels']).join('/');
  }

  function normalizeRowUrlPairs(rowUrlPairs) {
    if (!Array.isArray(rowUrlPairs)) throw new Error('rowUrlPairs 必须是数组');
    var byRow = Object.create(null);
    rowUrlPairs.forEach(function (pair) {
      var row = Number(pair && pair.row);
      var url = pair && pair.url != null ? String(pair.url).trim() : '';
      if (!Number.isInteger(row) || row < 2) throw new Error('Excel 行号必须是大于 1 的整数');
      if (!/^https?:\/\//i.test(url)) throw new Error('png_url 必须是 http/https 链接');
      byRow[row] = url;
    });
    return Object.keys(byRow).map(function (row) {
      return { row: Number(row), url: byRow[row] };
    }).sort(function (a, b) { return a.row - b.row; });
  }

  function createInlineStringCell(documentNode, reference, value) {
    var cell = documentNode.createElementNS(MAIN_NS, 'c');
    cell.setAttribute('r', reference);
    cell.setAttribute('t', 'inlineStr');
    var inlineString = documentNode.createElementNS(MAIN_NS, 'is');
    var text = documentNode.createElementNS(MAIN_NS, 't');
    text.textContent = String(value);
    inlineString.appendChild(text);
    cell.appendChild(inlineString);
    return cell;
  }

  function findOrCreateRow(sheetDocument, sheetData, rowNumber) {
    var rows = getElements(sheetData, 'row');
    for (var i = 0; i < rows.length; i++) {
      var existing = Number(rows[i].getAttribute('r'));
      if (existing === rowNumber) return rows[i];
      if (existing > rowNumber) {
        var rowBefore = sheetDocument.createElementNS(MAIN_NS, 'row');
        rowBefore.setAttribute('r', String(rowNumber));
        sheetData.insertBefore(rowBefore, rows[i]);
        return rowBefore;
      }
    }
    var row = sheetDocument.createElementNS(MAIN_NS, 'row');
    row.setAttribute('r', String(rowNumber));
    sheetData.appendChild(row);
    return row;
  }

  function appendCell(row, cell, targetColumn) {
    var cells = getElements(row, 'c');
    for (var i = 0; i < cells.length; i++) {
      var parsed = parseCellReference(cells[i].getAttribute('r'));
      if (parsed && parsed.column === targetColumn) {
        if (cells[i].hasAttribute('s')) cell.setAttribute('s', cells[i].getAttribute('s'));
        row.replaceChild(cell, cells[i]);
        updateRowSpans(row, targetColumn);
        return;
      }
      if (parsed && parsed.column > targetColumn) {
        row.insertBefore(cell, cells[i]);
        updateRowSpans(row, targetColumn);
        return;
      }
    }
    row.appendChild(cell);
    updateRowSpans(row, targetColumn);
  }

  function updateRowSpans(row, targetColumn) {
    var spans = /^(\d+):(\d+)$/.exec(row.getAttribute('spans') || '');
    if (!spans) return;
    row.setAttribute('spans', Math.min(Number(spans[1]), targetColumn) + ':' +
      Math.max(Number(spans[2]), targetColumn));
  }

  function cellHasContent(cell) {
    var formulas = getElements(cell, 'f');
    if (formulas.length) return true;
    var values = getElements(cell, 'v');
    if (values.some(function (value) { return value.textContent !== ''; })) return true;
    return getElements(cell, 't').some(function (text) { return text.textContent !== ''; });
  }

  function findSheetBounds(sheetDocument) {
    var minColumn = Infinity;
    var minRow = Infinity;
    var maxColumn = 0;
    var maxRow = 1;
    getElements(sheetDocument, 'c').forEach(function (cell) {
      var parsed = parseCellReference(cell.getAttribute('r'));
      if (parsed && cellHasContent(cell)) {
        minColumn = Math.min(minColumn, parsed.column);
        minRow = Math.min(minRow, parsed.row);
        maxColumn = Math.max(maxColumn, parsed.column);
        maxRow = Math.max(maxRow, parsed.row);
      }
    });
    return {
      minColumn: Number.isFinite(minColumn) ? minColumn : 1,
      minRow: Number.isFinite(minRow) ? minRow : 1,
      maxColumn: Math.max(1, maxColumn),
      maxRow: maxRow
    };
  }

  function extendRangeAttribute(element, attribute, newColumn, newMaxRow) {
    var range = parseRange(element.getAttribute(attribute));
    if (!range) return;
    range.end.column = Math.max(range.end.column, newColumn);
    range.end.row = Math.max(range.end.row, newMaxRow);
    element.setAttribute(attribute, formatRange(range));
  }

  function updateSheetRanges(sheetDocument, bounds, newColumn, newMaxRow) {
    var dimensions = getElements(sheetDocument, 'dimension');
    if (dimensions.length) {
      var dimensionRange = parseRange(dimensions[0].getAttribute('ref')) || {
        start: { column: bounds.minColumn, row: bounds.minRow },
        end: { column: bounds.maxColumn, row: bounds.maxRow }
      };
      dimensionRange.start.column = Math.min(dimensionRange.start.column, bounds.minColumn, newColumn);
      dimensionRange.start.row = Math.min(dimensionRange.start.row, bounds.minRow, 1);
      dimensionRange.end.column = Math.max(dimensionRange.end.column, bounds.maxColumn, newColumn);
      dimensionRange.end.row = Math.max(dimensionRange.end.row, bounds.maxRow, newMaxRow);
      dimensions[0].setAttribute('ref', formatRange(dimensionRange));
    } else {
      var dimension = sheetDocument.createElementNS(MAIN_NS, 'dimension');
      dimension.setAttribute('ref', columnNumberToName(Math.min(bounds.minColumn, newColumn)) + '1:' +
        columnNumberToName(Math.max(bounds.maxColumn, newColumn)) + newMaxRow);
      var root = sheetDocument.documentElement;
      var insertBefore = getElements(root, 'sheetViews')[0] || getElements(root, 'sheetData')[0] || root.firstChild;
      root.insertBefore(dimension, insertBefore);
    }
    getElements(sheetDocument, 'autoFilter').forEach(function (autoFilter) {
      extendRangeAttribute(autoFilter, 'ref', newColumn, newMaxRow);
    });
  }

  function updateTableDocument(tableDocument, oldColumn, newColumn, newMaxRow) {
    var table = getElements(tableDocument, 'table')[0];
    if (!table) return;
    var tableRange = parseRange(table.getAttribute('ref'));
    if (!tableRange || tableRange.start.row !== 1 || tableRange.end.column !== oldColumn) return;
    extendRangeAttribute(table, 'ref', newColumn, newMaxRow);
    getElements(table, 'autoFilter').forEach(function (autoFilter) {
      extendRangeAttribute(autoFilter, 'ref', newColumn, newMaxRow);
    });
    var tableColumns = getElements(table, 'tableColumns')[0];
    if (!tableColumns) return;
    var columns = getElements(tableColumns, 'tableColumn');
    var maxId = columns.reduce(function (maximum, column) {
      return Math.max(maximum, Number(column.getAttribute('id')) || 0);
    }, 0);
    var column = tableDocument.createElementNS(table.namespaceURI || MAIN_NS, 'tableColumn');
    column.setAttribute('id', String(maxId + 1));
    column.setAttribute('name', 'png_url');
    tableColumns.appendChild(column);
    tableColumns.setAttribute('count', String(columns.length + 1));
  }

  async function appendUrlsToWorkbook(arrayBuffer, rowUrlPairs) {
    if (!global.JSZip) throw new Error('缺少 JSZip，无法生成链接 Excel');
    var pairs = normalizeRowUrlPairs(rowUrlPairs);
    if (!pairs.length) throw new Error('没有可写入的 png_url');

    var zip = await global.JSZip.loadAsync(arrayBuffer);
    var workbookPath = 'xl/workbook.xml';
    var workbookRelsPath = 'xl/_rels/workbook.xml.rels';
    var workbookFile = zip.file(workbookPath);
    var workbookRelsFile = zip.file(workbookRelsPath);
    if (!workbookFile || !workbookRelsFile) throw new Error('不是有效的 .xlsx 工作簿');

    var workbookDocument = parseXml(await workbookFile.async('string'), workbookPath);
    var workbookRelsDocument = parseXml(await workbookRelsFile.async('string'), workbookRelsPath);
    var firstSheet = getElements(workbookDocument, 'sheet')[0];
    if (!firstSheet) throw new Error('工作簿没有可写入的工作表');
    var sheetRelationshipId = firstSheet.getAttributeNS(REL_NS, 'id') || firstSheet.getAttribute('r:id');
    var sheetPath = relationshipTarget(workbookRelsDocument, sheetRelationshipId, workbookPath);
    var sheetFile = sheetPath && zip.file(sheetPath);
    if (!sheetFile) throw new Error('无法定位第一个工作表');

    var sheetDocument = parseXml(await sheetFile.async('string'), sheetPath);
    var sheetData = getElements(sheetDocument, 'sheetData')[0];
    if (!sheetData) throw new Error('第一个工作表缺少 sheetData');
    var bounds = findSheetBounds(sheetDocument);
    if (bounds.maxColumn >= 16384) throw new Error('工作表已达到 Excel 最大列数，无法新增 png_url');
    var newColumn = bounds.maxColumn + 1;
    var newColumnName = columnNumberToName(newColumn);
    var maxWrittenRow = pairs.reduce(function (maximum, pair) {
      return Math.max(maximum, pair.row);
    }, 1);
    var newMaxRow = Math.max(bounds.maxRow, maxWrittenRow);

    var headerRow = findOrCreateRow(sheetDocument, sheetData, 1);
    appendCell(headerRow, createInlineStringCell(sheetDocument, newColumnName + '1', 'png_url'), newColumn);
    pairs.forEach(function (pair) {
      var row = findOrCreateRow(sheetDocument, sheetData, pair.row);
      appendCell(row, createInlineStringCell(sheetDocument, newColumnName + pair.row, pair.url), newColumn);
    });
    updateSheetRanges(sheetDocument, bounds, newColumn, newMaxRow);

    var sheetRelsPath = relationshipFilePath(sheetPath);
    var sheetRelsFile = zip.file(sheetRelsPath);
    if (sheetRelsFile) {
      var sheetRelsDocument = parseXml(await sheetRelsFile.async('string'), sheetRelsPath);
      var tableParts = getElements(sheetDocument, 'tablePart');
      for (var i = 0; i < tableParts.length; i++) {
        var tableRelationshipId = tableParts[i].getAttributeNS(REL_NS, 'id') ||
          tableParts[i].getAttribute('r:id');
        var tablePath = relationshipTarget(sheetRelsDocument, tableRelationshipId, sheetPath);
        var tableFile = tablePath && zip.file(tablePath);
        if (!tableFile) continue;
        var tableDocument = parseXml(await tableFile.async('string'), tablePath);
        updateTableDocument(tableDocument, bounds.maxColumn, newColumn, newMaxRow);
        zip.file(tablePath, serializeXml(tableDocument));
      }
    }

    zip.file(sheetPath, serializeXml(sheetDocument));
    var output = await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
    return output;
  }

  global.Tool3Data = {
    parseLooseJson: parseLooseJson,
    parseConversation: parseConversation,
    isSafeImageUrl: isSafeImageUrl,
    collectImages: function (value) { return uniq(collectImages(value)); },
    appendUrlsToWorkbook: appendUrlsToWorkbook,
    columnNumberToName: columnNumberToName,
    columnNameToNumber: columnNameToNumber,
    xmlEscape: xmlEscape
  };
})(window);
