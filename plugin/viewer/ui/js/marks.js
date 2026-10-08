'use strict';
    // -- Feed rendering. Grammar: a message is a card with "sender -> receiver" in the actor's
    // color; Codex work is a collapsed activity log on a teal rail under its turn; System and
    // Plugin text is quiet and collapsed; turn markers are thin centered rules.
    // Every actor's avatar is a glyph from the GL set (docs/UI-THEME.md, "Kind marks"), never a font glyph.
    var ACTORS = {
      opencode: { name: 'OpenCode', glyph: 'opencode' },
      'opencode-work': { name: 'OpenCode work', glyph: 'opencode' },
      you: { name: 'You', glyph: 'you' },
      relay: { name: 'You', glyph: 'you' },
      claude: { name: 'Claude', glyph: 'claude' },
      // Claude workflow actors: Claude's clay and the flow glyph (a script fanning out to agents).
      'workflow-script': { name: 'Workflow script', glyph: 'flow' },
      'claude-agent': { name: 'Claude agent', glyph: 'flow' },
      'claude-work': { name: 'Agent work', glyph: 'flow' },
      // A main chat and a plain subagent (not a workflow): Claude's clay and the Claude glyph.
      'chat-work': { name: 'Claude work', glyph: 'claude' },
      subagent: { name: 'Claude agent', glyph: 'claude' },
      'subagent-work': { name: 'Agent work', glyph: 'claude' },
      plugin: { name: 'Plugin', glyph: 'plugin' },
      codex: { name: 'Codex', glyph: 'codex' },
      work: { name: 'Codex work', glyph: 'codex' },
      'codex-lead': { name: 'Codex (lead)', glyph: 'codex' },
      system: { name: 'System', glyph: 'info' }
    };
    var LONG_MESSAGE = 3000;

    function actorAvatar(actor, small) {
      var info = ACTORS[actor] || ACTORS.system;
      var avatar = document.createElement('span');
      avatar.className = 'avatar' + (small ? ' small' : '');
      avatar.setAttribute('aria-hidden', 'true');
      avatar.appendChild(glyph(info.glyph));
      return avatar;
    }

    // One SVG set for every mark, kind word, avatar, chip and usage cell: a 16-unit box, 1.7 stroke, round caps.
    // claude = Claude (chat, agent, the starter of a handoff), codex = Codex (handoff, agent, CLI run), flow = a
    // workflow script, ghost = a chat not on this PC, you = the human, plugin = the codex plugin, info = System.
    // Trusted constants: this is the one place innerHTML takes markup, and it never carries user text.
    var GL = {
      opencode: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10v10H3zM6 6h4v4H6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
      claude: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6v10.8M2.6 8h10.8M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
      codex: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5l4 3.5-4 3.5M8.8 12h4.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      flow: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.6" cy="8" r="1.9" fill="currentColor"/><circle cx="12.4" cy="3" r="1.9" fill="currentColor"/><circle cx="12.4" cy="8" r="1.9" fill="currentColor"/><circle cx="12.4" cy="13" r="1.9" fill="currentColor"/><path d="M5.2 8h5.4M5.2 8l5.4-4.6M5.2 8l5.4 4.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
      ghost: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 6a2.5 2.5 0 1 1 3.7 2.2C8.4 8.7 8 9.3 8 10.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="13.1" r="1" fill="currentColor"/></svg>',
      you: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="2.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M2.8 14a5.2 5.2 0 0 1 10.4 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
      plugin: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
      chev: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.75 3.5l4.5 4.5-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="4.2" r="1.1" fill="currentColor"/><path d="M8 7v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    };
    // glyph(name): the GL glyph as an <svg> element (sized by its parent's CSS).
    function glyph(name) {
      var holder = document.createElement('template');
      holder.innerHTML = GL[name] || GL.info;
      return holder.content.firstChild;
    }
    // Kind mark: a 16 px box around a glyph. shape 'fill' (a root or a run), 'ring' (an agent) or 'ghost' (not on this PC);
    // k 'claude' | 'codex' | 'system' is the color of who does the work. state (a badge or an agent state) picks the
    // halo: mk-busy (arc), mk-ask (amber ring), mk-warn (dotted ring), mk-dim (finished and kin); waiting is the plain mark.
    // The map lives inside the function: tests extract it by regex and run it bare.
    function markElement(shape, k, name, title, state) {
      var MARK_STATE = { LIVE: 'mk-busy', running: 'mk-busy', NEEDS_ANSWER: 'mk-ask', STALE: 'mk-warn', failed: 'mk-warn',
        DONE: 'mk-dim', done: 'mk-dim', STOPPED: 'mk-dim', ENDED: 'mk-dim', ended: 'mk-dim', ARCHIVED: 'mk-dim', BG: 'mk-dim' };
      var mark = document.createElement('span');
      mark.className = 'mark ' + shape + ' k-' + k + (MARK_STATE[state] ? ' ' + MARK_STATE[state] : '');
      if (title) mark.title = title;
      mark.appendChild(glyph(name));
      return mark;
    }
    // Kind word: "Claude chat", "Handoff"... in the worker's color. starter 'claude' adds the clay starter glyph
    // (Claude started it, Codex does the work); name adds the kind glyph (flow, ghost) before the word.
    function kindLabel(text, k, options) {
      var o = options || {};
      var label = document.createElement('span');
      label.className = 'kind-label k-' + k;
      if (o.title) label.title = o.title;
      if (o.starter) { var s = document.createElement('span'); s.className = 'g starter'; s.appendChild(glyph(o.starter)); label.appendChild(s); }
      if (o.glyph) { var g = document.createElement('span'); g.className = 'g'; g.appendChild(glyph(o.glyph)); label.appendChild(g); }
      label.appendChild(document.createTextNode(text));
      return label;
    }
    // State dot: a 10 px box, one color per state. Only the roll-up line and the kind counts use it; rows carry the state on the kind mark.
    function stateDot(state, title) {
      var dot = document.createElement('span');
      dot.className = 'sdot ' + state;
      if (title) dot.title = title;
      return dot;
    }
    // Kind chips (Claude, Codex) as one wrapping unit for #chips. The click handler is the logic's; this is the markup.
    // Source toggles (Claude, Codex, OpenCode) for the #kinds bar: a 16 px glyph box in the actor color and the word.
    function kindChipsElement() {
      var unit = document.createDocumentFragment();
      [['claude', 'Claude', 'Only Claude’s own work. None on: every source'], ['codex', 'Codex', 'Only work that runs under Codex. None on: every source'], ['opencode', 'OpenCode', 'Only OpenCode sessions. None on: every source']].forEach(function (k) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'kind-button';
        button.dataset.kind = k[0];
        button.title = k[2];
        var box = document.createElement('span');
        box.className = 'k';
        box.style.color = 'var(--' + k[0] + ')';
        box.appendChild(glyph(k[0]));
        var word = document.createElement('span');
        word.className = 'w';
        word.textContent = k[1];
        button.append(box, word);
        unit.appendChild(button);
      });
      return unit;
    }

