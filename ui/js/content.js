'use strict';

    // Count UTF-8 bytes without allocating an encoded copy of a large transcript.
    function contentWithinLimit(text, limit) {
      if (text.length > limit) return false;
      var bytes = 0;
      for (var i = 0; i < text.length; i++) {
        var n = text.charCodeAt(i);
        if (n < 128) bytes++;
        else if (n < 2048) bytes += 2;
        else if (n >= 0xd800 && n <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
        else bytes += 3;
        if (bytes > limit) return false;
      }
      return true;
    }

    function languageOf(nameOrPath) {
      var name = String(nameOrPath || '').trim().toLowerCase();
      var aliases = {
        js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
        ts: 'ts', typescript: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
        json: 'json', py: 'py', python: 'py', pyw: 'py',
        sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', bashrc: 'sh', zshrc: 'sh',
        ps1: 'ps1', powershell: 'ps1', pwsh: 'ps1', psm1: 'ps1', psd1: 'ps1',
        php: 'php', rust: 'rust', rs: 'rust', css: 'css', html: 'html', htm: 'html', xml: 'html',
        sql: 'sql', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'md', markdown: 'md', diff: 'diff', patch: 'diff'
      };
      if (Object.prototype.hasOwnProperty.call(aliases, name)) return aliases[name];
      var base = name.split(/[\\/]/).pop();
      var extension = base.match(/\.([^.]+)$/);
      return extension && Object.prototype.hasOwnProperty.call(aliases, extension[1]) ? aliases[extension[1]] : '';
    }

    function detectFormat(text, hint) {
      if (hint) return hint;
      text = String(text || '');
      if (text.indexOf('\u001b[') !== -1 || text.indexOf('\u009b') !== -1) return 'ansi';
      var lines = /[^\r\n]+/g, match, count = 0, diffLines = 0, hasDiff = false;
      while ((match = lines.exec(text))) {
        var line = match[0];
        if (!line.trim()) continue;
        count++;
        if (/^(?:diff --git |@@|---|\+\+\+|[+\- ])/.test(line)) diffLines++;
        if (/^(?:diff --git |@@)/.test(line)) hasDiff = true;
      }
      if (hasDiff && diffLines > count / 2) return 'diff';
      if (contentWithinLimit(text, 200 * 1024 - 1) && /^\s*[\[{]/.test(text)) {
        try { JSON.parse(text); return 'json'; } catch (_) {}
      }
      if (parseSections(text)) return 'sections';
      if (/(?:^|\n) {0,3}(?:#{1,6}(?:\s|$)|[-*+]\s|\d+[.)]\s|>{1,}\s?|`{3,}|~{3,}|(?:[-*_]\s*){3,}$)/m.test(text) ||
          /\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^\n]*\)|(?:^|\n)[^\n]*\|[^\n]*\n\s*\|?\s*:?-{3,}/.test(text) ||
          /<\/?[a-z][\w-]*>/.test(text)) return 'markdown';
      return 'plain';
    }

    // Palette names, not arbitrary CSS: the renderer owns the actual theme colors.
    function parseAnsi(text) {
      text = String(text || '');
      var names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'bright-black', 'bright-red', 'bright-green', 'bright-yellow', 'bright-blue', 'bright-magenta', 'bright-cyan', 'bright-white'];
      var palette = [[0,0,0], [128,0,0], [0,128,0], [128,128,0], [0,0,128], [128,0,128], [0,128,128], [192,192,192],
        [128,128,128], [255,0,0], [0,255,0], [255,255,0], [0,0,255], [255,0,255], [0,255,255], [255,255,255]];
      var fg = null, bg = null, bold = false, result = [], cursor = 0, start = 0;
      function append(value) {
        if (!value) return;
        var last = result[result.length - 1];
        if (last && last.fg === fg && last.bg === bg && last.bold === bold) last.text += value;
        else result.push({ text: value, fg: fg, bg: bg, bold: bold });
      }
      function nearest(rgb) {
        var best = 0, distance = Infinity;
        for (var p = 0; p < palette.length; p++) {
          var d = 0;
          for (var c = 0; c < 3; c++) d += Math.pow(rgb[c] - palette[p][c], 2);
          if (d < distance) { distance = d; best = p; }
        }
        return names[best];
      }
      function indexed(n) {
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        if (n < 16) return names[n];
        if (n >= 232) return nearest([8 + (n - 232) * 10, 8 + (n - 232) * 10, 8 + (n - 232) * 10]);
        var levels = [0, 95, 135, 175, 215, 255];
        n -= 16;
        return nearest([levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]]);
      }
      function sgr(params) {
        var values = params === '' ? [0] : params.split(';').flatMap(function (v) {
          if (v.indexOf(':') === -1) return [v === '' ? 0 : Number(v)];
          var parts = v.split(':');
          if (parts[0] !== '38' && parts[0] !== '48') return [NaN];
          // The optional color-space slot in 38:2::r:g:b is not a color channel.
          if (parts[1] === '2' && parts.length === 6) parts.splice(2, 1);
          if (!((parts[1] === '2' && parts.length === 5) || (parts[1] === '5' && parts.length === 3))) return [NaN];
          return parts.map(function (part) { return part === '' ? NaN : Number(part); });
        });
        for (var i = 0; i < values.length; i++) {
          var n = values[i];
          if (n === 0) { fg = null; bg = null; bold = false; }
          else if (n === 1) bold = true;
          else if (n === 22) bold = false;
          else if (n === 39) fg = null;
          else if (n === 49) bg = null;
          else if (n >= 30 && n <= 37) fg = names[n - 30];
          else if (n >= 90 && n <= 97) fg = names[n - 90 + 8];
          else if (n >= 40 && n <= 47) bg = names[n - 40];
          else if (n >= 100 && n <= 107) bg = names[n - 100 + 8];
          else if (n === 38 || n === 48) {
            var color = null, mode = values[++i];
            if (mode === 5) color = indexed(values[++i]);
            else if (mode === 2) {
              var rgb = values.slice(i + 1, i + 4); i += 3;
              if (rgb.length === 3 && rgb.every(function (v) { return Number.isInteger(v) && v >= 0 && v <= 255; })) color = nearest(rgb);
            }
            if (color !== null) { if (n === 38) fg = color; else bg = color; }
          }
        }
      }
      while (cursor < text.length) {
        var ch = text.charCodeAt(cursor);
        if (ch !== 27 && !(ch >= 0x80 && ch <= 0x9f)) { cursor++; continue; }
        append(text.slice(start, cursor));
        var escape = ch === 27 ? text[cursor + 1] : ({ 155: '[', 157: ']', 144: 'P', 152: 'X', 158: '^', 159: '_' })[ch];
        cursor += ch === 27 ? 2 : 1;
        if (escape === '[') {
          var paramsAt = cursor;
          while (cursor < text.length && !/[\x40-\x7e]/.test(text[cursor])) cursor++;
          var params = text.slice(paramsAt, cursor);
          if (text[cursor] === 'm' && /^[\d;:]*$/.test(params)) sgr(params);
          if (cursor < text.length) cursor++;
        } else if (escape === ']' || escape === 'P' || escape === 'X' || escape === '^' || escape === '_') {
          while (cursor < text.length && text[cursor] !== '\u009c' && !(escape === ']' && text[cursor] === '\u0007') &&
                 !(text[cursor] === '\u001b' && text[cursor + 1] === '\\')) cursor++;
          if (cursor < text.length) cursor += text[cursor] === '\u001b' ? 2 : 1;
        } else if (ch === 27 && escape && /[\x20-\x2f]/.test(escape)) {
          while (cursor < text.length && /[\x20-\x2f]/.test(text[cursor])) cursor++;
          if (cursor < text.length) cursor++;
        }
        start = cursor;
      }
      append(text.slice(start));
      return result;
    }

    function parseDiff(text) {
      var lines = String(text || '').split(/\r?\n/), files = [], file = null, hunk = null;
      var oldNo = 0, newNo = 0, oldLeft = 0, newLeft = 0;
      function pathOf(value, literal) {
        value = value.split('\t')[0].trim();
        if (value[0] === '"') { try { value = JSON.parse(value); } catch (_) {} }
        return literal ? value : value.replace(/^[ab]\//, '');
      }
      function begin(oldPath, path) {
        file = { path: path, oldPath: oldPath, op: 'update', added: 0, removed: 0, hunks: [] };
        files.push(file); hunk = null; oldLeft = 0; newLeft = 0;
      }
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i], m;
        if (line.indexOf('diff --git ') === 0) {
          m = line.match(/^diff --git ("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/);
          begin(m ? pathOf(m[1]) : '', m ? pathOf(m[2]) : ''); continue;
        }
        if (line.indexOf('--- ') === 0 && (!hunk || (oldLeft <= 0 && newLeft <= 0)) && lines[i + 1] && lines[i + 1].indexOf('+++ ') === 0) {
          var previous = pathOf(line.slice(4)), next = pathOf(lines[++i].slice(4));
          if (!file || hunk) begin(previous, next);
          file.oldPath = previous; file.path = next === '/dev/null' ? previous : next;
          file.op = previous === '/dev/null' ? 'add' : next === '/dev/null' ? 'delete' : 'update';
          continue;
        }
        m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (m) {
          if (!file) begin('', '');
          oldNo = +m[1]; newNo = +m[3]; oldLeft = m[2] === undefined ? 1 : +m[2]; newLeft = m[4] === undefined ? 1 : +m[4];
          hunk = { header: line, lines: [] }; file.hunks.push(hunk); continue;
        }
        if (!file) continue;
        if (line.indexOf('new file mode ') === 0) { file.op = 'add'; continue; }
        if (line.indexOf('deleted file mode ') === 0) { file.op = 'delete'; continue; }
        if (line.indexOf('rename from ') === 0) { file.oldPath = pathOf(line.slice(12), true); continue; }
        if (line.indexOf('rename to ') === 0) { file.path = pathOf(line.slice(10), true); continue; }
        if (!hunk) continue;
        if (line[0] === '+') { hunk.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ }); file.added++; newLeft--; }
        else if (line[0] === '-') { hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null }); file.removed++; oldLeft--; }
        else if (line[0] === ' ') { hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ }); oldLeft--; newLeft--; }
        else if (line) hunk.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
      }
      return files;
    }

    function parseSections(text) {
      text = String(text || '');
      if (!/<[a-z][\w-]*>/.test(text)) return null;
      // Mask code examples while preserving offsets into the original body.
      var ranges = [], fence = null, linePattern = /^ {0,3}(`{3,}|~{3,})[^\r\n]*$/gm, m;
      while ((m = linePattern.exec(text))) {
        if (!fence) fence = { start: m.index, mark: m[1] };
        else if (m[1][0] === fence.mark[0] && m[1].length >= fence.mark.length && !m[0].slice(m[0].indexOf(m[1]) + m[1].length).trim()) {
          ranges.push([fence.start, linePattern.lastIndex]); fence = null;
        }
      }
      if (fence) ranges.push([fence.start, text.length]);
      var masked = '', end = 0;
      for (var r = 0; r < ranges.length; r++) {
        masked += text.slice(end, ranges[r][0]) + text.slice(ranges[r][0], ranges[r][1]).replace(/[^\r\n]/g, ' '); end = ranges[r][1];
      }
      masked += text.slice(end);
      masked = masked.replace(/(`+)[^`\r\n]*\1/g, function (value) { return value.replace(/[^\r\n]/g, ' '); });
      var tags = /<(\/?)([a-z][\w-]*)>/g, stack = [], sections = [], start = 0, bodyAt = 0, outsideAt = 0, covered = 0;
      while ((m = tags.exec(masked))) {
        if (!m[1]) {
          if (!stack.length) {
            var outside = text.slice(outsideAt, m.index).trim();
            if (outside) sections.push({ tag: '', label: '', body: outside });
            start = m.index; bodyAt = tags.lastIndex;
          }
          stack.push(m[2]);
        } else {
          if (stack.pop() !== m[2]) return null;
          if (!stack.length) {
            var label = m[2].replace(/[_-]+/g, ' ');
            sections.push({ tag: m[2], label: label[0].toUpperCase() + label.slice(1), body: text.slice(bodyAt, m.index).trim() });
            covered += tags.lastIndex - start; outsideAt = tags.lastIndex;
          }
        }
      }
      if (stack.length || covered <= text.trim().length / 2) return null;
      var tail = text.slice(outsideAt).trim();
      if (tail) sections.push({ tag: '', label: '', body: tail });
      return sections;
    }

    function prettyJson(text) {
      text = String(text || '');
      if (!contentWithinLimit(text, 200 * 1024 - 1)) return null;
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { return null; }
    }

    function stripMarkdown(text) {
      text = String(text || '').replace(/\r\n?/g, '\n').trim();
      var heading = text.match(/^ {0,3}#{1,6}\s+([^\n]+)\n+/);
      var title = heading ? heading[1] : '';
      if (heading) text = text.slice(heading[0].length);
      text = (title ? title + ': ' : '') + text;
      text = text.replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/gm, '')
        .replace(/^\s*\[[^\]]+\]:[^\n]*$/gm, '')
        .replace(/!?\[([^\]]*)\]\((?:\\.|[^()\\]|\([^()]*\))*\)/g, '$1')
        .replace(/!?\[([^\]]+)\]\[[^\]]*\]/g, '$1')
        .replace(/(<\/[^>\n]+>)\s*(?=<)/g, '$1 ')
        .replace(/<[^>\n]*>/g, '')
        .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?/gm, '')
        .replace(/^\s*>+\s?/gm, '')
        .replace(/[#*`~]/g, '')
        .replace(/\b_{1,2}([^_\n]+)_{1,2}\b/g, '$1')
        .replace(/\s+/g, ' ').trim();
      var sentence = text.match(/^.*?[.!?](?=\s|$)/);
      return (sentence ? sentence[0] : text).slice(0, 200);
    }


    // ---- Render part. Every function takes `doc` (tests hand in a tiny shim: createElement, createTextNode,
    // createDocumentFragment, appendChild, className, textContent, style only), so construction uses nothing else;
    // classList, dataset and listeners run only inside click handlers or on feed-only rows.
    // Block state (Wrap, an opened fold, "Copied") lives in contentState by key, so a live re-render restores it.
    var contentState = {};
    function blockState(opts) {
      if (!opts || !opts.key) return {};
      opts.n = (opts.n || 0) + 1;
      var key = opts.key + '#' + opts.n;
      return contentState[key] || (contentState[key] = {});
    }
    function cel(doc, tag, cls, text) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }
    function setFlag(el, cls, on) { el.classList.toggle(cls, !!on); }
    var LANG_NAMES = { js: 'JavaScript', ts: 'TypeScript', json: 'JSON', py: 'Python', sh: 'Shell', ps1: 'PowerShell', php: 'PHP', rust: 'Rust',
      css: 'CSS', html: 'HTML', sql: 'SQL', yaml: 'YAML', toml: 'TOML', md: 'Markdown', diff: 'diff', text: 'text', txt: 'text' };
    function langName(lang) {
      var raw = String(lang || '').trim();
      if (!raw) return 'code';
      var id = languageOf(raw);
      return LANG_NAMES[id] || LANG_NAMES[raw.toLowerCase()] || raw.toLowerCase();
    }
    function lineCount(text) {
      var n = 1;
      for (var i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
      return n;
    }
    function codeButton(doc, label, onClick, on) {
      var b = cel(doc, 'button', 'code-btn' + (on ? ' on' : ''), label);
      b.type = 'button';
      b.onclick = onClick;
      return b;
    }
    // Copies the raw text; shows "Copied" for 1.5 s, and keeps showing it across a re-render inside that window.
    function copyButton(doc, getText, label, st) {
      label = label || 'Copy';
      var b = codeButton(doc, label, function () {
        try { navigator.clipboard.writeText(getText()); } catch (_) {}
        if (st) st.copiedUntil = Date.now() + 1500;
        showCopied(b, label, 1500);
      });
      var left = st && st.copiedUntil ? st.copiedUntil - Date.now() : 0;
      if (left > 0) { b.textContent = 'Copied'; b.className += ' copied'; showCopied(b, label, left); }
      return b;
    }
    function showCopied(b, label, ms) {
      b.textContent = 'Copied'; setFlag(b, 'copied', true);
      setTimeout(function () { b.textContent = label; setFlag(b, 'copied', false); }, ms);
    }
    function wrapButton(doc, box, st) {
      return codeButton(doc, 'Wrap', function () { st.wrap = !st.wrap; setFlag(box, 'wrap', st.wrap); setFlag(this, 'on', st.wrap); }, st.wrap);
    }
    function foldButton(doc, box, n, keep, st) {
      var more = cel(doc, 'button', 'code-more', st.open ? 'Show first ' + keep + ' lines' : 'Show all ' + n + ' lines');
      more.type = 'button';
      more.onclick = function () { st.open = !st.open; setFlag(box, 'folded', !st.open); more.textContent = st.open ? 'Show first ' + keep + ' lines' : 'Show all ' + n + ' lines'; };
      return more;
    }
    function cutNote(doc, truncated, unit) {
      return cel(doc, 'div', 'code-cut', 'cut off: ' + Number(truncated.shown).toLocaleString() + ' of ' + Number(truncated.total).toLocaleString() + ' ' + (unit || 'characters'));
    }
    function appendTokens(parent, code, lang, doc) {
      highlight(code, lang).forEach(function (t) {
        parent.appendChild(t.type === 'plain' ? doc.createTextNode(t.text) : cel(doc, 'span', 'tk-' + t.type, t.text));
      });
    }
    function diffLineKind(line) {
      if (/^@@ /.test(line)) return 'hunk';
      if (/^(diff |index |--- |\+\+\+ |rename |new file|deleted file|similarity)/.test(line)) return 'meta';
      if (line[0] === '+') return 'add';
      if (line[0] === '-') return 'del';
      return 'ctx';
    }
    // A code block: header (language, Wrap, Copy), no wrapping by default, 4-wide tabs, folded above 25 lines to 15.
    // opts.quiet (a thinking step) draws it without syntax colors.
    function renderCodeBlock(text, lang, opts, doc) {
      opts = opts || {}; doc = doc || document;
      text = String(text == null ? '' : text);
      var st = blockState(opts);
      var n = lineCount(text);
      var fold = n > 25 && opts.fold !== false;
      var box = cel(doc, 'div', 'code' + (st.wrap ? ' wrap' : '') + (fold && !st.open ? ' folded' : '') + (opts.quiet ? ' quiet' : ''));
      var head = cel(doc, 'div', 'code-head');
      head.appendChild(cel(doc, 'span', 'code-lang', langName(lang)));
      head.appendChild(cel(doc, 'span', 'spacer'));
      head.appendChild(wrapButton(doc, box, st));
      head.appendChild(copyButton(doc, function () { return text; }, 'Copy', st));
      var pre = cel(doc, 'pre'), code = cel(doc, 'code');
      var id = languageOf(lang);
      if (opts.quiet || !id) code.textContent = text;
      else if (id === 'diff') {
        var path = (text.match(/^diff --git a\/\S+ b\/(\S+)/m) || text.match(/^\+\+\+ (?:b\/)?(\S+)/m) || [])[1] || '';
        text.split('\n').forEach(function (line) {
          var kind = diffLineKind(line), span = cel(doc, 'span', 'dl-' + kind);
          var body = kind === 'add' || kind === 'del' || kind === 'ctx' ? line.slice(1) : line;
          if (kind === 'hunk' || kind === 'meta' || !languageOf(path)) span.textContent = body; else appendTokens(span, body, path, doc);
          code.appendChild(span);
        });
      } else appendTokens(code, text, lang, doc);
      pre.appendChild(code);
      box.appendChild(head);
      box.appendChild(pre);
      if (fold) box.appendChild(foldButton(doc, box, n, 15, st));
      if (opts.truncated) box.appendChild(cutNote(doc, opts.truncated));
      return box;
    }
    function pathSpan(doc, cls, path) {
      var s = cel(doc, 'span', cls), m = String(path).match(/^(.*[\\/])([^\\/]+)$/);
      if (m) { s.appendChild(cel(doc, 'span', 'dir', m[1])); s.appendChild(doc.createTextNode(m[2])); } else s.textContent = path;
      return s;
    }
    // Diff view: one block per file, +/- counts, hunk headers, a two-number gutter, syntax colors by extension.
    function renderDiff(text, opts, doc) {
      opts = opts || {}; doc = doc || document;
      text = String(text == null ? '' : text);
      var frag = doc.createDocumentFragment();
      var files = parseDiff(text);
      files.forEach(function (f) {
        var st = blockState(opts);
        var n = f.hunks.reduce(function (sum, h) { return sum + 1 + h.lines.length; }, 0);
        var fold = n > 25 && opts.fold !== false;
        var box = cel(doc, 'div', 'diff' + (st.wrap ? ' wrap' : '') + (fold && !st.open ? ' folded' : ''));
        var head = cel(doc, 'div', 'diff-head');
        head.appendChild(pathSpan(doc, 'diff-path', f.path || f.oldPath || '(file)'));
        if (f.op !== 'update') head.appendChild(cel(doc, 'span', 'diff-op ' + f.op, f.op === 'add' ? 'new file' : 'deleted'));
        var counts = cel(doc, 'span', 'diff-counts');
        counts.appendChild(cel(doc, 'span', 'add', '+' + f.added));
        counts.appendChild(cel(doc, 'span', 'del', '−' + f.removed));
        head.appendChild(counts);
        head.appendChild(cel(doc, 'span', 'spacer'));
        head.appendChild(wrapButton(doc, box, st));
        head.appendChild(copyButton(doc, function () {
          return f.hunks.map(function (h) { return h.lines.filter(function (l) { return l.kind === 'add' || l.kind === 'ctx'; }).map(function (l) { return l.text; }).join('\n'); }).join('\n');
        }, 'Copy', st));
        head.appendChild(copyButton(doc, function () { return text; }, 'Copy diff'));
        box.appendChild(head);
        var lines = cel(doc, 'div', 'diff-lines');
        var lang = languageOf(f.path || f.oldPath);
        f.hunks.forEach(function (h) {
          var hl = cel(doc, 'div', 'diff-line hunk');
          hl.appendChild(cel(doc, 'span', 'diff-no')); hl.appendChild(cel(doc, 'span', 'diff-no')); hl.appendChild(cel(doc, 'span', 'diff-sign'));
          hl.appendChild(cel(doc, 'span', 'diff-text', h.header));
          lines.appendChild(hl);
          h.lines.forEach(function (l) {
            var row = cel(doc, 'div', 'diff-line ' + l.kind), t = cel(doc, 'span', 'diff-text');
            row.appendChild(cel(doc, 'span', 'diff-no', l.oldNo == null ? '' : String(l.oldNo)));
            row.appendChild(cel(doc, 'span', 'diff-no', l.newNo == null ? '' : String(l.newNo)));
            row.appendChild(cel(doc, 'span', 'diff-sign', l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ''));
            if (lang && l.kind !== 'meta') appendTokens(t, l.text, lang, doc); else t.textContent = l.text;
            row.appendChild(t);
            lines.appendChild(row);
          });
        });
        box.appendChild(lines);
        if (fold) box.appendChild(foldButton(doc, box, n, 15, st));
        frag.appendChild(box);
      });
      if (!files.length) frag.appendChild(renderCodeBlock(text, 'diff', opts, doc));
      if (opts.truncated && frag.lastChild) frag.lastChild.appendChild(cutNote(doc, opts.truncated));
      return frag;
    }
    function exitBadge(doc, exit) {
      if (exit == null || exit === 0 || exit === '') return null;
      return cel(doc, 'span', 'exit-badge fail', 'exit ' + exit);
    }
    function renderAnsiInto(parent, text, doc) {
      parseAnsi(text).forEach(function (s) {
        var cls = [s.fg ? 'a-' + s.fg : '', s.bg ? 'a-bg-' + s.bg : '', s.bold ? 'a-bold' : ''].filter(Boolean).join(' ');
        parent.appendChild(cls ? cel(doc, 'span', cls, s.text) : doc.createTextNode(s.text));
      });
    }
    // Command view: the full command, a badge when it failed, the output below (ANSI as colors, capped at 30 lines;
    // a failed command shows its last 10 lines when folded, so the error is never hidden).
    function renderCommand(o, opts, doc) {
      opts = opts || {}; doc = doc || document;
      var st = blockState(opts);
      var failed = o.exit != null && o.exit !== 0;
      var box = cel(doc, 'div', 'cmd' + (failed ? ' failed' : ''));
      var head = cel(doc, 'div', 'cmd-head');
      var cmdText = String(o.command || '');
      head.appendChild(cel(doc, 'span', 'cmd-prompt', o.prompt || '$'));
      head.appendChild(cel(doc, 'pre', 'cmd-text', cmdText));
      var meta = cel(doc, 'span', 'cmd-meta');
      if (o.duration) meta.appendChild(cel(doc, 'span', 'cmd-dur', o.duration));
      var badge = exitBadge(doc, o.exit); if (badge) meta.appendChild(badge);
      meta.appendChild(copyButton(doc, function () { return cmdText; }, 'Copy', st));
      head.appendChild(meta);
      box.appendChild(head);
      var out = String(o.output == null ? '' : o.output).replace(/\r\n|\r/g, '\n').replace(/\n+$/, '');
      if (!out) { if (o.output != null) box.appendChild(cel(doc, 'pre', 'cmd-out empty', o.pending ? '(running)' : '(no output)')); return box; }
      var n = lineCount(out), cap = failed ? 10 : 30, pre = cel(doc, 'pre', 'cmd-out');
      if (n > cap && !st.open) {
        var parts = out.split('\n');
        renderAnsiInto(pre, (failed ? parts.slice(-cap) : parts.slice(0, cap)).join('\n'), doc);
        var more = cel(doc, 'button', 'code-more', (failed ? 'Last ' + cap + ' of ' + n + ' lines' : 'First ' + cap + ' of ' + n + ' lines') + ' · Show all');
        more.type = 'button';
        more.onclick = function () { st.open = true; pre.textContent = ''; renderAnsiInto(pre, out, doc); more.remove(); };
        if (failed) { box.appendChild(more); box.appendChild(pre); } else { box.appendChild(pre); box.appendChild(more); }
      } else { renderAnsiInto(pre, out, doc); box.appendChild(pre); }
      if (o.truncated) box.appendChild(cutNote(doc, o.truncated));
      return box;
    }
    // JSON view: pretty printed, keys and values colored, folded above 25 lines.
    function jsonInto(parent, v, indent, doc) {
      var pad = '  '.repeat(indent);
      if (v === null || typeof v === 'boolean') parent.appendChild(cel(doc, 'span', 'jb', String(v)));
      else if (typeof v === 'number') parent.appendChild(cel(doc, 'span', 'jn', String(v)));
      else if (typeof v === 'string') parent.appendChild(cel(doc, 'span', 'js', JSON.stringify(v)));
      else if (Array.isArray(v)) {
        if (!v.length) { parent.appendChild(cel(doc, 'span', 'jp', '[]')); return; }
        parent.appendChild(cel(doc, 'span', 'jp', '['));
        v.forEach(function (x, i) { parent.appendChild(doc.createTextNode('\n' + pad + '  ')); jsonInto(parent, x, indent + 1, doc); if (i < v.length - 1) parent.appendChild(cel(doc, 'span', 'jp', ',')); });
        parent.appendChild(doc.createTextNode('\n' + pad)); parent.appendChild(cel(doc, 'span', 'jp', ']'));
      } else if (v && typeof v === 'object') {
        var keys = Object.keys(v);
        if (!keys.length) { parent.appendChild(cel(doc, 'span', 'jp', '{}')); return; }
        parent.appendChild(cel(doc, 'span', 'jp', '{'));
        keys.forEach(function (k, i) {
          parent.appendChild(doc.createTextNode('\n' + pad + '  ')); parent.appendChild(cel(doc, 'span', 'jk', JSON.stringify(k))); parent.appendChild(cel(doc, 'span', 'jp', ': '));
          jsonInto(parent, v[k], indent + 1, doc); if (i < keys.length - 1) parent.appendChild(cel(doc, 'span', 'jp', ','));
        });
        parent.appendChild(doc.createTextNode('\n' + pad)); parent.appendChild(cel(doc, 'span', 'jp', '}'));
      } else parent.appendChild(doc.createTextNode(String(v)));
    }
    function renderJson(value, opts, doc) {
      opts = opts || {}; doc = doc || document;
      var st = blockState(opts);
      var pretty = JSON.stringify(value, null, 2) || '';
      var n = lineCount(pretty), fold = n > 25 && opts.fold !== false;
      var box = cel(doc, 'div', 'json' + (fold && !st.open ? ' folded' : ''));
      var head = cel(doc, 'div', 'code-head');
      head.appendChild(cel(doc, 'span', 'code-lang', opts.title || 'JSON'));
      head.appendChild(cel(doc, 'span', 'spacer'));
      head.appendChild(copyButton(doc, function () { return pretty; }, 'Copy', st));
      var pre = cel(doc, 'pre');
      jsonInto(pre, value, 0, doc);
      box.appendChild(head);
      box.appendChild(pre);
      if (fold) box.appendChild(foldButton(doc, box, n, 15, st));
      if (opts.truncated) box.appendChild(cutNote(doc, opts.truncated));
      return box;
    }
    // Sections view: <goal>, <rules>, <done_when> as labeled sections with Markdown bodies.
    function renderSections(sections, opts, doc) {
      doc = doc || document;
      var frag = doc.createDocumentFragment();
      sections.forEach(function (s) {
        var sec = cel(doc, 'div', 'sec');
        if (s.label) sec.appendChild(cel(doc, 'div', 'sec-label', s.label));
        var body = cel(doc, 'div', 'sec-body');
        body.appendChild(renderMarkdown(s.body, doc, opts));
        sec.appendChild(body);
        frag.appendChild(sec);
      });
      return frag;
    }
    function sizeText(chars) { return chars >= 1000 ? (chars / 1000).toFixed(chars >= 10000 ? 0 : 1) + 'k chars' : chars + ' chars'; }
    var BLOCK_KINDS = { 'agents-md': 'Instructions', 'claude-md': 'Instructions', skill: 'Skill', developer: 'Developer', 'system-reminder': 'Reminder',
      'task-notification': 'Task finished', harness: 'Harness', context: 'Context', other: 'Injected' };
    // Injected block rows: one line each (kind, title, size); the body opens on its own, rendered by its format, capped.
    // b = { type, title, body, status?, format? }. opts.key gives the row its data-key, so its open state survives re-renders.
    function renderInjectedRow(b, opts, doc) {
      opts = opts || {}; doc = doc || document;
      var d = cel(doc, 'details', 'inj'), s = cel(doc, 'summary');
      if (opts.key) d.dataset.key = opts.key;
      s.appendChild(cel(doc, 'span', 'inj-kind', BLOCK_KINDS[b.type] || b.type || 'Injected'));
      if (b.status) s.appendChild(cel(doc, 'span', 'inj-status ' + b.status));
      s.appendChild(cel(doc, 'span', 'inj-title', b.title || 'Injected content'));
      s.appendChild(cel(doc, 'span', 'inj-size', sizeText(String(b.body || '').length)));
      d.appendChild(s);
      lazyDetails(d, function () {
        var body = cel(doc, 'div', 'inj-body');
        var text = String(b.body || '');
        var format = b.format || detectFormat(text);
        if (format === 'markdown' || format === 'sections' || format === 'json' || format === 'diff') body.appendChild(renderContent(text, format, { key: opts.key }, doc));
        else body.appendChild(cel(doc, 'pre', 'raw', text));
        return body;
      });
      return d;
    }
    // A <details> whose body is built on first open, so highlighting runs only for blocks the reader looks at.
    // drawTranscript calls details._build after it restores an open choice (the toggle event comes later).
    function lazyDetails(details, build) {
      var done = false;
      function run() { if (done) return; done = true; details.appendChild(build()); }
      details._build = run;
      details.addEventListener('toggle', function () { if (details.open) run(); });
      if (details.open) run();
    }
    function taskNotificationRow(text) {
      var g = function (t) { var m = text.match(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>')); return m ? m[1].trim() : ''; };
      var status = g('status') || 'completed';
      return { type: 'task-notification', status: /fail|error/i.test(status) ? 'failed' : 'completed', title: g('summary') || 'task notification', body: text, format: 'plain' };
    }
    // Workflow harness frames: every "[Workflow harness — …]" block becomes a caption plus the relayed text, dedented.
    var HARNESS_FRAME = /^\[Workflow harness — ([^\]\n]+)\]([^\n]*)\n?/;
    function renderHarness(text, opts, doc) {
      doc = doc || document;
      var parts = String(text || '').split(/(?=^\[Workflow harness — )/m).filter(function (p) { return p.trim(); });
      if (!parts.length || !HARNESS_FRAME.test(parts[0])) return null;
      var frag = doc.createDocumentFragment();
      parts.forEach(function (part) {
        var m = part.match(HARNESS_FRAME);
        var box = cel(doc, 'div', 'harness');
        if (m) {
          var cap = cel(doc, 'div', 'harness-cap');
          var kind = m[1].trim();
          cap.appendChild(cel(doc, 'span', '', kind === 'user request' ? 'Relayed user request' : kind === 'computed task' ? 'Computed task' : kind));
          var note = cel(doc, 'span', 'note', kind === 'user request' ? '· verbatim, relayed by the Workflow harness' : kind === 'computed task' ? '· script output, carries no user authority' : '');
          note.title = m[2].trim();
          cap.appendChild(note);
          box.appendChild(cap);
          part = part.slice(m[0].length);
        }
        var body = cel(doc, 'div', 'msg-body');
        body.appendChild(renderMarkdown(part.replace(/^  /gm, ''), doc, opts));
        box.appendChild(body);
        frag.appendChild(box);
      });
      return frag;
    }
    function mediaUrl(ref) { return '/media?ref=' + encodeURIComponent(String(ref || '')); }
    // Image thumbnail from a media ref; a missing or blocked image becomes the "image not available" placeholder.
    function renderImage(item, doc) {
      doc = doc || document;
      var name = item.alt || 'Image';
      var fig = cel(doc, 'figure', 'img-thumb');
      fig.title = 'Open full size';
      var img = cel(doc, 'img');
      img.alt = name;
      img.src = mediaUrl(item.ref);
      img.onerror = function () { var missing = renderImageMissing(name, doc); if (fig.parentNode) fig.parentNode.replaceChild(missing, fig); };
      fig.onclick = function () { openImageOverlay(img.src, name); };
      fig.appendChild(img);
      var cap = cel(doc, 'figcaption', 'img-cap');
      cap.appendChild(cel(doc, 'b', '', name));
      img.onload = function () { if (img.naturalWidth) cap.appendChild(cel(doc, 'span', '', img.naturalWidth + '×' + img.naturalHeight)); };
      fig.appendChild(cap);
      return fig;
    }
    function renderImageMissing(name, doc) {
      doc = doc || document;
      var d = cel(doc, 'div', 'img-missing');
      if (typeof glyph === 'function') d.appendChild(glyph('ghost'));
      d.appendChild(cel(doc, 'span', '', 'image not available' + (name && name !== 'Image' ? ' · ' + name : '')));
      return d;
    }
    // Full-size view: one overlay element, made on first use and appended to body (no load-time code).
    function openImageOverlay(src, name) {
      var overlay = document.getElementById('image-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'image-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-label', 'Image');
        overlay.tabIndex = -1;
        overlay.onclick = function () { overlay.hidden = true; overlay.textContent = ''; };
        overlay.onkeydown = function (e) { if (e.key === 'Escape') overlay.onclick(); };
        document.body.appendChild(overlay);
      }
      overlay.textContent = '';
      var img = document.createElement('img');
      img.src = src; img.alt = name || 'image';
      overlay.appendChild(img);
      overlay.hidden = false;
      overlay.focus();
    }
    // A client attachment note becomes a chip with the file name; the path stays in the tooltip, never loaded.
    var ATTACHMENT_NOTE = /^[ \t]*\[Attached (?:image|file) "([^"\n]+)" is saved at: ([^\]\n]+)\][ \t]*$/gm;
    function renderAttachmentChip(name, path, doc) {
      doc = doc || document;
      var chip = cel(doc, 'span', 'chip-file');
      chip.title = path;
      var ext = String(name).match(/\.[^.]+$/);
      if (typeof glyph === 'function') chip.appendChild(glyph('plugin'));
      chip.appendChild(cel(doc, 'span', '', ext ? name.slice(0, -ext[0].length) : name));
      chip.appendChild(cel(doc, 'span', 'ext', ext ? ext[0] : ''));
      return chip;
    }
    // Plain or ANSI text as an output box.
    function renderOutputPre(text, opts, doc) {
      var pre = cel(doc, 'pre', 'out');
      renderAnsiInto(pre, String(text == null ? '' : text), doc);
      if (opts && opts.truncated) { var frag = doc.createDocumentFragment(); frag.appendChild(pre); frag.appendChild(cutNote(doc, opts.truncated)); return frag; }
      return pre;
    }
    // One renderer for every surface: renderContent(text, format, { key, lang, path, truncated, quiet, pre }) -> Node.
    // `format` is a hint (section 3.1); without it the page detects. `pre` draws plain text as an output box
    // (a tool result), else plain text reads as prose.
    function renderContent(text, format, opts, doc) {
      opts = opts || {}; doc = doc || document;
      text = String(text == null ? '' : text);
      format = detectFormat(text, format);
      if (format === 'ansi') return renderOutputPre(text, opts, doc);
      if (format === 'diff') return renderDiff(text, opts, doc);
      if (format === 'code') return renderCodeBlock(text, opts.lang || opts.path, opts, doc);
      if (format === 'json') {
        var pretty = prettyJson(text);
        if (pretty !== null) return renderJson(JSON.parse(text), opts, doc);
      }
      if (format === 'sections') {
        var sections = parseSections(text);
        if (sections) return renderSections(sections, opts, doc);
      }
      if (format === 'plain' && opts.pre) return renderOutputPre(text, opts, doc);
      var md = renderMarkdown(text, doc, opts);
      if (opts.truncated) md.appendChild(cutNote(doc, opts.truncated));
      return md;
    }
