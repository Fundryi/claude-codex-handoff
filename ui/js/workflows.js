'use strict';
    // -- Claude workflows: the Claude tab's list, header, run view and agent panel. Every Claude
    // surface carries the mark (Claude's clay, flow icon, "Claude workflow"), so it never looks like Codex work.
    function claudeRunById(id) { return claudeRuns.find(function (run) { return run.id === id; }) || null; }
    function textDiv(className, text) {
      var div = document.createElement('div');
      div.className = className;
      div.textContent = text;
      return div;
    }

    // Header counter (design 4.5): every kind, over the Live roots' roll-up. Hidden when all three are zero.
    var counter = document.getElementById('counter');
    function counterCounts() {
      var model = currentModel();
      var counts = { RUNNING: 0, ANSWER: 0, ATTENTION: 0 };
      viewRoots(model, { tab: 'LIVE', chip: 'ALL', kinds: {} }, Date.now(), prefs.dismissed, '').forEach(function (id) {
        var states = model.nodes[id].states;
        Object.keys(counts).forEach(function (s) { if (states[s]) counts[s]++; });
      });
      return counts;
    }
    function renderCounter() {
      var c = counterCounts();
      var text = [c.RUNNING, c.ANSWER, c.ATTENTION].join('/');
      counter.hidden = !c.RUNNING && !c.ANSWER && !c.ATTENTION;
      if (counter.dataset.text === text) return;
      counter.dataset.text = text;
      counter.textContent = '';
      [['RUNNING', 'LIVE', 'running', 'running'], ['ANSWER', 'NEEDS_ANSWER', 'need you', 'needs you'], ['ATTENTION', 'STALE', 'need attention', 'needs attention']].forEach(function (k) {
        if (!c[k[0]]) return;
        var span = document.createElement('span');
        span.append(stateDot(k[1]), document.createTextNode(c[k[0]] + ' ' + (c[k[0]] === 1 ? k[3] : k[2])));
        counter.appendChild(span);
      });
    }
    // A workflow agent row in the run view: open it in the side panel.
    function openClaudeAgent(id) {
      var runId = claudeRunId();
      var run = claudeRunById(runId);
      if (!run) return;
      selectNode('wfagent:' + run.sessionId + '/' + run.id + '/' + id, true);
    }

    function claudeMetaItem(text, title) {
      var span = textSpan('meta-item', text);
      span.title = title || text;
      return span;
    }
    // Header: the Claude workflow badge always; then the open run (its agent shows in the side panel).
    function renderClaudeHeader() {
      var run = claudeRunById(claudeRunId());
      var now = Date.now();
      taskMeta.textContent = '';
      taskHandoff.hidden = true;
      taskFast.hidden = true;
      resumeSessionButton.hidden = true;
      autoOpenToggle.hidden = true;
      taskClaude.hidden = false;
      actionsButton.hidden = !run;
      if (!run) {
        closeActionMenu();
        taskFacts.hidden = true;
        taskStatus.hidden = true;
        taskTitle.textContent = !claudeLoaded || !claudeChatsLoaded ? 'Loading this workflow…' : 'This workflow is not tracked any more';
        taskTitle.title = '';
        if (claudeLoaded && claudeChatsLoaded) taskMeta.appendChild(claudeMetaItem('The viewer tracks the 20 newest workflow runs of the last 24 hours, and every running one.', 'Its files are still in ~/.claude/projects. Read only.'));
        return;
      }
      taskStatus.hidden = false;
      var view = claudeStatusView(run.status);
      taskStatus.className = 'status ' + view.badge;
      taskStatus.textContent = view.label;
      taskStatus.title = view.help;
      taskTitle.textContent = run.name || run.id;
      taskTitle.title = [run.name, run.description].filter(Boolean).join('\n');
      renderTaskFacts('claude', run.project, 'Project: ' + run.project, run.model, run.effort);
      if (run.description) taskMeta.appendChild(claudeMetaItem(run.description)).classList.add('claude-desc');
      taskMeta.appendChild(claudeMetaItem('session ' + run.session, 'Claude Code session that started the workflow'));
      var started = run.startedMs ? new Date(run.startedMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      var duration = claudeRunDuration(run, now);
      if (started || duration) {
        taskMeta.appendChild(claudeMetaItem([started ? 'started ' + started : '', duration ? (run.status === 'RUNNING' ? 'running ' : 'took ') + formatDuration(duration) : ''].filter(Boolean).join(' · '),
          run.startedMs ? 'Started ' + new Date(run.startedMs).toLocaleString() : 'Duration'));
      }
      var reason = run.error ? 'Details unavailable: this run’s files are in a format this viewer does not know.'
        : run.status === 'QUIET' ? 'Quiet for ' + formatDuration(now - run.updatedMs) + ', no finish record. May be paused, rate-limited or ended. Use /workflows in a terminal or Remote Control to check.'
        : run.status === 'FAILED' ? 'The workflow reported failed.' : '';
      if (reason) {
        var reasonLine = claudeMetaItem(reason);
        reasonLine.id = 'wait-reason';
        reasonLine.className = 'meta-item STALE';
        taskMeta.appendChild(reasonLine);
      }
    }

    // One agent in the run view: kind mark (a Claude ring that carries the state), label, last write, and while running its tool and context.
    // The open agent's row is highlighted (its transcript is in the side panel); running rows get a faint blue.
    function claudeAgentRow(agent, run) {
      var view = claudeAgentView(agent.state);
      var open = agent.id === panelAgentId();
      var button = document.createElement('button');
      button.type = 'button';
      // .claude-agent stays as the hook the open/close code queries; .agent-row is the look (grid: mark, label, tail).
      button.className = 'agent-row claude-agent ' + agent.state + (open ? ' open' : '');
      button.setAttribute('aria-pressed', open ? 'true' : 'false');
      button.dataset.key = 'agent:' + agent.id; // renderClaudeOverview puts focus back by this key
      button.title = [agent.label, view.label + ': ' + view.help, 'agent ' + agent.id, 'Click to open its transcript in the side panel'].join('\n');
      var dot = markElement('ring', 'claude', 'claude', view.label + ': ' + view.help, agent.state);
      var lab = document.createElement('span');
      lab.className = 'lab';
      lab.appendChild(textSpan('t', agent.label || agent.id));
      if (agent.state === 'running' && agent.tool) lab.appendChild(textSpan('tool mono', agent.tool));
      // A script can run one agent on another model or effort: tag only what differs from the run.
      var differs = [agent.model && run.model && agent.model !== run.model ? modelShortName(agent.model) : '',
        agent.effort && run.effort && agent.effort !== run.effort ? agent.effort : ''].filter(Boolean);
      if (differs.length) {
        var tag = textSpan('agent-tag', differs.join(' · '));
        tag.title = 'This agent runs on ' + [agent.model, agent.effort ? 'effort ' + agent.effort : ''].filter(Boolean).join(', ') + ' (the run: ' + [run.model, run.effort].filter(Boolean).join(', ') + ')';
        lab.appendChild(tag);
      }
      // tail: context while running, last write (the words hide on a phone), the state word
      var tail = document.createElement('span');
      tail.className = 'tail';
      tail.appendChild(textSpan('state-word ' + view.badge, view.label.toLowerCase()));
      if (agent.state === 'running' && agent.contextTokens) tail.appendChild(textSpan('', compactCount(agent.contextTokens) + ' context'));
      if (agent.lastWriteMs) { var w = textSpan('', ''); w.append(textSpan('w', 'last write '), document.createTextNode(relativeTime(agent.lastWriteMs))); tail.appendChild(w); }
      button.append(dot, lab, tail);
      button.addEventListener('click', function () { openClaudeAgent(agent.id); });
      return button;
    }

    // A topic row in the run view: chevron, title, steps, state word, tokens, time. A click opens or closes its agents.
    function claudeTopicRow(run, group, isOpen, shown) {
      var state = group.running ? 'running' : group.failed ? 'failed' : 'done';
      var view = claudeAgentView(state);
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'topic-row ' + state;
      button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      button.dataset.key = 'topic:' + group.key;
      button.title = topicTooltip(group) + '\n' + (isOpen ? 'Click to fold its agents away' : 'Click to show its ' + shown + ' agents');
      var chev = document.createElement('span');
      chev.className = 'chev';
      chev.appendChild(glyph('chev'));
      var use = textSpan('use', boundText(group.partial, group.tokens));
      use.title = 'Tokens';
      button.append(chev, textSpan('t', group.title), stepsElement(group), textSpan('state-word ' + view.badge, view.label.toLowerCase()), use, textSpan('when', relativeTime(group.lastWriteMs)));
      button.addEventListener('click', function () {
        openTopics[run.id + '/' + group.key] = !isOpen;
        lastClaudeOverviewSignature = '';
        renderClaudeOverview();
      });
      return button;
    }
    // The agent panel's header. Text only: the close button is static HTML, so focus on it survives
    // the 1.5 s transcript poll (which calls renderHeader).
    // A thin progress bar: done green, failed amber, the rest of the started agents gray.
    function claudeBar(done, failed, started) {
      var bar = document.createElement('div');
      bar.className = 'claude-bar';
      bar.setAttribute('aria-hidden', 'true');
      [['bar-done', done], ['bar-failed', failed]].forEach(function (part) {
        if (!part[1] || !started) return;
        var span = document.createElement('span');
        span.className = part[0];
        span.style.width = (100 * part[1] / started) + '%';
        bar.appendChild(span);
      });
      return bar;
    }
    // Top of the run view: progress over the whole run, totals once finished, and the running agents.
    function claudeRunSummary(run) {
      var c = run.counts || {};
      var box = document.createElement('div');
      box.className = 'claude-summary';
      var line = document.createElement('div');
      line.className = 'claude-summary-line';
      var progress = document.createElement('span');
      progress.title = 'Agents seen in the run journal. Queued agents and the planned total are not on disk.';
      var done = document.createElement('b');
      done.textContent = (c.done || 0) + ' done';
      progress.append(done, document.createTextNode(' of ' + (c.started || 0) + ' started'));
      line.appendChild(progress);
      if (c.running) line.appendChild(textSpan('', c.running + ' running'));
      if (c.failed) line.appendChild(textSpan('', c.failed + ' failed'));
      if (c.ended) line.appendChild(claudeMetaItem(c.ended + ' ended', 'No end record: the run ended or went quiet'));
      if (run.totals) {
        line.appendChild(claudeMetaItem(compactCount(run.totals.tokens) + ' tokens · ' + (run.totals.toolCalls || 0).toLocaleString() + ' tool calls', 'From the finish record'));
      }
      box.append(line, claudeBar(c.done || 0, c.failed || 0, c.started || 0));
      return box;
    }

    // A workflow page: the run view fills the main pane; an open workflow agent shows in #panel.
    function renderClaudeBody() {
      renderClaudeOverview();
    }

    // The run view (left, own scroll): every run as a card when none is open, or the open run's
    // summary and its agents by phase. Rebuilt only when its own signature changes.
    var lastClaudeOverviewScope = null;
    function renderClaudeOverview() {
      var run = claudeRunById(claudeRunId());
      var scope = run ? run.id : '';
      // An open run counts only what the run view shows, coarsely: each agent write would otherwise
      // rebuild the rows the user is about to click. The 10 s tick refreshes the relative times.
      var signature = JSON.stringify([scope, panelAgentId(), claudeLoaded, Math.floor(Date.now() / 10000), run ? [run.status, run.counts, run.totals, run.phases, run.groups, openTopics, run.agentsHidden, run.model, run.effort,
        (run.agents || []).map(function (agent) {
          return [agent.id, agent.state, agent.label, agent.phase, agent.group, agent.order, agent.tool, agent.model, agent.effort, Math.floor((agent.lastWriteMs || 0) / 10000), Math.floor((agent.contextTokens || 0) / 1000)];
        })] : claudeRuns.map(function (entry) {
        return [entry.id, entry.status, entry.name, entry.project, entry.model, entry.effort, entry.counts, Math.floor(entry.updatedMs / 10000), entry.durationMs];
      })]);
      if (signature === lastClaudeOverviewSignature) return;
      lastClaudeOverviewSignature = signature;
      // Keyboard focus on a card or agent row survives the live rebuild, as in renderFeed.
      var focusHost = claudeOverview.contains(document.activeElement) ? document.activeElement.closest('[data-key]') : null;
      var focusKey = focusHost ? focusHost.dataset.key : null;
      claudeOverview.textContent = '';
      var wrap = document.createElement('div');
      wrap.className = 'claude-view';
      if (!run) {
        var empty = document.createElement('div');
        empty.className = 'feed-empty';
        var strong = document.createElement('strong');
        var ready = claudeLoaded && claudeChatsLoaded;
        strong.textContent = ready ? 'This workflow is not tracked any more' : 'Loading this workflow…';
        empty.append(strong, textSpan('', ready ? 'Pick another node in the tree.' : ''));
        wrap.appendChild(empty);
      } else {
        wrap.appendChild(claudeRunSummary(run));
        // Topics (the server's run.groups) in the tree's order; the agents of a topic in start order. Counts come from the
        // group (every agent, sent or not); the rows come from run.agents (capped for big runs), so a topic can miss some.
        var groups = (run.groups || []).slice().sort(function (a, b) { return a.order - b.order; });
        var byGroup = {};
        (run.agents || []).forEach(function (agent) { var key = agent.group || ''; (byGroup[key] = byGroup[key] || []).push(agent); });
        groups.forEach(function (group) {
          var agents = (byGroup[group.key] || []).sort(function (a, b) { return a.order - b.order; });
          var topicKey = run.id + '/' + group.key;
          // open: the user's choice, else topics with running agents; a topic that holds the open panel agent is always open
          var isOpen = (openTopics[topicKey] !== undefined ? openTopics[topicKey] : group.running > 0) || agents.some(function (agent) { return agent.id === panelAgentId(); });
          wrap.appendChild(claudeTopicRow(run, group, isOpen, agents.length));
          if (!isOpen) return;
          agents.forEach(function (agent) { var row = claudeAgentRow(agent, run); row.classList.add('child'); wrap.appendChild(row); });
          if (group.started > agents.length) wrap.appendChild(textDiv('topic-note', '+ ' + (group.started - agents.length) + ' more not shown'));
        });
        // Agents outside every topic keep the phase captions. With no topics at all, that is the whole run.
        var loose = groups.length ? { phases: [], agents: byGroup[''] || [] } : run;
        claudePhaseGroups(loose).forEach(function (group) {
          var heading = document.createElement('div');
          heading.className = 'claude-phase';
          heading.append(textSpan('', group.title), textSpan('phase-count', group.done + '/' + group.started + (group.failed ? ' · ' + group.failed + ' failed' : '')),
            claudeBar(group.done, group.failed, group.started));
          heading.title = group.done + ' done of ' + group.started + ' started';
          wrap.appendChild(heading);
          group.agents.forEach(function (agent) { wrap.appendChild(claudeAgentRow(agent, run)); });
        });
        if (run.agentsHidden) wrap.appendChild(textDiv('claude-note', '+ ' + run.agentsHidden + ' more agents not shown'));
        wrap.appendChild(textDiv('claude-note', 'Queued agents, log() lines and the planned total are not on disk, so they are not shown.'));
      }
      claudeOverview.appendChild(wrap);
      if (focusKey) wrap.querySelectorAll('[data-key]').forEach(function (el) { if (el.dataset.key === focusKey) el.focus({ preventScroll: true }); });
      if (scope !== lastClaudeOverviewScope) claudeOverview.scrollTop = 0; // a new run opens at the top; live updates keep the place
      lastClaudeOverviewScope = scope;
    }

    // Copy-only menu for a run (the ... button and a row's right-click menu).
    function fillClaudeMenu(container, run, agentId, onPick) {
      container.dataset.signature = '';
      container.textContent = '';
      var group = null;
      claudeMenuItems(run, agentId).forEach(function (entry) {
        if (entry.group !== group) {
          group = entry.group;
          container.appendChild(textDiv('menu-group', group));
        }
        var button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.dataset.action = entry.id;
        button.textContent = entry.label;
        button.title = entry.title;
        button.addEventListener('click', function () {
          onPick(entry.id);
          runClaudeMenuAction(entry.id, run, agentId, button);
        });
        container.appendChild(button);
      });
    }
    async function runClaudeMenuAction(id, run, agentId, button) {
      if (id === 'copy-run-id') { copyText(run.id, button, 'Run ID copied'); return; }
      if (id === 'copy-agent-id') { copyText(agentId, button, 'Agent ID copied'); return; }
      // Paths never ride /events: they come from the gated /claude/run.
      var message;
      try {
        var response = await fetch('/claude/run?run=' + encodeURIComponent(run.id), { cache: 'no-store' });
        if (response.ok) {
          var data = await response.json();
          var journal = id === 'copy-journal-path';
          copyText(journal ? data.journal : data.resume, button, journal ? 'Journal path copied' : 'Resume hint copied');
          return;
        }
        message = response.status === 404 ? 'This run is no longer tracked.' : await response.text();
      } catch (error) {
        message = 'Request failed: ' + error.message;
      }
      // Refused: say why in the button, copy nothing.
      var old = button.textContent;
      button.textContent = message;
      button.title = message;
      window.setTimeout(function () { button.textContent = old; }, 4000);
    }

    // Live keeps a question for you after its session left the server's newest 40. Load that
    // session by thread and open the row when it arrives. No session file: the job dialog.
