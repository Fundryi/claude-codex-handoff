'use strict';
    function folderIcon() {
      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      var shape = document.createElementNS(ns, 'path');
      shape.setAttribute('d', 'M1.5 3.5a1 1 0 0 1 1-1h3.6l1.6 1.6h5.8a1 1 0 0 1 1 1v7.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z');
      shape.setAttribute('fill', 'none');
      shape.setAttribute('stroke', 'currentColor');
      shape.setAttribute('stroke-width', '1.4');
      shape.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(shape);
      return svg;
    }
    // The chips under the header title: project (the most visible), model, effort. owner 'claude' or 'codex'.
    function renderTaskFacts(owner, project, projectTitle, model, effort) {
      taskFacts.textContent = '';
      taskFacts.className = owner;
      taskFacts.hidden = !project && !model && !effort;
      if (project) {
        var chip = document.createElement('span');
        chip.className = 'fact fact-project';
        chip.title = projectTitle || project;
        var name = document.createElement('b');
        name.textContent = project;
        chip.append(folderIcon(), name);
        taskFacts.appendChild(chip);
      }
      if (model) {
        var modelChip = textSpan('fact', modelShortName(model));
        modelChip.title = 'Model: ' + model;
        taskFacts.appendChild(modelChip);
      }
      if (effort) {
        var effortChip = document.createElement('span');
        effortChip.className = 'fact';
        effortChip.title = 'Reasoning effort: ' + effort;
        effortChip.append(textSpan('fact-key', 'effort'), document.createTextNode(effort));
        taskFacts.appendChild(effortChip);
      }
    }

    // Breadcrumb (#crumbs): every ancestor of the open node as a link, then "this <kind>". Empty for a root.
    var crumbsBar = document.getElementById('crumbs');
    var usageBar = document.getElementById('usage');
    function renderCrumbs() {
      var model = currentModel();
      var chain = prefs.node && pageKind() !== 'overview' ? nodeChain(model, prefs.node) : [];
      var signature = chain.map(function (n) { return n.id + '|' + n.title; }).join('/');
      if (crumbsBar.dataset.signature === signature) return;
      crumbsBar.dataset.signature = signature;
      crumbsBar.textContent = '';
      if (chain.length < 2) return;
      chain.slice(0, -1).forEach(function (n) {
        var link = document.createElement('a');
        link.href = '#';
        link.title = n.title;
        link.append(nodeMark(n), document.createTextNode(n.title.length > 34 ? n.title.slice(0, 34) + '…' : n.title));
        link.addEventListener('click', function (event) { event.preventDefault(); selectNode(n.id, true); });
        crumbsBar.append(link, textSpan('sep', '›'));
      });
      var self = chain[chain.length - 1];
      var here = textSpan('', '');
      here.style.display = 'inline-flex';
      here.style.alignItems = 'center';
      here.style.gap = '5px';
      here.append(nodeMark(self), document.createTextNode('this ' + (KIND_INFO[self.kind] || {}).word));
      crumbsBar.appendChild(here);
    }

    // Usage strip (#usage, design 7): Context, Total and Tree for a node. Empty on the overview.
    function usageCell(label, title, lower) {
      var cell = textSpan('ucell' + (lower ? ' lower' : ''), '');
      cell.title = title;
      cell.appendChild(textSpan('lab', label));
      return cell;
    }
    function bold(text) { var b = document.createElement('b'); b.textContent = text; return b; }
    function meterElement(percent, sev) {
      var meter = document.createElement('span');
      meter.className = 'meter' + (sev ? ' ' + sev : '');
      var fill = document.createElement('i');
      fill.style.setProperty('--p', Math.max(0, Math.min(100, Math.round(percent))) + '%');
      meter.appendChild(fill);
      return meter;
    }
    function treeParts(cell, tree) {
      if (tree.claude !== 0) {
        var sc = textSpan('sc', '');
        sc.append(glyphSpan('claude'), document.createTextNode(compactCount(tree.claude)));
        cell.appendChild(sc);
      }
      if (controlsBlocked || tree.codex !== 0) {
        var sp = textSpan('sp', '');
        sp.append(glyphSpan('codex'), document.createTextNode(controlsBlocked ? '?' : compactCount(tree.codex)));
        cell.appendChild(sp);
      }
      if (tree.opencode != null && tree.opencode !== 0) { var so = textSpan('so', ''); so.append(glyphSpan('opencode'), document.createTextNode(compactCount(tree.opencode))); cell.appendChild(so); }
    }
    function renderUsage(node) {
      var cells = [];
      var now = Date.now();
      if (!node) { usageBar.textContent = ''; usageBar.dataset.signature = ''; return; } // plan limits live in the sidebar block
      var usage = node.usage;
      var context = node.kind === 'opencode' ? transcripts.main.contextTokens : node.kind === 'chat' ? usage && usage.context : node.row && node.row.session ? node.row.session.contextTokens : null;
      var windowSize = node.row && node.row.session ? node.row.session.contextWindow : 0;
      var ctx = usageCell('Context', 'Context in the newest message' + (windowSize ? ' of a ' + compactCount(windowSize) + ' window' : ''));
      if (node.kind === 'ghost') ctx.appendChild(textSpan('unk', 'no chat file'));
      else if (!context) ctx.appendChild(textSpan('unk', 'unknown'));
      else {
        ctx.appendChild(bold(compactCount(context)));
        if (windowSize) ctx.append(textSpan('', '/ ' + compactCount(windowSize)), meterElement(100 * context / windowSize, ''), textSpan('', Math.round(100 * context / windowSize) + '%'));
        else { var unk = textSpan('unk', 'window unknown'); unk.title = 'The window size is not on disk for this source'; ctx.appendChild(unk); }
      }
      cells.push(ctx);
      var total = usageCell('Total', 'Input (cached included) plus output, every call, this node only', usage && usage.partial && usage.total);
      if (node.kind === 'ghost') total.appendChild(textSpan('unk', 'no chat file'));
      else if (!usage || usage.total == null) total.appendChild(textSpan('unk', 'unknown'));
      else if (usage.partial && !usage.total) total.appendChild(textSpan('unk', 'counting…'));
      else {
        total.appendChild(bold(compactCount(usage.total)));
        if (usage.output) { var out = textSpan('', '↓ ' + compactCount(usage.output)); out.title = 'Output tokens'; total.appendChild(out); }
      }
      cells.push(total);
      if (node.children.length) {
        var tree = usageCell('Tree', 'This node plus every child' + (node.tree.partial ? '. A lower bound: some usage is unknown or over the read cap' : ''), node.tree.partial && node.tree.total);
        if (node.tree.partial && !node.tree.total) tree.appendChild(textSpan('unk', 'counting…'));
        else {
          tree.appendChild(bold(compactCount(node.tree.total)));
          treeParts(tree, node.tree);
        }
        cells.push(tree);
      }
      var signature = cells.map(function (c) { return c.outerHTML; }).join('');
      if (usageBar.dataset.signature === signature) return;
      usageBar.dataset.signature = signature;
      usageBar.textContent = '';
      cells.forEach(function (c) { usageBar.appendChild(c); });
    }

    // Header for a chat or a ghost root (design 8.1). Codex nodes keep their own header; workflows theirs.
    function renderNodeHeader(node) {
      taskMeta.textContent = '';
      taskHandoff.hidden = true;
      taskFast.hidden = true;
      taskClaude.hidden = true;
      resumeSessionButton.hidden = true;
      autoOpenToggle.hidden = true;
      actionsButton.hidden = !node;
      if (!node) {
        closeActionMenu();
        taskFacts.hidden = true;
        taskStatus.hidden = true;
        taskTitle.textContent = claudeChatsLoaded ? 'This chat is not loaded' : 'Loading…';
        taskTitle.title = '';
        return;
      }
      var badge = nodeBadge(node.state);
      taskStatus.hidden = false;
      taskStatus.className = 'status ' + (badge === 'ENDED' ? 'STOPPED' : badge);
      taskStatus.textContent = nodeWord(node);
      taskStatus.title = nodeStateHelp(node);
      // The kind word sits before the title, in the title row.
      var row = document.getElementById('task-title-row');
      var oldKind = row.querySelector('.kind-label, .you-tag');
      while (oldKind) { oldKind.remove(); oldKind = row.querySelector('.kind-label, .you-tag'); }
      row.insertBefore(nodeKindLabel(node), taskTitle);
      taskTitle.textContent = node.kind === 'ghost' ? 'Claude chat not found on this PC' : node.title;
      taskTitle.title = node.title;
      var chat = node.chat || {};
      var source = SOURCE_NAMES[chat.source] || chat.source || '';
      renderTaskFacts(node.kind === 'opencode' ? 'opencode' : 'claude', node.kind === 'ghost' ? projectName(node.project) : node.project, chat.cwd || node.project, node.model, node.effort);
      if (source) {
        var from = document.createElement('span');
        from.className = 'fact fact-from';
        from.title = 'Where this chat runs';
        from.append(textSpan('fact-key', 'from'), document.createTextNode(source));
        taskFacts.appendChild(from);
        taskFacts.hidden = false;
      }
      function item(text, title, className) {
        var span = textSpan('meta-item' + (className ? ' ' + className : ''), text);
        span.title = title || text;
        taskMeta.appendChild(span);
        return span;
      }
      if (node.kind === 'ghost') {
        item('Started by: Claude, in a chat that is not on this PC', 'The handoffs carry this chat id, but its file is not under ~/.claude/projects');
        item('session ' + String(node.sessionId || '').slice(0, 8), 'Claude chat id ' + node.sessionId);
      } else if (node.kind === 'opencode') {
        var openId = item('session ' + chat.sessionId, 'OpenCode session id. Click to copy it', 'meta-button');
        openId.addEventListener('click', function () { copyText(chat.sessionId, openId, 'Session id copied'); });
        if (chat.parentId) item('Child session', 'Parent: ' + chat.parentId);
        if (chat.outcome) item(chat.outcome, 'OpenCode idle outcome');
        item('last update ' + relativeTime(node.updatedMs), new Date(node.updatedMs || 0).toLocaleString());
        if (node.row && node.row.job) {
          var origin = startedBy({ originator: 'Claude Code' });
          var starter = item('', 'Started by Claude through a handoff', 'started-by actor-' + origin.actor);
          starter.append(actorAvatar(origin.actor, true), document.createTextNode('Started by: '), bold(origin.label));
          var target = resumeTarget(node.row);
          resumeSessionButton.hidden = !target;
        } else item('Read only', 'This session has no companion job');
      } else {
        var who = item('', 'Chat source: ' + (chat.source || 'unknown'), 'started-by actor-you');
        who.append(actorAvatar('you', true), document.createTextNode('Started by: '), bold('you'), document.createTextNode(source ? ' (' + source + ')' : ''));
        var sid = item('session ' + String(chat.sessionId || '').slice(0, 8), 'Claude chat id ' + chat.sessionId + '\nClick to copy it', 'meta-button');
        sid.addEventListener('click', function () { copyText(chat.sessionId, sid, 'Chat id copied'); });
        if (chat.forkedFrom) {
          var parent = currentModel().nodes['chat:' + chat.forkedFrom];
          var fork = item('forked from ' + (parent ? parent.title : chat.forkedFrom.slice(0, 8)), 'This chat is a fork of another chat');
          if (parent) { fork.classList.add('meta-button'); fork.addEventListener('click', function () { selectNode(parent.id, true); }); }
        }
        if (chat.startedMs) item('started ' + new Date(chat.startedMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 'Started ' + new Date(chat.startedMs).toLocaleString());
        item(node.state === 'RUNNING' ? 'turn running' : node.state === 'BACKGROUND' ? 'turn done · work runs in the background' : node.state === 'ANSWER' ? 'waiting for you' : 'turn done', nodeStateHelp(node));
        if (chat.compactions) item(chat.compactions + (chat.compactions === 1 ? ' compaction' : ' compactions'), 'Times this chat was compacted');
        item('last write ' + relativeTime(node.updatedMs), new Date(node.updatedMs || 0).toLocaleString());
      }
      if (controlsBlocked) {
        var blocked = item('Codex handoffs are blocked at this address', 'Controls are blocked at this address, so Codex handoffs cannot load. Open the viewer on the PC itself or through the tunnel link. If a proxy serves it, add this name to CODEX_VIEWER_ALLOWED_HOSTS.', 'flag');
        blocked.classList.add('flag');
      }
    }

    // Copy-only menu for a chat or a ghost (design 8.9): no control acts on a Claude chat.
    function fillChatMenu(container, node, onPick) {
      container.dataset.signature = '';
      container.textContent = '';
      var id = node.kind === 'ghost' ? node.sessionId : node.chat && node.chat.sessionId;
      var items = [['copy-chat-id', 'Copy chat id', 'The session id of this chat', id]];
      if (node.kind === 'chat') items.push(['copy-resume', 'Copy resume command', 'claude --resume: open this chat in a terminal', 'claude --resume ' + id]);
      container.appendChild(textDiv('menu-group', 'Copy'));
      items.forEach(function (entry) {
        var button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.dataset.action = entry[0];
        button.textContent = entry[1];
        button.title = entry[2];
        button.addEventListener('click', function () { onPick(entry[0]); copyText(entry[3], button, 'Copied'); });
        container.appendChild(button);
      });
      if (node.kind === 'opencode' && !node.row) {
        var hidden = (prefs.dismissed || []).indexOf(node.id) !== -1;
        container.appendChild(textDiv('menu-group', 'Session'));
        var dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.setAttribute('role', 'menuitem');
        dismiss.dataset.action = 'dismiss';
        dismiss.textContent = hidden ? 'Restore task' : 'Dismiss task';
        dismiss.title = 'Hide this task from every view except History > Dismissed and Everything. Viewer-only, undoable.';
        dismiss.addEventListener('click', function () { onPick('dismiss'); toggleDismissed(node.id); });
        container.appendChild(dismiss);
      }
    }
    // Right-click on a tree row: the Codex menu for a Codex node, copy-only for Claude nodes.
    function nodeContextMenu(event, node) {
      if (node.row) { openContextMenu(event, node.row); return; }
      if (node.kind === 'workflow' && node.run) { openClaudeContextMenu(event, node.run); return; }
      if (node.kind === 'chat' || node.kind === 'opencode' || node.kind === 'ghost') {
        event.preventDefault();
        fillChatMenu(contextMenu, node, function () { closeContextMenu(); });
        showContextMenuAt(event);
      }
    }

