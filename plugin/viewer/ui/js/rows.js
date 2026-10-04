'use strict';
    function projectName(cwd) {
      var parts = String(cwd || '').split(/[\\/]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : 'Unknown project';
    }
    function formatDuration(ms) {
      var seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
      if (seconds < 60) return seconds + 's';
      var minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
      return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
    }
    // short: without path, model and effort (the header shows those as chips above the line).
    function sessionMetaLine(meta, short) {
      if (!meta) return '';
      var parts = short ? [] : [meta.cwd || meta.id || ''];
      if (!short) parts.push('model: ' + (meta.model || '?'));
      if (meta.effort && !short) parts.push('effort: ' + meta.effort);
      if (meta.sandbox) parts.push('sandbox: ' + meta.sandbox);
      if (meta.tokensUsed) parts.push('tokens: ' + meta.tokensUsed.toLocaleString());
      parts.push('thread: ' + (meta.threadId || '?'));
      return parts.join('   |   ');
    }
    function jobStatusLabel(job) {
      if (job.live === 'completed' && job.needsDecision && !workflowQuestionOwned(job)) return 'Needs answer';
      var map = {
        working: 'Running',
        'possibly-stuck': 'Needs attention',
        dead: 'Needs attention',
        failed: 'Needs attention',
        completed: 'Finished',
        cancelled: 'Stopped',
        queued: 'Running'
      };
      return map[job.live] || map[job.status] || String(job.status || job.live || '?');
    }
    function jobDetailLine(job, now) {
      var parts = [];
      if (job.phase) parts.push(job.phase);
      if (job.heartbeatAt) parts.push('last activity ' + formatDuration(now - Date.parse(job.heartbeatAt)) + ' ago');
      if (job.model) parts.push(job.model);
      if (job.effort) parts.push(job.effort);
      if (job.sandbox) parts.push(job.sandbox);
      if (job.diedReason) parts.push(job.diedReason);
      if (job.agents && job.agents.length) parts.push('agents: ' + job.agents.join(', '));
      return parts.join(' \u00b7 ');
    }
    // Interactive sessions rarely carry a title now (the prompt sits behind
    // injected context), so borrow the companion job's title for the same thread,
    // then the child agent's nickname.
    function sessionTitle(session, jobs) {
      if (!session) return 'Untitled Codex task';
      if (session.title) return session.title;
      var job = session.threadId ? (jobs || []).find(function (entry) { return entry.threadId === session.threadId && entry.title; }) : null;
      if (job) return job.title;
      if (session.agentNickname) return 'Agent ' + session.agentNickname;
      return 'Untitled Codex task';
    }
    // Codex child agents write their own rollout with parentThreadId set. Group
    // them under the parent when the parent is loaded; otherwise they stay top level.
    function childSessions(sessions) {
      var known = {};
      (sessions || []).forEach(function (s) { if (s.threadId) known[s.threadId] = true; });
      var byParent = {};
      var childIds = {};
      (sessions || []).forEach(function (s) {
        if (!s.parentThreadId || !known[s.parentThreadId] || s.parentThreadId === s.threadId) return;
        (byParent[s.parentThreadId] = byParent[s.parentThreadId] || []).push(s);
        childIds[s.id] = true;
      });
      return { byParent: byParent, isChild: function (id) { return !!childIds[id]; } };
    }
    function fastChip() {
      var chip = document.createElement('span');
      chip.className = 'status FAST';
      chip.textContent = 'FAST';
      chip.title = 'Priority processing (fast tier)';
      return chip;
    }
    function resumeBody(session, opts) {
      const b = { threadId: session.threadId, cwd: session.cwd };
      if (session.engine === 'opencode') b.engine = 'opencode';
      if (opts.prompt) b.prompt = opts.prompt;
      if (opts.effort) b.effort = opts.effort;
      if (opts.model) b.model = opts.model;
      if (opts.write) b.write = true;
      if (opts.fast) b.fast = true;
      if (opts.sandbox) b.sandbox = opts.sandbox;
      return b;
    }
    // The resume prompt for an answer typed into the result card. The prefix keeps a
    // leading "--" inside the prompt text; blank answers give '' (nothing to send).
    function answerPrompt(text) {
      var trimmed = String(text == null ? '' : text).trim();
      return trimmed ? 'Answer from the user: ' + trimmed : '';
    }
    function waitReason(session) {
      if (!session || session.archived) return '';
      if (session.status === 'STOPPED') {
        return session.lastKind === 'err' ? 'Stopped — ' + firstLine(session.lastText, 80) : '';
      }
      if (session.status !== 'IDLE' && session.status !== 'STALE') return '';
      var text = firstLine(session.lastText, 80);
      var phrase = ({
        cmd: (session.lastDone ? 'ran' : 'running') + ' command "' + text + '"',
        out: 'processing command output',
        patch: 'editing "' + text + '"',
        think: 'thinking (reasoning summary in progress)',
        tool: 'tool call "' + text + '"',
        user: 'prompt sent, no agent response yet',
        agent: 'agent replied — may be waiting for approval or next instruction'
      })[session.lastKind] || (session.lastEvent || 'no displayable activity');
      return 'Waiting ' + formatDuration(session.quietMs) + ' — last activity: ' + phrase;
    }
    function processWarnings(proc, sessionStartMs) {
      return {
        shared: /app-server|mcp/i.test(String(proc.cmd || '')),
        timeMatch: !!(sessionStartMs && proc.started && Math.abs(proc.started - sessionStartMs) < 15000)
      };
    }
    function resumeCommand(threadId) { return 'codex resume ' + threadId; }
    function continueCommand(threadId) {
      return 'codex exec resume ' + threadId + ' "Continue the previous task where it left off and finish it."';
    }
    function forkCommand(threadId) { return 'codex fork ' + threadId; }
    function archiveCommand(threadId) { return 'codex archive ' + threadId; }
    function unarchiveCommand(threadId) { return 'codex unarchive ' + threadId; }
    function mergeHistoryResults(results, liveIds) {
      return (results || []).filter(function (entry) {
        return liveIds.indexOf(entry.id) === -1;
      });
    }
    // Unified row model: sessions and handoff jobs become one list of rows.
    // Row status ids: RUNNING, WAITING, ATTENTION, ANSWER, STOPPED, FINISHED, ARCHIVED.
    // CLAUDE lists Claude Code workflows only (claudeRuns, not rows): no Codex row is ever in it.
    var TABS = { NOW: ['ALL', 'RUNNING', 'WAITING', 'ATTENTION', 'ANSWER'], HANDOFFS: ['ALL', 'RUNNING', 'ATTENTION', 'ANSWER', 'FINISHED', 'STOPPED'], HISTORY: ['FINISHED', 'STOPPED', 'ARCHIVED', 'DISMISSED', 'EVERYTHING'], CLAUDE: ['ALL', 'RUNNING', 'ATTENTION', 'FINISHED'] };
    // A finished workflow agent returned its handoff result to the workflow, which owns the question.
    // Missing links or frames leave normal handoff behavior intact; never infer this from the chat state.
    function workflowQuestionOwned(job) {
      if (!job) return false;
      var frame = typeof claudeChats === 'undefined' ? null : claudeChats;
      var runs = typeof claudeRuns === 'undefined' ? [] : claudeRuns;
      return !!(frame && (frame.chats || []).some(function (chat) {
        return (chat.children || []).some(function (kid) {
          if (kid.kind !== 'handoff' || String(kid.parentId || '').indexOf('wfagent:') !== 0) return false;
          if ((kid.jobIds || []).indexOf(job.id) === -1) return false;
          return runs.some(function (run) {
            return (run.agents || []).some(function (agent) {
              return kid.parentId === 'wfagent:' + run.sessionId + '/' + run.id + '/' + agent.id
                && ['done', 'failed', 'ended'].indexOf(agent.state) !== -1;
            });
          });
        });
      }));
    }
    // The session wrote more than 5 s after the run finished asking: answered outside the viewer.
    function answeredElsewhere(session, job) {
      var asked = job ? Date.parse(job.updatedAt || '') : NaN;
      return !!(session && asked && session.lastGrow > asked + 5000);
    }
    function rowStatus(session, job) {
      // Job liveness wins over session quiet time; an active job even beats the archive flag.
      var state = job ? job.live || job.status : '';
      if (state === 'working' || state === 'running' || state === 'queued') return 'RUNNING';
      // A live session beats any ended job, dead or failed ones too: the thread was resumed after
      // the handoff (often from a copied command), so it runs, and a Resume would start a second Codex.
      if (session && session.status === 'LIVE' && !session.archived) return 'RUNNING';
      if (state === 'possibly-stuck' || state === 'dead' || state === 'failed') return 'ATTENTION';
      if (session && session.archived) return 'ARCHIVED';
      if (state === 'completed') return String(job.needsDecision || '').trim() && !workflowQuestionOwned(job) && !answeredElsewhere(session, job) ? 'ANSWER' : 'FINISHED';
      if (state === 'cancelled') return 'STOPPED';
      var map = { LIVE: 'RUNNING', IDLE: 'WAITING', STALE: 'ATTENTION', STOPPED: 'STOPPED', DONE: 'FINISHED' };
      return (session && map[session.status]) || 'WAITING';
    }
    function buildRows(sessions, jobs) {
      sessions = sessions || [];
      // Newest job first per thread; server order breaks ties.
      var sorted = (jobs || []).map(function (job, index) {
        return { job: job, index: index, ms: Date.parse(job.updatedAt || job.createdAt || '') || 0 };
      }).sort(function (a, b) { return b.ms - a.ms || a.index - b.index; });
      var byThread = {};
      var threadOrder = [];
      var loose = [];
      sorted.forEach(function (entry) {
        var threadId = entry.job.threadId;
        if (!threadId) { loose.push([entry.job]); return; }
        if (!byThread[threadId]) { byThread[threadId] = []; threadOrder.push(threadId); }
        byThread[threadId].push(entry.job);
      });
      var claimed = {};
      function makeRow(session, threadJobs) {
        var job = threadJobs && threadJobs.length ? threadJobs[0] : null;
        var status = rowStatus(session, job);
        var jobMs = job ? Math.max(Date.parse(job.updatedAt || '') || 0, Date.parse(job.heartbeatAt || '') || 0) : 0;
        return {
          id: session ? session.id : 'job:' + job.id,
          session: session || null,
          job: job,
          olderJobs: job ? threadJobs.length - 1 : 0,
          status: status,
          title: session ? sessionTitle(session, threadJobs) : job.title || job.kindLabel || 'Untitled Codex job',
          project: (session && session.cwd) || (job && (job.workspaceRoot || job.cwd)) || '',
          threadId: (session && session.threadId) || (job && job.threadId) || null,
          fast: !!(job && job.fast),
          needsAnswer: status === 'ANSWER',
          updatedMs: Math.max((session && session.lastGrow) || 0, jobMs),
          children: []
        };
      }
      function sessionRow(session) {
        // The first session on a thread takes its jobs; a thread never feeds two rows.
        var threadJobs = session.threadId && !claimed[session.threadId] ? byThread[session.threadId] : null;
        if (session.threadId) claimed[session.threadId] = true;
        return makeRow(session, threadJobs);
      }
      var grouped = childSessions(sessions);
      var drawn = {};
      var rows = [];
      // One level of nesting, each session once; deeper or cyclic agents get their own row.
      sessions.forEach(function (session) {
        if (grouped.isChild(session.id) || drawn[session.id]) return;
        drawn[session.id] = true;
        var row = sessionRow(session);
        (grouped.byParent[session.threadId] || []).forEach(function (kid) {
          if (drawn[kid.id]) return;
          drawn[kid.id] = true;
          row.children.push(sessionRow(kid));
        });
        rows.push(row);
      });
      // Grandchildren and cyclic parent links: their own top-level row, never hidden.
      sessions.forEach(function (session) {
        if (!drawn[session.id]) { drawn[session.id] = true; rows.push(sessionRow(session)); }
      });
      threadOrder.forEach(function (threadId) {
        if (!claimed[threadId]) rows.push(makeRow(null, byThread[threadId]));
      });
      loose.forEach(function (threadJobs) { rows.push(makeRow(null, threadJobs)); });
      return rows.map(function (row, index) { return { row: row, index: index }; })
        .sort(function (a, b) { return b.row.updatedMs - a.row.updatedMs || a.index - b.index; })
        .map(function (entry) { return entry.row; });
    }
    function rowInView(row, tab, chip, dismissedIds) {
      if (!row || !Object.prototype.hasOwnProperty.call(TABS, tab) || TABS[tab].indexOf(chip) === -1) return false;
      if (tab === 'CLAUDE') return false;
      var dismissed = (dismissedIds || []).indexOf(row.id) !== -1;
      if (tab === 'HISTORY' && chip === 'EVERYTHING') return true;
      if (tab === 'HISTORY' && chip === 'DISMISSED') return dismissed;
      if (dismissed) return false;
      if (tab === 'HISTORY') return row.status === chip;
      if (row.status === 'ARCHIVED') return false;
      if (tab === 'HANDOFFS' && !row.job) return false;
      // Now/All keeps today's Active rule: everything not finished.
      if (chip === 'ALL') return tab === 'HANDOFFS' || row.status !== 'FINISHED';
      return row.status === chip;
    }
    function viewCounts(rows, dismissedIds) {
      var counts = {};
      Object.keys(TABS).forEach(function (tab) {
        counts[tab] = {};
        TABS[tab].forEach(function (chip) {
          counts[tab][chip] = (rows || []).filter(function (row) { return rowInView(row, tab, chip, dismissedIds); }).length;
        });
      });
      return counts;
    }
    function legacyFilterView(prefs) {
      var map = {
        ACTIVE: ['NOW', 'ALL'], JOBS: ['HANDOFFS', 'ALL'], LIVE: ['NOW', 'RUNNING'], IDLE: ['NOW', 'WAITING'],
        STALE: ['NOW', 'ATTENTION'], DONE: ['HISTORY', 'FINISHED'], STOPPED: ['HISTORY', 'STOPPED'],
        ARCHIVED: ['HISTORY', 'ARCHIVED'], ALL: ['HISTORY', 'EVERYTHING']
      };
      var saved = prefs && typeof prefs === 'object' ? prefs : {};
      if (saved.home === true) return { tab: 'NOW', chip: 'ALL', overview: true };
      var hit = typeof saved.filter === 'string' && Object.prototype.hasOwnProperty.call(map, saved.filter) ? map[saved.filter] : map.ACTIVE;
      return { tab: hit[0], chip: hit[1], overview: false };
    }
    // One builder for the ... menu and the right-click menu. context: { dismissed, windows }.
    // windows defaults to true: the page cannot see the server platform, and today Stop always shows.
    function menuItems(row, context) {
      var items = [];
      var opts = context || {};
      var session = row.session;
      var job = row.job;
      var live = job ? job.live || job.status : '';
      var archived = !!(session && session.archived);
      function add(group, id, label, title, danger) {
        var item = { group: group, id: id, label: label, title: title };
        if (danger) item.danger = true;
        items.push(item);
      }
      if (resumeTarget(row)) {
        if (job) add('Resume', 'resume-job', 'Resume job', 'Continue this handoff on its thread (asks first)');
        else add('Resume', 'resume-session', 'Resume', 'Continue this session on its thread (asks first)');
      }
      if (job) {
        var ended = live === 'completed' || live === 'failed' || live === 'cancelled';
        add('Job', 'show-result', ended ? 'Show full result' : 'Show job details', ended ? 'Open the handoff result' : 'Open the handoff job details');
      }
      if (job && (live === 'working' || live === 'possibly-stuck')) {
        add('Job', 'cancel-job', 'Cancel job…', 'Cancel this handoff job (asks first)', true);
      }
      add('Session', 'dismiss', opts.dismissed ? 'Restore task' : 'Dismiss task', 'Hide this task from every view except History > Dismissed and Everything. Viewer-only, undoable.');
      if (row.threadId && !archived && (!job || job.engine !== 'opencode')) {
        add('Terminal commands', 'copy-resume', 'Copy resume command', 'codex resume — reopen this conversation interactively');
        add('Terminal commands', 'copy-continue', 'Copy continue command', 'codex exec resume — continue this task headlessly where it left off');
        add('Terminal commands', 'copy-fork', 'Copy fork command', 'codex fork — experiment on a copy; the original session stays untouched');
        if (session) add('Terminal commands', 'copy-archive', 'Copy archive command', 'codex archive — move this session out of the list permanently (paste in your terminal)');
      }
      if (row.threadId && archived) {
        add('Terminal commands', 'copy-unarchive', 'Copy unarchive command', 'codex unarchive — move this session back into the active list (paste in your terminal)');
      }
      if (session && !archived && opts.windows !== false) {
        add('Diagnostics', 'show-processes', 'Show processes', 'List the Codex processes that match this task');
        // An aborted turn is STOPPED too, but its interactive Codex window often still runs.
        if (session.status !== 'DONE' && !(session.status === 'STOPPED' && live === 'cancelled')) {
          add('Diagnostics', 'stop', 'Stop task process…', 'Pick a matching Codex process and end it (asks first)', true);
        }
      }
      return items;
    }
    // Where Resume continues, or null when the row is not resumable: a dead or failed handoff
    // with a thread, or a STALE session with no handoff job (a possibly-stuck job may still run).
    // Never while the session is LIVE: the thread already runs (e.g. resumed in a terminal).
    function resumeTarget(row) {
      var job = row.job;
      var session = row.session;
      var live = job ? job.live || job.status : '';
      if (session && session.status === 'LIVE') return null;
      if (job) return job.threadId && (live === 'dead' || live === 'failed' || (job.engine === 'opencode' && (live === 'completed' || live === 'cancelled'))) ? {
        threadId: job.threadId, cwd: job.workspaceRoot || job.cwd || row.project,
        ...(job.engine === 'opencode' ? { engine: 'opencode' } : {})
      } : null;
      if (session && session.status === 'STALE' && session.threadId && !session.archived) return { threadId: session.threadId, cwd: session.cwd };
      return null;
    }
    // Header line 3: the session's wait reason, then why the handoff needs attention.
    function headerReason(row, now) {
      var job = row.job;
      var live = job ? job.live || job.status : '';
      var parts = [rowReason(row)];
      if (live === 'dead') parts.push('Handoff process died' + (job.diedReason ? ': ' + job.diedReason : ''));
      if (live === 'failed') parts.push('Handoff failed' + (job.diedReason ? ': ' + job.diedReason : ''));
      if (live === 'possibly-stuck') parts.push('Handoff may be stuck' + (job.heartbeatAt ? ': no heartbeat for ' + formatDuration(now - Date.parse(job.heartbeatAt)) : ''));
      return parts.filter(Boolean).join(' · ');
    }
    // The row that draws this id, child agents included.
    function rowById(rows, id) {
      var top = findRow(rows, id);
      if (!top || top.id === id) return top;
      return top.children.find(function (kid) { return kid.id === id; }) || null;
    }
    // Every run on the job's thread, newest first (the job alone when it has no thread).
    function threadRuns(jobs, job) {
      if (!job.threadId) return [job];
      return (jobs || []).filter(function (entry) { return entry.threadId === job.threadId && (entry.engine || 'codex') === (job.engine || 'codex'); })
        .map(function (entry, index) { return { job: entry, index: index, ms: Date.parse(entry.updatedAt || entry.createdAt || '') || 0 }; })
        .sort(function (a, b) { return b.ms - a.ms || a.index - b.index; })
        .map(function (entry) { return entry.job; });
    }
    // Result card content from a job's result.rawOutput and result.touchedFiles.
    // plain: the whole answer when it has none of the known headings, else the text above them.
    // sections: Summary, Changed files (Codex's list plus recorded edits it does not
    // already name), Checks run - empty ones left out. question: readResultQuestion.
    function resultCardModel(rawOutput, touchedFiles) {
      var text = String(rawOutput == null ? '' : rawOutput);
      var summary = extractResultSection(text, 'Summary');
      var changed = extractResultSection(text, 'Changed files');
      var checks = extractResultSection(text, 'Checks run');
      var decision = extractResultSection(text, 'Needs decision');
      var none = summary == null && changed == null && checks == null && decision == null;
      var listed = String(changed || '').replace(/\\/g, '/');
      // Whole tokens, minus a trailing line reference or sentence period (src/a.js:12.).
      var tokens = listed.split(/[\s`'"(),;*]+/).map(function (token) { return token.replace(/(?::\d+)*[.:]*$/, ''); }).filter(Boolean);
      var recorded = [];
      (Array.isArray(touchedFiles) ? touchedFiles : []).forEach(function (file) {
        var path = String(file || '').replace(/\\/g, '/');
        if (!path || recorded.indexOf(path) !== -1 || tokens.indexOf(path) !== -1) return;
        // Codex usually lists workspace-relative paths; the companion may record absolute ones.
        if (tokens.some(function (token) { return token.indexOf('/') !== -1 && path.slice(-token.length - 1) === '/' + token; })) return;
        recorded.push(path);
      });
      var changedText = [changed, recorded.length
        ? 'Recorded file edits (patch tool only, shell edits are not listed):\n' + recorded.map(function (path) { return '- `' + path + '`'; }).join('\n')
        : ''].filter(Boolean).join('\n\n');
      var sections = [['Summary', summary], ['Changed files', changedText], ['Checks run', checks]]
        .filter(function (pair) { return pair[1]; })
        .map(function (pair) { return { heading: pair[0], body: pair[1] }; });
      return { plain: none ? text.trim() : resultPreface(text), sections: sections, question: readResultQuestion(text) };
    }
    // Where an answer to a finished run resumes: the run's thread, in resumeTarget's folder.
    // Null when the newest run did not complete, has no thread, or any run on the thread still works,
    // the session is LIVE again, or it was answered outside the viewer.
    function answerTarget(row, jobs) {
      var job = row.job;
      if (!job || !job.threadId || job.status !== 'completed') return null;
      if (workflowQuestionOwned(job)) return null;
      if (row.session && (row.session.status === 'LIVE' || answeredElsewhere(row.session, job))) return null;
      var busy = threadRuns(jobs, job).some(function (run) {
        var live = run.live || run.status;
        return live === 'working' || live === 'possibly-stuck' || live === 'queued' || live === 'running';
      });
      return busy ? null : { threadId: job.threadId, cwd: job.workspaceRoot || job.cwd || row.project,
        ...(job.engine === 'opencode' ? { engine: 'opencode' } : {}) };
    }
    // Dismissed row ids worth keeping: sessions still tracked, job-only rows ('job:<id>') whose job
    // still exists, and OpenCode sessions ('opencode:<id>') still listed. Before the first job list or
    // OpenCode frame arrives (openChats null), those ids are kept.
    function keptDismissed(ids, sessions, jobs, jobsLoaded, openChats) {
      return (ids || []).filter(function (id) {
        if (String(id).indexOf('job:') === 0) return !jobsLoaded || (jobs || []).some(function (job) { return 'job:' + job.id === id; });
        if (String(id).indexOf('opencode:') === 0) return !openChats || openChats.some(function (chat) { return chat.id === id; });
        return (sessions || []).some(function (session) { return session.id === id; });
      });
    }
    // A tab's count is what clicking it shows: its first chip (counts from viewCounts).
    function tabCounts(counts) {
      var result = {};
      Object.keys(TABS).forEach(function (tab) { result[tab] = counts[tab][TABS[tab][0]]; });
      return result;
    }
    // The top-level row that draws this id: the row itself, or the lead of a child agent.
    function findRow(rows, id) {
      return (rows || []).find(function (row) {
        return row.id === id || row.children.some(function (kid) { return kid.id === id; });
      }) || null;
    }
    // A view that shows the row: the current one, then the row's status chip (same tab first,
    // Now before History before Handoffs), then the catch-alls. HISTORY/EVERYTHING always matches.
    function viewContaining(row, tab, chip, dismissedIds) {
      var tries = [[tab, chip], [tab, row.status], ['NOW', row.status], ['HISTORY', row.status], ['HANDOFFS', row.status],
        ['NOW', 'ALL'], ['HANDOFFS', 'ALL'], ['HISTORY', 'DISMISSED'], ['HISTORY', 'EVERYTHING']];
      var hit = tries.find(function (view) { return rowInView(row, view[0], view[1], dismissedIds); });
      return { tab: hit[0], chip: hit[1] };
    }
    // Stored tab + chip win; prefs from before the tabs map over from filter / home.
    function savedView(prefs) {
      var saved = prefs && typeof prefs === 'object' ? prefs : {};
      if (typeof saved.tab === 'string' && Object.prototype.hasOwnProperty.call(TABS, saved.tab) && TABS[saved.tab].indexOf(saved.chip) !== -1) {
        return { tab: saved.tab, chip: saved.chip };
      }
      var legacy = legacyFilterView(saved);
      return { tab: legacy.tab, chip: legacy.chip };
    }
    // null: no match. '': empty query or a title match. Otherwise the name of the field that matched.
    function rowMatch(row, query) {
      var needle = String(query || '').trim().toLowerCase();
      if (!needle) return '';
      function has(value) { return String(value || '').toLowerCase().indexOf(needle) !== -1; }
      if (has(row.title)) return '';
      var session = row.session || {};
      var job = row.job || {};
      var fields = [['project', row.project], ['thread id', row.threadId], ['model', session.model || job.model], ['agent', session.agentNickname],
        ['id', session.id], ['id', job.id], ['job title', job.title], ['kind', job.kindLabel], ['phase', job.phase]];
      var hit = fields.find(function (field) { return has(field[1]); });
      if (hit) return hit[0];
      return (row.children || []).some(function (kid) { return rowMatch(kid, needle) !== null; }) ? 'agent team' : null;
    }
    // Row status -> the badge class (and STATUS key) it shows.
    function rowBadge(status) {
      return ({ RUNNING: 'LIVE', WAITING: 'IDLE', ATTENTION: 'STALE', ANSWER: 'NEEDS_ANSWER', STOPPED: 'STOPPED', FINISHED: 'DONE', ARCHIVED: 'ARCHIVED' })[status] || 'IDLE';
    }
    function rowMetaLine(row) {
      var session = row.session || {};
      var job = row.job || {};
      var tokens = session.tokensUsed ? 'tokens: ' + Number(session.tokensUsed).toLocaleString() : '';
      return [projectName(row.project), session.model || job.model, job.effort || session.effort, tokens].filter(Boolean).join(' · ');
    }
    // The session's wait/stop reason, only while the session (not a job) decides the row status.
    function rowReason(row) {
      if (!row.session || (row.job && rowStatus(row.session, null) !== row.status)) return '';
      return waitReason(row.session);
    }
    // Everything the 3-line row leaves out: full path, thread, sandbox, reason, handoff detail.
    function rowTooltip(row, now) {
      var session = row.session;
      var job = row.job;
      var lines = [row.title, row.project];
      if (row.threadId) lines.push('thread: ' + row.threadId);
      if (session && session.sandbox) lines.push('sandbox: ' + session.sandbox);
      lines.push(rowReason(row));
      if (job) lines.push('Handoff: ' + (jobDetailLine(job, now) || job.status || job.live || ''));
      if (row.olderJobs) lines.push(row.olderJobs + (row.olderJobs === 1 ? ' earlier run' : ' earlier runs') + ' on this thread');
      return lines.filter(Boolean).join('\n');
    }
