'use strict';
    function setConnection(state, label) {
      connection.className = state;
      connectionText.textContent = label;
    }

    function applyPrefs() {
      if (prefs.sideWidthSet) {
        var savedWidth = Math.max(240, Number(prefs.sideWidth) || 340);
        prefs.sideWidth = window.innerWidth > 760
          ? Math.round(clamp(savedWidth, 240, Math.max(260, window.innerWidth * .55)) / 4) * 4
          : savedWidth;
        document.documentElement.style.setProperty('--sidebar-width', prefs.sideWidth + 'px');
      } else document.documentElement.style.removeProperty('--sidebar-width');
      document.body.classList.toggle('side-collapsed', !!prefs.sideCollapsed);
      // The page decides the body layout: a workflow shows its run view, a chat its transcript, an agent the side panel.
      var page = pageKind();
      document.body.classList.toggle('claude-tab', page === 'workflow');
      document.body.classList.toggle('chat-page', page === 'chat' || page === 'opencode' || page === 'ghost');
      document.body.classList.toggle('opencode-page', page === 'opencode');
      document.body.classList.toggle('overview-page', page === 'overview');
      document.body.classList.toggle('panel-open', !!prefs.panel || panelDocked());
      search.value = prefs.query || '';
      autoOpenToggle.classList.toggle('on', !!prefs.autoFollow);
      autoOpenToggle.setAttribute('aria-pressed', prefs.autoFollow ? 'true' : 'false');
      autoOpenToggle.textContent = 'Auto-open: ' + (prefs.autoFollow ? 'On' : 'Off');
    }

    function currentRows() { return buildRows(sessions, jobs); }
    function currentModel() {
      if (modelCache.version !== dataVersion) modelCache = { version: dataVersion, model: buildNodes(claudeChats, claudeRuns, currentRows(), jobs, Date.now(), opencodeChats) };
      return modelCache.model;
    }
    // The Live overview shows whenever no node is open, or the user asked for it (prefs.home, set by
    // re-clicking the active Live tab; cleared by picking any node or view).
    function showOverview() { var page = pageKind(); return page === 'overview' || (page === 'codex' && !currentSession()); }
    // No transcript in the main feed: the overview, a workflow (its run view) or a ghost chat.
    function feedOverview() { var page = pageKind(); return page === 'chat' || page === 'opencode' ? false : page === 'workflow' || page === 'ghost' ? true : showOverview(); }
    // Whose feed rows the open-state and paging choices belong to.
    function feedScope() { return pageKind() === 'chat' || pageKind() === 'opencode' ? 'chat:' + prefs.node : String(selected || ''); }

    function viewButton(className, label, count, on) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = className + (on ? ' on' : '');
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.append(document.createTextNode(label + ' '));
      var badge = document.createElement('span');
      badge.className = 'count';
      badge.textContent = count;
      button.appendChild(badge);
      return button;
    }

    // Scroll edges: a fade at the tree's top or bottom, and at the chip row's left or right (phone), only while there is more.
    function listEdges() {
      var wrap = document.getElementById('list-wrap');
      wrap.classList.toggle('more-above', list.scrollTop > 2);
      wrap.classList.toggle('more-below', list.scrollHeight - list.scrollTop - list.clientHeight > 2);
    }
    function chipEdges() {
      var wrap = document.getElementById('chips-wrap');
      wrap.classList.toggle('more-left', chipsBar.scrollLeft > 2);
      wrap.classList.toggle('more-right', chipsBar.scrollWidth - chipsBar.scrollLeft - chipsBar.clientWidth > 2);
    }

    function renderFilters() {
      var model = currentModel();
      var view = currentView();
      var counts = nodeViewCounts(model, view, Date.now(), prefs.dismissed);
      var signature = JSON.stringify([prefs.tab, prefs.chip, prefs.kinds, prefs.home, counts]);
      if (signature === lastFilterSignature) return;
      lastFilterSignature = signature;
      tabsBar.textContent = '';
      Object.keys(VIEW_TABS).forEach(function (tab) {
        var count = counts[tab][tab === 'HISTORY' ? 'EVERYTHING' : 'ALL'];
        var button = viewButton('tab-button', VIEW_LABELS[tab], '(' + count + ')', prefs.tab === tab);
        button.dataset.tab = tab;
        button.title = tab === 'LIVE' ? 'Everything from the last 24 hours, and what still needs you. Click again for the overview.' : 'Finished and older Codex sessions';
        button.addEventListener('click', function () {
          // Clicking the already-active Live tab opens the overview instead of re-picking a chip.
          if (tab === 'LIVE' && prefs.tab === 'LIVE' && !prefs.home) {
            prefs.home = true;
            prefs.panel = null;
            lastHomeSignature = '';
            savePrefs();
            applyPrefs();
            syncTranscripts();
            renderFilters();
            renderList();
            renderHeader();
            renderFeed();
            renderPanel();
            return;
          }
          chooseView(tab, prefs.tab === tab ? prefs.chip : VIEW_TABS[tab][0]);
        });
        tabsBar.appendChild(button);
      });
      chipsBar.textContent = '';
      VIEW_TABS[prefs.tab].forEach(function (chip) {
        var count = counts[prefs.tab][chip];
        var label = prefs.tab === 'LIVE' && chip === 'ANSWER' ? 'Needs you' : VIEW_LABELS[chip];
        var button = viewButton('chip-button' + (chip === 'RUNNING' && count > 0 ? ' has-sessions' : '') + (count === 0 ? ' zero' : ''), label, count, prefs.chip === chip);
        button.dataset.chip = chip;
        if (chip === 'RUNNING' && prefs.tab === 'LIVE') button.title = 'Work that runs now, and work that waits for your answer';
        button.addEventListener('click', function () { chooseView(prefs.tab, chip); });
        chipsBar.appendChild(button);
      });
      if (prefs.tab === 'LIVE') {
        var kinds = kindChipsElement();
        kinds.querySelectorAll('.chip-button.kind').forEach(function (button) {
          var kind = button.dataset.kind;
          var on = !!(prefs.kinds || {})[kind];
          button.classList.toggle('on', on);
          button.setAttribute('aria-pressed', String(on));
          button.addEventListener('click', function () {
            prefs.kinds = Object.assign({ claude: false, codex: false }, prefs.kinds || {});
            prefs.kinds[kind] = !prefs.kinds[kind];
            chooseView('LIVE', prefs.chip);
          });
        });
        chipsBar.appendChild(kinds);
      }
      chipEdges();
    }

    function chooseView(tab, chip) {
      prefs.tab = tab;
      prefs.chip = chip;
      prefs.autoFollow = false;
      prefs.home = false;
      savePrefs();
      applyPrefs();
      renderFilters();
      renderList();
      renderHeader();
      renderFeed();
    }

    // previousStatus: the open Codex node's status before the update. When the change takes its root out
    // of the view, the chip widens to All (History: Everything), so the open node stays in the tree.
    // The Auto-open toggle lives on the overview. Turning it on leaves the overview and opens the running
    // Codex task now. It never pulls the view away from an open Claude chat, workflow or agent.
    function setAutoOpen(on, running) {
      prefs.autoFollow = on;
      if (on) {
        prefs.home = false;
        followRunningSession(running);
      }
      savePrefs();
    }

    function followRunningSession(running) {
      if (prefs.home || !prefs.autoFollow || !running || prefs.panel) return;
      var page = pageKind();
      if (page !== 'overview' && page !== 'codex') return;
      if (running.id !== selected) selectSession(running.id, false);
      // The opened task's tree must be in the list: a chip or kind that hides it widens to everything.
      var model = currentModel();
      var root = prefs.node ? nodeRoot(model, prefs.node) : null;
      if (root && viewRoots(model, currentView(), Date.now(), prefs.dismissed, '').indexOf(root.id) === -1) {
        prefs.tab = 'LIVE';
        prefs.chip = 'ALL';
        prefs.kinds = {};
      }
      savePrefs();
    }

