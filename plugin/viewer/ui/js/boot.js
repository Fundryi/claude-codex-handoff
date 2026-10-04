'use strict';
    [list, claudeOverview, panelBody].forEach(function (el) { snapScrollToGrid(el, false); });
    snapScrollToGrid(feed, true);
    var panelInner = document.createElement('div');
    panelInner.id = 'panel-inner';
    panelBody.appendChild(panelInner);
    counter.addEventListener('click', function () {
      var c = counterCounts();
      prefs.kinds = { claude: false, codex: false };
      chooseView('LIVE', c.ANSWER ? 'ANSWER' : c.ATTENTION ? 'ATTENTION' : 'RUNNING');
    });
    controlModalForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!controlAction) return;
      controlModalError.textContent = '';
      controlModalConfirm.disabled = true;
      try {
        var action = controlAction();
        var response = await fetch(action.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action.body)
        });
        var data = {};
        try { data = await response.json(); } catch (_) {}
        if (!response.ok || data.ok === false) {
          controlModalError.textContent = data.error || ('Request failed with HTTP ' + response.status);
          if (response.status === 409) {
            controlModalError.textContent += '\nCancel that run first: ⋯ menu > Cancel job.';
          }
          return;
        }
        var onSuccess = action.onSuccess;
        closeControlModal();
        if (onSuccess) onSuccess(data);
      } catch (error) {
        controlModalError.textContent = 'Request failed: ' + error.message;
      } finally {
        if (!controlModal.hidden) controlModalConfirm.disabled = false;
      }
    });
    controlModalCancel.addEventListener('click', closeControlModal);
    controlModal.addEventListener('click', function (event) {
      if (event.target === controlModal) closeControlModal();
    });

    stopModalConfirm.addEventListener('click', async function () {
      if (pendingKillPid == null) return;
      stopModalConfirm.disabled = true;
      var message = '';
      try { message = await (await fetch('/kill?pid=' + pendingKillPid, { method: 'POST' })).text(); }
      catch (error) { message = 'Request failed: ' + error; }
      pendingKillPid = null;
      stopModalBody.textContent = '';
      stopModalBody.appendChild(modalWarning(/^killed/i.test(message) ? 'ok' : 'yellow', message));
      stopModalConfirm.hidden = true;
      stopModalCancel.textContent = 'Close';
      processPanel.hidden = true;
    });
    stopModalCancel.addEventListener('click', function () {
      stopModal.hidden = true;
      pendingKillPid = null;
    });
    stopModal.addEventListener('click', function (event) {
      if (event.target === stopModal) { stopModal.hidden = true; pendingKillPid = null; }
    });
    jobModalClose.addEventListener('click', function () { jobModal.hidden = true; });
    jobModal.addEventListener('click', function (event) {
      if (event.target === jobModal) jobModal.hidden = true;
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        var closedSomething = false;
        if (!stopModal.hidden) { stopModal.hidden = true; pendingKillPid = null; closedSomething = true; }
        if (!jobModal.hidden) { jobModal.hidden = true; closedSomething = true; }
        if (!controlModal.hidden) { closeControlModal(); closedSomething = true; }
        if (!contextMenu.hidden) { closeContextMenu(); closedSomething = true; }
        if (!actionMenu.hidden) { closeActionMenu(); closedSomething = true; }
        // Nothing else was open: on mobile, Escape closes the drawer instead.
        if (!closedSomething && document.body.classList.contains('mobile-side-open')) {
          document.body.classList.remove('mobile-side-open');
        } else if (!closedSomething && prefs.panel && !isEditableElement(document.activeElement)) {
          closePanel(); // then the side panel
        }
        return;
      }
      if (event.key === '/' && !isEditableElement(document.activeElement) &&
        stopModal.hidden && jobModal.hidden && controlModal.hidden) {
        event.preventDefault();
        search.focus();
      }
    });

    document.getElementById('side-backdrop').addEventListener('click', function () {
      document.body.classList.remove('mobile-side-open');
    });

    tabsBar.addEventListener('keydown', rovingKeydown(tabsBar));
    chipsBar.addEventListener('keydown', rovingKeydown(chipsBar));

    resumeSessionButton.addEventListener('click', function () {
      var row = selectedRow();
      var target = row && resumeTarget(row);
      if (target) openResumeModal(target, row.title);
    });

    document.getElementById('open-elsewhere-show').addEventListener('click', function () {
      prefs.kinds = { claude: false, codex: false };
      chooseView(prefs.tab, prefs.tab === 'HISTORY' ? 'EVERYTHING' : 'ALL');
    });

    search.addEventListener('input', function () {
      prefs.query = search.value;
      savePrefs();
      window.clearTimeout(historySearchTimer);
      lastListSignature = '';
      renderList();
      var query = String(prefs.query || '').trim();
      if (!query) {
        historyResults = [];
        lastListSignature = '';
        renderList();
        return;
      }
      historySearchTimer = window.setTimeout(async function () {
        try {
          var response = await fetch('/search?q=' + encodeURIComponent(query));
          var data = await response.json();
          if (String(prefs.query || '').trim() !== query) return; // stale response
          historyResults = data.results || [];
        } catch (_) {
          historyResults = [];
        }
        lastListSignature = '';
        renderList();
      }, 250);
    });
    autoOpenToggle.addEventListener('click', function () {
      setAutoOpen(!prefs.autoFollow, newestRunning());
      applyPrefs();
      renderFilters();
      renderList();
      renderHeader();
      renderFeed();
    });
    jumpLatest.addEventListener('click', scrollToLatest);
    // toggle does not bubble: capture it. Rows restored by renderFeed fire it too, harmlessly.
    feedInner.addEventListener('toggle', function (event) {
      var row = event.target;
      if (!row.dataset || !row.dataset.key || feedOverview()) return;
      var id = feedScope() + '|' + row.dataset.key;
      if (row.open !== (row.dataset.autoOpen === '1')) feedOpenChoices[id] = row.open;
      else delete feedOpenChoices[id];
    }, true);
    feed.addEventListener('scroll', function () {
      jumpLatest.hidden = feedOverview() || nearBottom();
    }, { passive: true });

    document.getElementById('hide-side').addEventListener('click', function () {
      if (window.innerWidth <= 760) document.body.classList.remove('mobile-side-open');
      else {
        prefs.sideCollapsed = true;
        savePrefs();
        applyPrefs();
      }
    });
    document.getElementById('show-side').addEventListener('click', function () {
      if (window.innerWidth <= 760) document.body.classList.add('mobile-side-open');
      else {
        prefs.sideCollapsed = false;
        savePrefs();
        applyPrefs();
      }
    });

    splitter.addEventListener('pointerdown', function (event) {
      splitter.dataset.startWidth = document.getElementById('side').getBoundingClientRect().width;
      splitter.dataset.startX = event.clientX;
      splitter.setPointerCapture(event.pointerId);
      splitter.classList.add('dragging');
    });
    splitter.addEventListener('pointermove', function (event) {
      if (!splitter.hasPointerCapture(event.pointerId)) return;
      prefs.sideWidth = Math.round(clamp(Number(splitter.dataset.startWidth) + event.clientX - Number(splitter.dataset.startX), 240, window.innerWidth * .55) / 4) * 4; // steps of 4 px: the panes stay on the pixel grid
      prefs.sideWidthSet = true;
      document.documentElement.style.setProperty('--sidebar-width', prefs.sideWidth + 'px');
    });
    splitter.addEventListener('pointerup', function (event) {
      if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
      splitter.classList.remove('dragging');
      savePrefs();
    });
    splitter.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      var width = prefs.sideWidthSet && Number(prefs.sideWidth) > 0 ? Number(prefs.sideWidth) : document.getElementById('side').getBoundingClientRect().width;
      prefs.sideWidth = clamp(width + (event.key === 'ArrowRight' ? 16 : -16), 240, window.innerWidth * .55);
      prefs.sideWidthSet = true;
      savePrefs();
      applyPrefs();
    });

    actionsButton.addEventListener('click', function () {
      if (!actionMenu.hidden) { closeActionMenu(); return; }
      if (pageKind() === 'chat' || pageKind() === 'opencode' || pageKind() === 'ghost') {
        var node = pageNode();
        if (!node) return;
        if (node.row && node.row.job) fillMenu(actionMenu, node.row, actionMenuPick);
        else fillChatMenu(actionMenu, node, actionMenuPick);
        actionMenu.hidden = false;
        actionsButton.setAttribute('aria-expanded', 'true');
        return;
      }
      if (pageKind() === 'workflow') {
        var run = claudeRunById(claudeRunId());
        if (!run) return;
        fillClaudeMenu(actionMenu, run, panelAgentId(), actionMenuPick);
        actionMenu.hidden = false;
        actionsButton.setAttribute('aria-expanded', 'true');
        return;
      }
      var row = selectedRow();
      if (!row || !fillMenu(actionMenu, row, actionMenuPick)) return;
      actionMenu.hidden = false;
      actionsButton.setAttribute('aria-expanded', 'true');
    });
    document.addEventListener('click', function (event) {
      closeContextMenu();
      if (actionMenu.hidden || actionMenu.contains(event.target) || actionsButton.contains(event.target)) return;
      closeActionMenu();
    });

    list.addEventListener('scroll', closeContextMenu, { passive: true });
    list.addEventListener('mouseleave', function () { lastTreeSignature = ''; renderList(); });
    // Capture phase: must run before the row handler that opens the menu, or it would close it again.
    document.addEventListener('contextmenu', function (event) {
      if (!contextMenu.hidden && !contextMenu.contains(event.target)) closeContextMenu();
    }, true);

    window.addEventListener('resize', function () {
      applyPrefs();
      if (window.innerWidth > 760) document.body.classList.remove('mobile-side-open');
      renderHeader(); // the meta line shows the project name at 760 px and below, the full path above
      if (showOverview()) renderHome();
    });

    document.addEventListener('selectionchange', function () {
      if (feedRenderPending && !feedRenderFrame) feedRenderFrame = requestAnimationFrame(flushFeedRender);
    });

    list.addEventListener('keydown', function (event) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(event.key) === -1) return;
      var items = Array.prototype.slice.call(list.querySelectorAll('.row[data-id], .fold:not(.cap), .group-caption'));
      var index = items.indexOf(document.activeElement);
      if (index === -1) return;
      event.preventDefault();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        var next = items[index + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) next.focus();
        return;
      }
      var id = document.activeElement.dataset.id;
      var model = currentModel();
      var node = id && model.nodes[id];
      if (!node) return;
      prefs.openNodes = prefs.openNodes || {};
      var isOpen = node.children.length > 0 && nodeOpen(node, revealSet(model));
      if (event.key === 'ArrowRight' && node.children.length && !isOpen) prefs.openNodes[id] = true;
      else if (event.key === 'ArrowLeft' && isOpen) prefs.openNodes[id] = false;
      else if (event.key === 'ArrowLeft' && node.parentId) {
        var parentRow = list.querySelector('.row[data-id="' + CSS.escape(node.parentId) + '"]');
        if (parentRow) parentRow.focus();
        return;
      } else return;
      savePrefs();
      renderList();
      var again = list.querySelector('.row[data-id="' + CSS.escape(id) + '"]');
      if (again) again.focus();
    });

    // Live updates rebuild rows, and a new element starts its animation at 0, so the working arc and the
    // breathing dots jumped back on every update. Pin each looping animation to the page clock before the
    // next paint: a rebuilt arc continues where the old one was.
    var animationSyncQueued = false;
    new MutationObserver(function () {
      if (animationSyncQueued) return;
      animationSyncQueued = true;
      requestAnimationFrame(function () {
        animationSyncQueued = false;
        var now = document.timeline.currentTime;
        document.getAnimations().forEach(function (animation) {
          if (animation.animationName === 'mk-orbit' || animation.animationName === 'breathe') animation.currentTime = now;
        });
      });
    }).observe(document.body, { childList: true, subtree: true });

    var events = new EventSource('/events');
    events.onopen = function () { if (!controlsBlocked) setConnection('connected', 'Live updates connected'); };
    events.onerror = function () { setConnection('disconnected', 'Reconnecting\u2026'); };
    events.onmessage = function (message) {
      var data = JSON.parse(message.data);
      if (data.type === 'sessions') {
        var previousSelected = selected;
        var previousFeedStatus = (selectedRow() || {}).status;
        data.sessions.forEach(function (session) {
          var oldStatus = previousStatus[session.id];
          if (seeded && session.id !== selected && oldStatus !== session.status) unread.add(session.id);
          previousStatus[session.id] = session.status;
        });
        sessions = data.sessions;
        dataVersion++;
        seeded = true;
        // forget dismissals for sessions and job-only rows that fell out of the tracked lists
        if (sessions.length && (prefs.dismissed || []).length) {
          var kept = keptDismissed(prefs.dismissed, sessions, jobs, jobsLoaded, opencodeChatsLoaded ? opencodeChats.chats : null);
          if (kept.length !== prefs.dismissed.length) { prefs.dismissed = kept; savePrefs(); }
        }
        if (selected && !sessions.some(function (session) { return session.id === selected; })) selected = null;
        migrateSelection();
        openPending();
        followRunningSession(newestRunning());
        renderFilters();
        renderList();
        renderHeader();
        renderResultCard();
        if (showOverview()) renderFeed();
        else if (selected === previousSelected && (selectedRow() || {}).status !== previousFeedStatus) requestFeedRender();
      }
      if (data.type === 'claudeChats') {
        claudeChats = { chats: data.chats || [], ghosts: data.ghosts || [] };
        claudeChatsLoaded = true;
        dataVersion++;
        migrateSelection();
        syncTranscripts();
        renderFilters();
        renderList();
        renderHeader();
        renderPanel();
        // A workflow or ghost page can only draw once its node is in the tree.
        if (pageKind() === 'workflow') renderClaudeBody();
        else if (pageKind() === 'ghost' || showOverview()) renderFeed();
      }
      if (data.type === 'opencodeChats') {
        opencodeChats = { chats: data.chats || [] };
        opencodeChatsLoaded = true;
        dataVersion++;
        migrateSelection();
        syncTranscripts();
        renderFilters();
        renderList();
        renderHeader();
        if (pageKind() === 'opencode') requestFeedRender(); else if (showOverview()) renderFeed();
      }
      if (data.type === 'claudeUsage') {
        claudeUsage = data.usage || null;
        renderPlans();
      }
      if (data.type === 'codexLimits') {
        codexLimits = data.limits || null;
        renderPlans();
      }
      if (data.type === 'claudeRuns') {
        claudeRuns = data.runs || [];
        claudeLoaded = true;
        dataVersion++;
        renderFilters();
        renderList();
        renderHeader();
        if (pageKind() === 'workflow') renderClaudeBody(); // the open transcript follows its own poll
        migrateSelection();
        syncTranscripts();
        renderPanel();
      }
      if (data.type === 'snapshot') {
        store[data.session] = data.events;
        // Through requestFeedRender, like new events: a reconnect keeps the reader's scroll and selection.
        if (data.session === selected && !showOverview()) requestFeedRender();
      }
      if (data.type === 'events') {
        var existing = store[data.session] = store[data.session] || [];
        existing.push.apply(existing, data.events);
        if (existing.length > 500) existing.splice(0, existing.length - 500);
        if (data.session === selected && !showOverview()) {
          requestFeedRender();
        } else if (data.session !== selected) {
          unread.add(data.session);
          renderList();
        }
      }
    };

    var notifications = new EventSource('/notifications');
    notifications.onmessage = function (message) {
      try {
        var data = JSON.parse(message.data);
        if (data.type === 'job') refreshJobs();
      } catch (_) {}
    };

    // Prefs saved before the tabs carry filter/home instead of tab/chip. TABS exists only from here on.
    Object.assign(prefs, nodeSavedView(prefs));
    // A selection saved before the redesign (a Codex row id, a Claude run) maps to its node once the data is in.
    var legacySelection = prefs.node === undefined && (prefs.selected || prefs.claudeRun) ? { selected: prefs.selected, claudeRun: prefs.claudeRun, claudeAgent: prefs.claudeAgent } : null;
    function migrateSelection() {
      if (!legacySelection) return;
      var id = nodeIdFor(currentModel(), legacySelection);
      if (id) { legacySelection = null; selectNode(id, false); return; }
      if (seeded && claudeChatsLoaded) legacySelection = null; // not loaded any more: the overview shows
    }
    delete prefs.claudeRun;
    delete prefs.claudeAgent;
    if (pageKind() !== 'codex') selected = null;
    delete prefs.filter;
    delete prefs.autoScroll; // dropped pref: auto-scroll is now always the follow-at-bottom behavior
    taskClaude.prepend(glyph('flow'));
    taskHandoff.prepend(glyph('claude')); // the clay starter glyph: Claude started it, Codex does the work
    applyPrefs();
    list.addEventListener('scroll', listEdges, { passive: true });
    list.addEventListener('scroll', listScrolled, { passive: true });
    chipsBar.addEventListener('scroll', chipEdges, { passive: true });
    window.addEventListener('resize', function () { listEdges(); chipEdges(); renderPanel(); });
    renderFilters();
    renderList();
    renderHeader();
    renderFeed();
    syncTranscripts();
    renderPanel();
    renderPlans();
    refreshJobs();
    window.setInterval(function () { renderList(); renderHeader(); renderPlans(); renderPanel(); if (pageKind() === 'workflow') renderClaudeBody(); else if (feedOverview()) renderFeed(); }, 10000);
    // Rows merge job state into every tab, so job liveness is polled everywhere.
    window.setInterval(refreshJobs, 5000);
