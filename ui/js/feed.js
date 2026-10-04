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

    function markdownBody(text) {
      var body = document.createElement('div');
      body.className = 'msg-body';
      body.appendChild(renderMarkdown(text, document));
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

      // Tag-only lines become headings in Claude's prompts only; a human's "<div>" stays as typed.
      var markdown = actor === 'claude' ? promptMarkdown(body) : body;
      if (body.length > LONG_MESSAGE) {
        var more = document.createElement('details');
        more.className = 'msg-more';
        more.dataset.key = key + '|full';
        var moreSummary = document.createElement('summary');
        moreSummary.textContent = stripMarkdown(body) + '  ·  show full message (' + body.split('\n').length + ' lines)';
        more.append(moreSummary, markdownBody(markdown));
        card.appendChild(more);
      } else if (body.trim()) {
        card.appendChild(markdownBody(markdown));
      }
      if (question) {
        var ask = document.createElement('div');
        ask.className = 'ask actor-' + asked.actor;
        var askTitle = document.createElement('div');
        askTitle.className = 'ask-title';
        askTitle.append(actorAvatar(asked.actor, true), document.createTextNode(asked.title));
        ask.append(askTitle, markdownBody(question));
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
      var text = String(event.text || '').trim();
      var tag = text.match(/^<([\w-]+)/);
      if (tag) return tag[1].replace(/[_-]+/g, ' ');
      if (/^# AGENTS\.md instructions/.test(text)) return 'AGENTS.md';
      return event.kind === 'agent' ? 'developer text' : 'context';
    }

    // A run of injected context and hook text: one quiet collapsed row.
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
      group.steps.forEach(function (step) {
        var item = document.createElement('div');
        item.className = 'quiet-step';
        var head = document.createElement('div');
        head.className = 'quiet-step-head';
        var name = document.createElement('b');
        name.textContent = systemBlockName(step);
        head.append(name, textSpan('', String(step.text || '').length.toLocaleString() + ' chars'), textSpan('', eventTime(step.ts)));
        var pre = document.createElement('pre');
        pre.textContent = step.text || '';
        item.append(head, pre);
        details.appendChild(item);
      });
      return details;
    }

    // A thinking group collapses to one row; expanding shows each step, Markdown rendered.
    // `key` comes from assignEventKeys (technicalEventKey is not collision-safe on its own).
    function createThinkGroupEvent(event, key) {
      var details = document.createElement('details');
      details.className = 'event technical thinkgroup';
      details.dataset.key = key || technicalEventKey(event);
      var summary = summaryRow('', '', event.ts);
      summary.replaceChild(textSpan('step-kind', 'Thinking'), summary.children[1]);
      summary.replaceChild(textSpan('sum-text', event.steps.length + (event.steps.length === 1 ? ' step' : ' steps') + ' · ' + firstLine(event.text, 140)), summary.children[2]);
      details.appendChild(summary);
      event.steps.forEach(function (step) {
        var stepEl = document.createElement('div');
        stepEl.className = 'thinkgroup-step';
        var stepTime = document.createElement('div');
        stepTime.className = 'thinkgroup-step-time';
        stepTime.textContent = eventTime(step.ts);
        var stepBody = document.createElement('div');
        stepBody.className = 'event-body';
        stepBody.appendChild(renderMarkdown(step.text || '', document));
        stepEl.append(stepTime, stepBody);
        details.appendChild(stepEl);
      });
      return details;
    }

    // One Codex work step (command, output, patch, tool call): a collapsed row, full text inside.
    function createEvent(event, key) {
      if (event.kind === 'thinkgroup') return createThinkGroupEvent(event, key);
      var details = document.createElement('details');
      details.className = 'event technical ' + event.kind;
      details.dataset.key = key || technicalEventKey(event);
      var label = ({ cmd: 'Command', out: 'Output', patch: 'Patch', tool: 'Tool' })[event.kind] || 'Step';
      var summary = summaryRow('', '', event.ts);
      summary.replaceChild(textSpan('step-kind', label), summary.children[1]);
      summary.replaceChild(textSpan('step-text', firstLine(event.text, 200)), summary.children[2]);
      var pre = document.createElement('pre');
      pre.textContent = event.detail || event.text || '';
      details.append(summary, pre);
      return details;
    }

    // Consecutive work: one collapsed activity block on the actor's rail (Codex work: teal,
    // a Claude agent's work: Claude's clay).
    function createWorkBlock(block, open, actor) {
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
      block.items.forEach(function (item, index) { list.appendChild(createEvent(item, block.keys[index])); });
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
