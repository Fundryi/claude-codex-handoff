'use strict';
    // -- Pages (design 8). prefs.node is the open node and decides the main pane; an open Claude agent
    // (prefs.panel) shows in the side panel next to its chat or workflow. Codex nodes set `selected`
    // (the Codex session id), so every Codex header, feed, result card and menu works as before.
    var CHAT_SESSION = { source: 'chat' };   // the pseudo-session the feed code sees for a chat transcript
    var AGENT_SESSION = { source: 'agent' }; // and for a plain subagent's transcript
    function pageNode() { return prefs.node ? currentModel().nodes[prefs.node] || null : null; }
    function panelNode() { return prefs.panel ? currentModel().nodes[prefs.panel] || null : null; }
    function pageKind() {
      if (prefs.home || !prefs.node) return 'overview';
      var kind = String(prefs.node).split(':')[0];
      if (kind === 'handoff' || kind === 'codex' || kind === 'codexagent') return selected ? 'codex' : 'overview';
      return kind === 'chat' || kind === 'opencode' || kind === 'workflow' || kind === 'ghost' ? kind : 'overview';
    }
    function claudeRunId() { var n = pageNode(); return n && n.kind === 'workflow' ? n.runId : null; }
    function panelAgentId() {
      var p = panelNode();
      if (!p || !p.agent) return null;
      return p.kind === 'wfagent' ? p.agent.id : String(p.id).replace(/^agent:/, '');
    }

    function selectNode(id, byUser) {
      var model = currentModel();
      var node = model.nodes[id];
      // A handoff with no session has no page: load its session by thread first, else its job dialog.
      if (node && node.kind !== 'opencode' && node.row && !node.row.session) {
        if (byUser && node.row.job) { if (node.row.job.threadId) openOldHandoff(id, node.row.job); else openJob(node.row.job); }
        return;
      }
      if (byUser) { prefs.autoFollow = false; prefs.home = false; }
      if (node && (node.kind === 'agent' || node.kind === 'wfagent')) {
        // The agent opens in the side panel; its nearest chat or workflow shows in the main pane.
        var host = nodeChain(model, id).filter(function (n) { return n.kind !== 'agent' && n.kind !== 'wfagent' && n.kind !== 'wfgroup'; }).pop();
        prefs.panel = id;
        if (host) prefs.node = host.id;
      } else {
        prefs.node = id;
        prefs.panel = null;
      }
      var page = model.nodes[prefs.node];
      if (page && page.row) {
        if (page.row.session) { selected = page.row.session.id; unread.delete(selected); unread.delete(page.row.id); }
        else { selected = null; if (page.kind !== 'opencode' && byUser && page.row.job) openJob(page.row.job); }
      } else if (pageKind() !== 'codex') selected = null;
      prefs.selected = selected;
      treeScrollPending = true;
      processPanel.hidden = true;
      closeActionMenu();
      savePrefs();
      applyPrefs();
      syncTranscripts();
      queueViewerRender({ tree: true, feed: true, panel: true });
      if (window.innerWidth <= 760) document.body.classList.remove('mobile-side-open');
    }
    // A Codex session id (auto-open, a loaded History session): the node that draws it.
    function selectSession(id, byUser) {
      var model = currentModel();
      var hit = Object.keys(model.nodes).find(function (key) { var r = model.nodes[key].row; return r && r.session && r.session.id === id; });
      if (hit) { selectNode(hit, byUser); return; }
      // Not in the tree yet (a History session that just loaded): open it by its session id.
      if (byUser) { prefs.autoFollow = false; prefs.home = false; }
      selected = id;
      prefs.selected = id;
      prefs.node = 'codex:' + id;
      prefs.panel = null;
      unread.delete(id);
      processPanel.hidden = true;
      closeActionMenu();
      savePrefs();
      applyPrefs();
      syncTranscripts();
      queueViewerRender({ tree: true, feed: true, panel: true });
      if (window.innerWidth <= 760) document.body.classList.remove('mobile-side-open');
    }
    function closePanel() {
      var id = prefs.panel;
      prefs.panel = null;
      savePrefs();
      applyPrefs();
      syncTranscripts();
      renderList();
      renderPanel();
      renderHeader();
      if (pageKind() === 'workflow') renderClaudeBody();
      var row = id && list.querySelector('.row[data-id="' + CSS.escape(id) + '"]');
      if (row) row.focus({ preventScroll: true });
    }

    // Two transcript slots (never on /events): 'main' for an open Claude or OpenCode chat, 'panel' for an open
    // Claude agent. Claude polls /claude/transcript by byte offset, so a quiet transcript costs one stat per poll;
    // OpenCode polls /opencode/transcript by seq and re-reads its last row. Each poll waits for the one before;
    // a reply for a transcript no longer open is dropped.
    var transcripts = { main: newClaudeFeed(''), panel: newClaudeFeed('') };
    var transcriptTimers = { main: 0, panel: 0 };
    function transcriptUrl(slot) {
      if (slot === 'panel') {
        var p = panelNode();
        if (!p || !p.agent) return '';
        if (p.kind === 'wfagent') return '/claude/transcript?run=' + encodeURIComponent(p.run.id) + '&agent=' + encodeURIComponent(p.agent.id);
        return '/claude/transcript?chat=' + encodeURIComponent(p.chatId) + '&agent=' + encodeURIComponent(panelAgentId());
      }
      var n = pageNode();
      if (pageKind() === 'opencode' && n && n.chat) return '/opencode/transcript?session=' + encodeURIComponent(n.chat.sessionId);
      return pageKind() === 'chat' && n && n.chat ? '/claude/transcript?chat=' + encodeURIComponent(n.chat.sessionId) : '';
    }
    function syncTranscripts() {
      ['main', 'panel'].forEach(function (slot) {
        var want = transcriptUrl(slot);
        if (want !== transcripts[slot].key) {
          window.clearTimeout(transcriptTimers[slot]);
          transcriptTimers[slot] = 0;
          transcripts[slot] = newClaudeFeed(want);
        }
        var state = transcripts[slot];
        if (want && !state.busy && !transcriptTimers[slot] && !state.stopped) pollTranscript(slot);
      });
    }
    async function pollTranscript(slot) {
      transcriptTimers[slot] = 0;
      var state = transcripts[slot];
      if (!state.key || state.key !== transcriptUrl(slot)) return;
      state.busy = true;
      try {
        var response = await fetch(state.key + (state.loaded ? '&offset=' + state.offset : ''), { cache: 'no-store' });
        if (response.status === 403) { state.error = 'Transcripts are refused at this address. Open the viewer on the PC itself or through the tunnel link. If a proxy serves it, add this name to CODEX_VIEWER_ALLOWED_HOSTS.'; state.stopped = true; }
        else if (response.status === 404) { state.error = 'This transcript is not on this PC any more.'; state.stopped = true; }
        else if (response.ok) {
          var data = await response.json();
          state.error = '';
          state.loaded = true;
          if (state.key.indexOf('/opencode/') === 0) {
            var pageSig = JSON.stringify(data.events || []);
            if (pageSig !== state.pageSig) { state.pageSig = pageSig; state.revision = (state.revision || 0) + 1; }
            if (data.replaceFrom != null) state.events = state.events.filter(function (event) { return event.seq < data.replaceFrom; });
          }
          if (data.events && data.events.length) {
            state.events.push.apply(state.events, data.events);
            if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
          }
          state.offset = data.offset || 0;
          state.tool = data.tool || '';
          state.contextTokens = data.contextTokens || 0;
          state.model = data.model || '';
          state.effort = data.effort || '';
          state.state = data.state || '';
        }
      } catch (_) {} // a network hiccup: the next poll tries again
      state.busy = false;
      if (state !== transcripts[slot]) return; // the reader moved on
      state.loaded = state.loaded || !!state.error;
      // A finished agent or chat can go on later (a new message, SendMessage): keep a slow poll.
      if (!state.stopped && state.key === transcriptUrl(slot)) {
        transcriptTimers[slot] = window.setTimeout(function () { pollTranscript(slot); }, data && data.more ? 0 : state.state === 'running' ? 1500 : 4000);
      }
      queueViewerRender({ header: true, result: slot === 'main', openFeed: slot === 'main', panel: slot === 'panel' });
    }

    // One transcript into one target: { inner, scroller, pill, renderKey, session, rawEvents, running,
    // workingLabel, emptyTitle, emptyText, error, rerender }. The Codex feed, a chat and the side panel use it.
    function drawTranscript(target, preservePosition) {
      var inner = target.inner;
      var renderKey = target.renderKey;
      var limit = renderLimits[renderKey] || 160;
      // Keyboard focus on a row survives the rebuild: same data-key, new element.
      var focusHost = inner.contains(document.activeElement) ? document.activeElement.closest('[data-key]') : null;
      var focusKey = focusHost ? focusHost.dataset.key : null;
      inner.textContent = '';
      var session = target.session;
      var rawEvents = target.rawEvents || [];
      var allEvents = groupFeed(rawEvents, session);
      // Keyed off the full, unpaged list so a row's key doesn't shift as "Show earlier activity" changes the slice.
      var allKeys = assignEventKeys(allEvents);
      var hiddenCount = Math.max(0, allEvents.length - limit);
      var events = hiddenCount ? allEvents.slice(hiddenCount) : allEvents;
      var keys = hiddenCount ? allKeys.slice(hiddenCount) : allKeys;
      if (!allEvents.length) {
        var empty = document.createElement('div');
        empty.className = 'feed-empty';
        var strong = document.createElement('strong');
        strong.textContent = target.emptyTitle;
        empty.append(strong, textSpan('', target.emptyText || ''));
        inner.appendChild(empty);
      } else {
        var fragment = document.createDocumentFragment();
        if (hiddenCount) {
          var earlier = document.createElement('button');
          earlier.type = 'button';
          earlier.className = 'load-earlier';
          earlier.textContent = 'Show earlier activity (' + hiddenCount + ' hidden)';
          earlier.addEventListener('click', function () {
            var scroller = target.scroller;
            var oldHeight = scroller.scrollHeight;
            var oldTop = scroller.scrollTop;
            renderLimits[renderKey] = limit + 100;
            target.rerender();
            requestAnimationFrame(function () { scroller.scrollTop = oldTop + (scroller.scrollHeight - oldHeight); });
          });
          fragment.appendChild(earlier);
        }
        // Consecutive work folds into one activity block; everything else stands alone.
        var blocks = [];
        events.forEach(function (event, idx) {
          var actor = messageActor(event, session);
          var isWork = actor === 'work' || actor === 'claude-work' || actor === 'chat-work' || actor === 'subagent-work' || actor === 'opencode-work';
          var last = blocks[blocks.length - 1];
          if (isWork && last && last.work) { last.items.push(event); last.keys.push(keys[idx]); return; }
          blocks.push(isWork ? { work: true, actor: actor, items: [event], keys: [keys[idx]] } : { event: event, key: keys[idx], actor: actor });
        });
        blocks.forEach(function (block, index) {
          // The block being worked on right now starts open; older ones start collapsed.
          if (block.work) fragment.appendChild(createWorkBlock(block, target.running && index === blocks.length - 1, block.actor, renderKey));
          else if (block.actor === 'system') fragment.appendChild(createSystemGroup(block.event, renderKey + '|' + block.key));
          else if (block.actor === 'status') fragment.appendChild(createMarker(block.event));
          else fragment.appendChild(createMessage(block.event, block.actor, renderKey + '|' + block.key, session));
        });
        if (target.running) {
          var working = document.createElement('div');
          working.className = 'working';
          working.setAttribute('role', 'status');
          working.append(textSpan('working-label', target.workingLabel), textSpan('working-text', '· ' + workingLine(rawEvents)));
          fragment.appendChild(working);
        }
        if (target.error) fragment.appendChild(textDiv('feed-empty', target.error));
        inner.appendChild(fragment);
      }
      inner.querySelectorAll('details[data-key]').forEach(function (d) {
        var choice = feedOpenChoices[renderKey + '|' + d.dataset.key];
        if (choice !== undefined) d.open = choice;
        // A lazy body (work step, System row, long message) is built now, so the restored row keeps its height
        // before the scroll position is read; the toggle event would build it a frame later.
        if (d.open && d._build) d._build();
        if (d.dataset.key === focusKey) d.querySelector('summary').focus({ preventScroll: true });
      });
      if (!preservePosition) requestAnimationFrame(function () { target.scroller.scrollTop = target.scroller.scrollHeight; if (target.pill) target.pill.hidden = true; });
      if (target.pill) target.pill.hidden = true;
    }

    // Pixel grid for scrolled lists: every row and mark is laid out on a 4 px grid, and a scroll offset that is not a multiple
    // of 4 would put every mark between device pixels at DPR 1.25 / 1.5 / 1.75. When a scroll ends (wheel, drag, keyboard or
    // scrollIntoView), the offset settles on the nearest multiple of 4: at most 2 px, after the motion, so nothing jumps while scrolling.
    function snapScrollToGrid(el, pinEnd) {
      if (!el || !('onscrollend' in el)) return;
      el.addEventListener('scrollend', function () {
        var max = el.scrollHeight - el.clientHeight;
        if (pinEnd && el.scrollTop >= max - 1) return; // the feed pinned to its latest line stays pinned
        var snapped = Math.min(max - (max % 4), Math.round(el.scrollTop / 4) * 4); // at the end the last few px of air stay out of view
        if (snapped !== el.scrollTop) el.scrollTop = snapped;
      });
    }
    // The side panel: an open Claude agent's head and transcript (design 8.6).
    var panelHead = document.getElementById('panel-head');
    var panelBody = document.getElementById('panel-body');
    var lastPanelSignature = '';
    // A wide-screen page has a slim Activity rail. An open agent takes this slot.
    var WIDE_OFF = /[?&]wide=0(?:&|$)/.test(location.search);
    function isWide() { return !WIDE_OFF && window.innerWidth >= 2200; }
    function panelDocked() { return !prefs.panel && isWide() && !showOverview(); }
    function renderPanel() {
      var docked = panelDocked();
      var open = !!prefs.panel || docked;
      document.body.classList.toggle('panel-open', open);
      document.body.classList.toggle('activity-open', docked);
      if (!open) { lastPanelSignature = ''; return; }
      if (docked) {
        renderActivity();
        return;
      }
      var p = panelNode();
      var t = transcripts.panel;
      var signature = JSON.stringify([prefs.panel, p ? [p.state, p.title, p.model, p.effort, p.tool, p.usage, Math.floor((p.updatedMs || 0) / 10000)] : null,
        t.key, t.events.length, t.offset, t.state, t.error, t.loaded, t.tool, t.contextTokens, renderLimits['panel:' + prefs.panel]]);
      if (signature === lastPanelSignature) return;
      lastPanelSignature = signature;
      renderPanelHead(p, t);
      var follow = panelBody.scrollHeight - panelBody.scrollTop - panelBody.clientHeight < 90;
      drawTranscript({
        inner: panelInner, scroller: panelBody, pill: null, renderKey: 'panel:' + prefs.panel,
        session: p && p.kind === 'wfagent' ? CLAUDE_SESSION : AGENT_SESSION, rawEvents: t.events, running: t.state === 'running',
        workingLabel: 'Claude agent is working', error: t.events.length ? t.error : '',
        emptyTitle: t.error ? 'Transcript unavailable' : !t.loaded ? 'Loading transcript…' : 'No activity yet',
        emptyText: t.error || (t.loaded ? 'This Claude agent has not written anything yet.' : ''),
        rerender: function () { lastPanelSignature = ''; renderPanel(); }
      }, !follow);
    }
    function renderPanelHead(p, t) {
      panelHead.textContent = '';
      var host = pageNode();
      var back = document.createElement('button');
      back.type = 'button';
      back.id = 'back';
      back.textContent = '‹ Back to ' + (host && host.kind === 'workflow' ? 'run' : 'chat');
      back.addEventListener('click', closePanel);
      var copy = document.createElement('div');
      copy.style.minWidth = '0';
      copy.style.flex = '1';
      var top = document.createElement('div');
      top.className = 'row-top';
      if (p) {
        top.append(nodeMark(p), nodeKindLabel(p));
        if (p.flags.indexOf('background') !== -1) top.appendChild(textSpan('flag', 'background'));
      }
      var title = textSpan('t', p ? p.title : String(prefs.panel || ''));
      title.title = title.textContent;
      top.appendChild(title);
      if (p) { var pword = textSpan('state-word ' + nodeBadge(p.state), nodeStateLabel(p.state).toLowerCase()); pword.title = nodeStateHelp(p); top.appendChild(pword); }
      var meta = document.createElement('div');
      meta.className = 'm';
      function item(text, tip, mono) { var s = textSpan(mono ? 'mono' : '', text); if (tip) s.title = tip; meta.appendChild(s); }
      if (p && p.kind === 'wfagent' && p.phase) item(p.phase, 'Phase');
      else if (p && p.agent && p.agent.agentType) item(p.agent.agentType, 'Agent type');
      var model = (p && p.model) || t.model, effort = (p && p.effort) || t.effort;
      if (model || effort) item([modelShortName(model), effort ? 'effort ' + effort : ''].filter(Boolean).join(' · '), [model, effort].filter(Boolean).join(', '));
      if (panelAgentId()) item('agent ' + panelAgentId(), 'Agent ID', true);
      if (p && p.updatedMs) item('last write ' + relativeTime(p.updatedMs), 'Last write to its transcript');
      if (t.state === 'running' && t.tool) item(t.tool, 'Tool it is running now', true);
      if (t.contextTokens) item('context ' + compactCount(t.contextTokens), t.contextTokens.toLocaleString() + ' tokens in its context');
      var total = p && p.usage && p.usage.total;
      if (total != null) item('total ' + boundText(p.usage.partial, total) + (p.usage.output ? ' · ↓ ' + compactCount(p.usage.output) : ''), 'Input (cached included) plus output, every call; ↓ output tokens');
      copy.append(top, meta);
      var close = document.createElement('button');
      close.type = 'button';
      close.id = 'panel-close';
      close.className = 'icon-button';
      close.title = 'Close the transcript (Esc)';
      close.setAttribute('aria-label', 'Close the agent transcript');
      close.textContent = '×';
      close.addEventListener('click', closePanel);
      panelHead.append(back, copy, close);
    }

    function newClaudeFeed(key) {
      return { key: key, events: [], offset: 0, tool: '', contextTokens: 0, state: '', error: '', loaded: false, busy: false, final: false, stopped: false, revision: 0 };
    }
