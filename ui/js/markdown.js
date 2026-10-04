'use strict';
    // -- Markdown: a safe subset (headings, paragraphs, bold/italic/inline code,
    // fenced code, lists, block quotes). Links become plain "text (url)" - never
    // an <a>. No HTML is ever parsed, so "<script>" etc. stay literal text.
    function markdownEscapeRegExp(text) {
      return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function parseInline(text) {
      // The label is bounded ({0,300}) so an unclosed "[" can't make this quadratic.
      var withLinks = String(text || '').replace(/\[([^\][\n]{0,300})\]\(([^)\s]+)\)/g, function (m, label, url) {
        return label + ' (' + url + ')';
      });
      var tokens = [];
      // Italic content may not contain whitespace and the "*" can't open mid-word
      // (no word char or "*" just before it) - otherwise prose like "src/*.js and
      // lib/*.mjs" gets read as one italic run spanning both asterisks.
      var re = /(\*\*([^*]+)\*\*|`([^`]+)`|(?:^|[^\w*])\*([^*\s]+)\*)/g;
      var last = 0;
      var match;
      while ((match = re.exec(withLinks))) {
        var start = match.index + (match[4] !== undefined ? match[0].indexOf('*') : 0);
        if (start > last) tokens.push({ type: 'text', text: withLinks.slice(last, start) });
        if (match[2] !== undefined) tokens.push({ type: 'bold', text: match[2] });
        else if (match[3] !== undefined) tokens.push({ type: 'code', text: match[3] });
        else tokens.push({ type: 'italic', text: match[4] });
        last = re.lastIndex;
      }
      if (last < withLinks.length) tokens.push({ type: 'text', text: withLinks.slice(last) });
      if (!tokens.length) tokens.push({ type: 'text', text: '' });
      return tokens;
    }
    // Blocks are nested-free: no indentation-based nesting of lists or quotes.
    function parseMarkdown(text) {
      var lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
      var blocks = [];
      var i = 0;
      while (i < lines.length) {
        var line = lines[i];
        if (!line.trim()) { i++; continue; }
        var heading = line.match(/^(#{1,3})\s+(.*)$/);
        if (heading) {
          blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2].trim()) });
          i++;
          continue;
        }
        // Up to 3 leading spaces (a fence inside a list item) is still a fence.
        var fence = line.match(/^\s{0,3}```(.*)$/);
        if (fence) {
          var lang = fence[1].trim();
          var codeLines = [];
          i++;
          while (i < lines.length && !/^\s{0,3}```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
          if (i < lines.length) i++; // skip closing fence
          blocks.push({ type: 'code', lang: lang, text: codeLines.join('\n') });
          continue;
        }
        if (/^>\s?/.test(line)) {
          var quoteLines = [];
          while (i < lines.length && /^>\s?/.test(lines[i])) { quoteLines.push(lines[i].replace(/^>\s?/, '')); i++; }
          blocks.push({ type: 'quote', inline: parseInline(quoteLines.join(' ').trim()) });
          continue;
        }
        var bullet = line.match(/^[-*]\s+(.*)$/);
        var numbered = line.match(/^(\d+)\.\s+(.*)$/);
        if (bullet || numbered) {
          var ordered = !!numbered;
          var start = ordered ? Number(numbered[1]) : null;
          var items = [];
          while (i < lines.length) {
            var itemMatch = ordered ? lines[i].match(/^\d+\.\s+(.*)$/) : lines[i].match(/^[-*]\s+(.*)$/);
            if (!itemMatch) break;
            items.push(parseInline(itemMatch[1]));
            i++;
          }
          var listBlock = { type: ordered ? 'ol' : 'ul', items: items };
          if (ordered) listBlock.start = start;
          blocks.push(listBlock);
          continue;
        }
        var paraLines = [];
        while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\s{0,3}```|>\s?|[-*]\s|\d+\.\s)/.test(lines[i])) {
          paraLines.push(lines[i]);
          i++;
        }
        blocks.push({ type: 'paragraph', inline: parseInline(paraLines.join(' ')) });
      }
      return blocks;
    }
    function appendInline(parent, tokens, doc) {
      tokens.forEach(function (token) {
        if (token.type === 'bold') {
          var strong = doc.createElement('strong');
          strong.textContent = token.text;
          parent.appendChild(strong);
        } else if (token.type === 'italic') {
          var em = doc.createElement('em');
          em.textContent = token.text;
          parent.appendChild(em);
        } else if (token.type === 'code') {
          var code = doc.createElement('code');
          code.textContent = token.text;
          parent.appendChild(code);
        } else {
          parent.appendChild(doc.createTextNode(token.text));
        }
      });
    }
    function renderMarkdownBlock(block, doc) {
      if (block.type === 'heading') {
        var heading = doc.createElement('div');
        heading.className = 'md-h' + block.level;
        appendInline(heading, block.inline, doc);
        return heading;
      }
      if (block.type === 'code') {
        var wrap = doc.createElement('div');
        wrap.className = 'md-code';
        if (block.lang) {
          var label = doc.createElement('div');
          label.className = 'md-code-lang';
          label.textContent = block.lang;
          wrap.appendChild(label);
        }
        var pre = doc.createElement('pre');
        pre.textContent = block.text;
        wrap.appendChild(pre);
        return wrap;
      }
      if (block.type === 'quote') {
        var quote = doc.createElement('blockquote');
        quote.className = 'md-quote';
        appendInline(quote, block.inline, doc);
        return quote;
      }
      if (block.type === 'ul' || block.type === 'ol') {
        var list = doc.createElement(block.type === 'ol' ? 'ol' : 'ul');
        list.className = 'md-list';
        if (block.type === 'ol' && Number(block.start) > 0) list.start = Number(block.start);
        block.items.forEach(function (inline) {
          var li = doc.createElement('li');
          appendInline(li, inline, doc);
          list.appendChild(li);
        });
        return list;
      }
      var p = doc.createElement('p');
      p.className = 'md-p';
      appendInline(p, block.inline, doc);
      return p;
    }
    // Pure but for `doc`, passed in so tests can hand it a minimal DOM shim.
    // Never innerHTML: every node is built with createElement/createTextNode.
    function renderMarkdown(text, doc) {
      var fragment = doc.createDocumentFragment();
      parseMarkdown(text).forEach(function (block) {
        fragment.appendChild(renderMarkdownBlock(block, doc));
      });
      return fragment;
    }

