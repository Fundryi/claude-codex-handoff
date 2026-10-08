'use strict';
    'use strict';

    var STORAGE_KEY = 'codex-live-viewer-ui-v1';
    var defaults = {
      sideWidth: 340,
      sideCollapsed: false,
      query: '',
      home: false,
      autoFollow: true,
      selected: null,
      dismissed: [],
      claudeRun: null, // the open Claude workflow run id (Claude tab)
      claudeAgent: null // the open agent id inside it: its transcript shows in the side panel
    };
    var prefs = loadPrefs();
    var sessions = [];
    var jobs = [];
    var selected = prefs.selected;
    var store = {};
    var seeded = false;
    var unread = new Set();
    var previousStatus = {};
    var lastListSignature = '';
    var lastHomeSignature = '';
    var lastFilterSignature = '';
    var renderLimits = {};
    // Live feed batches rebuild at most once per frame, and not while the reader selects text in it.
    var feedRenderPending = false;
    var feedRenderFrame = 0;
    // Result card, per job id and in memory only: the fetched detail (refetched when the
    // job's updatedAt/status changes), the typed answer, and whether the reader collapsed it.
    var resultDetails = {};
    var answerDrafts = {};
    // Feed rows the reader opened or closed, as 'session|row key' -> open. Only a row whose state
    // differs from its default is kept (feed toggle listener), so a live rebuild keeps what the
    // reader chose while a block that opened by itself closes again once it is no longer the last.
    var feedOpenChoices = {};
    var resultCardClosed = {};
    var resultCardKey = '';
    var historyResults = [];
    var historySearchTimer = null;
    var jobsLoaded = false;
    // Claude workflows (the Claude tab): the claudeRuns SSE frame, and the open agent's transcript,
    // polled from /claude/transcript (transcripts never ride /events).
    var claudeRuns = [];
    var claudeLoaded = false;
    var openTopics = {}; // run view: "<run id>/<group key>" -> open or closed, once the user chose
    // The run view and the agent panel rebuild on their own signatures, so one never redraws the other.
    var lastClaudeListSignature = '', lastClaudeFeedSignature = '', lastClaudeOverviewSignature = '';
    var claudePollTimer = 0;
    var CLAUDE_SESSION = { source: 'claude' }; // the pseudo-session the feed code sees for a Claude transcript
    // The unified tree: Claude chats (claudeChats frame) joined with runs, jobs and Codex sessions.
    // dataVersion moves on every data update, so currentModel() rebuilds only when something changed.
    var claudeChats = { chats: [], ghosts: [] };
    var opencodeChats = { chats: [] };
    var opencodeChatsLoaded = false;
    var claudeChatsLoaded = false;
    var claudeUsage = null; // Claude plan limits (claudeUsage frame), or null
    var dataVersion = 0;
    var modelCache = { version: -1, model: null };

    var side = document.getElementById('side');
    var splitter = document.getElementById('splitter');
    var list = document.getElementById('list');
    var tabsBar = document.getElementById('tabs');
    var chipsBar = document.getElementById('chips');
    var kindsBar = document.getElementById('kinds');
    var openElsewhere = document.getElementById('open-elsewhere');
    var openElsewhereTitle = document.getElementById('open-elsewhere-title');
    var search = document.getElementById('search');
    var feed = document.getElementById('feed');
    var feedInner = document.getElementById('feed-inner');
    var resultCard = document.getElementById('result-card');
    var jumpLatest = document.getElementById('jump-latest');
    var taskTitle = document.getElementById('task-title');
    var taskStatus = document.getElementById('task-status');
    var taskFast = document.getElementById('task-fast');
    var taskHandoff = document.getElementById('task-handoff');
    var taskClaude = document.getElementById('task-claude');
    var claudeOverview = document.getElementById('claude-overview');
    var taskMeta = document.getElementById('task-meta');
    var taskFacts = document.getElementById('task-facts');
    var actionMenu = document.getElementById('action-menu');
    var contextMenu = document.getElementById('context-menu');
    var actionsButton = document.getElementById('actions-button');
    var processPanel = document.getElementById('process-panel');
    var stopModal = document.getElementById('stop-modal');
    var stopModalBody = document.getElementById('stop-modal-body');
    var stopModalConfirm = document.getElementById('stop-modal-confirm');
    var stopModalCancel = document.getElementById('stop-modal-cancel');
    var jobModal = document.getElementById('job-modal');
    var jobModalTitle = document.getElementById('job-modal-title');
    var jobModalMeta = document.getElementById('job-modal-meta');
    var jobModalResult = document.getElementById('job-modal-result');
    var jobModalClose = document.getElementById('job-modal-close');
    var jobModalResume = document.getElementById('job-modal-resume');
    var jobModalRuns = document.getElementById('job-modal-runs');
    var jobModalRunsField = document.getElementById('job-modal-runs-field');
    var jobModalToken = 0;
    var controlModal = document.getElementById('control-modal');
    var controlModalTitle = document.getElementById('control-modal-title');
    var controlModalForm = document.getElementById('control-modal-form');
    var controlModalBody = document.getElementById('control-modal-body');
    var controlModalError = document.getElementById('control-modal-error');
    var controlModalConfirm = document.getElementById('control-modal-confirm');
    var controlModalCancel = document.getElementById('control-modal-cancel');
    var resumeSessionButton = document.getElementById('resume-session-button');
    var controlAction = null;
    var pendingKillPid = null;
    var autoOpenToggle = document.getElementById('auto-open-toggle');
    var connection = document.getElementById('connection');
    var connectionText = document.getElementById('connection-text');

    var STATUS = {
      LIVE: { label: 'Running', help: 'The session is writing new events, or its job process is alive and streaming.' },
      IDLE: { label: 'Waiting', help: 'No new events for 20 seconds and no live job process. It may be running a quiet tool.' },
      STALE: { label: 'Needs attention', help: 'The job process died or stopped its heartbeat before completing.' },
      DONE: { label: 'Finished', help: 'The session reported that the task completed.' },
      STOPPED: { label: 'Stopped', help: 'Stopped: the job was cancelled, or the Codex turn was aborted.' },
      ARCHIVED: { label: 'Archived', help: 'This session was archived with codex archive. Copy the unarchive command to bring it back.' },
      NEEDS_ANSWER: { label: 'Needs answer', help: 'The handoff finished and Codex asked a question.' }
    };
    // Tab and chip ids come from TABS.
    var VIEW_LABELS = {
      LIVE: 'Live', NOW: 'Now', HANDOFFS: 'Handoffs', HISTORY: 'History', CLAUDE: 'Claude',
      ALL: 'All', RUNNING: 'Running', WAITING: 'Waiting', ATTENTION: 'Needs attention', ANSWER: 'Needs answer',
      FINISHED: 'Finished', STOPPED: 'Stopped', ARCHIVED: 'Archived', DISMISSED: 'Dismissed', EVERYTHING: 'Everything'
    };

    function loadPrefs() {
      var loaded;
      try {
        loaded = Object.assign({}, defaults, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
      } catch (_) {
        loaded = Object.assign({}, defaults);
      }
      delete loaded.internals; // dropped pref: the feed always shows everything, injected blocks collapsed
      return loaded;
    }

    function savePrefs() {
      try {
        // prefs.home is a runtime-only flag (the Now-overview toggle), never persisted.
        var toSave = Object.assign({}, prefs);
        delete toSave.home;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
      } catch (_) {}
    }

    function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
    function currentSession() { return sessions.find(function (session) { return session.id === selected; }); }
    function isDismissed(id) { return (prefs.dismissed || []).indexOf(id) !== -1; }
    function sessionStart(id) {
      var match = String(id || '').match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
      return match ? new Date(+match[1], match[2] - 1, +match[3], +match[4], +match[5], +match[6]).getTime() : 0;
    }
    function relativeTime(timestamp) {
      if (!timestamp) return '';
      var seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
      if (seconds < 5) return 'now';
      if (seconds < 60) return seconds + 's ago';
      var minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      var hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.floor(hours / 24) + 'd ago';
    }
    function eventTime(timestamp) {
      try { return timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; }
      catch (_) { return ''; }
    }
    function firstLine(text, limit) {
      // Legacy view-model checks also extract this helper on its own.
      var value = typeof stripMarkdown === 'function' ? stripMarkdown(text) : String(text || '').replace(/\s+/g, ' ').trim();
      return value.length > limit ? value.slice(0, limit - 1) + '\u2026' : value;
    }
