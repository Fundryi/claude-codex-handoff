'use strict';
    function newestRunning() { return sessions.find(function (session) { return session.status === 'LIVE'; }); }
    function scrollToLatest() { feed.scrollTop = feed.scrollHeight; jumpLatest.hidden = true; }
    function nearBottom() { return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90; }

    async function copyText(text, button, successLabel) {
      var old = button.textContent;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = successLabel;
        window.setTimeout(function () { button.textContent = old; }, 1200);
      } catch (_) {
        window.prompt('Copy this value:', text);
      }
    }

    function controlField(labelText, control) {
      var label = document.createElement('label');
      label.className = 'control-field';
      var text = document.createElement('span');
      text.textContent = labelText;
      label.append(text, control);
      return label;
    }

    function controlSelect(options) {
      var select = document.createElement('select');
      options.forEach(function (item) {
        var option = document.createElement('option');
        option.value = item[0];
        option.textContent = item[1];
        select.appendChild(option);
      });
      return select;
    }

    function effortSelect() {
      return controlSelect([
        ['', 'Default (xhigh)'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'],
        ['xhigh', 'XHigh'], ['max', 'Max'], ['ultra', 'Ultra']
      ]);
    }

    function sandboxSelect() {
      return controlSelect([
        ['', 'Default'], ['danger-full-access', 'danger-full-access'],
        ['workspace-write', 'workspace-write'], ['read-only', 'read-only']
      ]);
    }

    function textInput(placeholder) {
      var input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder || '';
      return input;
    }

    function controlCheckbox(textContent) {
      var label = document.createElement('label');
      label.className = 'control-checkbox';
      var input = document.createElement('input');
      input.type = 'checkbox';
      var text = document.createElement('span');
      text.textContent = textContent;
      label.append(input, text);
      return { label: label, input: input };
    }

    // cancelText defaults to 'Cancel' (Resume); Cancel job passes 'Back' so a dialog
    // whose confirm button reads "Cancel job" never shows two buttons both saying Cancel.
    // Every open sets it explicitly so one dialog's label never leaks into the next.
    function showControlModal(title, confirmText, cancelText) {
      controlModalTitle.textContent = title;
      controlModalBody.textContent = '';
      controlModalError.textContent = '';
      controlModalConfirm.textContent = confirmText;
      controlModalConfirm.disabled = false;
      controlModalConfirm.classList.remove('danger');
      controlModalCancel.textContent = cancelText || 'Cancel';
      controlAction = null;
      controlModal.hidden = false;
    }

    function closeControlModal() {
      controlModal.hidden = true;
      controlAction = null;
    }

    function openResumeModal(session, title, promptText) {
      showControlModal('Resume ' + (session.engine === 'opencode' ? 'OpenCode' : 'Codex') + ' thread?', 'Resume');
      controlModalBody.appendChild(modalRow('Task', title || 'Codex task'));
      controlModalBody.appendChild(modalRow('Project', session.cwd || ''));
      controlModalBody.appendChild(modalRow('Thread', session.threadId || '', true));
      var prompt = document.createElement('textarea');
      prompt.placeholder = 'Optional prompt override';
      prompt.value = promptText || '';
      controlModalBody.appendChild(controlField('Prompt override', prompt));
      var effort = effortSelect();
      if (session.engine === 'opencode') effort.options[0].textContent = 'OpenCode default variant';
      var model = textInput('default');
      var sandbox = sandboxSelect();
      var fast = controlCheckbox('Fast (priority processing \u2014 uses more quota)');
      var grid = document.createElement('div');
      grid.className = 'control-grid';
      grid.append(controlField('Effort', effort), controlField('Model', model));
      if (session.engine !== 'opencode') grid.append(controlField('Sandbox', sandbox), fast.label);
      controlModalBody.appendChild(grid);
      controlAction = function () {
        return {
          endpoint: '/resume',
          body: resumeBody(session, {
            prompt: prompt.value.trim(), effort: effort.value, model: model.value.trim(),
            fast: fast.input.checked, sandbox: sandbox.value
          }),
          onSuccess: function () { chooseView('LIVE', 'ALL'); }
        };
      };
      prompt.focus();
    }

    function openCancelModal(job) {
      showControlModal('Cancel running job?', 'Cancel job', 'Back');
      controlModalConfirm.classList.add('danger');
      controlModalBody.appendChild(modalRow('Task', job.title || job.id || 'Codex job'));
      controlModalBody.appendChild(modalRow('Project', job.workspaceRoot || ''));
      controlModalBody.appendChild(modalRow('Job ID', job.id || '', true));
      controlModalBody.appendChild(modalWarning('red', 'Cancelling stops this job and cannot be undone.'));
      controlAction = function () {
        return {
          endpoint: '/cancel',
          body: { cwd: job.workspaceRoot, jobId: job.id },
          onSuccess: refreshJobs
        };
      };
      controlModalCancel.focus();
    }

    function modalRow(label, value, mono) {
      var row = document.createElement('div');
      row.className = 'stop-modal-row';
      var name = document.createElement('span');
      name.className = 'stop-modal-label';
      name.textContent = label;
      var val = document.createElement('span');
      val.className = 'stop-modal-value' + (mono ? ' mono' : '');
      val.textContent = value;
      row.append(name, val);
      return row;
    }

    function modalWarning(kind, text) {
      var warning = document.createElement('div');
      warning.className = 'stop-modal-warning ' + kind;
      warning.textContent = text;
      return warning;
    }

    function openStopModal(proc) {
      var session = currentSession();
      var startedMs = sessionStart(selected);
      var warnings = processWarnings(proc, startedMs);
      pendingKillPid = proc.pid;
      stopModalBody.textContent = '';
      stopModalBody.appendChild(modalRow('Task', (session && session.title) || 'Unknown task'));
      stopModalBody.appendChild(modalRow('Project', session ? projectName(session.cwd) : 'Unknown'));
      stopModalBody.appendChild(modalRow('PID', proc.pid + '  (' + proc.name + ')', true));
      stopModalBody.appendChild(modalRow('Started', proc.started ? new Date(proc.started).toLocaleTimeString() : 'Unknown'));
      stopModalBody.appendChild(modalRow('Command', String(proc.cmd || '(unknown command line)'), true));
      if (warnings.shared) {
        stopModalBody.appendChild(modalWarning('red',
          'Possibly shared Codex process (app-server / MCP). A Codex Desktop or VS Code one can host several tasks, and stopping it stops ALL of them; a plugin job’s app-server serves only that job.'));
      }
      if (warnings.timeMatch) {
        stopModalBody.appendChild(modalWarning('ok', 'Process start time matches this task’s start time.'));
      } else {
        stopModalBody.appendChild(modalWarning('yellow',
          'This process does not match this task’s start time. The task’s own process may already have exited.'));
      }
      stopModalBody.appendChild(modalWarning('red', 'Stopping kills the process and its entire child tree. This cannot be undone.'));
      stopModalConfirm.hidden = false;
      stopModalConfirm.disabled = false;
      stopModalCancel.textContent = 'Cancel';
      stopModal.hidden = false;
      stopModalCancel.focus();
    }

    function rovingKeydown(bar) {
      return function (event) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        var buttons = Array.prototype.slice.call(bar.querySelectorAll('button'));
        var current = buttons.indexOf(document.activeElement);
        if (current === -1) return;
        event.preventDefault();
        var next = rovingFocusIndex(current, buttons.length, event.key);
        buttons[next].focus();
      };
    }
    // The one copy-command table, shared by both menus.
    var COPY_COMMANDS = {
      'copy-resume': { build: resumeCommand, done: 'Resume command copied' },
      'copy-continue': { build: continueCommand, done: 'Continue command copied' },
      'copy-fork': { build: forkCommand, done: 'Fork command copied' },
      'copy-archive': { build: archiveCommand, done: 'Archive command copied' },
      'copy-unarchive': { build: unarchiveCommand, done: 'Unarchive command copied' }
    };

    function toggleDismissed(id) {
      var ids = prefs.dismissed = prefs.dismissed || [];
      var at = ids.indexOf(id);
      if (at === -1) ids.push(id); else ids.splice(at, 1);
      savePrefs();
      lastListSignature = '';
      lastFilterSignature = '';
      lastHomeSignature = '';
      renderFilters();
      renderList();
      renderHeader();
      if (showOverview()) renderFeed();
    }

    function closeContextMenu() { contextMenu.hidden = true; }

    // One handler table for the ... menu and the right-click menu (ids from menuItems).
    function runMenuAction(id, row, button) {
      var copy = COPY_COMMANDS[id];
      if (copy) {
        if (row.threadId) copyText(copy.build(row.threadId), button, copy.done);
        return;
      }
      if (id === 'dismiss') { toggleDismissed(row.id); return; }
      if (id === 'resume-job' || id === 'resume-session') {
        var target = resumeTarget(row);
        if (target) openResumeModal(target, row.title);
        return;
      }
      if (id === 'cancel-job') { openCancelModal(row.job); return; }
      if (id === 'show-result') { openJob(row.job); return; }
      if (id === 'show-processes' || id === 'stop') {
        // From an overview row the task is not open yet: open it so the panel has a header.
        if (row.session.id !== selected || showOverview()) selectSession(row.session.id, true);
        showProcesses(id === 'stop');
      }
    }

    // Copy items keep the ... menu open so their "copied" label shows, as today.
    function actionMenuPick(id) { if (id.indexOf('copy-') !== 0) closeActionMenu(); }
    // What the menu shows for this row; renderHeader rebuilds an open ... menu when it changes.
    function menuSignature(row) {
      return JSON.stringify(menuItems(row, { dismissed: isDismissed(row.id) }).map(function (item) { return [item.id, item.label]; }));
    }

    // Grouped menu items as DOM (labels via textContent). onPick(id) runs before the action.
    // Returns the number of items.
    function fillMenu(container, row, onPick) {
      var items = menuItems(row, { dismissed: isDismissed(row.id) });
      container.dataset.signature = menuSignature(row);
      container.textContent = '';
      var group = null;
      items.forEach(function (entry) {
        if (entry.group !== group) {
          group = entry.group;
          var label = document.createElement('div');
          label.className = 'menu-group';
          label.textContent = group;
          container.appendChild(label);
        }
        var button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.dataset.action = entry.id;
        button.textContent = entry.label;
        button.title = entry.title;
        if (entry.danger) button.className = 'danger';
        button.addEventListener('click', function () {
          onPick(entry.id);
          runMenuAction(entry.id, row, button);
        });
        container.appendChild(button);
      });
      return items.length;
    }

    function openContextMenu(event, row) {
      if (!row || !fillMenu(contextMenu, row, closeContextMenu)) return;
      showContextMenuAt(event);
    }
    function openClaudeContextMenu(event, run) {
      // Copy items keep the menu open so a refusal from /claude/run stays readable.
      fillClaudeMenu(contextMenu, run, null, function (id) { if (id.indexOf('copy-') !== 0) closeContextMenu(); });
      showContextMenuAt(event);
    }
    function showContextMenuAt(event) {
      event.preventDefault();
      contextMenu.hidden = false;
      var pad = 8;
      contextMenu.style.left = Math.max(pad, Math.min(event.clientX, window.innerWidth - contextMenu.offsetWidth - pad)) + 'px';
      contextMenu.style.top = Math.max(pad, Math.min(event.clientY, window.innerHeight - contextMenu.offsetHeight - pad)) + 'px';
    }

    // The process panel under the header, for the open task (STOP on a row opens the Stop dialog).
    // stopBest also opens the Stop dialog for a process that started with the task (it asks first).
    async function showProcesses(stopBest) {
      closeActionMenu();
      processPanel.hidden = false;
      processPanel.textContent = 'Looking for matching Codex processes…';
      var processes = [];
      try { processes = await (await fetch('/procs')).json(); } catch (_) {}
      processPanel.textContent = '';
      if (!processes.length) {
        processPanel.textContent = 'No matching Codex processes were found. The task may already have exited.';
        return;
      }
      var started = sessionStart(selected);
      processes.sort(function (a, b) { return Math.abs(a.started - started) - Math.abs(b.started - started); });
      var closeMatch = processes.some(function (process) { return started && Math.abs(process.started - started) < 15000; });
      if (started && !closeMatch) {
        var warning = document.createElement('div');
        warning.style.color = 'var(--yellow)';
        warning.style.marginBottom = '8px';
        warning.textContent = 'No process closely matches this task start time. Shared app-server processes can host several tasks; stopping one may affect all of them.';
        processPanel.appendChild(warning);
      }
      processes.forEach(function (process) {
        var row = document.createElement('div');
        row.className = 'process';
        var kill = document.createElement('button');
        kill.type = 'button';
        kill.className = 'kill-button';
        kill.textContent = 'STOP';
        kill.addEventListener('click', function () { openStopModal(process); });
        var description = document.createElement('span');
        description.className = 'mono';
        description.textContent = 'PID ' + process.pid + '  ' + process.name + '  ' + String(process.cmd || '').slice(0, 180);
        row.append(kill, description);
        processPanel.appendChild(row);
      });
      // Only a process started with the task is offered straight away; otherwise the user picks.
      if (stopBest && closeMatch) openStopModal(processes[0]);
    }

