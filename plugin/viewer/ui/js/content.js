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
