'use strict';
    function actorName(actor) {
      var name = document.createElement('span');
      name.className = 'who actor-' + actor;
      name.textContent = ACTORS[actor].name;
      return name;
    }

    function textSpan(className, text) {
      var span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      return span;
    }

    // One collapsed summary row: caret, label, one-line preview, time.
    function summaryRow(label, text, ts) {
      var summary = document.createElement('summary');
      summary.append(textSpan('caret', '▸'), textSpan('sum-label', label), textSpan('sum-text', text));
      if (ts) summary.appendChild(textSpan('sum-time', eventTime(ts)));
      return summary;
    }

    // The first line of a command or path as typed: no Markdown stripping (that would eat `*` and backticks).
    function rawFirstLine(text, limit) {
      var value = String(text == null ? '' : text).replace(/^\s+/, '').split(/\r?\n/)[0].trim();
      return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
    }
    // An injected block appended to the end of a message (context-mode's <context_window_protection>, a system
    // reminder, a task notification): split off and shown as its own injected row under the message.
    var TRAILING_BLOCK = /\n[ \t]*<(context[\w-]*|system-reminder|task-notification|codex-jobs|codex_internal_context)>[\s\S]*?<\/\1>[ \t]*$/;
    function splitTrailingBlocks(text) {
      var blocks = [], m;
      while ((m = text.match(TRAILING_BLOCK))) {
        var body = m[0].trim();
        blocks.unshift(m[1] === 'task-notification' ? taskNotificationRow(body) : { type: /^context/.test(m[1]) || /^codex/.test(m[1]) ? 'context' : m[1], title: m[1].replace(/[_-]+/g, ' '), body: body });
        text = text.slice(0, m.index).replace(/\s+$/, '');
      }
      return { text: text, blocks: blocks };
    }
    // One message body: harness frames, section views for tagged prompts, Markdown otherwise; attachment notes
    // become chips, trailing injected blocks become rows, media refs become thumbnails.
    function messageBody(text, actor, key, event) {
      var body = document.createElement('div');
      body.className = 'msg-body';
      var opts = { key: key };
      var harness = renderHarness(text, opts, document);
      if (harness) { body.appendChild(harness); return body; }
      var chips = [];
      text = text.replace(ATTACHMENT_NOTE, function (_, name, path) { chips.push([name, path.trim()]); return ''; }).replace(/\n{3,}/g, '\n\n').trim();
      var split = splitTrailingBlocks(text);
      var prompt = actor === 'claude' || actor === 'you' || actor === 'relay' || actor === 'codex-lead' || actor === 'workflow-script';
      var sections = prompt ? parseSections(split.text) : null;
      if (sections && sections.some(function (s) { return s.tag; })) body.appendChild(renderSections(sections, opts, document));
      else body.appendChild(renderMarkdown(actor === 'claude' || actor === 'workflow-script' ? promptMarkdown(split.text) : split.text, document, opts));
      chips.forEach(function (chip) { body.appendChild(renderAttachmentChip(chip[0], chip[1], document)); });
      if (event && event.media) event.media.forEach(function (item) { body.appendChild(renderImage(item, document)); });
      if (split.blocks.length) {
        var list = document.createElement('div');
        list.className = 'quiet-list';
        split.blocks.forEach(function (block, index) { list.appendChild(renderInjectedRow(block, { key: key + '|inj' + index }, document)); });
        body.appendChild(list);
      }
      return body;
    }
    // Kept for callers that only have text (the question callout).
    function markdownBody(text, key) {
      var body = document.createElement('div');
      body.className = 'msg-body';
      body.appendChild(renderMarkdown(text, document, { key: key }));
      return body;
    }

    // A conversation message: You, Claude, You relayed, or Codex.
    function createMessage(event, actor, key, session) {
      var route = messageRoute(actor, session);
      var card = document.createElement('article');
      card.className = 'msg actor-' + actor;
      var head = document.createElement('div');
      head.className = 'msg-head';
      head.append(actorAvatar(actor), actorName(route.from), textSpan('route-arrow', '→'), actorName(route.to));

      var text = String(event.text || '');
      // A reply (Codex, or a Claude workflow agent) is never read as a prompt, and the plugin's
      // return-format footer is a Codex handoff thing, never parsed out of a Claude transcript.
      var source = session && session.source;
      var claudeTranscript = source === 'claude' || source === 'chat' || source === 'agent' || source === 'opencode';
      var reply = actor === 'codex' || actor === 'opencode' || actor === 'claude-agent' || actor === 'subagent' || (source === 'chat' && actor === 'claude');
      var parts = (reply || claudeTranscript) ? { body: text, footer: '' } : splitReturnFormat(text);
      var prefix = claudeTranscript ? { tag: '', text: parts.body } : answerPrefix(parts.body);
      var body = prefix.text;
      var resume = !reply && !claudeTranscript && !prefix.tag && isResumePrompt(body);
      // Claude's message is a handoff prompt in a Codex session, the Agent tool's prompt in a subagent, a reply in a chat.
      var tag = prefix.tag || (resume ? 'resume' : actor === 'claude' ? (source === 'agent' ? 'Agent tool' : source === 'chat' ? '' : 'handoff') : '');
      var question = actor === 'codex' ? feedQuestion(text) : null;
      if (question) body = removeResultSection(body, 'Needs decision');
      if (tag) {
        var tagEl = textSpan('msg-tag' + (resume ? ' neutral' : ''), tag);
        if (resume) tagEl.title = 'Sent by a Resume button or Claude’s resume';
        if (actor === 'relay') tagEl.title = 'Your answer, delivered to Codex through Claude or the viewer’s answer box';
        head.appendChild(tagEl);
      }
      // Who the question is for: you directly, you through Claude in a handoff, or the lead agent.
      var asked = route.to === 'codex-lead'
        ? { actor: 'codex-lead', tag: 'asks the lead agent', title: 'Question for the lead agent' }
        : { actor: 'you', tag: route.to === 'claude' ? 'asks you (via Claude)' : 'asks you', title: route.to === 'claude' ? 'Question for you (via Claude)' : 'Question for you' };
      if (question) {
        var asks = textSpan('msg-tag actor-' + asked.actor, asked.tag);
        asks.title = 'Codex asked a question under Needs decision';
        head.appendChild(asks);
      }
      head.appendChild(textSpan('msg-time', eventTime(event.ts)));
      card.appendChild(head);

      // A reply never reads as a prompt; a chat reply is Claude's own words, not a handoff.
      var bodyActor = reply ? 'reply' : actor;
      if (body.length > LONG_MESSAGE) {
        var more = document.createElement('details');
        more.className = 'msg-more';
        more.dataset.key = key + '|full';
        var moreSummary = document.createElement('summary');
        moreSummary.textContent = stripMarkdown(body);
        moreSummary.appendChild(textSpan('pv-more', '  ·  show full message (' + body.split('\n').length + ' lines)'));
        more.appendChild(moreSummary);
        lazyDetails(more, function () { return messageBody(body, bodyActor, key, event); });
        card.appendChild(more);
      } else if (body.trim() || (event.media && event.media.length)) {
        card.appendChild(messageBody(body, bodyActor, key, event));
      }
      if (question) {
        var ask = document.createElement('div');
        ask.className = 'ask actor-' + asked.actor;
        var askTitle = document.createElement('div');
        askTitle.className = 'ask-title';
        askTitle.append(actorAvatar(asked.actor, true), document.createTextNode(asked.title));
        ask.append(askTitle, markdownBody(question, key + '|ask'));
        card.appendChild(ask);
      }

      if (parts.footer) {
        var plugin = document.createElement('details');
        plugin.className = 'part actor-plugin';
        plugin.dataset.key = key + '|plugin';
        var summary = summaryRow('Plugin', 'added the return format: Summary, Changed files, Checks run, Needs decision', 0);
        summary.insertBefore(actorAvatar('plugin', true), summary.children[1]);
        var pre = document.createElement('pre');
        pre.textContent = parts.footer;
        plugin.append(summary, pre);
        card.appendChild(plugin);
      }
      return card;
    }

    // What one injected block is, for its line in a System group.
    function systemBlockName(event) {
      if (event.block && event.block.title) return event.block.title;
      var text = String(event.text || '').trim();
      var tag = text.match(/^<([\w-]+)/);
      if (tag) return tag[1].replace(/[_-]+/g, ' ');
      if (/^# AGENTS\.md instructions/.test(text)) return 'AGENTS.md';
      return event.kind === 'agent' ? 'developer text' : 'context';
    }
    // The injected row model of one System step: typed by the adapter's `block`, else by its text.
    function systemBlockRow(event) {
      var text = String(event.text || '');
      var block = event.block || {};
      var type = block.type || (/^\s*# AGENTS\.md instructions/.test(text) ? 'agents-md' : /^\s*<task-notification/.test(text) ? 'task-notification' : event.kind === 'agent' ? 'developer' : 'other');
      if (type === 'task-notification') return taskNotificationRow(text);
      var format = type === 'agents-md' || type === 'claude-md' || type === 'skill' ? 'markdown' : '';
      if (!format && /^\s*<[a-z][\w-]*>/.test(text) && parseSections(text)) format = 'sections';
      // A generic title (Developer, Context, Injected content) says nothing: the block's own first line does.
      var title = block.title || systemBlockName(event);
      if (/^(Developer|Context|Injected content|developer text|context)$/.test(title)) title = firstLine(text.replace(/^\s*<[^>\n]*>\s*/, ''), 110) || title;
      return { type: type, title: title, body: text, format: format };
    }

    // A run of injected context and hook text: one quiet collapsed row, one injected row per block inside.
    function createSystemGroup(group, key) {
      var details = document.createElement('details');
      details.className = 'quiet actor-system';
      details.dataset.key = key;
      var names = [];
      group.steps.forEach(function (step) {
        var name = systemBlockName(step);
        if (names.indexOf(name) === -1) names.push(name);
      });
      var count = group.steps.length;
      var summary = summaryRow('System', (count === 1 ? '1 injected block' : count + ' injected blocks') + ' · ' + names.join(', '), group.steps[0].ts);
      summary.insertBefore(actorAvatar('system', true), summary.children[1]);
      details.appendChild(summary);
      lazyDetails(details, function () {
        var list = document.createElement('div');
        list.className = 'quiet-list';
        group.steps.forEach(function (step, index) { list.appendChild(renderInjectedRow(systemBlockRow(step), { key: key + '|inj' + index }, document)); });
        return list;
      });
      return details;
    }

    // A thinking group collapses to one row; expanding shows each step, Markdown rendered with code kept quiet.
    // `key` comes from assignEventKeys (technicalEventKey is not collision-safe on its own).
    function createThinkGroupEvent(event, key) {
      var details = document.createElement('details');
      details.className = 'event technical thinkgroup';
      details.dataset.key = key || technicalEventKey(event);
      var summary = summaryRow('', '', event.ts);
      summary.replaceChild(textSpan('step-kind', 'Thinking'), summary.children[1]);
      summary.replaceChild(textSpan('sum-text', event.steps.length + (event.steps.length === 1 ? ' step' : ' steps') + ' · ' + firstLine(event.text, 140)), summary.children[2]);
      details.appendChild(summary);
      lazyDetails(details, function () {
        var frag = document.createDocumentFragment();
        event.steps.forEach(function (step, index) {
          var stepEl = document.createElement('div');
          stepEl.className = 'thinkgroup-step';
          var stepTime = document.createElement('div');
          stepTime.className = 'thinkgroup-step-time';
          stepTime.textContent = eventTime(step.ts);
          var stepBody = document.createElement('div');
          stepBody.className = 'event-body';
          stepBody.appendChild(renderMarkdown(step.text || '', document, { quiet: true, key: details.dataset.key + '|' + index }));
          if (step.truncated) stepBody.appendChild(cutNote(document, step.truncated));
          stepEl.append(stepTime, stepBody);
          frag.appendChild(stepEl);
        });
        return frag;
      });
      return details;
    }

    // A Codex CommandExecution carries its output inside `detail`, after the command and an "exit N" line.
    function codexCommandOutput(event) {
      var detail = String(event.detail || ''), text = String(event.text || '');
      if (!detail) return undefined;
      if (detail.indexOf(text) === 0) detail = detail.slice(text.length).replace(/^\n\nexit -?\d+/, '').replace(/^\n/, '');
      return detail;
    }
    function stepTarget(event) {
      if (event.tool && event.tool.target) return String(event.tool.target);
      return String(event.text || '');
    }
    // The summary text of a work row: the files of a patch, the target of a tool, the first line of a command.
    function stepTextSpan(row) {
      var event = row.item;
      var span = textSpan('step-text', '');
      if (event.kind === 'patch' && event.files && event.files.length) {
        span.classList.add('step-files');
        event.files.forEach(function (f, i) {
          if (i) span.appendChild(document.createTextNode(', '));
          var name = String(f.path || '').match(/[^\\/]+$/);
          var b = document.createElement('b');
          b.textContent = name ? name[0] : String(f.path || '');
          b.title = String(f.path || '');
          span.appendChild(b);
          if (f.added != null || f.removed != null) span.appendChild(textSpan('n', ' +' + (f.added || 0) + ' −' + (f.removed || 0)));
        });
      } else if (event.kind === 'tool' && event.tool && event.tool.target && /[\\/]/.test(event.tool.target) && !/\s/.test(event.tool.target)) {
        var m = String(event.tool.target).match(/^(.*[\\/])([^\\/]+)$/);
        if (m) { span.append(textSpan('dir', m[1]), document.createTextNode(m[2])); } else span.textContent = event.tool.target;
      } else if (event.kind === 'tool' && event.tool && !event.tool.target && event.tool.input && Object.keys(event.tool.input).length) {
        span.textContent = rawFirstLine(JSON.stringify(event.tool.input), 200);
      } else span.textContent = rawFirstLine(event.kind === 'tool' ? stepTarget(event) : event.text, 200);
      if (event.kind === 'out' && event.resultOf) span.classList.add('prose');
      return span;
    }
    function outputSection(parent, out, opts, label) {
      var head = document.createElement('div');
      head.className = 'out-label';
      head.textContent = label || 'Output';
      parent.appendChild(head);
      var text = String(out.text || '');
      if (text) parent.appendChild(renderOutput(text, out.format, { key: opts.key, truncated: out.truncated }));
      if (out.media) out.media.forEach(function (item) { parent.appendChild(renderImage(item, document)); });
    }
    // A tool result: a line-numbered file dump ("1: text", "     1→text") stays an output box, whatever the file
    // holds; a Markdown result (a subagent hand-back) reads as Markdown inside a capped box of its own.
    function renderOutput(text, format, opts) {
      var lines = text.split('\n'), numbered = 0;
      for (var i = 0; i < lines.length; i++) if (/^\s*\d+(?:[:→]|\t)/.test(lines[i])) numbered++;
      if (!format && lines.length > 2 && numbered > lines.length / 2) format = 'plain';
      format = detectFormat(text, format);
      var node = renderContent(text, format, { key: opts.key, pre: true, truncated: opts.truncated }, document);
      if (format !== 'markdown' && format !== 'sections') return node;
      var box = document.createElement('div');
      box.className = 'out md';
      box.appendChild(node);
      return box;
    }
    // The body of a work row: command view, diff view, JSON view of a tool input, then its outputs.
    function stepBody(row, renderKey) {
      var event = row.item;
      var body = document.createElement('div');
      body.className = 'step-body';
      var opts = { key: (renderKey ? renderKey + '|' : '') + row.key };
      var outputs = row.outputs.length ? row.outputs : row.waitOutputs.slice(-1);
      if (event.kind === 'cmd') {
        // Claude: the paired tool_result; Codex: the output inside detail (the last wait poll only when that is empty).
        var output = row.outputs.length ? row.outputs.map(function (o) { return o.text; }).join('\n') : codexCommandOutput(event);
        if (!output && row.waitOutputs.length) output = row.waitOutputs[row.waitOutputs.length - 1].text;
        var truncated = event.truncated || (outputs.length ? outputs[outputs.length - 1].truncated : undefined);
        body.appendChild(renderCommand({ command: event.text, exit: row.exit, output: output, truncated: truncated, pending: !event.done && !outputs.length }, opts, document));
        outputs.forEach(function (o) { if (o.media) o.media.forEach(function (item) { body.appendChild(renderImage(item, document)); }); });
        return body;
      }
      if (event.kind === 'patch') {
        if (event.diff) body.appendChild(renderDiff(event.diff, { key: opts.key, truncated: event.truncated }, document));
        else body.appendChild(renderContent(event.detail || event.text || '', event.format, { key: opts.key, pre: true, truncated: event.truncated }, document));
        outputs.forEach(function (o, index) { outputSection(body, o, { key: opts.key + '|output|' + index }, 'Result'); });
        return body;
      }
      if (event.kind === 'tool') {
        if (event.tool && event.tool.input && typeof event.tool.input === 'object' && Object.keys(event.tool.input).length) {
          body.appendChild(renderJson(event.tool.input, { key: opts.key + '|input', title: event.tool.name || 'Input', truncated: event.truncated }, document));
        } else if (event.detail || event.text) {
          body.appendChild(renderContent(event.detail || event.text, event.format, { key: opts.key + '|detail', pre: true, truncated: event.truncated }, document));
        }
        if (event.detail && event.tool && event.tool.input && Object.keys(event.tool.input).length && event.detail !== event.text) {
          outputSection(body, { text: event.detail, format: event.format, truncated: event.truncated }, { key: opts.key + '|detail' }, 'Output');
        }
        outputs.forEach(function (o, index) { outputSection(body, o, { key: opts.key + '|output|' + index }); });
        return body;
      }
      // An output on its own (no call to sit under), or any other step.
      var text = event.detail || event.text || '';
      if (text) body.appendChild(renderOutput(text, event.format, { key: opts.key, truncated: event.truncated }));
      if (event.media) event.media.forEach(function (item) { body.appendChild(renderImage(item, document)); });
      return body;
    }

    // One work step (command, patch, tool call, lone output): a collapsed row; the body is built on first open.
    function createEvent(row, renderKey) {
      if (!row.item) row = { item: row, key: renderKey, outputs: [], waits: 0, waitIds: {}, waitOutputs: [], exit: row.exit };
      var event = row.item;
      if (event.kind === 'thinkgroup') return createThinkGroupEvent(event, (renderKey ? renderKey + '|' : '') + row.key);
      var details = document.createElement('details');
      details.className = 'event technical ' + event.kind + (stepFailed(row.exit) ? ' failed' : '');
      details.dataset.key = row.key || technicalEventKey(event);
      var label = event.kind === 'tool' && event.tool && event.tool.name ? event.tool.name : ({ cmd: 'Command', out: 'Output', patch: 'Patch', tool: 'Tool' })[event.kind] || 'Step';
      var summary = summaryRow('', '', event.ts);
      summary.replaceChild(textSpan('step-kind', label), summary.children[1]);
      summary.replaceChild(stepTextSpan(row), summary.children[2]);
      if (row.waits) summary.insertBefore(textSpan('step-count', 'waited ' + row.waits + (row.waits === 1 ? ' time' : ' times')), summary.lastChild);
      var badge = exitBadge(document, row.exit);
      if (badge) { badge.classList.add('step-badge'); summary.insertBefore(badge, summary.lastChild); }
      details.appendChild(summary);
      lazyDetails(details, function () { return stepBody(row, renderKey); });
      return details;
    }

    // Consecutive work: one collapsed activity block on the actor's rail (Codex work: teal,
    // a Claude agent's work: Claude's clay). Outputs sit under their calls.
    function createWorkBlock(block, open, actor, renderKey) {
      actor = actor || 'work';
      var details = document.createElement('details');
      details.className = 'work actor-' + actor;
      details.dataset.key = 'work|' + block.keys[0];
      details.open = !!open;
      if (open) details.dataset.autoOpen = '1'; // opened by default, not by the reader
      var last = block.items[block.items.length - 1];
      var summary = summaryRow(ACTORS[actor].name, workSummary(block.items), last.ts);
      summary.insertBefore(actorAvatar(actor, true), summary.children[1]);
      var list = document.createElement('div');
      list.className = 'work-list';
      pairWorkItems(block.items, block.keys).forEach(function (row) { list.appendChild(createEvent(row, renderKey)); });
      details.append(summary, list);
      return details;
    }
    // Turn markers: task started / complete / aborted.
    function createMarker(event) {
      var marker = document.createElement('div');
      marker.className = 'marker ' + event.kind;
      marker.title = event.text || '';
      var label = ({ done: '✓ Turn complete', err: 'Turn aborted', sys: 'Turn started' })[event.kind] || firstLine(event.text, 60);
      if (event.kind === 'sys' && !/task started/i.test(event.text || '')) label = firstLine(event.text, 60);
      if (event.kind === 'meta') {
        var parts = [event.model, event.effort].filter(Boolean);
        if (event.tokens) parts.push(compactCount(event.tokens) + ' in');
        if (event.outputTokens) parts.push(compactCount(event.outputTokens) + ' out');
        if (event.reasoningTokens) parts.push(compactCount(event.reasoningTokens) + ' reasoning');
        if (event.cost) parts.push('$' + event.cost);
        label = parts.join(' · ');
      }
      if (event.kind === 'done' && event.outcome && event.outcome !== 'succeeded') { label = 'Turn ' + event.outcome; marker.className = 'marker err'; }
      marker.textContent = label + (event.ts ? ' · ' + eventTime(event.ts) : '');
      return marker;
    }

    // The list and the Activity rail share groups. Running children stay under their
    // parent; questions and failed handoffs remain directly accessible.
    function renderFeed(preservePosition) {
      feedRenderPending = false; // this rebuild covers any batch still waiting for a frame
      var page = pageKind();
      renderResultCard();
      if (page === 'workflow') { lastHomeSignature = ''; renderClaudeBody(); return; }
      lastClaudeOverviewScope = null;
      if (page === 'ghost') { lastHomeSignature = ''; lastClaudeFeedSignature = ''; renderGhostPage(); return; }
      if (page === 'chat' || page === 'opencode') {
        lastHomeSignature = '';
        var t = transcripts.main;
        var signature = JSON.stringify(['chat', prefs.node, t.key, t.events.length, t.offset, t.revision, t.state, t.error, t.loaded, renderLimits[feedScope()]]);
        if (signature === lastClaudeFeedSignature) return;
        lastClaudeFeedSignature = signature;
        drawTranscript({
          inner: feedInner, scroller: feed, pill: jumpLatest, renderKey: feedScope(), session: page === 'opencode' ? { source: 'opencode' } : CHAT_SESSION,
          rawEvents: t.events, running: t.state === 'running', workingLabel: page === 'opencode' ? 'OpenCode is working' : 'Claude is working', error: t.events.length ? t.error : '',
          emptyTitle: t.error ? 'Transcript unavailable' : !t.loaded ? 'Loading transcript…' : 'No activity yet',
          emptyText: t.error || (t.loaded ? 'This chat has no messages yet.' : ''),
          rerender: function () { lastClaudeFeedSignature = ''; renderFeed(true); }
        }, preservePosition);
        return;
      }
      lastClaudeFeedSignature = '';
      // showOverview() covers "no task open" too, so selected is always truthy past this point.
      if (showOverview()) { renderHome(); return; }
      var row = selectedRow();
      var rawEvents = store[selected] || [];
      var lastRaw = rawEvents[rawEvents.length - 1];
      drawTranscript({
        inner: feedInner, scroller: feed, pill: jumpLatest, renderKey: feedScope(), session: currentSession(), rawEvents: rawEvents,
        // A session stays Running for 20 s after its last write; a finished turn is not "working".
        running: !!row && row.status === 'RUNNING' && !(lastRaw && lastRaw.kind === 'done'), workingLabel: 'Codex is working',
        emptyTitle: 'No activity yet', emptyText: 'Codex has not written anything to this session yet.',
        rerender: function () { renderFeed(true); }
      }, preservePosition);
    }
    // A chat that is not on this PC: its handoffs are in the tree, the main pane explains (design 8.8).
    function renderGhostPage() {
      var node = pageNode();
      var signature = 'ghost:' + prefs.node + ':' + (node ? node.children.length : 0);
      if (signature === lastClaudeFeedSignature) return;
      lastClaudeFeedSignature = signature;
      feedInner.textContent = '';
      jumpLatest.hidden = true;
      var empty = document.createElement('div');
      empty.className = 'feed-empty';
      var strong = document.createElement('strong');
      strong.textContent = 'This Claude chat is not on this PC';
      var count = node ? node.children.length : 0;
      empty.append(strong, textSpan('', 'Session ' + String(node ? node.sessionId : '').slice(0, 8) + ' has ' + count + (count === 1 ? ' handoff' : ' handoffs') +
        ' here, but no chat file under ~/.claude/projects. The chat may run on another machine (CloudCLI), or its file was cleaned up. The handoffs work as usual.'));
      feedInner.appendChild(empty);
    }

    // Grouping (thinking steps) means new events can't just be appended one at a time; a full
    // rebuild keeps counts and groups correct. It runs once per frame however many batches came,
    // and waits while the reader has text selected in the feed (the rebuild would wipe it).
    // Scroll position is unaffected: new content only lands below what is on screen.
    function requestFeedRender() {
      feedRenderPending = true;
      if (!feedRenderFrame) feedRenderFrame = requestAnimationFrame(flushFeedRender);
    }
    function flushFeedRender() {
      feedRenderFrame = 0;
      if (!feedRenderPending || feedOverview()) return;
      if (selectionInside(window.getSelection(), feedInner)) return; // selectionchange retries
      var shouldFollow = nearBottom();
      renderFeed(!shouldFollow);
      if (!shouldFollow) jumpLatest.hidden = false;
    }
