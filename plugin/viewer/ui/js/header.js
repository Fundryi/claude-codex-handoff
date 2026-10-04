'use strict';
    function statusChip(className, text, title) {
      var chip = document.createElement('span');
      chip.className = 'status ' + className;
      chip.textContent = text;
      chip.title = title;
      return chip;
    }

    // The open task's row (child agents included; buildRows draws every session).
    function selectedRow() {
      if (pageKind() === 'opencode') { var node = pageNode(); return node && node.row || null; }
      var s = currentSession();
      return s ? rowById(currentRows(), s.id) : null;
    }

    function closeActionMenu() {
      actionMenu.hidden = true;
      actionsButton.setAttribute('aria-expanded', 'false');
    }

    // Line 1: status, Handoff, FAST, title. Then the project, model and effort chips.
    // Line 2: meta (click copies the thread id), time.
    // Line 3: the reason line, only when there is one.
    function renderHeader() {
      renderCounter();
      renderCrumbs();
      document.querySelectorAll('#task-title-row .kind-label, #task-title-row .you-tag').forEach(function (el) { el.remove(); });
      var page = pageKind();
      if (page === 'workflow') { renderClaudeHeader(); renderUsage(pageNode()); return; }
      if (page === 'chat' || page === 'opencode' || page === 'ghost') { renderNodeHeader(pageNode()); renderUsage(pageNode()); return; }
      taskClaude.hidden = true;
      renderUsage(page === 'codex' ? pageNode() : null);
      taskClaude.hidden = true;
      var overview = showOverview();
      var row = overview ? null : selectedRow();
      taskMeta.textContent = '';
      autoOpenToggle.hidden = !overview;
      actionsButton.hidden = !row;
      if (!row) {
        closeActionMenu();
        taskFacts.hidden = true;
        taskStatus.hidden = true;
        taskHandoff.hidden = true;
        taskFast.hidden = true;
        taskTitle.textContent = 'Live';
        taskTitle.title = '';
        resumeSessionButton.hidden = true;
        return;
      }
      // An open ... menu follows the task: rebuild it when its items change (job finished, dismissed...).
      if (!actionMenu.hidden && actionMenu.dataset.signature !== menuSignature(row)) fillMenu(actionMenu, row, actionMenuPick);
      var session = row.session;
      var now = Date.now();
      var badgeClass = rowBadge(row.status);
      var reason = headerReason(row, now);
      taskStatus.hidden = false;
      taskStatus.className = 'status ' + badgeClass;
      taskStatus.textContent = STATUS[badgeClass].label;
      taskStatus.title = reason || STATUS[badgeClass].help;
      var handoffNode = pageNode();
      taskHandoff.hidden = !row.job && !(handoffNode && handoffNode.kind === 'handoff');
      if (taskHandoff.hidden && handoffNode) document.getElementById('task-title-row').insertBefore(nodeKindLabel(handoffNode), taskTitle);
      taskHandoff.title = 'Handoff from Claude to Codex' + (row.job ? row.olderJobs ? ' · ' + (row.olderJobs + 1) + ' runs on this thread' : '' : ' · its job record is gone, so there is no result card');
      taskFast.hidden = !row.fast;
      taskTitle.textContent = row.title;
      taskTitle.title = row.title;
      resumeSessionButton.hidden = !resumeTarget(row);
      var job = row.job || {};
      renderTaskFacts('codex', row.project ? projectName(row.project) : '', row.project, session.model || job.model, job.effort || session.effort);

      var origin = startedBy(session);
      if (origin) {
        var started = document.createElement('span');
        started.className = 'meta-item started-by actor-' + origin.actor;
        started.title = session.parentThreadId ? 'Child agent of thread ' + session.parentThreadId : 'Session originator: ' + session.originator;
        var who = document.createElement('b');
        who.textContent = origin.label;
        started.append(actorAvatar(origin.actor, true), document.createTextNode('Started by: '), who);
        taskMeta.appendChild(started);
      }
      // Path, model and effort are the chips above; the tooltip keeps the full line.
      sessionMetaLine(session, true).split('   |   ').filter(function (part) { return !/^tokens:/.test(part); }).forEach(function (part) {
        var thread = /^thread:/.test(part) && session.threadId;
        var metadata = document.createElement(thread ? 'button' : 'span');
        if (thread) metadata.type = 'button';
        metadata.className = 'meta-item' + (thread ? ' meta-button' : '');
        metadata.textContent = part;
        metadata.title = sessionMetaLine(session) + (thread ? '\nClick to copy the thread ID' : '');
        if (thread) metadata.addEventListener('click', function () { copyText(session.threadId, metadata, 'Thread copied'); });
        taskMeta.appendChild(metadata);
      });
      var values = [{ text: 'last write ' + relativeTime(row.updatedMs), title: 'Last activity' }];
      if (isDismissed(row.id)) values.push({ text: 'Dismissed', title: 'Hidden from every view except History > Dismissed and Everything' });
      values.forEach(function (item) {
        var span = document.createElement('span');
        span.className = 'meta-item';
        span.textContent = item.text;
        span.title = item.title;
        taskMeta.appendChild(span);
      });
      if (reason) {
        var reasonLine = document.createElement('span');
        reasonLine.id = 'wait-reason';
        reasonLine.className = 'meta-item ' + badgeClass;
        reasonLine.textContent = reason;
        reasonLine.title = reason;
        taskMeta.appendChild(reasonLine);
      }
    }

