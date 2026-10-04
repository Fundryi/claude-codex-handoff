'use strict';
    // Safe Markdown: a container tree and inline tokens, never parsed HTML.
    function markdownEscapeRegExp(text) {
      return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function markdownText(tokens, text) {
      if (!text) return;
      var last = tokens[tokens.length - 1];
      if (last && last.type === 'text') last.text += text;
      else tokens.push({ type: 'text', text: text });
    }
    // Index exact backtick runs and balanced target parentheses once. Failed
    // matches then cost a lookup, rather than scanning the rest of a long line.
    function markdownInlineIndex(text) {
      var ticks = Object.create(null);
      var nextTicks = Object.create(null);
      var runs = [];
      var re = /`+/g;
      var match;
      while ((match = re.exec(text))) runs.push({ at: match.index, size: match[0].length });
      for (var i = runs.length - 1; i >= 0; i--) {
        var run = runs[i];
        ticks[run.at] = { size: run.size, close: nextTicks[run.size] };
        nextTicks[run.size] = run.at;
      }
      var parens = Object.create(null);
      var stack = [];
      for (var j = 0; j < text.length; j++) {
        if (text[j] === '\\') { j++; continue; }
        if (text[j] === '(') stack.push(j);
        else if (text[j] === ')' && stack.length) parens[stack.pop()] = j;
      }
      return { ticks: ticks, parens: parens, budget: text.length * 4 + 1200 };
    }
    function markdownLinkAt(text, at, index) {
      var end = at + 1;
      var depth = 1;
      // Preserve the original 300-character label bound, including escapes.
      for (; end < text.length && end <= at + 301; end++) {
        if (text[end] === '\\') { end++; continue; }
        if (text[end] === '\n') return null;
        if (text[end] === '[') depth++;
        else if (text[end] === ']') depth--;
        if (depth === 0) break;
      }
      if (depth || text[end + 1] !== '(') return null;
      var start = end + 2;
      var close;
      var target;
      if (text[start] === '<') {
        close = start + 1;
        while (close < text.length && text[close] !== '>' && text[close] !== '\n') {
          if (--index.budget < 0) return null;
          close++;
        }
        if (text[close] !== '>' || text[close + 1] !== ')') return null;
        target = text.slice(start + 1, close);
        close++;
      } else {
        close = index.parens[end + 1];
        if (close === undefined) return null;
        if ((index.budget -= close - start) < 0) return null;
        target = text.slice(start, close);
        if (/\s/.test(target)) return null;
      }
      return { label: text.slice(at + 1, end), target: target, end: close + 1 };
    }
    function markdownInlineScan(text, allowLinks) {
      var index = markdownInlineIndex(text);
      var root = [];
      var stack = [{ children: root }];
      var i = 0;
      while (i < text.length) {
        var tokens = stack[stack.length - 1].children;
        var ch = text[i];
        if (ch === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(text[i + 1] || '')) {
          markdownText(tokens, text[i + 1]); i += 2; continue;
        }
        if (ch === '\n') { tokens.push({ type: 'br' }); i++; continue; }
        if (ch === '`') {
          var run = index.ticks[i];
          if (run && run.close !== undefined) {
            var code = text.slice(i + run.size, run.close).replace(/\n/g, ' ');
            if (/^ .+ $/.test(code) && /[^ ]/.test(code)) code = code.slice(1, -1);
            tokens.push({ type: 'code', text: code });
            i = run.close + run.size; continue;
          }
          var size = run ? run.size : 1;
          markdownText(tokens, text.slice(i, i + size)); i += size; continue;
        }
        if (allowLinks && (ch === '[' || (ch === '!' && text[i + 1] === '['))) {
          var image = ch === '!';
          var link = markdownLinkAt(text, image ? i + 1 : i, index);
          if (link) {
            if (image) markdownText(tokens, text.slice(i, link.end));
            else tokens.push({ type: 'link', href: /^https?:\/\//i.test(link.target) ? link.target : null,
              title: link.target, children: markdownInlineScan(link.label, false) });
            i = link.end; continue;
          }
        }
        if (allowLinks && (ch === 'h' || ch === 'H') && /^https?:\/\//i.test(text.slice(i, i + 8))) {
          var urlEnd = i;
          while (urlEnd < text.length && !/[\s<>]/.test(text[urlEnd])) urlEnd++;
          var url = text.slice(i, urlEnd).replace(/[.,;:!?)]+$/, '');
          if (url) {
            tokens.push({ type: 'link', href: url, title: url, children: [{ type: 'text', text: url }] });
            i += url.length; continue;
          }
        }
        if (ch === '*' || (ch === '~' && text[i + 1] === '~')) {
          var top = stack[stack.length - 1];
          var marker = ch === '~' ? '~~' : (top.marker === '*' && text[i + 2] === '*' ? '*' : (text[i + 1] === '*' ? '**' : '*'));
          if (top.marker === marker && i > 0 && !/\s/.test(text[i - 1])) {
            stack.pop();
            stack[stack.length - 1].children.push({ type: top.type, children: top.children });
            i += marker.length; continue;
          }
          var canOpen = !/\s/.test(text[i + marker.length] || ' ') &&
            (marker !== '*' || !/[\w*/\\]/.test(text[i - 1] || '') || (top.marker === '**' && !top.children.length));
          if (canOpen && stack.length < 64) {
            stack.push({ type: marker === '**' ? 'bold' : marker === '*' ? 'italic' : 'strike', marker: marker, children: [] });
          } else markdownText(tokens, marker);
          i += marker.length; continue;
        }
        var start = i++;
        while (i < text.length && !/[\\\n`*~[!hH]/.test(text[i])) i++;
        markdownText(tokens, text.slice(start, i));
      }
      // Unclosed delimiters are literal; unwind without recursive stack growth.
      while (stack.length > 1) {
        var pending = stack.pop();
        var parent = stack[stack.length - 1].children;
        markdownText(parent, pending.marker);
        pending.children.forEach(function (token) {
          if (token.type === 'text') markdownText(parent, token.text);
          else parent.push(token);
        });
      }
      if (!root.length) root.push({ type: 'text', text: '' });
      return root;
    }
    function parseInline(text) {
      return markdownInlineScan(String(text == null ? '' : text), true);
    }
    function markdownListMarker(line) {
      var match = line.match(/^( {0,3})([-*+]|\d+\.)([ \t]+)(.*)$/);
      if (!match) return null;
      return { indent: match[1].length, column: match[1].length + match[2].length + match[3].length,
        ordered: /\d/.test(match[2][0]), start: /^\d/.test(match[2]) ? Number(match[2].slice(0, -1)) : null, text: match[4] };
    }
    function markdownFence(line) {
      return line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/);
    }
    function markdownRule(line) {
      return /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
    }
    function markdownTableCells(line) {
      var cells = [];
      var start = 0;
      var tick = '';
      var i = 0;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '`') {
          var end = i + 1;
          while (line[end] === '`') end++;
          var run = line.slice(i, end);
          if (!tick) tick = run;
          else if (tick === run) tick = '';
          i = end; continue;
        }
        if (line[i] === '|' && !tick) { cells.push(line.slice(start, i).trim()); start = i + 1; }
        i++;
      }
      cells.push(line.slice(start).trim());
      if (cells.length > 1 && cells[0] === '') cells.shift();
      if (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
      return cells;
    }
    function markdownTableAt(lines, i) {
      if (i + 1 >= lines.length || lines[i].indexOf('|') < 0) return null;
      var head = markdownTableCells(lines[i]);
      var delimiters = markdownTableCells(lines[i + 1]);
      if (head.length !== delimiters.length || !delimiters.every(function (cell) { return /^:?-+:?$/.test(cell); })) return null;
      return { head: head.map(parseInline), align: delimiters.map(function (cell) {
        return cell[0] === ':' ? (cell[cell.length - 1] === ':' ? 'center' : 'left') : (cell[cell.length - 1] === ':' ? 'right' : null);
      }), rows: [] };
    }
    function markdownBlockStart(lines, i) {
      return /^ {0,3}(#{1,6}\s|>)/.test(lines[i]) || markdownFence(lines[i]) ||
        markdownRule(lines[i]) || markdownListMarker(lines[i]) || markdownTableAt(lines, i);
    }
    function markdownBlocks(lines) {
      var root = [];
      // Explicit frames allow deep containers without consuming the call stack.
      var frames = [{ lines: lines, i: 0, blocks: root }];
      while (frames.length) {
        var frame = frames[frames.length - 1];
        lines = frame.lines;
        var i = frame.i;
        var blocks = frame.blocks;
        if (i >= lines.length) { frames.pop(); continue; }
        var line = lines[i];
        if (!line.trim()) { frame.i++; continue; }
        var fence = markdownFence(line);
        if (fence) {
          var info = fence[2].trim();
          var codeLines = [];
          var close = new RegExp('^ {0,3}' + markdownEscapeRegExp(fence[1][0]) + '{' + fence[1].length + ',}[ \\t]*$');
          i++;
          while (i < lines.length && !close.test(lines[i])) codeLines.push(lines[i++]);
          if (i < lines.length) i++;
          blocks.push({ type: 'code', lang: info.split(/\s/)[0], info: info, text: codeLines.join('\n') });
          frame.i = i;
          continue;
        }
        var heading = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
        if (heading) {
          blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2].trim()) }); frame.i++; continue;
        }
        if (markdownRule(line)) { blocks.push({ type: 'hr' }); frame.i++; continue; }
        if (/^ {0,3}>/.test(line)) {
          var quoteLines = [];
          while (i < lines.length && /^ {0,3}>/.test(lines[i])) quoteLines.push(lines[i++].replace(/^ {0,3}> ?/, ''));
          var quote = { type: 'quote', blocks: [] };
          blocks.push(quote);
          frame.i = i;
          frames.push({ lines: quoteLines, i: 0, blocks: quote.blocks });
          continue;
        }
        var marker = markdownListMarker(line);
        if (marker) {
          var list = { type: marker.ordered ? 'ol' : 'ul', start: marker.start, items: [] };
          var children = [];
          var indent = marker.indent;
          while (i < lines.length) {
            var item = markdownListMarker(lines[i]);
            if (!item || item.indent !== indent || item.ordered !== marker.ordered || markdownRule(lines[i])) break;
            var task = item.text.match(/^\[([ xX])\][ \t]+(.*)$/);
            var itemLines = [task ? task[2] : item.text];
            i++;
            while (i < lines.length) {
              if (!lines[i].trim()) {
                var after = i + 1;
                while (after < lines.length && !lines[after].trim()) after++;
                if (after >= lines.length || (lines[after].match(/^ */)[0].length < item.column)) break;
                while (i < after) { itemLines.push(''); i++; }
                continue;
              }
              var spaces = lines[i].match(/^ */)[0].length;
              if (spaces < item.column) break;
              itemLines.push(lines[i++].slice(item.column));
            }
            var listItem = { blocks: [], checked: task ? task[1].toLowerCase() === 'x' : undefined };
            list.items.push(listItem);
            children.push({ lines: itemLines, i: 0, blocks: listItem.blocks });
            if (i < lines.length && !lines[i].trim()) break;
          }
          blocks.push(list);
          frame.i = i;
          for (var child = children.length - 1; child >= 0; child--) frames.push(children[child]);
          continue;
        }
        var table = markdownTableAt(lines, i);
        if (table) {
          i += 2;
          while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0 && !markdownBlockStart(lines, i)) {
            var cells = markdownTableCells(lines[i++]);
            var row = [];
            for (var c = 0; c < table.head.length; c++) row.push(parseInline(cells[c] || ''));
            table.rows.push(row);
          }
          blocks.push({ type: 'table', align: table.align, head: table.head, rows: table.rows }); frame.i = i; continue;
        }
        var paraLines = [lines[i++]];
        while (i < lines.length && lines[i].trim() && !markdownBlockStart(lines, i)) paraLines.push(lines[i++]);
        blocks.push({ type: 'p', inline: parseInline(paraLines.join('\n')) });
        frame.i = i;
      }
      return root;
    }
    function parseMarkdown(text) {
      return markdownBlocks(String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n'));
    }
    // A bold label that is exactly Passed / Failed / OK / Error gets a status color (Checks run lists).
    var STATUS_WORD = /^(Passed|Failed|FAILED|OK|Error)\b:?$/;
    function appendInline(parent, tokens, doc) {
      tokens.forEach(function (token) {
        if (token.type === 'text') { parent.appendChild(doc.createTextNode(token.text)); return; }
        var tags = { bold: 'strong', italic: 'em', strike: 'del', code: 'code', br: 'br', link: token.href ? 'a' : 'span' };
        var node = doc.createElement(tags[token.type]);
        if (token.type === 'code') node.textContent = token.text;
        if (token.type === 'bold' && token.children.length === 1 && token.children[0].type === 'text') {
          var word = token.children[0].text.trim().match(STATUS_WORD);
          if (word) node.className = /^(Passed|OK)/.test(word[1]) ? 'st-ok' : 'st-fail';
        }
        if (token.type === 'link') {
          node.className = token.href ? 'md-link' : 'md-link local';
          node.title = token.title;
          if (token.href) { node.href = token.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
        }
        if (token.children) appendInline(node, token.children, doc);
        parent.appendChild(node);
      });
    }
    // opts (optional) reaches the code blocks: { key, quiet, n } (see renderCodeBlock in content.js).
    function renderMarkdownBlock(block, doc, opts) {
      if (block.type === 'heading') {
        var heading = doc.createElement('div');
        heading.className = 'md-h' + block.level;
        appendInline(heading, block.inline, doc);
        return heading;
      }
      if (block.type === 'code') {
        if (typeof renderCodeBlock === 'function') return renderCodeBlock(block.text, block.lang, opts, doc);
        var wrap = doc.createElement('div');
        wrap.className = 'code';
        var pre = doc.createElement('pre');
        pre.textContent = block.text;
        wrap.appendChild(pre);
        return wrap;
      }
      if (block.type === 'quote') {
        var quote = doc.createElement('blockquote');
        quote.className = 'md-quote';
        block.blocks.forEach(function (child) { quote.appendChild(renderMarkdownBlock(child, doc, opts)); });
        return quote;
      }
      if (block.type === 'ul' || block.type === 'ol') {
        var list = doc.createElement(block.type);
        list.className = 'md-list';
        if (block.type === 'ol' && Number(block.start) > 0) list.start = Number(block.start);
        block.items.forEach(function (item) {
          var li = doc.createElement('li');
          if (item.checked !== undefined) {
            li.className = 'md-task';
            var check = doc.createElement('input');
            check.type = 'checkbox'; check.disabled = true; check.checked = item.checked;
            li.appendChild(check);
          }
          item.blocks.forEach(function (child) { li.appendChild(renderMarkdownBlock(child, doc, opts)); });
          list.appendChild(li);
        });
        return list;
      }
      if (block.type === 'hr') {
        var hr = doc.createElement('hr'); hr.className = 'md-hr'; return hr;
      }
      if (block.type === 'table') {
        var tableWrap = doc.createElement('div'); tableWrap.className = 'md-table-wrap';
        var table = doc.createElement('table'); table.className = 'md-table' + (block.head.length >= 4 ? ' wide' : '');
        var thead = doc.createElement('thead');
        var tbody = doc.createElement('tbody');
        var rows = [block.head].concat(block.rows);
        rows.forEach(function (cells, rowIndex) {
          var tr = doc.createElement('tr');
          cells.forEach(function (inline, column) {
            var cell = doc.createElement(rowIndex === 0 ? 'th' : 'td');
            if (block.align[column]) { cell.style.textAlign = block.align[column]; cell.className = 'al-' + block.align[column]; }
            appendInline(cell, inline, doc); tr.appendChild(cell);
          });
          (rowIndex === 0 ? thead : tbody).appendChild(tr);
        });
        table.appendChild(thead); table.appendChild(tbody); tableWrap.appendChild(table); return tableWrap;
      }
      var p = doc.createElement('p');
      p.className = 'md-p';
      appendInline(p, block.inline, doc);
      return p;
    }
    // Pure but for `doc`, passed in so tests can hand it a minimal DOM shim.
    function renderMarkdown(text, doc, opts) {
      var fragment = doc.createDocumentFragment();
      parseMarkdown(text).forEach(function (block) {
        fragment.appendChild(renderMarkdownBlock(block, doc, opts));
      });
      return fragment;
    }
