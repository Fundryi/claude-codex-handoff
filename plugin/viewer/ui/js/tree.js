'use strict';
    // -- The sidebar tree (design 5). Groups by project, roots, children with rails, folds and the cap row.
    var KIND_INFO = {
      opencode: { label: 'OpenCode chat', word: 'OpenCode chat', k: 'opencode', shape: 'fill', glyph: 'opencode' },
      chat: { label: 'Claude chat', word: 'Claude chat', k: 'claude', shape: 'fill', glyph: 'claude' },
      agent: { label: 'Claude agent', word: 'Claude agent', k: 'claude', shape: 'ring', glyph: 'claude' },
      workflow: { label: 'Workflow', word: 'workflow', k: 'claude', shape: 'fill', glyph: 'flow', kindGlyph: 'flow' },
      wfgroup: { label: 'Workflow topic', word: 'topic', k: 'claude', shape: 'ring', glyph: 'flow', kindGlyph: 'flow' },
      wfagent: { label: 'Workflow agent', word: 'workflow agent', k: 'claude', shape: 'ring', glyph: 'flow', kindGlyph: 'flow' },
      handoff: { label: 'Handoff', word: 'handoff', k: 'codex', shape: 'fill', glyph: 'codex', starter: 'claude' },
      codexagent: { label: 'Codex agent', word: 'Codex agent', k: 'codex', shape: 'ring', glyph: 'codex' },
      codex: { label: 'Codex CLI', word: 'Codex CLI run', k: 'codex', shape: 'fill', glyph: 'codex' },
      ghost: { label: 'Not on this PC', word: 'chat', k: 'system', shape: 'ghost', glyph: 'ghost', kindGlyph: 'ghost' }
    };
    var SOURCE_NAMES = { 'claude-vscode': 'VS Code', cli: 'Terminal', 'claude-desktop': 'Desktop', 'sdk-ts': 'SDK', 'sdk-py': 'SDK', 'sdk-cli': 'SDK' };
    var PROJECT_COLORS = ['var(--p1)', 'var(--p2)', 'var(--p3)', 'var(--p4)', 'var(--p5)'];
    var URGENT_STATES = { ANSWER: 1, ATTENTION: 1, RUNNING: 1, BACKGROUND: 1, WAITING: 1 };
    var lastTreeSignature = '';

    function nodeBadge(state) { return state === 'BACKGROUND' ? 'BG' : state === 'ENDED' ? 'ENDED' : rowBadge(state); }
    function nodeStateLabel(state) {
      return state === 'BACKGROUND' ? 'Background' : state === 'ENDED' ? 'Ended' : state === 'ANSWER' ? 'Needs answer' : STATUS[rowBadge(state)].label;
    }
    // A reported failure reads Failed; every other ATTENTION node keeps the Stuck label.
    function nodeWord(node) { return node.failed ? 'Failed' : nodeStateLabel(node.state); }
    function nodeStateHelp(node) {
      if (node.kind === 'opencode') return node.chat.state === 'ended' ? 'Finished: no end record was found for it.'
        : node.chat.state === 'running' ? 'OpenCode updated this session in the last 5 minutes.' : 'OpenCode reported ' + (node.chat.outcome || 'stopped') + '.';
      if (node.state === 'BACKGROUND') return 'The turn is done, and work it started still runs.';
      if (node.state === 'ENDED') return 'Finished: no end record was found for it.';
      if (node.kind === 'chat' && node.state === 'ANSWER') return 'Claude is waiting for you (a question or a dialog).';
      if (node.agent && node.agent.reason) return claudeAgentView('failed').help + ' Its last words: ' + node.agent.reason;
      if (node.failed) return claudeStatusView('FAILED').help;
      if (node.row) return rowReason(node.row) || STATUS[rowBadge(node.state)].help;
      return STATUS[rowBadge(node.state)] ? STATUS[rowBadge(node.state)].help : '';
    }
    function nodePill(node) {
      var badge = nodeBadge(node.state);
      return statusChip(badge === 'ENDED' ? 'STOPPED' : badge, nodeWord(node), nodeStateHelp(node));
    }
    function nodeMark(node) {
      var info = KIND_INFO[node.kind] || KIND_INFO.chat;
      var shape = node.kind === 'opencode' && node.chat && node.chat.parentId ? 'ring' : info.shape;
      return markElement(shape, info.k, info.glyph, info.label + ' · ' + nodeWord(node), nodeBadge(node.state));
    }
    function nodeKindLabel(node) {
      var info = KIND_INFO[node.kind] || KIND_INFO.chat;
      if (node.row && node.row.job && node.row.job.engine === 'opencode') info = { label: 'OpenCode task', k: 'opencode', kindGlyph: 'opencode' };
      var label = kindLabel(info.label, info.k, { title: info.starter ? 'Started by Claude, runs under Codex' : info.label, starter: info.starter, glyph: info.kindGlyph });
      if (node.kind !== 'codex') return label;
      var wrap = document.createDocumentFragment();
      wrap.append(label, textSpan('you-tag', 'you'));
      return wrap;
    }
    // A lower bound of 0 only means the backfill has not reached it yet.
    function boundText(partial, total) {
      if (partial && !total) return 'counting…';
      return (partial ? '≥ ' : '') + compactCount(total);
    }
    function nodeTokens(node) {
      if (!node.usage || node.usage.total == null) return null;
      return boundText(node.usage.partial, node.usage.total);
    }
    // The ancestors of a node, root first.
    function nodeChain(model, id) {
      var chain = [];
      for (var n = model.nodes[id], guard = 0; n && guard < 12; n = n.parentId ? model.nodes[n.parentId] : null, guard++) chain.unshift(n);
      return chain;
    }
    function nodeRoot(model, id) { return nodeChain(model, id)[0] || null; }
    // Words for a child's sub-line, in the design's order: state words, flags, then phase or phases.
    function nodeFlagWords(node) {
      var words = [];
      if (node.state === 'ANSWER') words.push(['needs answer', node.kind === 'chat' ? 'Claude waits for you.' : 'Codex asked a question. Answer it in the main pane.', 'ask']);
      if (node.state === 'ATTENTION') words.push([node.failed ? 'failed' : 'stuck', nodeStateHelp(node), 'ask']);
      if (node.state === 'STOPPED') words.push(['stopped', nodeStateHelp(node), 'st']);
      if (node.state === 'WAITING') words.push(['waiting', nodeStateHelp(node), 'st']);
      if (node.state === 'ENDED') words.push(['ended', nodeStateHelp(node), 'st']);
      if (node.fast) words.push(['fast', 'Fast mode: the priority service tier', 'fast']);
      var tips = {
        background: 'Runs in the background. Claude continues without waiting.',
        'agent not known': 'Only the chat is known. The exact agent that started it was not found.',
        'job pruned': 'The job file was pruned (the companion keeps 50 per project). The Codex session still exists.',
        'no job yet': 'A Codex handoff agent whose job has not started yet.',
        'parent agent not found': 'Its parent agent was not found, so it sits under the chat.',
        'parent thread not loaded': 'Its parent Codex thread is not loaded.',
        'started by Claude, chat unknown': 'Started by Claude, but no chat on this PC matches it.',
        'chat not in Live': 'Its Claude chat is older than the Live window.'
      };
      node.flags.forEach(function (flag) {
        var tip = tips[flag] || (flag.charAt(0) === '→' ? 'Runs in another project (--cwd): ' + (node.project || '') : /runs$/.test(flag) ? 'Runs on this Codex thread' : flag);
        words.push([flag, tip, '']);
      });
      return words;
    }
    function nodeMetaParts(node) {
      var parts = [];
      if (node.model) parts.push(modelShortName(node.model) || node.model);
      if (node.effort) parts.push(node.effort);
      var tokens = nodeTokens(node);
      if (tokens !== '0') parts.push(textSpan('tok', tokens || 'tokens unknown'));
      return parts;
    }
    function appendDotted(container, items) {
      items.forEach(function (item, index) {
        if (index) {
          if (typeof item !== 'string' && item.classList && item.classList.contains('tok')) item.prepend(document.createTextNode(' · '));
          else container.appendChild(document.createTextNode(' · '));
        }
        container.appendChild(typeof item === 'string' ? document.createTextNode(item) : item);
      });
    }
    function rails(ancestors, depth, last, openKids) {
      var frag = document.createDocumentFragment();
      function rail(kind, level) {
        var span = document.createElement('span');
        span.className = 'rl ' + kind;
        span.style.setProperty('--l', level);
        frag.appendChild(span);
      }
      ancestors.forEach(function (more, i) { if (more) rail('thru', i + 1); });
      if (depth > 0) rail('elbow', depth);
      if (depth > 0 && !last) rail('thru', depth);
      if (openKids) rail('stem', depth + 1);
      return frag;
    }
    function nodeUnread(node) {
      var row = node.row;
      return !!row && unread.has(row.session ? row.session.id : row.id);
    }
    function rootRowElement(model, node, isOpen) {
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'row root' + (prefs.node === node.id ? ' selected' : '') + (node.row && isDismissed(node.row.id) ? ' dismissed' : '');
      el.dataset.id = node.id;
      el.setAttribute('aria-expanded', node.children.length ? String(isOpen) : 'false');
      el.title = [node.title, node.project, node.row ? rowTooltip(node.row, Date.now()) : node.sessionId || (node.chat && node.chat.sessionId) || ''].filter(Boolean).join('\n');
      // Line 1: state mark, kind mark, title, state word, time. Line 2: kind word, source, fast, meta, flags.
      var top = document.createElement('div');
      top.className = 'row-top';
      var title = document.createElement('div');
      title.className = 'row-title';
      title.textContent = node.title;
      if (node.kind === 'ghost') title.appendChild(textSpan('mono src', ' ' + String(node.sessionId || '').slice(0, 8)));
      var word = textSpan('state-word ' + nodeBadge(node.state), nodeWord(node).toLowerCase());
      word.title = nodeStateHelp(node);
      var time = textSpan('row-time', relativeTime(node.updatedMs));
      // The root carries the dot for its whole tree, so a folded child's news still shows.
      if ((function any(n, d) { return nodeUnread(n) || (d < 8 && n.children.some(function (c) { return model.nodes[c] && any(model.nodes[c], d + 1); })); })(node, 0)) {
        var dot = textSpan('unread', '');
        dot.title = 'New activity';
        time.prepend(dot, document.createTextNode(' '));
      }
      top.append(nodeMark(node), title, word, time);
      var meta = document.createElement('div');
      meta.className = 'row-meta';
      var lead = [nodeKindLabel(node)];
      if (node.kind === 'chat' && node.source) lead.push(textSpan('src', SOURCE_NAMES[node.source] || node.source));
      if (node.fast) { var fast = textSpan('fl fast', 'fast'); fast.title = 'Fast mode: the priority service tier'; lead.push(fast); }
      if (node.kind === 'ghost') appendDotted(meta, lead.concat([node.children.length + (node.children.length === 1 ? ' handoff' : ' handoffs') + ' with this chat id']));
      else appendDotted(meta, lead.concat(nodeMetaParts(node), node.flags.length ? [node.flags.join(' · ')] : []));
      el.append(top, meta);
      // Roll-up line: the worst child state when it beats the root's own, kind counts, the tree total.
      if (node.children.length || (controlsBlocked && node.kind === 'chat')) {
        var sum = document.createElement('div');
        sum.className = 'row-sum';
        if (node.rollup !== node.state && STATE_ORDER.indexOf(node.rollup) < STATE_ORDER.indexOf(node.state)) {
          var roll = textSpan('rollup', '');
          var rollLabel = node.rollup === 'ATTENTION' && !node.hung ? 'Failed' : nodeStateLabel(node.rollup);
          roll.title = 'Most urgent work under it: ' + rollLabel;
          var word = document.createElement('i');
          word.textContent = rollLabel.toLowerCase();
          roll.append(stateDot(nodeBadge(node.rollup)), word);
          sum.appendChild(roll);
        }
        var counts = {};
        (function count(ids, depth) {
          ids.forEach(function (id) { var c = model.nodes[id]; if (!c || depth > 8) return; counts[c.kind] = (counts[c.kind] || 0) + 1; count(c.children, depth + 1); });
        })(node.children, 1);
        if (node.chat && node.chat.counts) { // exact counts from the server, also for children it did not send
          ['agent', 'workflow', 'handoff'].forEach(function (k) {
            var c = node.chat.counts[k];
            if (c) counts[k] = Math.max(counts[k] || 0, Object.keys(c).reduce(function (s, key) { return s + c[key]; }, 0));
          });
        }
        ['agent', 'workflow', 'wfagent', 'handoff', 'codexagent', 'opencode'].forEach(function (k) {
          if (!counts[k]) return;
          var cnt = textSpan('cnt', '');
          cnt.title = counts[k] + ' × ' + KIND_INFO[k].label;
          cnt.append(nodeMark({ kind: k }), document.createTextNode(String(counts[k])));
          sum.appendChild(cnt);
        });
        if (controlsBlocked && node.kind === 'chat') {
          var blocked = textSpan('flag', 'handoffs blocked');
          blocked.title = 'Controls are blocked at this address, so Codex handoffs cannot load. Open the viewer on the PC itself or through the tunnel link. If a proxy serves it, add this name to CODEX_VIEWER_ALLOWED_HOSTS.';
          sum.appendChild(blocked);
        }
        if (node.children.length) {
          var use = textSpan('use', 'Σ ' + boundText(node.tree.partial, node.tree.total));
          use.title = 'Tokens of this tree: Claude ' + compactCount(node.tree.claude) + ', Codex ' + (controlsBlocked ? 'unknown (handoffs did not load)' : compactCount(node.tree.codex)) + (node.tree.opencode != null ? ', OpenCode ' + compactCount(node.tree.opencode) : '') + (node.tree.partial ? '. A lower bound: some usage is unknown or over the read cap' : '');
          sum.appendChild(use);
        }
        el.appendChild(sum);
      }
      el.addEventListener('click', function () { treeClick(node.id); });
      el.addEventListener('contextmenu', function (event) { nodeContextMenu(event, node); });
      return el;
    }
    // The steps of a topic: "Review 1/1 › Verify 24/24", one span per step. The step with running agents is the active one
    // (running blue). A loose group is a phase bucket: its one step repeats the title, so it shows the count only.
    function stepsElement(group) {
      var el = document.createElement('span');
      el.className = 'wf-steps';
      el.title = topicTooltip(group);
      (group.steps || []).forEach(function (step, index) {
        if (index) el.appendChild(textSpan('sep', '›'));
        var span = textSpan(step.running ? 'on' : '', step.done + '/' + step.started);
        if (!group.loose) span.prepend(textSpan('n', step.title + ' '));
        el.appendChild(span);
      });
      return el;
    }
    function topicTooltip(group) {
      var head = group.title + ' · ' + (group.loose ? 'phase bucket' : 'workflow topic') + ': ' + group.done + ' done of ' + group.started +
        (group.running ? ', ' + group.running + ' running' : '') + (group.failed ? ', ' + group.failed + ' no result' : '');
      return [head].concat((group.steps || []).map(function (s) {
        return s.title + ' ' + s.done + '/' + s.started + (s.running ? ', ' + s.running + ' running' : '') + (s.failed ? ', ' + s.failed + ' no result' : '');
      })).join('\n');
    }
    function childRowElement(node, depth, last, ancestors, openKids) {
      var el = document.createElement('button');
      el.type = 'button';
      var open = prefs.node === node.id || prefs.panel === node.id;
      // Finished work (.fin) is one quiet line: title, state word, tokens, time. Active work keeps its meta line.
      var fin = node.state === 'FINISHED' || node.state === 'ENDED' || node.state === 'STOPPED';
      var topic = node.kind === 'wfgroup';
      el.className = 'row child' + (open ? ' selected' : '') + (fin ? ' fin' : '') + (topic ? ' topic' : '');
      el.dataset.id = node.id;
      el.style.setProperty('--d', depth);
      if (node.children.length) el.setAttribute('aria-expanded', String(openKids));
      el.title = topic ? topicTooltip(node.group) : [node.title, (KIND_INFO[node.kind] || {}).label, node.row ? rowTooltip(node.row, Date.now()) : ''].filter(Boolean).join('\n');
      el.appendChild(rails(ancestors, depth, last, openKids));
      var mark = nodeMark(node);
      if (topic) mark.classList.add('topic');
      el.append(mark);
      var title = textSpan('row-title', node.title);
      var word = textSpan('state-word ' + nodeBadge(node.state), nodeWord(node).toLowerCase());
      word.title = nodeStateHelp(node);
      var time = textSpan('row-time', relativeTime(node.updatedMs));
      if (nodeUnread(node)) time.prepend(textSpan('unread', ''), document.createTextNode(' '));
      el.append(title);
      if (topic) el.appendChild(stepsElement(node.group));
      el.appendChild(word);
      if (fin || topic) { var use = textSpan('row-use', nodeTokens(node) || ''); use.title = 'Tokens'; el.appendChild(use); }
      el.appendChild(time);
      var meta = document.createElement('div');
      meta.className = 'row-meta';
      // the state word sits on line 1 now; line 2 keeps the plain flags and "fast"
      var items = nodeFlagWords(node).filter(function (w) { return w[2] !== 'ask' && w[2] !== 'st'; }).map(function (w) {
        var span = textSpan('fl' + (w[2] ? ' ' + w[2] : ''), w[0]);
        span.title = w[1];
        return span;
      });
      if (node.phase) items.unshift(node.phase);
      if (node.kind === 'workflow' && node.run && node.run.phases) {
        items.push(node.run.phases.map(function (p) { return p.title + ' ' + p.done + '/' + p.started; }).join(' › '));
      }
      items = items.concat(nodeMetaParts(node));
      if (node.state === 'RUNNING' && node.tool) items.push(textSpan('mono', node.tool));
      appendDotted(meta, items);
      el.appendChild(meta);
      el.addEventListener('click', function () { treeClick(node.id); });
      el.addEventListener('contextmenu', function (event) { nodeContextMenu(event, node); });
      return el;
    }
    // Open state: an explicit choice wins; otherwise a node with urgent work under it starts open.
    function nodeOpen(node, reveal) {
      if (reveal[node.id]) return true;
      var choice = (prefs.openNodes || {})[node.id];
      if (choice !== undefined) return choice;
      return !!URGENT_STATES[node.rollup] && node.rollup !== 'WAITING';
    }
    // Folded: finished work, or (with a chip or kind on) a child that does not match. Never urgent work.
    function nodeFolded(model, node, view) {
      if (URGENT_STATES[node.rollup] && node.rollup !== 'WAITING') return false;
      if (node.kind === 'wfgroup' && view.chip === 'ALL' && !kindsFiltered(view.kinds)) return false; // a run's topics stay in sight; their agents fold
      if (view.chip !== 'ALL' || kindsFiltered(view.kinds)) {
        if (nodeMatch(model.nodes, node.id, view.chip, view.kinds)) return false;
        return true;
      }
      return node.rollup === 'FINISHED' || node.rollup === 'ENDED' || node.rollup === 'STOPPED';
    }
    function appendChildren(container, model, node, depth, ancestors, view, reveal) {
      var kids = node.children.map(function (id) { return model.nodes[id]; })
        .filter(function (k) { return k && (view.tab !== 'LIVE' || !liveHidden(k, prefs.dismissed)); }).sort(childOrder);
      var foldOpen = !!(prefs.openFolds || {})[node.id] || kids.some(function (k) { return reveal[k.id] || k.id === prefs.node || k.id === prefs.panel; });
      var folded = kids.filter(function (k) { return nodeFolded(model, k, view); });
      var shown = foldOpen ? kids : kids.filter(function (k) { return folded.indexOf(k) === -1; });
      var hidden = kids.length - shown.length;
      var cap = node.kind === 'chat' && node.hidden ? node.hidden : 0;
      shown.forEach(function (kid, index) {
        var last = index === shown.length - 1 && !hidden && !folded.length;
        var kidOpen = kid.children.length > 0 && depth < 8 && nodeOpen(kid, reveal);
        container.appendChild(childRowElement(kid, depth, last, ancestors, kidOpen));
        if (kidOpen) appendChildren(container, model, kid, depth + 1, ancestors.concat([!last]), view, reveal);
      });
      if (folded.length) {
        var fold = document.createElement('button');
        fold.type = 'button';
        fold.className = 'fold';
        fold.style.setProperty('--d', depth);
        fold.title = hidden ? 'Show the finished children' : 'Fold the finished children away';
        fold.appendChild(rails(ancestors, depth, true, false));
        fold.appendChild(textSpan('txt', hidden ? '+ ' + hidden + ' finished' : '− fold ' + folded.length + ' finished'));
        fold.addEventListener('click', function () {
          prefs.openFolds = prefs.openFolds || {};
          if (hidden) prefs.openFolds[node.id] = true; else delete prefs.openFolds[node.id];
          savePrefs();
          renderList();
        });
        container.appendChild(fold);
      }
      if (cap) {
        var row = document.createElement('div');
        row.className = 'fold cap';
        row.style.setProperty('--d', depth);
        row.title = 'The viewer loads the newest ' + 20 + ' children of a chat. The older ones are in the History tab, with their full feed.';
        var txt = textSpan('txt', cap + ' older not shown · find them in ');
        txt.appendChild(document.createElement('b')).textContent = 'History';
        row.appendChild(txt);
        container.appendChild(row);
      }
    }
    // Every ancestor of the open node (and of the open panel agent) opens, and so does any fold on the way.
    // A search opens the way to every hit too.
    function revealSet(model, query) {
      var set = {};
      [prefs.node, prefs.panel].forEach(function (id) { if (id) nodeChain(model, id).slice(0, -1).forEach(function (n) { set[n.id] = true; }); });
      if (query) Object.keys(model.nodes).forEach(function (id) {
        if (model.nodes[id].parentId && nodeSearchHit(model.nodes[id], query)) nodeChain(model, id).forEach(function (n) { set[n.id] = true; });
      });
      return set;
    }
    function currentView() { return { tab: prefs.tab, chip: prefs.chip, kinds: prefs.tab === 'LIVE' ? prefs.kinds || {} : null }; }
    function treeClick(id) {
      var model = currentModel();
      var node = model.nodes[id];
      if (!node) return;
      prefs.openNodes = prefs.openNodes || {};
      // A topic has no page of its own: a click only opens or closes it.
      if (node.kind === 'wfgroup') {
        var opening = !nodeOpen(node, {});
        prefs.openNodes[id] = opening;
        prefs.openFolds = prefs.openFolds || {};
        if (opening) prefs.openFolds[id] = true; else delete prefs.openFolds[id]; // a finished topic opens onto its agents, not onto a fold row
        savePrefs(); renderList(); return;
      }
      var reveal = revealSet(model);
      // A second click on the open, selected node folds its children away (decision 12.3).
      if ((prefs.node === id || prefs.panel === id) && node.children.length && nodeOpen(node, {})) {
        prefs.openNodes[id] = false;
        savePrefs();
        renderList();
        return;
      }
      if (node.children.length) prefs.openNodes[id] = true;
      selectNode(id, true);
    }
    // A redraw rebuilds the list, and that stops a scroll in motion (a smooth wheel step, a flick) or sends it back.
    // While the list moves, redraws wait; one redraw runs 150 ms after the last scroll event. A new selection draws at once.
    var listScrollTimer = 0, listRenderWaiting = false;
    function listScrolled() {
      clearTimeout(listScrollTimer);
      listScrollTimer = setTimeout(function () {
        listScrollTimer = 0;
        if (listRenderWaiting) { listRenderWaiting = false; renderList(); }
      }, 150);
    }
    function renderList() {
      if (listScrollTimer && !treeScrollPending) { listRenderWaiting = true; return; }
      var model = currentModel();
      var view = currentView();
      var now = Date.now();
      var query = String(prefs.query || '').trim();
      var rootIds = viewRoots(model, view, now, prefs.dismissed, query);
      var reveal = revealSet(model, query);
      var signature = JSON.stringify([dataVersion, view, query, prefs.node, prefs.panel, prefs.openNodes, prefs.openFolds, prefs.closedGroups,
        Math.floor(now / 10000), Array.from(unread), prefs.dismissed, controlsBlocked, historyResults.map(function (entry) { return entry.id; })]);
      if (signature === lastTreeSignature) return;
      lastTreeSignature = signature;
      // The open node's root folded out of this view: say so, with a way back.
      var openRoot = prefs.node ? nodeRoot(model, prefs.node) : null;
      var openHidden = !!openRoot && rootIds.indexOf(openRoot.id) === -1 && pageKind() !== 'overview';
      openElsewhere.hidden = !openHidden;
      openElsewhereTitle.textContent = openHidden ? model.nodes[prefs.node].title : '';
      openElsewhereTitle.title = openElsewhereTitle.textContent;
      var scrollTop = list.scrollTop;
      var focusHost = list.contains(document.activeElement) ? document.activeElement.closest('[data-id]') : null;
      var focusId = focusHost ? focusHost.dataset.id : null;
      var previousGroups = [], previousRoots = Object.create(null);
      if (list.matches(':hover')) {
        Array.from(list.querySelectorAll('.group')).forEach(function (group) {
          var key = group.querySelector('.group-caption').dataset.id;
          previousGroups.push(key);
          previousRoots[key] = Array.from(group.querySelectorAll('.row.root[data-id]')).map(function (row) { return row.dataset.id; });
        });
      }
      list.textContent = '';
      if (query) list.appendChild(textDiv('search-count', rootIds.length + (rootIds.length === 1 ? ' result' : ' results')));
      // Groups by project: the most recent activity first; inside, urgent roots first, then the newest.
      var groups = [], byKey = Object.create(null), ghosts = [];
      rootIds.forEach(function (id) {
        var node = model.nodes[id];
        if (node.kind === 'ghost') { ghosts.push(node); return; }
        var key = projectName(node.project) || 'No project';
        if (!byKey[key]) { byKey[key] = { key: key, roots: [], updated: 0 }; groups.push(byKey[key]); }
        byKey[key].roots.push(node);
        byKey[key].updated = Math.max(byKey[key].updated, node.updatedMs || 0);
      });
      groups.sort(function (a, b) { return b.updated - a.updated; });
      if (ghosts.length) groups.push({ key: 'Not on this PC', roots: ghosts, ghost: true });
      if (previousGroups.length) groups.sort(function (a, b) {
        var ai = previousGroups.indexOf(a.key), bi = previousGroups.indexOf(b.key);
        return (ai < 0 ? previousGroups.length : ai) - (bi < 0 ? previousGroups.length : bi);
      });
      groups.forEach(function (group, index) {
        group.roots.sort(function (a, b) {
          var ua = URGENT_STATES[a.rollup] ? STATE_ORDER.indexOf(a.rollup) : 99, ub = URGENT_STATES[b.rollup] ? STATE_ORDER.indexOf(b.rollup) : 99;
          return ua - ub || (b.updatedMs || 0) - (a.updatedMs || 0);
        });
        var previous = previousRoots[group.key];
        if (previous) group.roots.sort(function (a, b) {
          var ai = previous.indexOf(a.id), bi = previous.indexOf(b.id);
          return (ai < 0 ? previous.length : ai) - (bi < 0 ? previous.length : bi);
        });
        var closed = !!(prefs.closedGroups || {})[group.key];
        var box = document.createElement('div');
        box.className = 'group' + (group.ghost ? ' ghost' : '') + (closed ? ' closed' : '');
        if (!group.ghost) box.style.setProperty('--pc', PROJECT_COLORS[index % PROJECT_COLORS.length]);
        var caption = document.createElement('button');
        caption.type = 'button';
        caption.className = 'group-caption';
        caption.dataset.id = group.key;
        caption.setAttribute('aria-expanded', String(!closed));
        var total = 0, low = false;
        group.roots.forEach(function (r) { total += r.tree.total; low = low || r.tree.partial; });
        var use = textSpan('use', boundText(low, total));
        use.title = 'Tokens of every tree in this group';
        caption.append(textSpan('caret', '▼'), group.ghost ? markElement('ghost', 'system', 'ghost', 'Not on this PC') : folderIcon(), textSpan('nm', group.key), textSpan('n', String(group.roots.length)), use);
        caption.addEventListener('click', function () {
          prefs.closedGroups = prefs.closedGroups || {};
          if (closed) delete prefs.closedGroups[group.key]; else prefs.closedGroups[group.key] = true;
          savePrefs();
          renderList();
        });
        var rows = document.createElement('div');
        rows.className = 'rows';
        group.roots.forEach(function (root) {
          var isOpen = root.children.length > 0 && nodeOpen(root, reveal);
          rows.appendChild(rootRowElement(model, root, isOpen));
          if (isOpen) appendChildren(rows, model, root, 1, [], view, reveal);
        });
        box.append(caption, rows);
        list.appendChild(box);
      });
      if (!rootIds.length) {
        var empty = textDiv('empty-list', !seeded && !claudeChatsLoaded ? 'Loading…'
          : query ? 'Nothing matches this search.' : view.tab === 'HISTORY' ? 'No sessions match this filter.'
          : view.chip === 'RUNNING' ? 'Nothing is running right now.' : 'Nothing matches this filter.');
        if ((seeded || claudeChatsLoaded) && !query && view.tab === 'LIVE' && view.chip !== 'ALL') {
          var all = document.createElement('button');
          all.type = 'button';
          all.className = 'empty-action';
          all.textContent = 'Show everything from today';
          all.addEventListener('click', function () { chooseView('LIVE', 'ALL'); });
          empty.appendChild(all);
        }
        list.appendChild(empty);
      }
      // Older Codex sessions from the server's search (not in the live lists): click loads one.
      // Only the sessions drawn above drop out of the server's results; a tracked one that is not drawn stays findable.
      var drawn = Array.from(list.querySelectorAll('.row[data-id]')).map(function (el) {
        var n = model.nodes[el.dataset.id];
        return n && n.row && n.row.session ? n.row.session.id : '';
      });
      var history = query ? mergeHistoryResults(historyResults, drawn) : [];
      if (history.length) {
        list.appendChild(textDiv('history-caption', 'History — older sessions (' + history.length + ')'));
        history.forEach(function (entry) {
          var row = document.createElement('button');
          row.type = 'button';
          row.className = 'row root';
          row.dataset.id = 'history:' + entry.id;
          var top = document.createElement('div');
          top.className = 'row-top';
          var title = document.createElement('div');
          title.className = 'row-title';
          title.textContent = entry.title || 'Untitled Codex task';
          var word = textSpan('state-word STOPPED', entry.archived ? 'archived' : 'history');
          word.title = 'Not in the live list. Click to load this session.';
          top.append(markElement('fill', 'codex', 'codex', 'Codex · ' + word.title, 'ENDED'), title, word, textSpan('row-time', relativeTime(entry.mtimeMs)));
          var meta = document.createElement('div');
          meta.className = 'row-meta';
          meta.appendChild(document.createElement('b')).textContent = projectName(entry.cwd);
          meta.title = entry.cwd || '';
          row.append(top, title, meta);
          row.addEventListener('click', function () { openHistorySession(entry.id); });
          list.appendChild(row);
        });
      }
      list.scrollTop = scrollTop;
      if (focusId) {
        var focusNext = list.querySelector('[data-id="' + CSS.escape(focusId) + '"]');
        if (focusNext) focusNext.focus({ preventScroll: true });
      }
      var selectedEl = list.querySelector('.row.selected');
      if (selectedEl && treeScrollPending) { selectedEl.scrollIntoView({ block: 'nearest' }); treeScrollPending = false; }
      listEdges();
    }
    var treeScrollPending = true;

