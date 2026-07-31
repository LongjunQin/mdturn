/*
 * MDTurn annotation anchor helpers.
 *
 * This module deliberately has no DOM dependency.  The desktop renderer can
 * turn rendered Markdown leaves into descriptors shaped like:
 *   { key, lineStart, lineEnd, text }
 * and keep DOM Range creation/highlighting in the UI layer.
 */
(function expose(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MDTurnAnchor = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  'use strict';

  const ANCHOR_VERSION = 3;
  const DEFAULT_SEPARATOR = '\n';
  const DEFAULT_CONTEXT_LENGTH = 48;
  const LEGACY_ROUND_ID = 'legacy';
  const KNOWN_STATUSES = new Set(['open', 'applied', 'wontfix']);

  // v3 offsets are JavaScript/DOM UTF-16 offsets. endTextOffset is exclusive.
  // lineStart/lineEnd remain 1-based inclusive Markdown source coordinates.
  const ANCHOR_V3_PROTOCOL = Object.freeze({
    version: ANCHOR_VERSION,
    required: Object.freeze([
      'anchorVersion', 'lineStart', 'lineEnd',
      'startTextOffset', 'endTextOffset', 'quote', 'prefix', 'suffix',
    ]),
    offsetUnit: 'UTF-16 code units in the corresponding rendered leaf block text',
    endOffset: 'exclusive',
    lineCoordinates: '1-based inclusive Markdown source lines',
    blockSeparator: DEFAULT_SEPARATOR,
    contextLength: DEFAULT_CONTEXT_LENGTH,
    resolutionOrder: Object.freeze([
      'verify line coordinates plus v3 block offsets with quote/context',
      'recover by quote plus prefix/suffix, preferring the stored line range',
      'fall back to the stored line range with low confidence',
    ]),
  });

  function finiteInteger(value) {
    if (value === '' || value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
  }

  function asText(value) {
    return String(value == null ? '' : value);
  }

  function normalizeText(value) {
    return asText(value).replace(/\s+/g, ' ').trim();
  }

  function normalizeBlock(block, index) {
    const value = block || {};
    const lineStart = finiteInteger(value.lineStart);
    const storedEnd = finiteInteger(value.lineEnd);
    return {
      key: value.key != null ? value.key : (value.id != null ? value.id : index),
      index,
      lineStart,
      lineEnd: lineStart == null ? storedEnd : (storedEnd != null && storedEnd >= lineStart ? storedEnd : lineStart),
      text: asText(value.text != null ? value.text : value.textContent),
      source: block,
    };
  }

  function normalizeBlocks(blocks) {
    return Array.isArray(blocks) ? blocks.map(normalizeBlock) : [];
  }

  /** Build one deterministic text stream while retaining block boundaries. */
  function buildTextMap(rawBlocks, options) {
    const settings = options || {};
    const separator = settings.separator == null ? DEFAULT_SEPARATOR : asText(settings.separator);
    const blocks = normalizeBlocks(rawBlocks);
    const spans = [];
    let text = '';
    blocks.forEach((block, index) => {
      if (index) text += separator;
      const start = text.length;
      text += block.text;
      spans.push({
        blockIndex: index,
        key: block.key,
        start,
        end: text.length,
        length: block.text.length,
      });
    });
    return { blocks, spans, text, separator };
  }

  function blockPointToGlobal(textMap, blockIndex, offset, options) {
    const span = textMap && textMap.spans && textMap.spans[Number(blockIndex)];
    const point = finiteInteger(offset);
    if (!span || point == null) return null;
    const shouldClamp = Boolean(options && options.clamp);
    if (!shouldClamp && (point < 0 || point > span.length)) return null;
    return span.start + Math.max(0, Math.min(span.length, point));
  }

  /**
   * Convert a document-stream offset back to a block-local point.
   * Separators have no DOM node; bias chooses the preceding or following block.
   */
  function globalOffsetToBlockPoint(textMap, offset, bias) {
    if (!textMap || !Array.isArray(textMap.spans) || !textMap.spans.length) return null;
    const point = finiteInteger(offset);
    if (point == null || point < 0 || point > textMap.text.length) return null;
    const direction = bias === 'backward' ? 'backward' : 'forward';
    const spans = textMap.spans;
    for (let index = 0; index < spans.length; index += 1) {
      const span = spans[index];
      if (point > span.start && point < span.end) {
        return { blockIndex: index, key: span.key, offset: point - span.start };
      }
      if (point === span.start) {
        if (direction === 'backward' && index > 0) {
          const previous = spans[index - 1];
          return { blockIndex: index - 1, key: previous.key, offset: previous.length };
        }
        return { blockIndex: index, key: span.key, offset: 0 };
      }
      if (point === span.end) {
        if (direction === 'forward' && index + 1 < spans.length) {
          const next = spans[index + 1];
          return { blockIndex: index + 1, key: next.key, offset: 0 };
        }
        return { blockIndex: index, key: span.key, offset: span.length };
      }
      const next = spans[index + 1];
      if (next && point > span.end && point < next.start) {
        return direction === 'backward'
          ? { blockIndex: index, key: span.key, offset: span.length }
          : { blockIndex: index + 1, key: next.key, offset: 0 };
      }
    }
    const last = spans[spans.length - 1];
    return point === textMap.text.length
      ? { blockIndex: spans.length - 1, key: last.key, offset: last.length }
      : null;
  }

  function rangeToSegments(textMap, startOffset, endOffset) {
    if (!textMap || !Array.isArray(textMap.spans)) return [];
    const start = finiteInteger(startOffset);
    const end = finiteInteger(endOffset);
    if (start == null || end == null || start < 0 || end <= start || end > textMap.text.length) return [];
    const segments = [];
    textMap.spans.forEach((span) => {
      const localStart = Math.max(0, start - span.start);
      const localEnd = Math.min(span.length, end - span.start);
      if (localEnd > localStart) {
        segments.push({
          blockIndex: span.blockIndex,
          key: span.key,
          startTextOffset: localStart,
          endTextOffset: localEnd,
        });
      }
    });
    return segments;
  }

  // Normalize whitespace and retain raw UTF-16 boundaries for quote recovery.
  function normalizedTextMap(value) {
    const raw = asText(value);
    let text = '';
    const starts = [];
    const ends = [];
    let whitespaceStart = null;
    for (let index = 0; index < raw.length; index += 1) {
      if (/\s/.test(raw[index])) {
        if (whitespaceStart == null) whitespaceStart = index;
        continue;
      }
      if (whitespaceStart != null && text.length) {
        text += ' ';
        starts.push(whitespaceStart);
        ends.push(index);
      }
      whitespaceStart = null;
      text += raw[index];
      starts.push(index);
      ends.push(index + 1);
    }
    return { raw, text, starts, ends };
  }

  function findAll(text, needle) {
    if (!needle) return [];
    const matches = [];
    let cursor = 0;
    while (cursor <= text.length - needle.length) {
      const index = text.indexOf(needle, cursor);
      if (index < 0) break;
      matches.push(index);
      cursor = index + 1;
    }
    return matches;
  }

  function commonSuffixLength(left, right) {
    let length = 0;
    while (length < left.length && length < right.length &&
      left[left.length - 1 - length] === right[right.length - 1 - length]) length += 1;
    return length;
  }

  function commonPrefixLength(left, right) {
    let length = 0;
    while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
    return length;
  }

  function contextEvidence(text, start, end, annotation) {
    const prefix = normalizeText(annotation && annotation.prefix);
    const suffix = normalizeText(annotation && annotation.suffix);
    const before = normalizeText(text.slice(0, start));
    const after = normalizeText(text.slice(end));
    let score = 0;
    const reasons = [];
    if (prefix) {
      const overlap = commonSuffixLength(before, prefix);
      if (overlap === prefix.length) { score += 18; reasons.push('prefix-exact'); }
      else if (overlap >= Math.min(8, prefix.length)) { score += 7; reasons.push('prefix-partial'); }
      else score -= 4;
    }
    if (suffix) {
      const overlap = commonPrefixLength(after, suffix);
      if (overlap === suffix.length) { score += 18; reasons.push('suffix-exact'); }
      else if (overlap >= Math.min(8, suffix.length)) { score += 7; reasons.push('suffix-partial'); }
      else score -= 4;
    }
    return { score, reasons };
  }

  function lineContains(block, line) {
    return line != null && block.lineStart != null && block.lineEnd != null &&
      block.lineStart <= line && block.lineEnd >= line;
  }

  function linePairs(annotation, blocks, maximumSpan) {
    const startLine = finiteInteger(annotation && annotation.lineStart);
    const endLine = finiteInteger(annotation && annotation.lineEnd);
    if (startLine == null) return [];
    const targetEnd = endLine != null && endLine >= startLine ? endLine : startLine;
    const starts = blocks.filter((block) => lineContains(block, startLine)).map((block) => block.index);
    const ends = blocks.filter((block) => lineContains(block, targetEnd)).map((block) => block.index);
    const pairs = [];
    starts.forEach((start) => {
      (ends.length ? ends : [start]).forEach((end) => {
        if (end >= start && end - start <= maximumSpan) pairs.push({ start, end });
      });
    });
    return pairs;
  }

  function pointLineMatches(annotation, blocks, startIndex, endIndex) {
    const startLine = finiteInteger(annotation && annotation.lineStart);
    const storedEnd = finiteInteger(annotation && annotation.lineEnd);
    const endLine = storedEnd != null ? storedEnd : startLine;
    return (startLine == null || lineContains(blocks[startIndex], startLine)) &&
      (endLine == null || lineContains(blocks[endIndex], endLine));
  }

  function quoteEvidence(selected, quote) {
    const actual = normalizeText(selected);
    const expected = normalizeText(quote);
    if (!expected) return { score: 0, kind: 'none' };
    if (actual === expected) return { score: 100, kind: 'exact' };
    // A UI may deliberately cap quote while offsets still describe the full range.
    if (expected.length >= 24 && actual.startsWith(expected)) return { score: 62, kind: 'quote-prefix' };
    if (actual.length >= 16 && expected.includes(actual)) return { score: 24, kind: 'partial' };
    return { score: -55, kind: 'mismatch' };
  }

  function makeCandidate(textMap, annotation, start, end, details) {
    if (start == null || end == null || end <= start) return null;
    const startPoint = globalOffsetToBlockPoint(textMap, start, 'forward');
    const endPoint = globalOffsetToBlockPoint(textMap, end, 'backward');
    if (!startPoint || !endPoint || endPoint.blockIndex < startPoint.blockIndex) return null;
    const lineMatch = pointLineMatches(annotation, textMap.blocks, startPoint.blockIndex, endPoint.blockIndex);
    const quote = quoteEvidence(textMap.text.slice(start, end), annotation && annotation.quote);
    const context = contextEvidence(textMap.text, start, end, annotation || {});
    const base = details.baseScore || 0;
    const score = base + quote.score + context.score + (lineMatch ? 42 : 0);
    const hasBothContexts = context.reasons.includes('prefix-exact') && context.reasons.includes('suffix-exact');
    let confidence = 'low';
    if ((details.method === 'v3-offsets' && quote.kind === 'exact') ||
        (details.method === 'quote-context' && lineMatch && hasBothContexts)) confidence = 'exact';
    else if (quote.kind === 'exact' || (details.method === 'v3-offsets' && quote.kind === 'quote-prefix')) confidence = 'high';
    else if (details.method === 'v3-offsets' || lineMatch) confidence = 'medium';
    return {
      matched: true,
      method: details.method,
      confidence,
      score,
      start: startPoint,
      end: endPoint,
      startBlockIndex: startPoint.blockIndex,
      endBlockIndex: endPoint.blockIndex,
      blockIndexes: Array.from(
        { length: endPoint.blockIndex - startPoint.blockIndex + 1 },
        (_, offset) => startPoint.blockIndex + offset,
      ),
      segments: rangeToSegments(textMap, start, end),
      selectedText: textMap.text.slice(start, end),
      normalizedSelectedText: normalizeText(textMap.text.slice(start, end)),
      reasons: [details.method, lineMatch ? 'line-match' : 'line-mismatch', 'quote-' + quote.kind].concat(context.reasons),
      globalStart: start,
      globalEnd: end,
    };
  }

  function quoteCandidates(textMap, annotation, pairs) {
    const quote = normalizeText(annotation && annotation.quote);
    if (!quote) return [];
    const normalized = normalizedTextMap(textMap.text);
    const pairRanges = pairs.map((pair) => ({
      start: textMap.spans[pair.start].start,
      end: textMap.spans[pair.end].end,
    }));
    return findAll(normalized.text, quote).map((match) => {
      const rawStart = normalized.starts[match];
      const rawEnd = normalized.ends[match + quote.length - 1];
      const insideStoredLines = pairRanges.some((range) => rawStart >= range.start && rawEnd <= range.end);
      return makeCandidate(textMap, annotation, rawStart, rawEnd, {
        method: 'quote-context',
        baseScore: insideStoredLines ? 24 : 0,
      });
    }).filter(Boolean);
  }

  function offsetCandidates(textMap, annotation, pairs) {
    if (finiteInteger(annotation && annotation.anchorVersion) < ANCHOR_VERSION) return [];
    const startOffset = finiteInteger(annotation && annotation.startTextOffset);
    const endOffset = finiteInteger(annotation && annotation.endTextOffset);
    if (startOffset == null || endOffset == null) return [];
    return pairs.map((pair) => {
      const start = blockPointToGlobal(textMap, pair.start, startOffset);
      const end = blockPointToGlobal(textMap, pair.end, endOffset);
      // Offsets are primary only while quote/context still corroborate them.
      // In repeated text, exact prefix/suffix must be able to beat stale offsets.
      return makeCandidate(textMap, annotation, start, end, { method: 'v3-offsets', baseScore: 50 });
    }).filter(Boolean);
  }

  function lineFallbackCandidates(textMap, annotation, pairs) {
    const storedStartOffset = finiteInteger(annotation && annotation.startTextOffset);
    const storedEndOffset = finiteInteger(annotation && annotation.endTextOffset);
    return pairs.map((pair) => {
      const first = textMap.spans[pair.start];
      const last = textMap.spans[pair.end];
      const localStart = storedStartOffset != null && storedStartOffset >= 0 && storedStartOffset <= first.length
        ? storedStartOffset : 0;
      const localEnd = storedEndOffset != null && storedEndOffset >= 0 && storedEndOffset <= last.length
        ? storedEndOffset : last.length;
      return makeCandidate(textMap, annotation, first.start + localStart, last.start + localEnd, {
        method: 'line-range', baseScore: 5,
      });
    }).filter(Boolean);
  }

  function compareCandidates(left, right) {
    if (right.score !== left.score) return right.score - left.score;
    const leftSpan = left.globalEnd - left.globalStart;
    const rightSpan = right.globalEnd - right.globalStart;
    if (leftSpan !== rightSpan) return leftSpan - rightSpan;
    return left.globalStart - right.globalStart;
  }

  /** Resolve v1/v2/v3 annotations against rendered block descriptors. */
  function resolveAnchor(annotation, rawBlocks, options) {
    const settings = options || {};
    const textMap = buildTextMap(rawBlocks, settings);
    if (!textMap.blocks.length) return { matched: false, reason: 'no-blocks' };
    const maximumSpan = Math.max(1, finiteInteger(settings.maximumBlockSpan) || 64);
    const pairs = linePairs(annotation || {}, textMap.blocks, maximumSpan);
    const candidates = [];
    candidates.push.apply(candidates, offsetCandidates(textMap, annotation || {}, pairs));
    candidates.push.apply(candidates, quoteCandidates(textMap, annotation || {}, pairs));
    candidates.push.apply(candidates, lineFallbackCandidates(textMap, annotation || {}, pairs));
    if (!candidates.length) return { matched: false, reason: 'anchor-not-found' };
    candidates.sort(compareCandidates);
    const best = candidates[0];
    best.candidateCount = candidates.length;
    return best;
  }

  function createAnchorV3(input, options) {
    const value = input || {};
    const lineStart = finiteInteger(value.lineStart);
    const lineEnd = finiteInteger(value.lineEnd);
    const startTextOffset = finiteInteger(value.startTextOffset);
    const endTextOffset = finiteInteger(value.endTextOffset);
    if (lineStart == null || lineStart < 1 || lineEnd == null || lineEnd < lineStart) {
      throw new TypeError('anchor v3 requires valid 1-based lineStart/lineEnd');
    }
    if (startTextOffset == null || startTextOffset < 0 || endTextOffset == null || endTextOffset < 0) {
      throw new TypeError('anchor v3 requires non-negative startTextOffset/endTextOffset');
    }
    const requestedContextLength = finiteInteger(options && options.contextLength);
    const contextLength = Math.max(0, requestedContextLength == null ? DEFAULT_CONTEXT_LENGTH : requestedContextLength);
    const anchor = {
      anchorVersion: ANCHOR_VERSION,
      lineStart,
      lineEnd,
      startTextOffset,
      endTextOffset,
      quote: asText(value.quote),
      prefix: contextLength ? asText(value.prefix).slice(-contextLength) : '',
      suffix: asText(value.suffix).slice(0, contextLength),
    };
    ['headingPath', 'figureRef', 'reviewSessionId'].forEach((field) => {
      if (value[field] != null) anchor[field] = value[field];
    });
    return anchor;
  }

  /** Create a v3 payload from block-local UTF-16 points. */
  function createAnchorFromBlocks(rawBlocks, startPoint, endPoint, extras, options) {
    const textMap = buildTextMap(rawBlocks, options);
    const startIndex = finiteInteger(startPoint && startPoint.blockIndex);
    const endIndex = finiteInteger(endPoint && endPoint.blockIndex);
    if (startIndex == null || endIndex == null || endIndex < startIndex ||
        !textMap.blocks[startIndex] || !textMap.blocks[endIndex]) {
      throw new TypeError('selection requires ordered start/end block indexes');
    }
    const startOffset = finiteInteger(startPoint && startPoint.offset);
    const endOffset = finiteInteger(endPoint && endPoint.offset);
    const globalStart = blockPointToGlobal(textMap, startIndex, startOffset);
    const globalEnd = blockPointToGlobal(textMap, endIndex, endOffset);
    if (globalStart == null || globalEnd == null || globalEnd <= globalStart) {
      throw new TypeError('selection offsets are outside their blocks or collapsed');
    }
    const requestedContextLength = finiteInteger(options && options.contextLength);
    const contextLength = Math.max(0, requestedContextLength == null ? DEFAULT_CONTEXT_LENGTH : requestedContextLength);
    return createAnchorV3(Object.assign({}, extras || {}, {
      lineStart: textMap.blocks[startIndex].lineStart,
      lineEnd: textMap.blocks[endIndex].lineEnd,
      startTextOffset: startOffset,
      endTextOffset: endOffset,
      quote: textMap.text.slice(globalStart, globalEnd),
      prefix: textMap.text.slice(Math.max(0, globalStart - contextLength), globalStart),
      suffix: textMap.text.slice(globalEnd, globalEnd + contextLength),
    }), { contextLength });
  }

  /**
   * Missing legacy status is open unless legacy apply audit fields prove it was
   * already processed. Unknown explicit values fail open instead of hiding work.
   */
  function effectiveStatus(annotation) {
    const value = annotation || {};
    const explicit = asText(value.status).trim().toLowerCase();
    if (KNOWN_STATUSES.has(explicit)) return explicit;
    if (['done', 'resolved', 'complete', 'completed', 'closed'].includes(explicit)) return 'applied';
    if (['wont_fix', 'dismissed', 'rejected', 'skipped', 'ignored'].includes(explicit)) return 'wontfix';
    if (explicit) return 'open';
    if (value.wontfixAt || value.wontfixReason) return 'wontfix';
    if (value.appliedAt || value.appliedBy || value.appliedNote) return 'applied';
    return 'open';
  }

  function annotationTimestamp(annotation, historical) {
    const value = annotation || {};
    const candidates = historical
      ? [value.appliedAt, value.updatedAt, value.createdAt]
      : [value.createdAt, value.updatedAt];
    for (const candidate of candidates) {
      const parsed = Date.parse(candidate || '');
      if (Number.isFinite(parsed)) return parsed;
    }
    return -Infinity;
  }

  function roundIdOf(annotation) {
    const value = annotation || {};
    return asText(value.reviewSessionId || value.reviewRoundId || value.roundId || LEGACY_ROUND_ID);
  }

  function newestFirst(entries, historical) {
    return entries.slice().sort((left, right) => {
      const time = annotationTimestamp(right.annotation, historical) - annotationTimestamp(left.annotation, historical);
      // Later append wins when old records have no timestamp or share one.
      return Number.isNaN(time) || time === 0 ? right.index - left.index : time;
    });
  }

  /**
   * Prepare the right rail without mutating sidecar order.
   * Open notes are always newest-first. Processed notes stay in a collapsed
   * history section and are additionally grouped by review session/round.
   */
  function organizeAnnotations(annotations, options) {
    const settings = options || {};
    const entries = (Array.isArray(annotations) ? annotations : []).map((annotation, index) => ({
      annotation,
      index,
      status: effectiveStatus(annotation),
    }));
    const openEntries = newestFirst(entries.filter((entry) => entry.status === 'open'), false);
    const historyEntries = newestFirst(entries.filter((entry) => entry.status !== 'open'), true);
    const roundMap = new Map();
    historyEntries.forEach((entry) => {
      const id = roundIdOf(entry.annotation);
      if (!roundMap.has(id)) roundMap.set(id, []);
      roundMap.get(id).push(entry.annotation);
    });
    const rounds = Array.from(roundMap, ([id, items]) => ({
      id,
      legacy: id === LEGACY_ROUND_ID,
      count: items.length,
      items,
      newestAt: items.reduce((latest, item) => Math.max(latest, annotationTimestamp(item, true)), -Infinity),
    })).sort((left, right) => right.newestAt - left.newestAt || left.id.localeCompare(right.id));
    const open = openEntries.map((entry) => entry.annotation);
    const history = historyEntries.map((entry) => entry.annotation);
    const historyExpanded = Boolean(settings.historyExpanded);
    return {
      open: { key: 'open', collapsed: false, count: open.length, items: open },
      history: {
        key: 'history', collapsed: !historyExpanded, count: history.length,
        items: history, rounds,
      },
      visible: historyExpanded ? open.concat(history) : open.slice(),
      totalCount: entries.length,
    };
  }

  return Object.freeze({
    ANCHOR_VERSION,
    ANCHOR_V3_PROTOCOL,
    LEGACY_ROUND_ID,
    normalizeText,
    normalizeBlocks,
    buildTextMap,
    blockPointToGlobal,
    globalOffsetToBlockPoint,
    rangeToSegments,
    createAnchorV3,
    createAnchorFromBlocks,
    resolveAnchor,
    effectiveStatus,
    roundIdOf,
    organizeAnnotations,
  });
}));
