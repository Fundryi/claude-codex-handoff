'use strict';
    // -- The plans block (#plans): plan limits only, shown as the part already used. Claude comes from
    // the claudeUsage frame (the snapshot Claude Code saves when /usage or the VS Code usage panel
    // opens), Codex from the codexLimits frame (a live read every 5 min while a page is open).
    var codexLimits = null; // codexLimits frame, or null before the first read
    // A glyph in the inline .g box the usage cells size.
    function glyphSpan(name) {
      var box = textSpan('g', '');
      box.appendChild(glyph(name));
      return box;
    }
    function resetText(ms, now) {
      if (!ms || ms <= now) return '';
      if (ms - now < 24 * 3600 * 1000) return 'resets in ' + formatDuration(ms - now);
      var d = new Date(ms);
      return 'resets ' + d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    function ageText(ms, now) {
      var min = Math.max(0, Math.round((now - ms) / 60000));
      return min < 1 ? 'just now' : min < 120 ? min + ' min ago' : Math.round(min / 60) + ' h ago';
    }
    function windowLabel(mins) {
      if (!(mins > 0)) return 'limit'; // Codex sent no window length
      return mins === 300 ? '5 h' : mins === 10080 ? 'week' : mins % 1440 === 0 ? mins / 1440 + ' d' : mins < 60 ? mins + ' min' : Math.round(mins / 60) + ' h';
    }
    // Claude: the snapshot's own severity, never a threshold of ours. Codex has none: 80 % and 95 %.
    function planSeverity(severity, percent) {
      if (severity) return severity === 'critical' ? 'crit' : severity !== 'normal' ? 'warn' : '';
      return percent >= 95 ? 'crit' : percent >= 80 ? 'warn' : '';
    }
    // One source line: icon, name, then a quiet note (age or state) at the right.
    function planSource(kind, name, note, noteClass, title) {
      var line = document.createElement('div');
      line.className = 'plan-src ' + kind;
      var icon = textSpan('pl-ic', '');
      icon.appendChild(glyph(kind));
      var noteSpan = textSpan('pl-note' + (noteClass ? ' ' + noteClass : ''), note);
      noteSpan.title = title;
      line.append(icon, textSpan('pl-src', name), noteSpan);
      return line;
    }
    // A window whose reset time passed shows no number: the figure is from before the reset.
    function planRow(name, percent, resetMs, sev, title, now) {
      var passed = !!resetMs && resetMs <= now;
      var row = document.createElement('div');
      row.className = 'plan-row' + (passed ? ' passed' : sev ? ' ' + sev : '');
      row.title = title;
      var value = textSpan('pl-val', '');
      if (passed) value.textContent = 'unknown';
      else value.append(bold(Math.round(percent) + '%'), textSpan('u', ' used'));
      var reset = passed ? 'reset ' + new Date(resetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : resetText(resetMs, now);
      row.append(textSpan('pl-name', name), meterElement(passed ? 0 : percent, passed ? '' : sev), value, textSpan('pl-reset', reset));
      return row;
    }
    function renderPlans() {
      var plans = document.getElementById('plans');
      var now = Date.now();
      var usage = claudeUsage, codex = codexLimits;
      var signature = JSON.stringify([usage, codex, Math.floor(now / 60000)]);
      if (plans.dataset.signature === signature) return;
      plans.dataset.signature = signature;
      plans.hidden = false;
      plans.textContent = '';
      var head = textDiv('plans-head', 'Usage');
      head.title = 'Plan limits, shown as the part already used';
      plans.appendChild(head);

      // Two sources. The status line (after each Claude reply) stays valid while you do not use
      // Claude: the numbers only grow with use, and a passed reset shows "unknown". The /usage
      // snapshot is dropped by Claude Code itself after 1 h, so older snapshot numbers are hidden.
      var HOUR = 3600 * 1000;
      var live = !!usage && usage.source === 'statusline';
      var fresh = !!usage && (live || now - usage.fetchedAtMs <= HOUR);
      var claudeNote = !usage ? 'send one message' : fresh ? ageText(usage.fetchedAtMs, now) : 'checked ' + ageText(usage.fetchedAtMs, now) + ' · open /usage';
      plans.appendChild(planSource('claude', 'Claude', claudeNote, fresh ? '' : 'stale', live
        ? 'From the Claude Code status line, updated after each Claude reply. Use on claude.ai or another PC shows after your next reply here.'
        : fresh ? 'The snapshot Claude Code saves when /usage or the VS Code usage panel opens'
        : 'Add the plugin status line to keep this current (see the README), or open /usage.'));
      if (fresh) {
        usage.limits.forEach(function (l) {
          if (l.kind === 'weekly_scoped' && !l.isActive) return; // a per-model week only when it is the limit that binds
          if (l.atMs && now - l.atMs > HOUR) return; // from an old snapshot
          var name = l.kind === 'session' ? '5 h' : l.kind === 'weekly_all' ? 'week' : l.kind === 'weekly_scoped' ? (l.model || 'model') + ' week' : l.kind;
          var windowName = l.kind === 'session' ? '5-hour window' : l.kind === 'weekly_all' ? '7-day window, all models' : '7-day window, ' + (l.model || 'one model') + ' only';
          // The status line has no severity: 80 % and 95 % then, as for Codex.
          var sev = l.severity === null ? planSeverity('', l.percent) : planSeverity(l.severity || 'normal', l.percent);
          plans.appendChild(planRow(name, l.percent, Date.parse(l.resetsAt) || 0, sev, windowName + ' · ' + l.percent + '% used', now));
        });
        if (usage.spend && (!usage.spendAtMs || now - usage.spendAtMs <= HOUR)) plans.appendChild(planRow('credits', usage.spend.percent, 0, planSeverity(usage.spend.severity || 'normal', usage.spend.percent), 'Usage credits spent this period', now));
      }

      var note = 'checking…', noteClass = '', noteTitle = 'Read from Codex every 5 min while this page is open';
      if (codex && codex.allowed === false) { note = 'limit reached'; noteClass = 'crit'; }
      else if (codex && !codex.ok) {
        note = codex.windows.length ? 'update failed · ' + ageText(codex.fetchedAtMs, now) : 'unavailable';
        noteClass = 'stale';
        noteTitle = codex.error || 'No reply from Codex';
      } else if (codex) note = ageText(codex.fetchedAtMs, now);
      var source = planSource('codex', 'Codex', note, noteClass, noteTitle);
      var resets = codex && codex.resets;
      if (resets && resets.available > 0) {
        var pill = textSpan('pl-resets', resets.available + (resets.available === 1 ? ' reset' : ' resets'));
        var expiry = resets.nextExpiryMs ? new Date(resets.nextExpiryMs).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';
        pill.title = resets.available + ' free Codex limit ' + (resets.available === 1 ? 'reset' : 'resets') + ' to use' + (expiry ? ' · the next one expires ' + expiry : '');
        source.insertBefore(pill, source.lastChild);
      }
      plans.appendChild(source);
      if (codex) codex.windows.forEach(function (w) {
        plans.appendChild(planRow(windowLabel(w.windowMins), w.usedPercent, w.resetsAtMs, planSeverity('', w.usedPercent), 'Codex ' + windowLabel(w.windowMins) + ' window · ' + w.usedPercent + '% used', now));
      });
    }
