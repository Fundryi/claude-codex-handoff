'use strict';
    // -- Result-card section parsing, mirroring plugin/scripts/lib/render.mjs
    // extractSection/readNeedsDecision exactly (renamed for the UI's own use),
    // so the two never drift out of sync (see tests/plugin-task-result.test.js).
    // Line range of a section: its heading line (start) up to the next heading (end). The result
    // card ends it at any heading, as the plugin does. The feed (wholeSection) ends it at a heading
    // of the same or a higher level (a bold heading counts as ##) or at one of the four
    // return-format headings, outside code fences, so a question keeps its sub-headed options.
    function resultSectionBounds(lines, heading, wholeSection) {
      var name = markdownEscapeRegExp(heading);
      var startRe = new RegExp('^(?:#{2,3}\\s*' + name + '\\s*:?|\\*\\*' + name + '\\s*:?\\s*\\*\\*\\s*:?)\\s*$', 'i');
      // A heading inside a code fence (a Markdown example) is not the section.
      var start = -1, fenced = false;
      for (var s = 0; s < lines.length; s++) {
        if (/^\s{0,3}```/.test(lines[s])) fenced = !fenced;
        else if (!fenced && startRe.test(lines[s].trim())) { start = s; break; }
      }
      if (start === -1) return null;
      var known = /^(#{1,3}\s*(summary|changed files|checks run|needs decision)\s*:?\s*$|\*\*(summary|changed files|checks run|needs decision)\s*:?\s*\*\*\s*:?$)/i;
      var level = (lines[start].trim().match(/^#+/) || ['##'])[0].length;
      var peer = new RegExp('^#{1,' + level + '}\\s');
      var endRe = /^(#{1,3}\s|\*\*(summary|changed files|checks run|needs decision)\s*:?\s*\*\*\s*:?$)/i;
      var end = start + 1;
      var inFence = false;
      for (; end < lines.length; end++) {
        var line = lines[end].trim();
        if (!wholeSection) { if (endRe.test(line)) break; continue; }
        if (/^\s{0,3}```/.test(lines[end])) inFence = !inFence;
        if (!inFence && (peer.test(line) || known.test(line))) break;
      }
      return { start: start, end: end };
    }
    // What Codex wrote above its first return heading (render.mjs extractPreface): sometimes the
    // real answer, with Summary only a stub. Empty when there is no heading.
    function resultPreface(text) {
      var lines = String(text == null ? '' : text).split(/\r?\n/);
      var first = lines.findIndex(function (line) {
        return /^(?:#{2,3}\s*(summary|changed files|checks run|needs decision)\s*:?|\*\*(summary|changed files|checks run|needs decision)\s*:?\s*\*\*\s*:?)\s*$/i.test(line.trim());
      });
      return first > 0 ? lines.slice(0, first).join('\n').trim() : '';
    }
    function extractResultSection(text, heading) {
      var lines = String(text == null ? '' : text).split(/\r?\n/);
      var bounds = resultSectionBounds(lines, heading);
      return bounds ? lines.slice(bounds.start + 1, bounds.end).join('\n').trim() : null;
    }
    // The text without one whole section, so a reply can show its question once, in its own
    // callout. Only the seam is tidied: blank lines elsewhere (inside code fences) stay as written.
    function removeResultSection(text, heading) {
      var value = String(text == null ? '' : text);
      var lines = value.split(/\r?\n/);
      var bounds = resultSectionBounds(lines, heading, true);
      if (!bounds) return value;
      var before = lines.slice(0, bounds.start).join('\n').replace(/\s+$/, '');
      var after = lines.slice(bounds.end).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
      return (before && after ? before + '\n\n' + after : before || after).replace(/^\s*\n/, '');
    }
    // The question a feed reply asks: the whole Needs decision section, never cut short, or null
    // when there is none (readResultQuestion decides that, as everywhere else).
    function feedQuestion(text) {
      var lines = String(text == null ? '' : text).split(/\r?\n/);
      var bounds = resultSectionBounds(lines, 'Needs decision', true);
      if (!bounds) return null;
      var body = lines.slice(bounds.start + 1, bounds.end).join('\n').trim();
      return noQuestion(body) ? null : body;
    }
    // A Needs decision body that asks nothing: empty, or "None", "n/a", "-", "No questions" with no '?' in it.
    function noQuestion(body) {
      return !body || (/^(none\b|n\/a\b|-$|no (decision|question)s?\b)/i.test(body) && body.indexOf('?') === -1);
    }

    function readResultQuestion(text) {
      var body = extractResultSection(text, 'Needs decision');
      if (noQuestion(body)) return null;
      return body.slice(0, 1000);
    }

    // A stable key for a rendered <details> row, so a re-render can find "the
    // same" row again and restore whether the reader had it open. A thinking
    // group is keyed off its first step's timestamp (stable across regrouping
    // even though the group object itself is rebuilt every render).
    function technicalEventKey(event) {
      if (event.steps) return event.kind + '|' + (event.steps[0] && event.steps[0].ts); // thinkgroup, sysgroup
      return event.kind + '|' + event.ts;
    }

    // Parallel tool calls in one turn can share a kind and a timestamp, so
    // technicalEventKey alone can collide (two rows fighting over one open
    // state). This appends an occurrence counter in feed order - #0, #1, ...
    // per repeated base key - computed fresh from the same ordered event list
    // every render, so a given row keeps the same key across renders.
    function assignEventKeys(events) {
      var counts = {};
      return events.map(function (event) {
        var base = technicalEventKey(event);
        var n = counts[base] || 0;
        counts[base] = n + 1;
        return base + '#' + n;
      });
    }

    // -- Thinking groups: consecutive THINKING events collapse into one row.
    function groupThinking(events) {
      var result = [];
      var i = 0;
      while (i < events.length) {
        var event = events[i];
        if (event.kind !== 'think') { result.push(event); i++; continue; }
        var steps = [event];
        var j = i + 1;
        while (j < events.length && events[j].kind === 'think') { steps.push(events[j]); j++; }
        result.push({ kind: 'thinkgroup', ts: steps[steps.length - 1].ts, steps: steps, text: steps[0].text });
        i = j;
      }
      return result;
    }

    // -- Who sent what. Injected context dumps and hook text (the server's internal flag,
    // plus the older text patterns) are System, never speech.
    function isInternal(event) {
      if (event.internal) return true;
      // The same list as the server's (server/sessions.js simplify); a test keeps them equal.
      var INJECTED_BLOCK = /^\s*(?:<(?:environment_context|permissions|user_instructions|recommended_plugins|skills?|skills_instructions|apps|plugins|developer|multi_agent_mode|multi_agent_role|collaboration_mode|context_window[\w-]*|context_guidance|model_switch|app-context|codex-jobs|codex_internal_context|image_resize_notice|task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|ide_opened_file|ide_selection|system-reminder|turn_aborted|external_codex_apps_writing_block_edits|subagent_notification)(?=[\s>/])|# AGENTS\.md instructions\b|The following is the Codex agent history (?:added since your last approval assessment|whose request action you are assessing)\b)/;
      if (event.kind !== 'agent' && event.kind !== 'user') return false;
      var body = String(event.text || '');
      if (INJECTED_BLOCK.test(body)) return true;
      return event.kind === 'agent' && (body.includes('You are `/root`, the primary agent') || body.includes('<collaboration_mode>'));
    }
    // The actor of a feed item: 'you' | 'claude' | 'relay' (your answer, delivered by Claude or the
    // answer box) | 'codex' | 'work' (Codex's thinking, commands, output, patches, tools) |
    // 'system' | 'status' (turn markers). A plain prompt is Claude's handoff only when the session's
    // originator is Claude Code; the two answer prefixes win over that. Nothing else is guessed.
    function messageActor(event, session) {
      if (!event) return 'system';
      if (session && session.source === 'opencode') {
        if (event.internal || event.kind === 'sysgroup') return 'system';
        if (['cmd', 'out', 'patch', 'tool', 'think', 'thinkgroup'].indexOf(event.kind) !== -1) return 'opencode-work';
        if (['done', 'err', 'sys', 'meta'].indexOf(event.kind) !== -1) return 'status';
        return event.kind === 'agent' ? 'opencode' : event.kind === 'user' ? 'you' : 'system';
      }
      if (session && session.source === 'claude') return claudeActor(event);
      if (session && (session.source === 'chat' || session.source === 'agent')) {
        var chatKind = event.kind;
        var agentSide = session.source === 'agent';
        if (['cmd', 'out', 'patch', 'tool', 'think', 'thinkgroup'].indexOf(chatKind) !== -1) return agentSide ? 'subagent-work' : 'chat-work';
        if (chatKind === 'done' || chatKind === 'err' || chatKind === 'sys') return 'status';
        if (chatKind === 'sysgroup' || isInternal(event)) return 'system';
        if (chatKind === 'agent') return agentSide ? 'subagent' : 'claude';
        if (chatKind === 'user') return agentSide ? 'claude' : 'you';
        return 'system';
      }
      var kind = event.kind;
      if (['cmd', 'out', 'patch', 'tool', 'think', 'thinkgroup'].indexOf(kind) !== -1) return 'work';
      if (kind === 'done' || kind === 'err' || kind === 'sys') return 'status';
      if (kind === 'sysgroup' || isInternal(event)) return 'system';
      if (kind === 'agent') return 'codex';
      if (kind !== 'user') return 'system';
      var text = String(event.text || '').replace(/^\s+/, '');
      if (text.indexOf('Answer from the user:') === 0) return 'relay';
      if (text.indexOf('Answer from Claude (automatic') === 0) return 'claude';
      return sessionStarter(session);
    }
    // Who writes the plain prompts of a session: the lead agent in a child agent's session,
    // Claude in a session Claude Code started, you otherwise (unknown originator included).
    function sessionStarter(session) {
      if (session && session.parentThreadId) return 'codex-lead';
      return session && session.originator === 'Claude Code' ? 'claude' : 'you';
    }
    // Who a message goes to: everything incoming goes to Codex; Codex answers whoever started the session.
    function messageRoute(actor, session) {
      if (session && session.source === 'opencode') return actor === 'opencode' ? { from: actor, to: 'you' } : { from: actor, to: 'opencode' };
      // A Claude workflow transcript never names Codex: the script prompts the agent, the agent answers it.
      if (session && session.source === 'claude') {
        return actor === 'claude-agent' ? { from: 'claude-agent', to: 'workflow-script' } : { from: actor, to: 'claude-agent' };
      }
      // A chat: you write to Claude, Claude answers you. A subagent: Claude prompts it, it answers Claude.
      if (session && session.source === 'chat') return actor === 'claude' ? { from: 'claude', to: 'you' } : { from: actor, to: 'claude' };
      if (session && session.source === 'agent') return actor === 'subagent' ? { from: 'subagent', to: 'claude' } : { from: actor, to: 'subagent' };
      if (actor !== 'codex') return { from: actor === 'relay' ? 'you' : actor, to: 'codex' };
      return { from: 'codex', to: sessionStarter(session) };
    }
    // The answer prefixes as a tag, and the words after them.
    function answerPrefix(text) {
      var value = String(text == null ? '' : text);
      var auto = value.match(/^\s*Answer from Claude \(automatic([^)]*)\):?\s*/);
      if (auto) return { tag: ('automatic answer ' + auto[1].trim()).trim(), text: value.slice(auto[0].length) };
      var relay = value.match(/^\s*Answer from the user:\s*/);
      if (relay) return { tag: 'relayed answer', text: value.slice(relay[0].length) };
      return { tag: '', text: value };
    }
    // The plugin appends its return format to every handoff prompt (plugin/prompts/task-return-format.md),
    // starting at a line of its own that reads <return_format>. Split it off as the Plugin's part.
    function splitReturnFormat(text) {
      var value = String(text == null ? '' : text);
      var match = /(^|\r?\n)[ \t]*<return_format>[ \t]*(?=\r?\n|$)/.exec(value);
      if (!match) return { body: value, footer: '' };
      var start = match.index + match[1].length;
      return { body: value.slice(0, start).replace(/\s+$/, ''), footer: value.slice(start).replace(/\s+$/, '') };
    }
    // Handoff prompts come as <goal>, <rules>, <done_when> blocks. A line that is only an opening
    // tag becomes a small heading and a closing tag line goes, so the prompt reads as sections.
    // Code fences are left alone.
    function promptMarkdown(text) {
      var inFence = false;
      return String(text == null ? '' : text).split(/\r?\n/).map(function (line) {
        if (/^\s{0,3}```/.test(line)) inFence = !inFence;
        if (inFence) return line;
        var open = line.match(/^\s*<([a-z][\w-]*)>\s*$/i);
        if (open) {
          var name = open[1].replace(/[_-]+/g, ' ');
          return '\n### ' + name.charAt(0).toUpperCase() + name.slice(1);
        }
        return /^\s*<\/[a-z][\w-]*>\s*$/i.test(line) ? '' : line;
      }).join('\n');
    }
    // Thinking groups, then each run of System blocks folded into one quiet row.
    function groupFeed(events, session) {
      var result = [];
      groupThinking(events || []).forEach(function (event) {
        if (messageActor(event, session) !== 'system') { result.push(event); return; }
        var last = result[result.length - 1];
        if (last && last.kind === 'sysgroup') { last.steps.push(event); last.ts = event.ts; return; }
        result.push({ kind: 'sysgroup', ts: event.ts, steps: [event], text: event.text });
      });
      return result;
    }
    // Header line "Started by", from the session: a child agent's lead first, then the originator
    // by its readable name. null when neither is known.
    function startedBy(session) {
      if (session && session.parentThreadId) return { actor: 'codex-lead', label: 'Codex (lead agent)' };
      var value = String((session && session.originator) || '').trim();
      if (!value) return null;
      if (value === 'Claude Code') return { actor: 'claude', label: 'Claude (handoff)' };
      var names = { codex_cli_rs: 'Codex CLI', codex_exec: 'Codex CLI', 'codex-tui': 'Codex CLI', codex_sdk_ts: 'Codex SDK', codex_vscode: 'VS Code', 'Codex Desktop': 'Codex Desktop', codex_work_desktop: 'Codex Desktop' };
      return { actor: 'you', label: 'you (' + (Object.prototype.hasOwnProperty.call(names, value) ? names[value] : value) + ')' };
    }
    // The two texts a Resume sends when no prompt is typed: the viewer's (DEFAULT_RESUME_PROMPT in
    // server/jobs.js) and the companion's (DEFAULT_CONTINUE_PROMPT in plugin/scripts/lib/codex.mjs).
    function isResumePrompt(text) {
      var value = String(text == null ? '' : text).trim();
      return value === 'Continue the previous task where it left off and finish it.' ||
        value === 'Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.';
    }
    // "Codex is working: <this>", from the newest event that is not context or a turn marker.
    function workingLine(events) {
      var list = events || [];
      for (var i = list.length - 1; i >= 0; i--) {
        var event = list[i];
        if (event.kind === 'sys' || event.kind === 'done' || event.kind === 'err' || isInternal(event)) continue;
        if (event.kind === 'cmd') return (event.done ? 'ran ' : 'running ') + firstLine(event.text, 90);
        if (event.kind === 'patch') return 'editing ' + firstLine(event.text, 90);
        if (event.kind === 'think') return 'thinking';
        if (event.kind === 'tool') return 'using ' + String(event.text || '').trim().split(/\s/)[0];
        if (event.kind === 'out') return 'reading command output';
        if (event.kind === 'agent') return 'writing a reply';
        return 'reading the message';
      }
      return 'starting';
    }
    // "2 commands · 1 patch" for a collapsed Codex work block.
    function workSummary(items) {
      var names = { cmd: ['command', 'commands'], out: ['output', 'outputs'], patch: ['patch', 'patches'], tool: ['tool call', 'tool calls'], thinkgroup: ['thinking step', 'thinking steps'] };
      var counts = {};
      (items || []).forEach(function (item) {
        var kind = item.kind === 'think' ? 'thinkgroup' : item.kind;
        counts[kind] = (counts[kind] || 0) + (item.steps ? item.steps.length : 1);
      });
      return Object.keys(names).filter(function (kind) { return counts[kind]; }).map(function (kind) {
        return counts[kind] + ' ' + names[kind][counts[kind] === 1 ? 0 : 1];
      }).join(' · ');
    }
