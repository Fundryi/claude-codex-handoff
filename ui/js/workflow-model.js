'use strict';
    // -- Claude workflows (the Claude tab). Runs come from the server's claudeRuns frame.
    // Run status -> its chip (the tab's filter), badge class (existing status colors only), label and help.
    function claudeStatusView(status) {
      return ({
        RUNNING: { chip: 'RUNNING', badge: 'LIVE', label: 'Running', help: 'The workflow wrote in the last 5 minutes, or an agent is waiting on its own tool.' },
        QUIET: { chip: 'ATTENTION', badge: 'STALE', label: 'Quiet', help: 'Quiet for 5 min, no finish record. May be paused, rate-limited or ended.' },
        FAILED: { chip: 'ATTENTION', badge: 'STALE', label: 'Failed', help: 'The workflow reported failed.' },
        DONE: { chip: 'FINISHED', badge: 'DONE', label: 'Finished', help: 'The workflow wrote its finish record.' },
        KILLED: { chip: 'FINISHED', badge: 'STOPPED', label: 'Stopped', help: 'The workflow was stopped.' }
      })[status] || { chip: 'ATTENTION', badge: 'STALE', label: 'Quiet', help: 'No known status.' };
    }
    // An agent's state -> badge class, label and help (dot and header chip).
    function claudeAgentView(state) {
      return ({
        running: { badge: 'LIVE', label: 'Running', help: 'This agent is working.' },
        done: { badge: 'DONE', label: 'Done', help: 'This agent returned its result.' },
        failed: { badge: 'STOPPED', label: 'No result', help: 'This agent ended without returning a result. Its last words say why.' },
        ended: { badge: 'STOPPED', label: 'Ended', help: 'No end record. The run ended or went quiet.' }
      })[state] || { badge: 'STOPPED', label: 'Ended', help: 'No end record. The run ended or went quiet.' };
    }
    function claudeRunInView(run, chip) {
      return !!run && (chip === 'ALL' || claudeStatusView(run.status).chip === chip);
    }
    function claudeViewCounts(runs) {
      var counts = { ALL: 0, RUNNING: 0, ATTENTION: 0, FINISHED: 0 };
      (runs || []).forEach(function (run) { counts.ALL++; counts[claudeStatusView(run.status).chip]++; });
      return counts;
    }
    // The header counter, visible from every tab. '' when nothing runs or needs attention.
    function claudeCounterText(runs) {
      var counts = claudeViewCounts(runs);
      if (!counts.RUNNING && !counts.ATTENTION) return '';
      var parts = [];
      if (counts.RUNNING) parts.push(counts.RUNNING + ' running');
      if (counts.ATTENTION) parts.push(counts.ATTENTION + (counts.ATTENTION === 1 ? ' needs' : ' need') + ' attention');
      return 'Claude: ' + parts.join(' · ');
    }
    // "9 started, 6 done, 1 failed". Never "6/71": the planned total is not on disk.
    function claudeRunLine(run) {
      var c = (run && run.counts) || {};
      return (c.started || 0) + ' started, ' + (c.done || 0) + ' done' + (c.failed ? ', ' + c.failed + ' no result' : '');
    }
    // "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5". Anything else unchanged.
    function modelShortName(id) {
      var m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(String(id || ''));
      return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '') : String(id || '');
    }
    // Phases in the run's order with their agents. The counts come from run.phases (exact) because
    // run.agents is capped for big runs. Agents whose phase is not listed get their own group last.
    function claudePhaseGroups(run) {
      var groups = [];
      var byTitle = {};
      ((run && run.phases) || []).forEach(function (phase) {
        var group = { title: phase.title, started: phase.started || 0, done: phase.done || 0, failed: phase.failed || 0, agents: [] };
        byTitle[phase.title] = group;
        groups.push(group);
      });
      ((run && run.agents) || []).forEach(function (agent) {
        var title = agent.phase || 'phase unknown';
        if (!byTitle[title]) {
          byTitle[title] = { title: title, started: 0, done: 0, failed: 0, agents: [], counted: true };
          groups.push(byTitle[title]);
        }
        var group = byTitle[title];
        group.agents.push(agent);
        if (group.counted) { group.started++; if (agent.state === 'done') group.done++; if (agent.state === 'failed') group.failed++; }
      });
      return groups.map(function (group) { return { title: group.title, agents: group.agents, started: group.started, done: group.done, failed: group.failed }; });
    }
    function claudeRunMatch(run, query) {
      var needle = String(query || '').trim().toLowerCase();
      if (!needle) return true;
      var fields = [run.name, run.description, run.project, run.id, run.session].concat((run.agents || []).map(function (agent) { return agent.label; }));
      return fields.some(function (value) { return String(value || '').toLowerCase().indexOf(needle) !== -1; });
    }
    // Copy only: Claude Code has no outside interface to stop, pause or resume a workflow
    // (/workflows in a terminal, or Remote Control, does that).
    function claudeMenuItems(run, agentId) {
      var items = [
        { group: 'Copy', id: 'copy-run-id', label: 'Copy run ID', title: run.id },
        { group: 'Copy', id: 'copy-journal-path', label: 'Copy journal path', title: 'The run journal (journal.jsonl) on this PC' },
        { group: 'Copy', id: 'copy-resume-hint', label: 'Copy resume hint', title: 'A line to paste into Claude Code: resume this workflow with the Workflow tool' }
      ];
      if (agentId) items.push({ group: 'Copy', id: 'copy-agent-id', label: 'Copy agent ID', title: agentId });
      return items;
    }
    // Who wrote a line of a Claude agent's transcript. Never a Codex actor.
    function claudeActor(event) {
      var kind = event.kind;
      if (['cmd', 'out', 'patch', 'tool', 'think', 'thinkgroup'].indexOf(kind) !== -1) return 'claude-work';
      if (kind === 'done' || kind === 'err' || kind === 'sys') return 'status';
      if (kind === 'sysgroup' || isInternal(event)) return 'system';
      if (kind === 'agent') return 'claude-agent';
      if (kind === 'user') return 'workflow-script';
      return 'system';
    }
    // 1.9M / 104k / 950 tokens.
    function compactCount(value) {
      var n = Number(value) || 0;
      if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
      if (n >= 1000) return Math.round(n / 1000) + 'k';
      return String(n);
    }
    // Run length: the snapshot's duration when finished, the time since start while running.
    function claudeRunDuration(run, now) {
      if (!run) return 0;
      if (run.durationMs) return run.durationMs;
      if (run.endedMs && run.startedMs) return run.endedMs - run.startedMs;
      return run.startedMs ? Math.max(0, (run.status === 'RUNNING' ? now : run.updatedMs || now) - run.startedMs) : 0;
    }

    // Next index for arrow-key roving focus within a row of buttons (tabs, chips). Wraps around.
    function rovingFocusIndex(currentIndex, itemCount, key) {
      if (itemCount <= 0) return currentIndex;
      if (key === 'Home') return 0;
      if (key === 'End') return itemCount - 1;
      if (key === 'ArrowRight') return (currentIndex + 1) % itemCount;
      if (key === 'ArrowLeft') return (currentIndex - 1 + itemCount) % itemCount;
      return currentIndex;
    }
    // Whether the reader holds a non-empty text selection that starts or ends inside container.
    // A feed rebuild waits while this is true: it would wipe the selection.
    function selectionInside(selection, container) {
      if (!selection || !selection.rangeCount || selection.isCollapsed || !String(selection).length) return false;
      return container.contains(selection.anchorNode) || container.contains(selection.focusNode);
    }
    // Whether an element is a text-entry field '/' must not steal a keystroke from.
    function isEditableElement(el) {
      if (!el) return false;
      if (el.isContentEditable) return true;
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    }
