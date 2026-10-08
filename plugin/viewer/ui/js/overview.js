'use strict';
    function overviewGroups(model, now, dismissedIds) {
      var groups = { running: [], answer: [], attention: [], finished: [], children: {} };
      var midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      var seen = {};
      function visit(id, parent, depth) {
        var node = model.nodes[id];
        if (!node || seen[id] || depth > 8 || liveHidden(node, dismissedIds)) return;
        seen[id] = true;
        var group = node.state === 'RUNNING' || node.state === 'BACKGROUND' ? 'running'
          : node.state === 'ANSWER' ? 'answer' : node.state === 'ATTENTION' ? 'attention'
          : node.state === 'FINISHED' && node.updatedMs >= midnight.getTime() ? 'finished' : '';
        var host = parent;
        if (node.kind !== 'ghost' && group) {
          if (node.state === 'RUNNING' && parent) {
            (groups.children[parent] = groups.children[parent] || []).push(node);
            host = node.id;
          } else if (!parent || group === 'answer' || group === 'attention' || node.kind === 'handoff' || (node.kind === 'opencode' && node.row && node.row.job)) {
            groups[group].push(node);
            host = group === 'finished' ? null : node.id;
          }
        }
        (node.children || []).forEach(function (cid) { visit(cid, host, depth + 1); });
      }
      viewRoots(model, { tab: 'LIVE', chip: 'ALL', kinds: {} }, now, dismissedIds, '').forEach(function (id) { visit(id, null, 0); });
      Object.keys(groups).forEach(function (key) {
        if (key !== 'children') groups[key].sort(function (a, b) { return (b.updatedMs || 0) - (a.updatedMs || 0); });
      });
      Object.keys(groups.children).forEach(function (key) { groups.children[key].sort(childOrder); });
      return groups;
    }
    function overviewStep(model, node) {
      var job = node.row && node.row.job;
      var session = node.row && node.row.session;
      if (node.state === 'FINISHED') return { text: '' };
      if (node.state === 'ANSWER') return { text: firstLine(String(job && job.needsDecision || '').split(/\r?\n/, 1)[0], 160) || 'waiting for your answer', ask: true };
      if (node.state === 'BACKGROUND') {
        var count = 0, seen = {};
        function countRunning(id) {
          if (seen[id]) return;
          seen[id] = true;
          var kid = model.nodes[id];
          if (!kid) return;
          if (kid.state === 'RUNNING') count++;
          (kid.children || []).forEach(countRunning);
        }
        (node.children || []).forEach(countRunning);
        return { text: count ? count + (count === 1 ? ' agent running' : ' agents running') : '' };
      }
      if (node.state !== 'RUNNING') {
        var reason = job && job.errorMessage || node.chat && node.chat.outcome
          || (session && session.lastKind === 'err' ? session.lastText : '') || (node.state === 'STOPPED' ? 'stopped' : '');
        return { text: firstLine(String(reason).split(/\r?\n/, 1)[0], 160) };
      }
      if (node.kind === 'workflow' && node.run && node.run.phases) {
        var phases = node.run.phases;
        var phase = phases.find(function (p) { return p.started > p.done + (p.failed || 0); }) || phases[phases.length - 1];
        if (phase) return { text: phase.title + ' ' + phase.done + '/' + phase.started };
      }
      if (node.tool) return { text: firstLine(node.tool, 160), command: /^Bash:/i.test(node.tool) };
      if (node.kind === 'opencode' && node.chat && node.chat.step) return { text: node.chat.step, command: /^(bash|shell):/i.test(node.chat.step) };
      if (session && session.lastText) {
        var text = firstLine(String(session.lastText).split(/\r?\n/, 1)[0], 160);
        if (session.lastKind === 'cmd') return { text: 'ran ' + text, command: true };
        if (session.lastKind === 'patch') return { text: 'patched ' + String(session.lastText).split(/,\s*|\r?\n/).filter(Boolean).map(projectName).join(', ') };
        if (session.lastKind === 'tool') return { text: text };
        if (session.lastKind === 'think') return { text: 'thinking' };
        if (session.lastKind === 'agent') return { text: text };
      }
      return { text: 'working' };
    }
    function overviewTooltip(node, step) {
      var info = KIND_INFO[node.kind] || KIND_INFO.chat;
      var path = node.chat && node.chat.cwd || node.row && node.row.project || node.project || '';
      var meta = [info.label, node.model, node.effort, nodeTokens(node) ? nodeTokens(node) + (node.usage.total === 1 ? ' token' : ' tokens') : 'tokens unknown',
        node.fast ? 'FAST' : '', SOURCE_NAMES[node.source] || node.source].filter(Boolean);
      return [node.title, path, step.text, nodeStateLabel(node.state), meta.join(' · '), (node.flags || []).join(' · ')].filter(Boolean).join('\n');
    }
    function overviewRowElement(model, node, child, rail, depth) {
      var step = overviewStep(model, node);
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'ov-row' + (child ? ' child' : '') + (node.state === 'FINISHED' ? ' fin' : '') + (rail && prefs.node === node.id ? ' selected' : '');
      el.dataset.key = 'overview:' + node.id;
      el.dataset.node = node.id;
      el.title = overviewTooltip(node, step);
      var title = textSpan('ov-title', '');
      if (child) {
        el.style.setProperty('--ov-indent', (rail ? 20 : 28) * (depth || 1) + 'px'); // steps of 4: the inline mark stays on the pixel grid at every depth
        title.appendChild(nodeMark(node));
      }
      title.appendChild(textSpan('ov-t', node.title)); // a span: a child title is a flex row (mark, text) and the text still ellipsizes
      el.append(nodeMark(node), title);
      if (!rail) {
        var path = node.chat && node.chat.cwd || node.row && node.row.project || node.project || '';
        var project = textSpan('ov-project', projectName(path));
        project.title = path;
        el.append(project, textSpan('ov-now' + (step.command ? ' mono' : '') + (step.ask ? ' ov-answer' : ''), step.text),
          textSpan('state-word ' + nodeBadge(node.state), nodeStateLabel(node.state).toLowerCase()));
      }
      el.appendChild(textSpan('ov-age', relativeTime(node.updatedMs)));
      el.addEventListener('click', function () { lastHomeSignature = ''; selectNode(node.id, true); });
      el.addEventListener('contextmenu', function (event) { nodeContextMenu(event, node); });
      return el;
    }
    function overviewSection(model, groups, label, nodes, rail) {
      var section = document.createElement('section');
      section.className = 'ov-section';
      var heading = document.createElement('div');
      heading.className = 'home-heading';
      heading.append(document.createTextNode(label), textSpan('n', String(nodes.length)));
      section.appendChild(heading);
      function append(node, depth) {
        section.appendChild(overviewRowElement(model, node, depth > 0, rail, depth));
        if (depth < 8) (groups.children[node.id] || []).forEach(function (kid) { append(kid, depth + 1); });
      }
      nodes.forEach(function (node) { append(node, 0); });
      return section;
    }
    var homeFinishedOpen = false;
    function renderHome() {
      var model = currentModel();
      var now = Date.now();
      var groups = overviewGroups(model, now, prefs.dismissed);
      var signature = JSON.stringify([dataVersion, Math.floor(now / 10000), homeFinishedOpen, isWide(), new Date(now).toDateString()]);
      if (signature === lastHomeSignature) return;
      lastHomeSignature = signature;
      var focusHost = feedInner.contains(document.activeElement) ? document.activeElement.closest('[data-key]') : null;
      var focusKey = focusHost ? focusHost.dataset.key : null;
      feedInner.textContent = '';
      var wrap = document.createElement('div');
      wrap.id = 'home-view';
      var left = textDiv('ov-column', '');
      var right = textDiv('ov-column', '');
      left.appendChild(overviewSection(model, groups, 'Running', groups.running, false));
      if (!groups.running.length) left.appendChild(textDiv('activity-count', 'Nothing running right now'));
      if (groups.answer.length) right.appendChild(overviewSection(model, groups, 'Needs you', groups.answer, false));
      if (groups.attention.length) right.appendChild(overviewSection(model, groups, 'Needs attention', groups.attention, false));
      var finished = textDiv('ov-finished', groups.finished.length + ' finished today · ');
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'ov-show';
      more.dataset.key = 'overview:finished';
      more.textContent = homeFinishedOpen ? 'hide' : 'show';
      more.setAttribute('aria-expanded', String(homeFinishedOpen));
      more.addEventListener('click', function () { homeFinishedOpen = !homeFinishedOpen; lastHomeSignature = ''; renderHome(); });
      finished.appendChild(more);
      var done = textDiv('ov-finished-rows', '');
      if (homeFinishedOpen) groups.finished.forEach(function (node) { done.appendChild(overviewRowElement(model, node, false, false)); });
      // In one column, finished follows all active groups. In two, it stays on the left.
      var finishHost = isWide() ? left : right;
      finishHost.append(finished, done);
      wrap.append(left, right);
      feedInner.appendChild(wrap);
      if (focusKey) wrap.querySelectorAll('[data-key]').forEach(function (el) { if (el.dataset.key === focusKey) el.focus({ preventScroll: true }); });
      jumpLatest.hidden = true;
    }
    function renderActivity() {
      var model = currentModel();
      var groups = overviewGroups(model, Date.now(), prefs.dismissed);
      var shown = groups.answer.slice(0, 4);
      // Parents outside the rail must not hide work that is still running.
      var running = groups.running.concat(groups.attention.concat(groups.answer.slice(shown.length)).flatMap(function (node) { return groups.children[node.id] || []; }));
      var signature = JSON.stringify(['activity', dataVersion, prefs.node, Math.floor(Date.now() / 10000), new Date().toDateString()]);
      if (signature === lastPanelSignature) return;
      lastPanelSignature = signature;
      var focusHost = panelInner.contains(document.activeElement) ? document.activeElement.closest('[data-key]') : null;
      var focusKey = focusHost ? focusHost.dataset.key : null;
      panelHead.textContent = '';
      var copy = textDiv('', '');
      copy.append(textDiv('t', 'Activity'), textDiv('activity-count', running.length + ' running · ' + groups.answer.length + (groups.answer.length === 1 ? ' needs you' : ' need you')));
      panelHead.appendChild(copy);
      panelInner.textContent = '';
      var wrap = textDiv('activity-list', '');
      if (running.length) wrap.appendChild(overviewSection(model, groups, 'Running', running, true));
      if (shown.length) wrap.appendChild(overviewSection(model, groups, 'Needs you', shown, true));
      var more = groups.answer.length - shown.length;
      var footer = textDiv('activity-foot', more + (more === 1 ? ' more needs you · ' : ' more need you · ')
        + groups.attention.length + (groups.attention.length === 1 ? ' needs attention · ' : ' need attention · ') + groups.finished.length + ' finished · ');
      var live = document.createElement('button');
      live.type = 'button';
      live.className = 'activity-live';
      live.dataset.key = 'activity:live';
      live.textContent = 'open Live';
      live.addEventListener('click', function () { prefs.home = true; lastHomeSignature = ''; closePanel(); applyPrefs(); renderHeader(); renderFeed(); renderPanel(); });
      footer.appendChild(live);
      wrap.appendChild(footer);
      panelInner.appendChild(wrap);
      if (focusKey) wrap.querySelectorAll('[data-key]').forEach(function (el) { if (el.dataset.key === focusKey) el.focus({ preventScroll: true }); });
    }

