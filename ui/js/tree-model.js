'use strict';
    // -- The unified tree (design 13.2.1). Kind-prefixed node ids (13.3): chat:, agent:, workflow:,
    // wfagent:, handoff:, codexagent:, codex:, ghost:. Codex nodes wrap the existing rows (buildRows),
    // so their status, menus, result card and feed stay what they were.
    // Node states use the row vocabulary plus BACKGROUND (a chat whose turn is done while a child runs)
    // and ENDED (a Claude agent with no end record).
    var STATE_ORDER = ['ANSWER', 'ATTENTION', 'RUNNING', 'BACKGROUND', 'WAITING', 'STOPPED', 'FINISHED', 'ENDED', 'ARCHIVED'];
    function claudeNodeState(kind, state) {
      var maps = {
        chat: { running: 'RUNNING', background: 'BACKGROUND', 'needs-you': 'ANSWER', done: 'FINISHED' },
        agent: { running: 'RUNNING', done: 'FINISHED', failed: 'ATTENTION', stopped: 'STOPPED', killed: 'STOPPED', ended: 'ENDED' },
        workflow: { running: 'RUNNING', quiet: 'ATTENTION', failed: 'ATTENTION', killed: 'STOPPED', done: 'FINISHED',
          RUNNING: 'RUNNING', QUIET: 'ATTENTION', FAILED: 'ATTENTION', KILLED: 'STOPPED', DONE: 'FINISHED' }
      };
      var map = kind === 'wfagent' ? maps.agent : maps[kind] || {};
      return map[state] || 'ENDED';
    }
    // The most urgent of two states (STATE_ORDER), for the roll-up.
    function worstState(a, b) {
      if (!a) return b;
      if (!b) return a;
      return STATE_ORDER.indexOf(a) <= STATE_ORDER.indexOf(b) ? a : b;
    }
    // Children: active work first, newest started on top (a row does not jump while it writes);
    // then finished work, newest finished on top.
    function childOrder(a, b) {
      if (a.order != null && b.order != null) return a.order - b.order; // a run's groups and agents: start order
      var active = { ANSWER: 1, ATTENTION: 1, RUNNING: 1, BACKGROUND: 1, WAITING: 1 };
      var ga = active[a.rollup] ? 0 : 1, gb = active[b.rollup] ? 0 : 1;
      if (ga !== gb) return ga - gb;
      return ga === 0 ? (b.startedMs || 0) - (a.startedMs || 0) : (b.updatedMs || 0) - (a.updatedMs || 0);
    }
    // The key a Codex row shares with the server's handoff ids: its thread, else its job.
    function rowHandoffKey(row) {
      return row.threadId || (row.job ? row.job.id : '') || (row.session ? row.session.id : '');
    }
    function buildNodes(frame, runs, rows, jobs, now, openFrame) {
      frame = frame || { chats: [], ghosts: [] };
      var nodes = {};
      var roots = [];
      function add(node) {
        node.children = node.children || [];
        node.flags = node.flags || [];
        nodes[node.id] = node;
        return node;
      }
      function attach(node, parentId) {
        var parent = parentId && nodes[parentId];
        if (!parent || parent === node) { node.parentId = null; roots.push(node.id); return; }
        node.parentId = parent.id;
        parent.children.push(node.id);
      }
      (openFrame && openFrame.chats || []).forEach(function (chat) {
        add({ id: chat.id, kind: 'opencode', chat: chat, title: chat.title, state: claudeNodeState('agent', chat.state),
          project: chat.project, model: chat.model, effort: chat.effort, startedMs: chat.startedMs, updatedMs: chat.updatedMs, usage: chat.usage });
      });
      // Which chat a Codex thread belongs to by job.sessionId (any job on the thread, scope rule 5).
      var threadChat = {};
      (jobs || []).forEach(function (job) {
        if (job.engine === 'opencode') return;
        var key = job.threadId || job.id;
        if (job.sessionId && !threadChat[key]) threadChat[key] = job.sessionId;
      });
      var rowByKey = {};
      (rows || []).forEach(function (row) { rowByKey[rowHandoffKey(row)] = row; });
      var runById = {};
      (runs || []).forEach(function (run) { runById[run.id] = run; });
      var placedRows = {};
      var trackedChats = {};
      function codexNode(row, kind) {
        var session = row.session || {};
        var job = row.job || {};
        return add({
          id: kind + ':' + (kind === 'handoff' ? rowHandoffKey(row) : session.id || rowHandoffKey(row)),
          kind: kind, row: row, title: row.title, state: row.status, project: row.project,
          model: session.model || job.model || '', effort: job.effort || session.effort || '', fast: row.fast,
          startedMs: Date.parse(job.createdAt || '') || 0, updatedMs: row.updatedMs,
          usage: session.tokensUsed ? { total: session.tokensUsed } : null
        });
      }
      // Codex agents (rollouts with parentThreadId) nest under their parent's node, every level.
      function codexKids(node, row) {
        (row.children || []).forEach(function (kid) {
          var child = codexNode(kid, 'codexagent');
          attach(child, node.id);
          codexKids(child, kid);
        });
      }
      frame.chats.forEach(function (chat) {
        trackedChats[chat.sessionId] = true;
        var node = add({
          id: chat.id, kind: 'chat', chat: chat, title: chat.title, state: claudeNodeState('chat', chat.state),
          project: chat.project, model: chat.model, effort: chat.effort, tool: chat.tool, source: chat.source,
          startedMs: chat.startedMs, updatedMs: chat.updatedMs, usage: chat.usage, hidden: chat.childrenHidden || 0
        });
        attach(node, null);
        var kids = (chat.children || []).slice().sort(function (a, b) { return (a.startedMs || 0) - (b.startedMs || 0); });
        // Agents and workflows first, so a handoff can find the agent that started it.
        kids.forEach(function (kid) {
          if (kid.kind === 'agent') {
            var agent = add({ id: kid.id, kind: 'agent', agent: kid, chatId: chat.sessionId, title: kid.label, state: claudeNodeState('agent', kid.state),
              project: chat.project, model: kid.model, effort: kid.effort, tool: kid.tool, startedMs: kid.startedMs, updatedMs: kid.updatedMs, usage: kid.usage,
              parentHint: kid.parentId });
            if (kid.background) agent.flags.push('background');
            if (kid.flag) agent.flags.push(kid.flag);
            if (kid.agentType === 'codex:codex-rescue') agent.flags.push('no job yet');
          } else if (kid.kind === 'workflow') {
            var run = runById[kid.runId] || null;
            var wf = add({ id: kid.id, kind: 'workflow', run: run, runId: kid.runId, chatId: chat.sessionId, title: kid.label,
              state: claudeNodeState('workflow', run ? run.status : kid.state), project: chat.project, model: run ? run.model : '', effort: run ? run.effort : '',
              startedMs: kid.startedMs, updatedMs: kid.updatedMs, usage: kid.usage, parentHint: kid.parentId });
            // Topic groups (server's run.groups) sit between the run and its agents, in start order.
            var groupBase = 'wfgroup:' + chat.sessionId + '/' + kid.runId + '/';
            ((run && run.groups) || []).forEach(function (g) {
              add({ id: groupBase + g.key, kind: 'wfgroup', group: g, run: run, chatId: chat.sessionId, title: g.title, order: g.order,
                state: claudeNodeState('wfagent', g.running ? 'running' : g.failed ? 'failed' : 'done'), project: chat.project,
                startedMs: 0, updatedMs: g.lastWriteMs, usage: { total: g.tokens, partial: g.partial }, parentHint: wf.id });
            });
            (run ? run.agents : []).forEach(function (a) {
              add({ id: 'wfagent:' + chat.sessionId + '/' + kid.runId + '/' + a.id, kind: 'wfagent', run: run, agent: a, chatId: chat.sessionId,
                title: a.label, phase: a.phase, state: claudeNodeState('wfagent', a.state), project: chat.project, model: a.model, effort: a.effort,
                tool: a.tool, startedMs: 0, updatedMs: a.lastWriteMs, usage: a.usage, order: a.order,
                parentHint: a.group && nodes[groupBase + a.group] ? groupBase + a.group : wf.id });
            });
          }
        });
        kids.forEach(function (kid) {
          if (kid.kind !== 'handoff') return;
          var key = kid.id.slice('handoff:'.length);
          var row = rowByKey[key];
          if (!row) return; // its rollout and job are not loaded (or /jobs is blocked): the counts still have it
          placedRows[key] = true;
          var node = row.job && row.job.engine === 'opencode' && nodes['opencode:' + row.threadId] || codexNode(row, 'handoff');
          node.row = row;
          if (node.kind === 'opencode') node.state = row.status;
          node.startedMs = kid.startedMs || node.startedMs;
          node.parentHint = kid.parentId;
          node.chatId = chat.sessionId;
          if (!kid.exact) node.flags.push('agent not known');
          if (kid.jobIds && kid.jobIds.length > 1) node.flags.push(kid.jobIds.length + ' runs');
          if (kid.jobIds && !kid.jobIds.length) node.flags.push('job pruned');
          if (row.project && chat.cwd && projectName(row.project) !== projectName(chat.cwd)) node.flags.push('→ ' + projectName(row.project));
        });
        // Parents: the server's parentId when that node exists here, else the nearest known one.
        Object.keys(nodes).forEach(function (id) {
          var n = nodes[id];
          if (n.chatId !== chat.sessionId || n.parentId !== undefined) return;
          var hint = n.parentHint;
          if (hint && hint.indexOf('wfagent:') === 0 && !nodes[hint]) hint = 'workflow:' + hint.slice(8).split('/').slice(0, 2).join('/');
          attach(n, nodes[hint] ? hint : chat.id);
        });
        kids.forEach(function (kid) {
          if (kid.kind !== 'handoff') return;
          var key = kid.id.slice('handoff:'.length);
          if (rowByKey[key] && nodes['handoff:' + key]) codexKids(nodes['handoff:' + key], rowByKey[key]);
        });
      });
      // Handoffs of a chat that is not on this PC.
      (frame.ghosts || []).forEach(function (ghost) {
        var g = add({ id: ghost.id, kind: 'ghost', title: 'Claude chat not found on this PC', sessionId: ghost.sessionId, state: 'FINISHED',
          project: '', updatedMs: ghost.updatedMs, usage: null });
        attach(g, null);
        (ghost.children || []).forEach(function (kid) {
          var key = kid.id.slice('handoff:'.length);
          var row = rowByKey[key];
          if (!row) return;
          placedRows[key] = true;
          var node = row.job && row.job.engine === 'opencode' && nodes['opencode:' + row.threadId] || codexNode(row, 'handoff');
          node.row = row;
          if (node.kind === 'opencode') node.state = row.status;
          node.flags.push('agent not known');
          attach(node, g.id);
          codexKids(node, row);
          if (!g.project) g.project = row.project;
        });
      });
      // Every other Codex row: a handoff of a tracked chat that the frame did not send (the cap) stays
      // out of the roots; the rest are roots, yours ("Codex CLI") or Claude's with the chat unknown.
      // buildRows nests one level; a deeper Codex agent comes as its own row and nests here by thread.
      var threadNode = {};
      Object.keys(nodes).forEach(function (id) { var r = nodes[id].row; if (r && r.threadId) threadNode[r.threadId] = id; });
      var deep = [], older = [];
      (rows || []).forEach(function (row) {
        var key = rowHandoffKey(row);
        if (placedRows[key]) return;
        if (row.job && row.job.engine === 'opencode' && nodes['opencode:' + row.threadId]) {
          var open = nodes['opencode:' + row.threadId];
          open.row = row;
          open.state = row.status;
          var starter = nodes['chat:' + row.job.sessionId] || nodes['ghost:' + row.job.sessionId];
          if (starter) open.parentHint = starter.id;
          placedRows[key] = true;
          return;
        }
        if (threadChat[key] && trackedChats[threadChat[key]]) {
          // Past the chat's child cap: no root and no parent, but History and search still find it.
          var old = codexNode(row, 'handoff');
          old.parentId = null;
          old.chatId = threadChat[key];
          old.flags.push('older, not in Live');
          codexKids(old, row);
          older.push(old.id);
          return;
        }
        var parentThread = row.session && row.session.parentThreadId;
        if (parentThread && parentThread !== row.threadId) { deep.push(row); return; }
        var claude = !!row.job || (row.session && row.session.originator === 'Claude Code');
        var node = codexNode(row, claude ? 'handoff' : 'codex');
        if (claude) node.flags.push(threadChat[key] ? 'chat not in Live' : 'started by Claude, chat unknown');
        attach(node, null);
        codexKids(node, row);
        if (row.threadId) threadNode[row.threadId] = node.id;
        (row.children || []).forEach(function (kid) { if (kid.threadId) threadNode[kid.threadId] = 'codexagent:' + kid.session.id; });
      });
      // OpenCode sessions reuse the handoff parent found in Claude's transcript.
      // job.sessionId supplies the same fallback when that link is not loaded.
      (openFrame && openFrame.chats || []).forEach(function (chat) {
        var node = nodes[chat.id];
        if (node.parentId !== undefined) return;
        var parent = node.parentHint || chat.parentId, seen = {};
        seen[chat.id] = true;
        while (parent && nodes[parent] && nodes[parent].chat && !seen[parent]) { seen[parent] = true; parent = nodes[parent].chat.parentId; }
        attach(node, parent && seen[parent] ? null : node.parentHint || chat.parentId);
      });
      // Parents first: repeat while a pass places something; what is left has no loaded parent.
      for (var placed = true; placed && deep.length;) {
        placed = false;
        deep = deep.filter(function (row) {
          var parent = threadNode[row.session.parentThreadId];
          if (!parent) return true;
          var node = codexNode(row, 'codexagent');
          attach(node, parent);
          codexKids(node, row);
          if (row.threadId) threadNode[row.threadId] = node.id;
          placed = true;
          return false;
        });
      }
      deep.forEach(function (row) {
        var node = codexNode(row, 'codexagent');
        node.flags.push('parent thread not loaded');
        attach(node, null);
        codexKids(node, row);
      });
      // Depth, roll-up and usage per root, bottom up.
      function walk(id, depth) {
        var n = nodes[id];
        n.depth = depth;
        n.rollup = n.state;
        n.states = {};
        n.states[n.state] = true;
        var claude = 0, codex = 0, opencode = 0, partial = !n.usage, total = n.usage ? n.usage.total || 0 : 0;
        if (n.usage && n.usage.partial) partial = true;
        if (n.kind === 'opencode') opencode += total;
        else if (n.kind === 'handoff' || n.kind === 'codex' || n.kind === 'codexagent') codex += total; else claude += total;
        if (n.kind === 'workflow') claude -= total; // its agents carry the same tokens
        if (depth < 8) n.children.forEach(function (cid) {
          var c = walk(cid, depth + 1);
          n.rollup = worstState(n.rollup, c.rollup);
          Object.keys(c.states).forEach(function (s) { n.states[s] = true; });
          claude += c.tree.claude;
          codex += c.tree.codex;
          opencode += c.tree.opencode || 0;
          if (c.tree.partial) partial = true;
        });
        if (n.kind === 'workflow' && !n.children.length) claude += total;
        if (n.kind === 'wfgroup') claude = total; // the server's exact sum, also for agents the frame did not send
        // The server counts every subagent and workflow agent of a chat, also the ones it did not send.
        if (n.kind === 'chat' && n.chat.claudeTree) { claude = n.chat.claudeTree.total; if (n.chat.claudeTree.partial || n.hidden) partial = true; }
        n.tree = { claude: claude, codex: codex, total: claude + codex + opencode, partial: partial };
        if (opencode || n.kind === 'opencode') n.tree.opencode = opencode;
        return n;
      }
      roots.concat(older).forEach(function (id) { walk(id, 0); });
      return { nodes: nodes, roots: roots };
    }
    // Live tab chips, in the design's fixed order (4.2). History keeps its own chips.
    // Needs you (ANSWER) is one chip for a question (ANSWER) and a stuck or failed job (ATTENTION): both mean you must act.
    var VIEW_TABS = { LIVE: ['ALL', 'RUNNING', 'ANSWER', 'WAITING', 'FINISHED', 'STOPPED'], HISTORY: ['FINISHED', 'STOPPED', 'ARCHIVED', 'DISMISSED', 'EVERYTHING'] };
    // Live: a root that changed in the root window (24 h), or one that still needs something,
    // so an old "Needs answer" stays as visible as it was in the Now tab.
    function liveRoot(node, now, dismissedIds) {
      if (!node || node.state === 'ARCHIVED' || liveHidden(node, dismissedIds)) return false;
      var urgent = { ANSWER: 1, ATTENTION: 1, RUNNING: 1, BACKGROUND: 1, WAITING: 1 };
      return now - (node.updatedMs || 0) < 24 * 3600 * 1000 || !!urgent[node.rollup];
    }
    // A Codex session you dismissed or archived leaves Live at any depth (History keeps it).
    function liveHidden(node, dismissedIds) {
      if (node.kind === 'opencode' && !node.row) return (dismissedIds || []).indexOf(node.id) !== -1;
      return !!node.row && (node.state === 'ARCHIVED' || (dismissedIds || []).indexOf(node.row.id) !== -1);
    }
    function nodeKind(node) {
      if (node.kind === 'opencode' || (node.row && node.row.job && node.row.job.engine === 'opencode')) return 'opencode';
      return node.kind === 'handoff' || node.kind === 'codex' || node.kind === 'codexagent' ? 'codex' : node.kind === 'ghost' ? 'ghost' : 'claude';
    }
    // The source toggles: every source is on unless its key is false, so {} shows everything and a ghost
    // (kind 'ghost', never a key) always shows.
    function kindsFiltered(kinds) {
      var k = kinds || {};
      return k.claude === false || k.codex === false || k.opencode === false;
    }
    // One node against a chip and the source toggles. FINISHED takes ENDED (an agent with no end
    // record); RUNNING takes BACKGROUND only through the child that runs; ANSWER (Needs you) takes ATTENTION.
    function nodeSelfMatch(node, chip, kinds) {
      if ((kinds || {})[nodeKind(node)] === false) return false;
      if (chip === 'ALL') return true;
      if (chip === 'FINISHED') return node.state === 'FINISHED' || node.state === 'ENDED';
      if (chip === 'ANSWER') return node.state === 'ANSWER' || node.state === 'ATTENTION';
      // Running (the default view) also keeps a question for you in sight.
      if (chip === 'RUNNING') return node.state === 'RUNNING' || node.state === 'ANSWER';
      return node.state === chip;
    }
    // A node matches when it or any descendant does (the roll-up rule, 4.2). The cycle guard is depth 8.
    function nodeMatch(nodes, id, chip, kinds, depth) {
      var node = nodes[id];
      if (!node || (depth || 0) > 8) return false;
      if (nodeSelfMatch(node, chip, kinds)) return true;
      return node.children.some(function (cid) { return nodeMatch(nodes, cid, chip, kinds, (depth || 0) + 1); });
    }
    // Search: titles, projects, ids, models. A child hit keeps its root and opens the way to it.
    function nodeSearchHit(node, query) {
      var needle = String(query || '').trim().toLowerCase();
      if (!needle) return true;
      var row = node.row || {};
      var session = row.session || {};
      var job = row.job || {};
      return [node.title, node.project, node.id, node.model, node.sessionId, session.id, job.id, row.threadId, job.title, node.chat && node.chat.sessionId,
        node.phase, session.agentNickname]
        .some(function (v) { return String(v || '').toLowerCase().indexOf(needle) !== -1; });
    }
    function nodeSearch(nodes, id, query, depth) {
      var node = nodes[id];
      if (!node || (depth || 0) > 8) return false;
      if (nodeSearchHit(node, query)) return true;
      return node.children.some(function (cid) { return nodeSearch(nodes, cid, query, (depth || 0) + 1); });
    }
    // The roots a view shows, and the count per chip (a chip's count is what clicking it shows).
    function viewRoots(model, view, now, dismissedIds, query) {
      var nodes = model.nodes;
      if (view.tab === 'HISTORY') {
        // Every Codex session, also the ones under a chat: each is its own row here, its agents under it.
        // Stage 4 adds older chats.
        return Object.keys(nodes).filter(function (id) {
          var node = nodes[id];
          if (node.kind === 'opencode' && !node.row) {
            if (node.parentId || (query && !nodeSearch(nodes, id, query))) return false;
            return view.chip === 'EVERYTHING' || (view.chip === 'DISMISSED' && (dismissedIds || []).indexOf(id) !== -1);
          }
          if (!node.row || (node.kind === 'codexagent' && node.parentId)) return false;
          if (query && !nodeSearch(nodes, id, query)) return false;
          if (view.chip === 'EVERYTHING') return true;
          var dismissed = (dismissedIds || []).indexOf(node.row.id) !== -1;
          if (view.chip === 'DISMISSED') return dismissed;
          return !dismissed && node.row.status === view.chip;
        });
      }
      return model.roots.filter(function (id) {
        var node = nodes[id];
        return liveRoot(node, now, dismissedIds) && nodeMatch(nodes, id, view.chip, view.kinds) && (!query || nodeSearch(nodes, id, query));
      });
    }
    function nodeViewCounts(model, view, now, dismissedIds) {
      var counts = {};
      Object.keys(VIEW_TABS).forEach(function (tab) {
        counts[tab] = {};
        VIEW_TABS[tab].forEach(function (chip) {
          counts[tab][chip] = viewRoots(model, { tab: tab, chip: chip, kinds: tab === 'LIVE' ? view.kinds : null }, now, dismissedIds, '').length;
        });
      });
      return counts;
    }
    // Saved tab and chip from before the redesign map to Live plus a kind (design 4.3).
    // Running is the default Live chip: a saved Live "All" from before (viewV < 2) switches to it once.
    // viewV 3: the source toggles hide (false) instead of show; a saved "none on" (= everything) from
    // before becomes {} and "some on" keeps those on and turns the rest off. Needs attention merged into Needs you.
    var KIND_KEYS = ['claude', 'codex', 'opencode'];
    function nodeSavedView(prefs) {
      var saved = prefs && typeof prefs === 'object' ? prefs : {};
      if (saved.tab === 'LIVE' && saved.chip === 'ATTENTION') saved = Object.assign({}, saved, { chip: 'ANSWER' });
      var kinds = {};
      var old = saved.kinds && typeof saved.kinds === 'object' ? saved.kinds : {};
      if (saved.viewV >= 3) KIND_KEYS.forEach(function (k) { if (old[k] === false) kinds[k] = false; });
      else if (old.claude || old.codex || old.opencode) KIND_KEYS.forEach(function (k) { kinds[k] = !!old[k]; });
      var view;
      if (Object.prototype.hasOwnProperty.call(VIEW_TABS, saved.tab) && VIEW_TABS[saved.tab].indexOf(saved.chip) !== -1) view = { tab: saved.tab, chip: saved.chip, kinds: kinds };
      else {
        var legacy = savedView(saved); // NOW, HANDOFFS, CLAUDE, HISTORY
        if (legacy.tab === 'HISTORY') view = { tab: 'HISTORY', chip: legacy.chip, kinds: kinds };
        else {
          if (legacy.tab === 'HANDOFFS') kinds = { claude: false, codex: true, opencode: false };
          if (legacy.tab === 'CLAUDE') kinds = { claude: true, codex: false, opencode: false };
          var chip = legacy.chip === 'ATTENTION' ? 'ANSWER' : legacy.chip;
          view = { tab: 'LIVE', chip: VIEW_TABS.LIVE.indexOf(chip) !== -1 ? chip : 'ALL', kinds: kinds };
        }
      }
      if (!(saved.viewV >= 2) && view.tab === 'LIVE' && view.chip === 'ALL') view.chip = 'RUNNING';
      view.viewV = 3;
      return view;
    }
    // A saved selection from before the redesign: a Codex row id (session id or job:<id>), or a
    // Claude run and agent. Returns the node id, or null when the node is not loaded.
    function nodeIdFor(model, saved) {
      var nodes = model.nodes;
      if (saved.node && nodes[saved.node]) return saved.node;
      var ids = Object.keys(nodes);
      if (saved.claudeRun) {
        var open = saved.claudeAgent && ids.find(function (id) { var n = nodes[id]; return n.kind === 'wfagent' && n.run && n.run.id === saved.claudeRun && n.agent.id === saved.claudeAgent; });
        if (open) return open; // its workflow opens with it, in the side panel
        var wf = ids.find(function (id) { return nodes[id].kind === 'workflow' && nodes[id].runId === saved.claudeRun; });
        if (wf) return wf;
      }
      if (saved.selected) {
        var hit = ids.find(function (id) { return nodes[id].row && nodes[id].row.id === saved.selected; });
        if (hit) return hit;
      }
      return null;
    }
