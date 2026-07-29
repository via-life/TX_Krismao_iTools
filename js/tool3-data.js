/* Demand 3 data helpers: conversation normalization and in-place XLSX PNG embedding. */
(function (global) {
  'use strict';

  var REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  var XDR_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
  var DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  var PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  var CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
  var DRAWING_REL_TYPE = REL_NS + '/drawing';
  var IMAGE_REL_TYPE = REL_NS + '/image';
  var EMU_PER_PIXEL = 9525;
  var MAX_IMAGE_WIDTH_PX = 900;
  var MAX_EXCEL_ROW_HEIGHT_POINTS = 409.5;
  var MAX_IMAGE_HEIGHT_PX = Math.floor(MAX_EXCEL_ROW_HEIGHT_POINTS / 0.75);

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

  function escapeJsonControlCharacters(value) {
    var text = String(value || '');
    var output = '';
    var inString = false;
    var escaped = false;
    for (var i = 0; i < text.length; i++) {
      var character = text.charAt(i);
      var code = text.charCodeAt(i);
      if (!inString) {
        output += character;
        if (character === '"') inString = true;
        continue;
      }
      if (escaped) {
        output += character;
        escaped = false;
        continue;
      }
      if (character === '\\') {
        output += character;
        escaped = true;
        continue;
      }
      if (character === '"') {
        output += character;
        inString = false;
        continue;
      }
      if (code < 0x20) {
        if (character === '\b') output += '\\b';
        else if (character === '\t') output += '\\t';
        else if (character === '\n') output += '\\n';
        else if (character === '\f') output += '\\f';
        else if (character === '\r') output += '\\r';
        else output += '\\u' + ('000' + code.toString(16)).slice(-4);
        continue;
      }
      output += character;
    }
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
        try {
          parsed = JSON.parse(escapeJsonControlCharacters(text));
        } catch (sanitizedError) {
          return parsed;
        }
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

  function toUint8Array(value) {
    if (value instanceof Uint8Array) return Promise.resolve(value);
    if (value instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) {
      return Promise.resolve(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    if (value && typeof value.arrayBuffer === 'function') {
      return value.arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
    }
    return Promise.reject(new Error('PNG 必须使用 Blob、ArrayBuffer 或 Uint8Array'));
  }

  function readPngDimensions(bytes) {
    var signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 24 || !signature.every(function (value, index) { return bytes[index] === value; })) {
      throw new Error('图片不是有效的 PNG');
    }
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var width = view.getUint32(16, false);
    var height = view.getUint32(20, false);
    if (!width || !height) throw new Error('PNG 尺寸无效');
    return { width: width, height: height };
  }

  async function readPngSourceDimensions(source) {
    var headerSource = source && typeof source.slice === 'function' &&
      typeof source.arrayBuffer === 'function' ? source.slice(0, 24) : source;
    return readPngDimensions(await toUint8Array(headerSource));
  }

  async function normalizeRowPngPairs(rowPngPairs) {
    if (!Array.isArray(rowPngPairs)) throw new Error('rowPngPairs 必须是数组');
    if (!rowPngPairs.length) throw new Error('没有可写入的 PNG');
    var rows = Object.create(null);
    var output = [];
    for (var i = 0; i < rowPngPairs.length; i++) {
      var pair = rowPngPairs[i] || {};
      var row = Number(pair.row);
      if (!Number.isInteger(row) || row < 2) throw new Error('Excel 行号必须是大于 1 的整数');
      if (rows[row]) throw new Error('同一 Excel 行不能写入多张 PNG');
      rows[row] = true;
      var source = pair.blob != null ? pair.blob : pair.bytes;
      var dimensions = await readPngSourceDimensions(source);
      output.push({
        row: row,
        data: source,
        width: dimensions.width,
        height: dimensions.height
      });
    }
    output.sort(function (a, b) { return a.row - b.row; });
    return output;
  }

  async function normalizePngColumns(pngColumns) {
    if (!Array.isArray(pngColumns) || !pngColumns.length) {
      throw new Error('没有可写入的 PNG 列');
    }
    var headers = Object.create(null);
    var output = [];
    for (var index = 0; index < pngColumns.length; index++) {
      var column = pngColumns[index] || {};
      var header = String(column.header || 'png').trim() || 'png';
      if (headers[header]) throw new Error('PNG 输出列名不能重复：' + header);
      headers[header] = true;
      output.push({
        header: header,
        pairs: await normalizeRowPngPairs(column.pairs)
      });
    }
    return output;
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

  function createRowIndex(sheetData) {
    var ordered = getElements(sheetData, 'row');
    var byNumber = Object.create(null);
    ordered.forEach(function (row) {
      byNumber[Number(row.getAttribute('r'))] = row;
    });
    return { ordered: ordered, byNumber: byNumber };
  }

  function findOrCreateIndexedRow(sheetDocument, sheetData, rowNumber, rowIndex) {
    if (rowIndex.byNumber[rowNumber]) return rowIndex.byNumber[rowNumber];
    var low = 0;
    var high = rowIndex.ordered.length;
    while (low < high) {
      var middle = Math.floor((low + high) / 2);
      var current = Number(rowIndex.ordered[middle].getAttribute('r'));
      if (current < rowNumber) low = middle + 1;
      else high = middle;
    }
    var row = sheetDocument.createElementNS(MAIN_NS, 'row');
    row.setAttribute('r', String(rowNumber));
    sheetData.insertBefore(row, rowIndex.ordered[low] || null);
    rowIndex.ordered.splice(low, 0, row);
    rowIndex.byNumber[rowNumber] = row;
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

  function updateTableDocument(tableDocument, oldColumn, newHeaders, newMaxRow) {
    var table = getElements(tableDocument, 'table')[0];
    if (!table) return;
    var tableRange = parseRange(table.getAttribute('ref'));
    if (!tableRange || tableRange.start.row !== 1 || tableRange.end.column !== oldColumn) return;
    var newColumn = oldColumn + newHeaders.length;
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
    newHeaders.forEach(function (header, index) {
      var column = tableDocument.createElementNS(table.namespaceURI || MAIN_NS, 'tableColumn');
      column.setAttribute('id', String(maxId + index + 1));
      column.setAttribute('name', header);
      tableColumns.appendChild(column);
    });
    tableColumns.setAttribute('count', String(columns.length + newHeaders.length));
  }

  function directChild(root, localName) {
    for (var node = root.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1 && (node.localName || node.nodeName.split(':').pop()) === localName) return node;
    }
    return null;
  }

  function inheritLeftStyle(row, cell, targetColumn) {
    var cells = getElements(row, 'c');
    for (var i = 0; i < cells.length; i++) {
      var parsed = parseCellReference(cells[i].getAttribute('r'));
      if (parsed && parsed.column === targetColumn - 1 && cells[i].hasAttribute('s')) {
        cell.setAttribute('s', cells[i].getAttribute('s'));
        break;
      }
    }
    return cell;
  }

  function createBlankCell(documentNode, reference) {
    var cell = documentNode.createElementNS(MAIN_NS, 'c');
    cell.setAttribute('r', reference);
    return cell;
  }

  function excelImageLayout(width, height, existingRowHeight) {
    var scale = Math.min(1, MAX_IMAGE_WIDTH_PX / width, MAX_IMAGE_HEIGHT_PX / height);
    var displayWidth = Math.max(1, Math.floor(width * scale));
    var displayHeight = Math.max(1, Math.floor(height * scale));
    return {
      displayWidth: displayWidth,
      displayHeight: displayHeight,
      rowHeight: Math.min(
        MAX_EXCEL_ROW_HEIGHT_POINTS,
        Math.max(Number(existingRowHeight) || 0, displayHeight * 0.75)
      )
    };
  }

  function setImageRowHeight(row, png) {
    var layout = excelImageLayout(png.width, png.height, row.getAttribute('ht'));
    png.displayWidth = layout.displayWidth;
    png.displayHeight = layout.displayHeight;
    var height = layout.rowHeight;
    row.setAttribute('ht', String(height));
    row.setAttribute('customHeight', 'true');
  }

  function setImageColumnWidth(sheetDocument, targetColumn, displayWidth) {
    var root = sheetDocument.documentElement;
    var cols = directChild(root, 'cols');
    if (!cols) {
      cols = sheetDocument.createElementNS(MAIN_NS, 'cols');
      var sheetData = directChild(root, 'sheetData');
      root.insertBefore(cols, sheetData || null);
    }
    var definitions = getElements(cols, 'col');
    var target = null;
    for (var i = 0; i < definitions.length; i++) {
      var min = Number(definitions[i].getAttribute('min'));
      var max = Number(definitions[i].getAttribute('max'));
      if (min <= targetColumn && targetColumn <= max) {
        target = definitions[i];
        if (min < targetColumn) {
          var before = target.cloneNode(false);
          before.setAttribute('max', String(targetColumn - 1));
          cols.insertBefore(before, target);
        }
        if (targetColumn < max) {
          var after = target.cloneNode(false);
          after.setAttribute('min', String(targetColumn + 1));
          cols.insertBefore(after, target.nextSibling);
        }
        target.setAttribute('min', String(targetColumn));
        target.setAttribute('max', String(targetColumn));
        break;
      }
    }
    if (!target) {
      target = sheetDocument.createElementNS(MAIN_NS, 'col');
      target.setAttribute('min', String(targetColumn));
      target.setAttribute('max', String(targetColumn));
      var inserted = false;
      definitions = getElements(cols, 'col');
      for (var j = 0; j < definitions.length; j++) {
        if (Number(definitions[j].getAttribute('min')) > targetColumn) {
          cols.insertBefore(target, definitions[j]);
          inserted = true;
          break;
        }
      }
      if (!inserted) cols.appendChild(target);
    }
    var columnWidth = Math.floor((displayWidth / 7) * 1000) / 1000;
    target.setAttribute('width', String(columnWidth));
    target.setAttribute('customWidth', 'true');
  }

  function nextRelationshipId(relsDocument) {
    var used = Object.create(null);
    getElements(relsDocument, 'Relationship').forEach(function (relationship) {
      used[relationship.getAttribute('Id')] = true;
    });
    var number = 1;
    while (used['rId' + number]) number++;
    return 'rId' + number;
  }

  function findRelationship(relsDocument, relationshipId) {
    var relationships = getElements(relsDocument, 'Relationship');
    for (var i = 0; i < relationships.length; i++) {
      if (relationships[i].getAttribute('Id') === relationshipId) return relationships[i];
    }
    return null;
  }

  function relativePartTarget(fromPart, toPart) {
    var from = fromPart.split('/').slice(0, -1);
    var to = toPart.split('/');
    while (from.length && to.length && from[0] === to[0]) {
      from.shift();
      to.shift();
    }
    return from.map(function () { return '..'; }).concat(to).join('/');
  }

  function createRelationshipsDocument(label) {
    return parseXml('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="' + PACKAGE_REL_NS + '"></Relationships>', label);
  }

  function nextDrawingPath(zip) {
    var number = 1;
    while (zip.files['xl/drawings/drawing' + number + '.xml']) number++;
    return 'xl/drawings/drawing' + number + '.xml';
  }

  function createDrawingDocument(label) {
    return parseXml('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<xdr:wsDr xmlns:xdr="' + XDR_NS + '" xmlns:a="' + DRAWING_NS + '" xmlns:r="' + REL_NS + '"></xdr:wsDr>', label);
  }

  function insertDrawingElement(sheetDocument, drawingElement) {
    var root = sheetDocument.documentElement;
    var namesAfterDrawing = {
      legacyDrawing: true, legacyDrawingHF: true, picture: true, oleObjects: true,
      controls: true, webPublishItems: true, tableParts: true, extLst: true
    };
    for (var node = root.firstChild; node; node = node.nextSibling) {
      var localName = node.nodeType === 1 ? (node.localName || node.nodeName.split(':').pop()) : '';
      if (namesAfterDrawing[localName]) {
        root.insertBefore(drawingElement, node);
        return;
      }
    }
    root.appendChild(drawingElement);
  }

  async function ensureDrawingParts(zip, sheetDocument, sheetPath) {
    var sheetRelsPath = relationshipFilePath(sheetPath);
    var sheetRelsFile = zip.file(sheetRelsPath);
    var sheetRelsDocument = sheetRelsFile
      ? parseXml(await sheetRelsFile.async('string'), sheetRelsPath)
      : createRelationshipsDocument(sheetRelsPath);
    var drawingElement = directChild(sheetDocument.documentElement, 'drawing');
    var drawingRelationship = null;
    var drawingPath = null;
    if (drawingElement) {
      var existingId = drawingElement.getAttributeNS(REL_NS, 'id') || drawingElement.getAttribute('r:id');
      drawingRelationship = findRelationship(sheetRelsDocument, existingId);
      if (drawingRelationship) drawingPath = normalizeZipPath(sheetPath, drawingRelationship.getAttribute('Target'));
    }
    if (!drawingPath || !zip.file(drawingPath)) {
      drawingPath = nextDrawingPath(zip);
      if (!drawingRelationship) {
        drawingRelationship = sheetRelsDocument.createElementNS(PACKAGE_REL_NS, 'Relationship');
        drawingRelationship.setAttribute('Id', nextRelationshipId(sheetRelsDocument));
        sheetRelsDocument.documentElement.appendChild(drawingRelationship);
      }
      drawingRelationship.setAttribute('Type', DRAWING_REL_TYPE);
      drawingRelationship.setAttribute('Target', relativePartTarget(sheetPath, drawingPath));
      if (!drawingElement) {
        drawingElement = sheetDocument.createElementNS(MAIN_NS, 'drawing');
        insertDrawingElement(sheetDocument, drawingElement);
      }
      drawingElement.setAttributeNS(REL_NS, 'r:id', drawingRelationship.getAttribute('Id'));
    }
    var drawingFile = zip.file(drawingPath);
    var drawingDocument = drawingFile
      ? parseXml(await drawingFile.async('string'), drawingPath)
      : createDrawingDocument(drawingPath);
    var drawingRelsPath = relationshipFilePath(drawingPath);
    var drawingRelsFile = zip.file(drawingRelsPath);
    var drawingRelsDocument = drawingRelsFile
      ? parseXml(await drawingRelsFile.async('string'), drawingRelsPath)
      : createRelationshipsDocument(drawingRelsPath);
    return {
      sheetRelsPath: sheetRelsPath,
      sheetRelsDocument: sheetRelsDocument,
      drawingPath: drawingPath,
      drawingDocument: drawingDocument,
      drawingRelsPath: drawingRelsPath,
      drawingRelsDocument: drawingRelsDocument
    };
  }

  function nextMediaPath(zip, drawingPath) {
    var directory = drawingPath.split('/').slice(0, -1).concat('media').join('/');
    var number = 1;
    while (zip.files[directory + '/image' + number + '.png']) number++;
    return directory + '/image' + number + '.png';
  }

  function createMediaPathAllocator(zip, drawingPath) {
    var directory = drawingPath.split('/').slice(0, -1).concat('media').join('/');
    var number = 1;
    while (zip.files[directory + '/image' + number + '.png']) number++;
    return function () {
      while (zip.files[directory + '/image' + number + '.png']) number++;
      return directory + '/image' + (number++) + '.png';
    };
  }

  function nextPictureId(drawingDocument) {
    return getElements(drawingDocument, 'cNvPr').reduce(function (maximum, element) {
      return Math.max(maximum, Number(element.getAttribute('id')) || 0);
    }, 0) + 1;
  }

  function appendTextElement(documentNode, parent, namespace, qualifiedName, text) {
    var element = documentNode.createElementNS(namespace, qualifiedName);
    element.textContent = String(text);
    parent.appendChild(element);
    return element;
  }

  function appendPictureAnchor(drawingDocument, column, png, relationshipId, pictureId) {
    var anchor = drawingDocument.createElementNS(XDR_NS, 'xdr:oneCellAnchor');
    var from = drawingDocument.createElementNS(XDR_NS, 'xdr:from');
    appendTextElement(drawingDocument, from, XDR_NS, 'xdr:col', column - 1);
    appendTextElement(drawingDocument, from, XDR_NS, 'xdr:colOff', 0);
    appendTextElement(drawingDocument, from, XDR_NS, 'xdr:row', png.row - 1);
    appendTextElement(drawingDocument, from, XDR_NS, 'xdr:rowOff', 0);
    anchor.appendChild(from);

    var extent = drawingDocument.createElementNS(XDR_NS, 'xdr:ext');
    extent.setAttribute('cx', String(png.displayWidth * EMU_PER_PIXEL));
    extent.setAttribute('cy', String(png.displayHeight * EMU_PER_PIXEL));
    anchor.appendChild(extent);

    var picture = drawingDocument.createElementNS(XDR_NS, 'xdr:pic');
    var nonVisual = drawingDocument.createElementNS(XDR_NS, 'xdr:nvPicPr');
    var properties = drawingDocument.createElementNS(XDR_NS, 'xdr:cNvPr');
    properties.setAttribute('id', String(pictureId));
    properties.setAttribute('name', 'Image ' + pictureId);
    properties.setAttribute('descr', 'Picture');
    nonVisual.appendChild(properties);
    nonVisual.appendChild(drawingDocument.createElementNS(XDR_NS, 'xdr:cNvPicPr'));
    picture.appendChild(nonVisual);

    var blipFill = drawingDocument.createElementNS(XDR_NS, 'xdr:blipFill');
    var blip = drawingDocument.createElementNS(DRAWING_NS, 'a:blip');
    blip.setAttributeNS(REL_NS, 'r:embed', relationshipId);
    blip.setAttribute('cstate', 'print');
    blipFill.appendChild(blip);
    var stretch = drawingDocument.createElementNS(DRAWING_NS, 'a:stretch');
    stretch.appendChild(drawingDocument.createElementNS(DRAWING_NS, 'a:fillRect'));
    blipFill.appendChild(stretch);
    picture.appendChild(blipFill);

    var shapeProperties = drawingDocument.createElementNS(XDR_NS, 'xdr:spPr');
    var geometry = drawingDocument.createElementNS(DRAWING_NS, 'a:prstGeom');
    geometry.setAttribute('prst', 'rect');
    shapeProperties.appendChild(geometry);
    picture.appendChild(shapeProperties);
    anchor.appendChild(picture);
    anchor.appendChild(drawingDocument.createElementNS(XDR_NS, 'xdr:clientData'));
    drawingDocument.documentElement.appendChild(anchor);
  }

  function appendImageRelationship(drawingRelsDocument, target, relationshipId) {
    var relationship = drawingRelsDocument.createElementNS(PACKAGE_REL_NS, 'Relationship');
    relationshipId = relationshipId || nextRelationshipId(drawingRelsDocument);
    relationship.setAttribute('Id', relationshipId);
    relationship.setAttribute('Type', IMAGE_REL_TYPE);
    relationship.setAttribute('Target', target);
    drawingRelsDocument.documentElement.appendChild(relationship);
    return relationshipId;
  }

  function createRelationshipIdAllocator(relsDocument) {
    var used = Object.create(null);
    getElements(relsDocument, 'Relationship').forEach(function (relationship) {
      used[relationship.getAttribute('Id')] = true;
    });
    var number = 1;
    return function () {
      while (used['rId' + number]) number++;
      var relationshipId = 'rId' + number++;
      used[relationshipId] = true;
      return relationshipId;
    };
  }

  async function ensureContentTypes(zip, drawingPath) {
    var path = '[Content_Types].xml';
    var file = zip.file(path);
    if (!file) throw new Error('工作簿缺少 [Content_Types].xml');
    var documentNode = parseXml(await file.async('string'), path);
    var defaults = getElements(documentNode, 'Default');
    var pngDefault = defaults.filter(function (element) {
      return String(element.getAttribute('Extension')).toLowerCase() === 'png';
    })[0];
    if (!pngDefault) {
      pngDefault = documentNode.createElementNS(CONTENT_TYPES_NS, 'Default');
      pngDefault.setAttribute('Extension', 'png');
      var firstOverride = getElements(documentNode, 'Override')[0];
      documentNode.documentElement.insertBefore(pngDefault, firstOverride || null);
    }
    pngDefault.setAttribute('ContentType', 'image/png');

    var partName = '/' + drawingPath;
    var drawingOverride = getElements(documentNode, 'Override').filter(function (element) {
      return element.getAttribute('PartName') === partName;
    })[0];
    if (!drawingOverride) {
      drawingOverride = documentNode.createElementNS(CONTENT_TYPES_NS, 'Override');
      drawingOverride.setAttribute('PartName', partName);
      documentNode.documentElement.appendChild(drawingOverride);
    }
    drawingOverride.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.drawing+xml');
    zip.file(path, serializeXml(documentNode));
  }

  async function appendPngColumnsToWorkbook(arrayBuffer, pngColumns) {
    if (!global.JSZip) throw new Error('缺少 JSZip，无法生成内嵌图片 Excel');
    var columns = await normalizePngColumns(pngColumns);
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
    if (bounds.maxColumn + columns.length > 16384) {
      throw new Error('工作表剩余列数不足，无法新增全部 PNG 列');
    }
    var maxWrittenRow = columns.reduce(function (columnMaximum, column) {
      return column.pairs.reduce(function (maximum, pair) {
        return Math.max(maximum, pair.row);
      }, columnMaximum);
    }, 1);
    var newMaxRow = Math.max(bounds.maxRow, maxWrittenRow);

    var rowIndex = createRowIndex(sheetData);
    var headerRow = findOrCreateIndexedRow(sheetDocument, sheetData, 1, rowIndex);
    columns.forEach(function (column, columnIndex) {
      var targetColumn = bounds.maxColumn + columnIndex + 1;
      var targetColumnName = columnNumberToName(targetColumn);
      var headerCell = createInlineStringCell(
        sheetDocument,
        targetColumnName + '1',
        column.header
      );
      appendCell(
        headerRow,
        inheritLeftStyle(headerRow, headerCell, targetColumn),
        targetColumn
      );
      column.pairs.forEach(function (pair) {
        var row = findOrCreateIndexedRow(sheetDocument, sheetData, pair.row, rowIndex);
        var cell = createBlankCell(sheetDocument, targetColumnName + pair.row);
        appendCell(row, inheritLeftStyle(row, cell, targetColumn), targetColumn);
        setImageRowHeight(row, pair);
      });
      var maxDisplayWidth = column.pairs.reduce(function (maximum, pair) {
        return Math.max(maximum, pair.displayWidth);
      }, 1);
      setImageColumnWidth(sheetDocument, targetColumn, maxDisplayWidth);
    });
    var lastColumn = bounds.maxColumn + columns.length;
    updateSheetRanges(sheetDocument, bounds, lastColumn, newMaxRow);

    var drawingParts = await ensureDrawingParts(zip, sheetDocument, sheetPath);
    var pictureId = nextPictureId(drawingParts.drawingDocument);
    var nextMedia = createMediaPathAllocator(zip, drawingParts.drawingPath);
    var nextImageRelationshipId =
      createRelationshipIdAllocator(drawingParts.drawingRelsDocument);
    columns.forEach(function (column, columnIndex) {
      var targetColumn = bounds.maxColumn + columnIndex + 1;
      column.pairs.forEach(function (pair) {
        var mediaPath = nextMedia();
        var target = relativePartTarget(drawingParts.drawingPath, mediaPath);
        var relationshipId = appendImageRelationship(
          drawingParts.drawingRelsDocument,
          target,
          nextImageRelationshipId()
        );
        zip.file(mediaPath, pair.data, { binary: true, compression: 'STORE' });
        appendPictureAnchor(
          drawingParts.drawingDocument,
          targetColumn,
          pair,
          relationshipId,
          pictureId++
        );
      });
    });

    var tableParts = getElements(sheetDocument, 'tablePart');
    for (var i = 0; i < tableParts.length; i++) {
      var tableRelationshipId = tableParts[i].getAttributeNS(REL_NS, 'id') ||
        tableParts[i].getAttribute('r:id');
      var tablePath = relationshipTarget(drawingParts.sheetRelsDocument, tableRelationshipId, sheetPath);
      var tableFile = tablePath && zip.file(tablePath);
      if (!tableFile) continue;
      var tableDocument = parseXml(await tableFile.async('string'), tablePath);
      updateTableDocument(
        tableDocument,
        bounds.maxColumn,
        columns.map(function (column) { return column.header; }),
        newMaxRow
      );
      zip.file(tablePath, serializeXml(tableDocument));
    }

    await ensureContentTypes(zip, drawingParts.drawingPath);
    zip.file(sheetPath, serializeXml(sheetDocument));
    zip.file(drawingParts.sheetRelsPath, serializeXml(drawingParts.sheetRelsDocument));
    zip.file(drawingParts.drawingPath, serializeXml(drawingParts.drawingDocument));
    zip.file(drawingParts.drawingRelsPath, serializeXml(drawingParts.drawingRelsDocument));
    var output = await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      compression: 'DEFLATE',
      compressionOptions: { level: 1 },
      streamFiles: true
    });
    return output;
  }

  function appendPngsToWorkbook(arrayBuffer, rowPngPairs) {
    return appendPngColumnsToWorkbook(arrayBuffer, [
      { header: 'png', pairs: rowPngPairs }
    ]);
  }

  global.Tool3Data = {
    parseConversation: parseConversation,
    isSafeImageUrl: isSafeImageUrl,
    excelImageLayout: excelImageLayout,
    appendPngColumnsToWorkbook: appendPngColumnsToWorkbook,
    appendPngsToWorkbook: appendPngsToWorkbook
  };
})(window);
