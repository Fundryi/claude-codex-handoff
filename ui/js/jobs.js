'use strict';
    var pendingOpen = null;
    async function openOldHandoff(id, job) {
      pendingOpen = id;
      try {
        var response = await fetch('/open?id=' + encodeURIComponent(job.threadId), { method: 'POST' });
        if (response.ok) { openPending(); return; }
      } catch (_) {}
      pendingOpen = null;
      openJob(job);
    }
    function openPending() {
      var node = pendingOpen && currentModel().nodes[pendingOpen];
      if (!node || !node.row || !node.row.session) return;
      pendingOpen = null;
      selectNode(node.id, true);
    }

    async function openHistorySession(id) {
      try {
        var response = await fetch('/open?id=' + encodeURIComponent(id), { method: 'POST' });
        if (!response.ok) return;
        selectSession(id, true);
      } catch (_) {}
    }

    var controlsBlocked = false;
    async function refreshJobs() {
      try {
        var response = await fetch('/jobs');
        // Behind a proxy whose name the viewer does not know, every control is refused. Say so.
        if (response.status === 403) {
          controlsBlocked = true;
          setConnection('disconnected', 'Controls blocked at this address');
          connection.title = await response.text();
          return;
        }
        if (controlsBlocked) {
          controlsBlocked = false;
          connection.title = '';
          setConnection('connected', 'Live updates connected');
        }
        var data = await response.json();
        if (!response.ok) return;
        var previousFeedStatus = (selectedRow() || {}).status;
        jobs = data.jobs || [];
        dataVersion++;
        jobsLoaded = true;
        renderFilters();
        renderList();
        renderHeader();
        renderResultCard();
        if (showOverview()) renderFeed();
        else if ((selectedRow() || {}).status !== previousFeedStatus) requestFeedRender(); // spinner/open block follow status with no new events
      } catch (_) {}
    }

    // Run picker: every job on the thread, newest first, so earlier runs stay reachable.
    function fillRunPicker(job) {
      var runs = threadRuns(jobs.some(function (entry) { return entry.id === job.id; }) ? jobs : jobs.concat([job]), job);
      jobModalRunsField.hidden = runs.length < 2;
      jobModalRuns.textContent = '';
      runs.forEach(function (run, index) {
        var option = document.createElement('option');
        option.value = run.id;
        var when = relativeTime(Date.parse(run.updatedAt || run.createdAt || '') || 0);
        option.textContent = [index === 0 ? 'Latest run' : 'Run ' + (runs.length - index), run.title || run.kindLabel || 'Codex job', jobStatusLabel(run), when].filter(Boolean).join(' · ');
        jobModalRuns.appendChild(option);
      });
      jobModalRuns.value = job.id;
      jobModalRuns.onchange = function () {
        var picked = runs.find(function (run) { return run.id === jobModalRuns.value; });
        if (picked) openJob(picked);
      };
    }

    async function fetchJobDetail(job) {
      var response = await fetch('/job?dir=' + encodeURIComponent(job.stateDir) + '&id=' + encodeURIComponent(job.id));
      var detail = await response.json();
      if (!response.ok) throw new Error(detail.error || 'Job not found');
      return detail;
    }

    async function loadResultDetail(job, entry) {
      try { entry.detail = await fetchJobDetail(job); }
      catch (error) { entry.error = error.message || String(error); }
      renderResultCard();
    }

    // The card above the feed for a task whose newest run finished. It lives outside
    // #feed-inner and is rebuilt only when its content changes, so live feed updates
    // never touch it: a half-typed answer keeps its focus and cursor.
    function renderResultCard() {
      if (pageKind() !== 'codex' && pageKind() !== 'overview' && pageKind() !== 'opencode') { resultCard.hidden = true; return; }
      var row = showOverview() ? null : selectedRow();
      var job = row && row.job;
      if (!job || job.status !== 'completed') {
        resultCardKey = '';
        resultCard.hidden = true;
        resultCard.textContent = '';
        return;
      }
      resultCard.hidden = false;
      var stamp = (job.updatedAt || '') + '|' + job.status;
      var entry = resultDetails[job.id];
      if (!entry || entry.stamp !== stamp) {
        entry = resultDetails[job.id] = { stamp: stamp, detail: null, error: '' };
        loadResultDetail(job, entry);
      }
      var target = answerTarget(row, jobs);
      var runs = threadRuns(jobs, job).length;
      var key = JSON.stringify([row.id, job.id, stamp, !!entry.detail, entry.error, target, runs, row.title, workflowQuestionOwned(job)]);
      if (key === resultCardKey) return;
      resultCardKey = key;
      var old = resultCard.querySelector('.answer-box textarea');
      var focus = old && document.activeElement === old ? [old.selectionStart, old.selectionEnd] : null;
      buildResultCard(row, job, entry, target, runs);
      var fresh = resultCard.querySelector('.answer-box textarea');
      if (focus && fresh) { fresh.focus(); fresh.setSelectionRange(focus[0], focus[1]); }
    }

    function resultSection(heading, markdown, extraClass) {
      var section = document.createElement('div');
      section.className = 'result-section' + (extraClass ? ' ' + extraClass : '');
      var title = document.createElement('h3');
      title.className = 'result-section-title';
      title.textContent = heading;
      var body = document.createElement('div');
      body.className = 'result-section-body';
      body.appendChild(renderMarkdown(markdown, document));
      section.append(title, body);
      return section;
    }

    function buildResultCard(row, job, entry, target, runs) {
      resultCard.textContent = '';
      resultCard.hidden = false;
      var box = document.createElement('div');
      var engine = job.engine === 'opencode' ? 'opencode' : 'codex';
      box.className = 'result-card-box actor-' + engine;
      var head = document.createElement('div');
      head.className = 'result-card-head';
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'result-card-toggle';
      var caret = document.createElement('span');
      caret.className = 'result-card-caret';
      var label = document.createElement('span');
      label.textContent = 'Result from ' + (engine === 'opencode' ? 'OpenCode' : 'Codex');
      toggle.append(caret, actorAvatar(engine, true), label);
      head.appendChild(toggle);
      if (runs > 1) {
        var runCount = document.createElement('span');
        runCount.className = 'result-card-runs';
        runCount.textContent = runs + ' runs';
        head.appendChild(runCount);
      }
      var spacer = document.createElement('span');
      spacer.className = 'spacer';
      var full = document.createElement('button');
      full.type = 'button';
      full.className = 'toolbar-button';
      full.textContent = 'Show full result';
      full.addEventListener('click', function () { openJob(job); });
      head.append(spacer, full);

      var body = document.createElement('div');
      body.className = 'result-card-body';
      body.id = 'result-card-body';
      toggle.setAttribute('aria-controls', body.id);
      function setOpen(open) {
        body.hidden = !open;
        caret.textContent = open ? '▾' : '▸';
        toggle.setAttribute('aria-expanded', String(open));
      }
      setOpen(!resultCardClosed[job.id]);
      toggle.addEventListener('click', function () {
        resultCardClosed[job.id] = !body.hidden;
        setOpen(body.hidden);
      });
      box.append(head, body);
      resultCard.appendChild(box);

      if (!entry.detail) {
        var note = document.createElement('div');
        note.className = 'result-card-note';
        note.textContent = entry.error ? 'Could not load job result: ' + entry.error + ' ' : 'Loading job result…';
        if (entry.error) {
          // Only on request: an automatic refetch would repeat on every SSE batch.
          var retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'toolbar-button';
          retry.textContent = 'Retry';
          retry.addEventListener('click', function () {
            delete resultDetails[job.id];
            renderResultCard();
          });
          note.appendChild(retry);
        }
        body.appendChild(note);
        return;
      }
      var result = entry.detail.result || {};
      var model = resultCardModel(result.rawOutput, result.touchedFiles);
      if (model.plain) body.appendChild(resultSection('Answer', model.plain));
      model.sections.forEach(function (section) { body.appendChild(resultSection(section.heading, section.body)); });
      if (!model.plain && !model.sections.length && !model.question) {
        var empty = document.createElement('div');
        empty.className = 'result-card-note';
        empty.textContent = 'No answer text was recorded. Show full result has the details.';
        body.appendChild(empty);
      }
      if (!model.question) return;
      var workflowOwned = workflowQuestionOwned(job);
      var question = resultSection(workflowOwned ? 'Needs decision' : 'Needs decision: a question for you', model.question, 'question');
      body.appendChild(question);
      if (workflowOwned) {
        var note = document.createElement('div');
        note.className = 'result-card-note';
        note.textContent = 'Asked inside a workflow. The workflow went on.';
        question.appendChild(note);
        return;
      }
      if (!target) {
        // Answered outside the viewer (rowStatus made it Finished): the question stays, no box.
        if (row.status === 'FINISHED') return;
        var busy = document.createElement('div');
        busy.className = 'result-card-note';
        busy.textContent = 'A run on this thread is still working. Answer once it finishes.';
        question.appendChild(busy);
        return;
      }
      var answer = document.createElement('div');
      answer.className = 'answer-box';
      var input = document.createElement('textarea');
      input.placeholder = 'Your answer';
      input.setAttribute('aria-label', 'Your answer to the question above');
      input.value = answerDrafts[job.id] || '';
      var actions = document.createElement('div');
      actions.className = 'answer-box-actions';
      var send = document.createElement('button');
      send.type = 'button';
      send.textContent = 'Answer and resume';
      send.title = 'Opens the resume dialog with your answer as the prompt (asks first)';
      send.disabled = !answerPrompt(input.value);
      input.addEventListener('input', function () {
        answerDrafts[job.id] = input.value;
        send.disabled = !answerPrompt(input.value);
      });
      send.addEventListener('click', function () {
        var prompt = answerPrompt(input.value);
        if (prompt) openResumeModal(target, row.title, prompt);
      });
      actions.appendChild(send);
      answer.append(input, actions);
      question.appendChild(answer);
    }

    async function openJob(job) {
      var token = ++jobModalToken;
      fillRunPicker(job);
      jobModalTitle.textContent = job.title || job.kindLabel || 'Job result';
      jobModalMeta.textContent = '';
      jobModalMeta.appendChild(modalRow('Engine', job.engine === 'opencode' ? 'OpenCode task' : 'Codex'));
      jobModalMeta.appendChild(modalRow('Summary', job.summary || ''));
      jobModalMeta.appendChild(modalRow('Thread', job.threadId || '', true));
      if (job.fast) jobModalMeta.appendChild(modalRow('Tier', 'fast (priority)'));
      jobModalResult.textContent = 'Loading job result\u2026';
      // Same rule and folder as every other Resume, so no Resume while the thread's session is LIVE.
      var threadSession = job.threadId ? sessions.find(function (s) { return s.threadId === job.threadId; }) : null;
      var target = resumeTarget({ job: job, session: threadSession || null, project: '' });
      jobModalResume.hidden = !target;
      jobModalResume.onclick = target ? function () {
        jobModal.hidden = true;
        openResumeModal(target, job.title);
      } : null;
      var wasHidden = jobModal.hidden;
      jobModal.hidden = false;
      if (wasHidden) jobModalClose.focus();
      try {
        var detail = await fetchJobDetail(job);
        if (token !== jobModalToken) return; // another run was picked meanwhile
        jobModalTitle.textContent = detail.title || job.title || 'Job result';
        jobModalMeta.textContent = '';
        jobModalMeta.appendChild(modalRow('Engine', detail.engine === 'opencode' ? 'OpenCode task' : 'Codex'));
        jobModalMeta.appendChild(modalRow('Summary', detail.summary || ''));
        jobModalMeta.appendChild(modalRow('Thread', detail.threadId || '', true));
        if (job.fast) jobModalMeta.appendChild(modalRow('Tier', 'fast (priority)'));
        var resultText = detail.rendered
          || [detail.errorMessage, detail.stderrTail].filter(Boolean).join('\n\n')
          || 'No rendered result is available.';
        jobModalResult.textContent = '';
        jobModalResult.appendChild(renderMarkdown(resultText, document));
      } catch (error) {
        if (token !== jobModalToken) return;
        jobModalResult.textContent = 'Could not load job result: ' + error.message;
      }
    }
