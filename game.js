/* ===========================================================
   侦探档案 · 单机推理
   流程：选案 → 简报 → 调查（勘察/审讯/对质/笔记）→ 指控 → 结案
   无依赖、无构建、无网络请求（排行榜为本地实现，见 Leaderboard）
   =========================================================== */

const RECORDS_KEY = 'detective_records_v1';
const MUTE_KEY = 'detective_muted_v1';
const PROGRESS_KEY = 'detective_progress_v1';

/* ---------------- 本机排行榜 ----------------
   目前只写 localStorage。将来接数据库时，只需要把
   load/save 换成 supabase.from('records')，并对 submit 做 async 处理，
   结算页的调用点已经写成 fire-and-forget。 */
const Leaderboard = {
    load() {
        try { return JSON.parse(localStorage.getItem(RECORDS_KEY) || '{}') || {}; }
        catch (e) { return {}; }
    },
    save(records) {
        try { localStorage.setItem(RECORDS_KEY, JSON.stringify(records)); }
        catch (e) { /* 隐私模式下写入失败，忽略 */ }
    },
    staticRank(rank) {
        return { S: 5, A: 4, B: 3, C: 2, D: 1 }[rank] || 0;
    },
    bestOf(caseId) {
        const rec = this.load()[caseId];
        return rec && rec.rank ? rec : null;
    },
    submit(caseId, record) {
        const all = this.load();
        const old = all[caseId];
        const better = !old
            || this.staticRank(record.rank) > this.staticRank(old.rank)
            || (this.staticRank(record.rank) === this.staticRank(old.rank) && record.elapsed < old.elapsed);
        if (better) {
            all[caseId] = record;
            this.save(all);
        }
        return better;
    }
};

/* ---------------- 音效（Web Audio 合成，无资源文件） ---------------- */
let _audioCtx = null;
let _sfxEnabled = true;

function _getAudioCtx() {
    if (!_audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        try { _audioCtx = new Ctx(); } catch (e) { return null; }
    }
    if (_audioCtx.state === 'suspended') { _audioCtx.resume().catch(function () { }); }
    return _audioCtx;
}

function playSfx(type) {
    if (!_sfxEnabled) return;
    const ctx = _getAudioCtx();
    if (!ctx) return;
    const presets = {
        click: { f: 720, d: 0.05, w: 'sine', g: 0.12 },
        clue: { f: 880, d: 0.18, w: 'triangle', g: 0.16 },
        correct: { f: 620, d: 0.16, w: 'triangle', g: 0.18 },
        wrong: { f: 210, d: 0.22, w: 'square', g: 0.1 },
        verdict: { f: 523, d: 0.35, w: 'triangle', g: 0.16 }
    };
    const p = presets[type] || presets.click;
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = p.w;
        osc.frequency.value = p.f;
        const now = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(p.g, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + p.d);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + p.d + 0.02);
    }
    catch (e) { /* 音频失败不影响游戏 */ }
}

/* ---------------- 工具 ---------------- */
function fmtTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
}

function pickRandom(list) {
    if (!list || !list.length) return '';
    return list[Math.floor(Math.random() * list.length)];
}

/* ---------------- 应用 ---------------- */
const app = {
    caseData: null,
    state: null,
    currentPid: null,
    selectedEvidence: null,
    lastResponse: null,
    timerId: null,
    toastTimer: null,
    muted: false,
    notesTab: 'deductions',
    dossierOpen: false,
    panel: 'evidence',
    lastResult: null,
    accusation: { pid: null, evidence: [], motive: null },

    /* ---------- 启动 ---------- */
    init() {
        this.muted = localStorage.getItem(MUTE_KEY) === '1';
        _sfxEnabled = !this.muted;
        const btn = document.getElementById('mute-toggle');
        if (btn) btn.textContent = this.muted ? '🔇' : '🔊';
        this.renderHome();
        this.showScreen('screen-home');
    },

    showScreen(id) {
        ['screen-home', 'screen-brief', 'screen-game', 'screen-accuse', 'screen-result'].forEach(function (sid) {
            const el = document.getElementById(sid);
            if (el) el.classList.toggle('hidden', sid !== id);
        });
        const timer = document.getElementById('case-timer');
        if (timer) timer.classList.toggle('hidden', id !== 'screen-game');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    toggleMute() {
        this.muted = !this.muted;
        _sfxEnabled = !this.muted;
        localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
        document.getElementById('mute-toggle').textContent = this.muted ? '🔇' : '🔊';
        if (!this.muted) playSfx('click');
        this.showToast(this.muted ? '已静音' : '音效已开启');
    },

    showToast(msg, kind) {
        const el = document.getElementById('toast');
        if (!el) return;
        el.textContent = msg;
        el.className = 'toast' + (kind ? ' is-' + kind : '');
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 3200);
    },

    /* ---------- 首页 ---------- */
    allCases() {
        return (typeof window !== 'undefined' && Array.isArray(window.CASES)) ? window.CASES : [];
    },

    renderHome() {
        const list = document.getElementById('case-list');
        if (!list) return;
        const self = this;
        list.innerHTML = this.allCases().map(function (c, i) {
            const best = Leaderboard.bestOf(c.id);
            const bestText = best
                ? '最佳 ' + best.rank + ' · ' + fmtTime(best.elapsed)
                : '未结案';
            const no = 'No.' + (i + 1 < 10 ? '0' : '') + (i + 1);
            return '<button class="case-card" onclick="playSfx(\'click\');app.openCase(\'' + c.id + '\')">'
                + '<div class="case-top">'
                + '<span class="case-cover">' + c.cover + '</span>'
                + '<div class="case-tags">'
                + '<span class="case-tag">' + no + '</span>'
                + '<span class="case-tag is-diff">' + c.difficulty + '</span>'
                + '<span class="case-tag">' + c.duration + '</span>'
                + '</div></div>'
                + '<div><div class="case-title">' + c.title + '</div>'
                + '<div class="case-sub">' + c.subtitle + '</div></div>'
                + '<div class="case-desc">' + c.desc + '</div>'
                + '<div class="case-meta"><span>' + c.tags.join(' · ') + '</span>'
                + '<span class="case-best">' + bestText + '</span></div>'
                + '</button>';
        }).join('');
        this.renderResumeSlot();
    },

    backHome() {
        this.saveProgress();
        this.stopTimer();
        this.caseData = null;
        this.state = null;
        this.currentPid = null;
        this.selectedEvidence = null;
        this.lastResponse = null;
        this.renderHome();
        this.showScreen('screen-home');
    },

    /* ---------- 进度存档 ---------- */
    loadProgress() {
        try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null'); }
        catch (e) { return null; }
    },

    saveProgress() {
        if (!this.state || this.state.solved) return;
        try {
            this.state.elapsed = Math.floor((Date.now() - this.state.startedAt) / 1000);
            localStorage.setItem(PROGRESS_KEY, JSON.stringify({
                caseId: this.state.caseId,
                elapsed: this.state.elapsed,
                found: this.state.found,
                seen: this.state.seen,
                misses: this.state.misses,
                breakthroughs: this.state.breakthroughs,
                hints: this.state.hints,
                currentPid: this.currentPid,
                selectedEvidence: this.selectedEvidence,
                savedAt: Date.now()
            }));
        }
        catch (e) { /* 隐私模式下写入失败，忽略 */ }
    },

    clearProgress() {
        try { localStorage.removeItem(PROGRESS_KEY); } catch (e) { }
    },

    renderResumeSlot() {
        const slot = document.getElementById('resume-slot');
        if (!slot) return;
        const p = this.loadProgress();
        if (!p || !p.caseId) { slot.innerHTML = ''; return; }
        const c = this.allCases().filter(function (x) { return x.id === p.caseId; })[0];
        if (!c) { slot.innerHTML = ''; return; }
        const seen = Object.keys(p.seen || {}).length;
        slot.innerHTML = '<button class="resume-card" onclick="playSfx(\'click\');app.resumeCase()">'
            + '<span>'
            + '<span class="resume-kicker">未结案的卷宗</span>'
            + '<span class="resume-title">' + c.title + '</span>'
            + '<span class="resume-meta">' + fmtTime(p.elapsed || 0) + ' · 已勘察 '
            + seen + '/' + c.evidence.length + ' 件证物</span>'
            + '</span>'
            + '<span class="resume-go">继续调查 →</span>'
            + '</button>';
    },

    resumeCase() {
        const p = this.loadProgress();
        if (!p) { this.renderResumeSlot(); return; }
        const c = this.allCases().filter(function (x) { return x.id === p.caseId; })[0];
        if (!c) { this.clearProgress(); this.renderResumeSlot(); return; }

        this.caseData = c;
        this.state = {
            caseId: c.id,
            startedAt: Date.now() - (p.elapsed || 0) * 1000,
            elapsed: p.elapsed || 0,
            found: p.found || {},
            seen: p.seen || {},
            fresh: {},
            misses: p.misses || 0,
            breakthroughs: p.breakthroughs || 0,
            hints: p.hints || 0
        };
        this.currentPid = p.currentPid || c.suspects[0].pid;
        this.selectedEvidence = p.selectedEvidence || null;
        this.lastResponse = null;
        this.notesTab = 'deductions';
        this.dossierOpen = false;
        this.accusation = { pid: null, evidence: [], motive: null };

        document.getElementById('game-case-name').textContent = c.title + ' · ' + c.subtitle;
        this.setPanel('evidence');
        this.renderGame();
        this.showScreen('screen-game');
        this.startTimer();
        playSfx('click');
        this.showToast('已恢复到上次的调查', 'gold');
    },

    /* ---------- 简报 ---------- */
    openCase(caseId) {
        const c = this.allCases().filter(function (x) { return x.id === caseId; })[0];
        if (!c) return;
        this.caseData = c;
        this.state = null;
        this.currentPid = null;
        this.selectedEvidence = null;

        document.getElementById('brief-tag').textContent = c.tags.join(' · ').toUpperCase();
        document.getElementById('brief-title').textContent = c.title;
        document.getElementById('brief-sub').textContent = c.subtitle;

        const meta = [
            ['时间', c.brief.date],
            ['地点', c.brief.place],
            ['死者', c.brief.victim],
            ['死因', c.brief.cause],
            ['发现', c.brief.found]
        ];
        document.getElementById('brief-meta').innerHTML = meta.map(function (row) {
            return '<dt>' + row[0] + '</dt><dd>' + row[1] + '</dd>';
        }).join('');

        const sceneBox = document.getElementById('scene-block');
        if (sceneBox) {
            if (c.scene) {
                sceneBox.innerHTML = '<div class="scene-title">' + c.scene.title + '</div>'
                    + c.scene.paragraphs.map(function (p) { return '<p>' + p + '</p>'; }).join('')
                    + (c.scene.notes && c.scene.notes.length
                        ? '<div class="scene-note-list">' + c.scene.notes.map(function (n) {
                            return '<span class="scene-note">' + n + '</span>';
                        }).join('') + '</div>'
                        : '');
            }
            else { sceneBox.innerHTML = ''; }
        }

        document.getElementById('brief-summary').textContent = c.brief.summary;

        document.getElementById('brief-roster').innerHTML = c.suspects.map(function (s) {
            return '<div class="roster-item">'
                + '<span class="roster-emoji">' + s.emoji + '</span>'
                + '<div><div class="roster-name">' + s.name + '</div>'
                + '<div class="roster-role">' + s.role + '</div>'
                + '<div class="roster-tag">' + s.tagline + '</div></div>'
                + '</div>';
        }).join('');

        this.showScreen('screen-brief');
    },

    /* ---------- 开局 ---------- */
    startInvestigation() {
        const c = this.caseData;
        if (!c) return;
        const found = {};
        c.suspects.forEach(function (s) {
            s.statements.forEach(function (st) {
                if (st.from === 'start') found[st.id] = true;
            });
        });

        this.state = {
            caseId: c.id,
            startedAt: Date.now(),
            elapsed: 0,
            found: found,
            seen: {},
            fresh: {},
            misses: 0,
            breakthroughs: 0,
            hints: 0
        };
        this.currentPid = c.suspects[0].pid;
        this.selectedEvidence = null;
        this.lastResponse = null;
        this.notesTab = 'deductions';
        this.dossierOpen = false;
        this.accusation = { pid: null, evidence: [], motive: null };

        document.getElementById('game-case-name').textContent = c.title + ' · ' + c.subtitle;

        this.setPanel('evidence');
        this.renderGame();
        this.showScreen('screen-game');
        this.startTimer();
        this.saveProgress();
        playSfx('click');
    },

    confirmQuit() {
        if (window.confirm('放弃本案？进度会自动保留，下次可从档案柜继续。')) {
            this.backHome();
        }
    },

    replayCase() {
        if (!this.caseData) { this.backHome(); return; }
        this.startInvestigation();
    },

    /* ---------- 计时 ---------- */
    startTimer() {
        this.stopTimer();
        const self = this;
        this.timerId = setInterval(function () {
            if (!self.state) return;
            self.state.elapsed = Math.floor((Date.now() - self.state.startedAt) / 1000);
            const el = document.getElementById('case-timer');
            if (el) el.textContent = fmtTime(self.state.elapsed);
        }, 1000);
        const el = document.getElementById('case-timer');
        if (el) el.textContent = fmtTime(this.state ? this.state.elapsed : 0);
    },

    stopTimer() {
        if (this.timerId) { clearInterval(this.timerId); this.timerId = null; }
    },

    /* ---------- 渲染：调查台 ---------- */
    renderGame() {
        this.renderStats();
        this.renderEvidence();
        this.renderEvidenceDetail();
        this.renderSuspectTabs();
        this.renderInterview();
        this.renderNotes();
        this.state.fresh = {};
    },

    renderStats() {
        const el = document.getElementById('game-stat');
        if (!el || !this.state) return;
        const c = this.caseData;
        const seenCount = Object.keys(this.state.seen).length;
        const clueCount = this.countDeductions();
        el.innerHTML = '<b>' + seenCount + '</b>/' + c.evidence.length + ' 已勘察 · <b>'
            + clueCount + '</b> 条推论 · <b>' + this.state.misses + '</b> 次失误';
        this.renderProgress();
    },

    renderProgress() {
        const bar = document.getElementById('progress-fill');
        if (!bar || !this.state) return;
        const total = this.caseData.evidence.length + this.caseData.deductions.length;
        const got = Object.keys(this.state.seen).length + this.countDeductions();
        const pct = total ? Math.min(100, Math.round(got / total * 100)) : 0;
        bar.style.width = pct + '%';
    },

    setPanel(name) {
        this.panel = name;
        const grid = document.getElementById('game-grid');
        if (grid) {
            if (grid.dataset) { grid.dataset.active = name; }
            else if (grid.setAttribute) { grid.setAttribute('data-active', name); }
        }
        const tabs = document.getElementById('mobile-tabs');
        if (tabs && tabs.querySelectorAll) {
            const buttons = tabs.querySelectorAll('button');
            for (let i = 0; i < buttons.length; i++) {
                buttons[i].classList.toggle('is-active', buttons[i].getAttribute('data-panel') === name);
            }
        }
    },

    countDeductions() {
        if (!this.state) return 0;
        return this.caseData.deductions.filter(function (d) {
            return app.state.found[d.id];
        }).length;
    },

    renderEvidence() {
        const grid = document.getElementById('evidence-grid');
        if (!grid) return;
        const self = this;
        grid.innerHTML = this.caseData.evidence.map(function (ev) {
            const seen = !!self.state.seen[ev.id];
            const active = self.selectedEvidence === ev.id;
            return '<button class="evidence-item' + (seen ? ' is-seen' : '') + (active ? ' is-active' : '') + '"'
                + ' onclick="playSfx(\'click\');app.selectEvidence(\'' + ev.id + '\')">'
                + '<span class="evidence-icon">' + ev.icon + '</span>'
                + '<span class="evidence-name">' + ev.name + '</span>'
                + (seen ? '<span class="evidence-seen">✓</span>' : '')
                + '</button>';
        }).join('');
    },

    selectEvidence(evidenceId) {
        if (!this.state) return;
        this.selectedEvidence = evidenceId;
        this.state.seen[evidenceId] = true;
        this.state.found[evidenceId] = true;
        const added = this.checkDeductions();
        this.renderEvidence();
        this.renderEvidenceDetail();
        this.renderInterview();
        this.renderStats();
        this.renderNotes();
        this.saveProgress();
        if (added > 0) {
            playSfx('clue');
            this.showToast('推理笔记 +' + added, 'gold');
        }
    },

    renderEvidenceDetail() {
        const box = document.getElementById('evidence-detail');
        if (!box) return;
        if (!this.selectedEvidence) {
            box.classList.add('hidden');
            box.innerHTML = '';
            return;
        }
        const ev = this.caseData.evidence.filter(function (x) { return x.id === this.selectedEvidence; }.bind(this))[0];
        if (!ev) { box.classList.add('hidden'); return; }
        box.classList.remove('hidden');
        box.innerHTML = '<h4>' + ev.icon + ' ' + ev.name + '</h4>'
            + '<div class="spot">发现于：' + ev.spot + '</div>'
            + '<p>' + ev.desc + '</p>'
            + '<div class="insight">🔍 ' + ev.insight + '</div>';
    },

    renderSuspectTabs() {
        const wrap = document.getElementById('suspect-tabs');
        if (!wrap) return;
        const self = this;
        wrap.innerHTML = this.caseData.suspects.map(function (s) {
            const broken = self.hasBreakthrough(s);
            return '<button class="suspect-tab' + (self.currentPid === s.pid ? ' is-active' : '')
                + (broken ? ' is-broken' : '') + '"'
                + ' onclick="playSfx(\'click\');app.selectSuspect(\'' + s.pid + '\')">'
                + '<span class="suspect-avatar">' + s.emoji + '</span>'
                + '<span class="suspect-tab-name">' + s.name + '</span>'
                + '</button>';
        }).join('');
    },

    hasBreakthrough(suspect) {
        if (!this.state) return false;
        return suspect.statements.some(function (st) {
            return st.from === 'confront' && app.state.found[st.id];
        });
    },

    getSuspect(pid) {
        return this.caseData.suspects.filter(function (s) { return s.pid === pid; })[0];
    },

    selectSuspect(pid) {
        this.currentPid = pid;
        this.lastResponse = null;
        this.renderSuspectTabs();
        this.renderInterview();
    },

    renderInterview() {
        const body = document.getElementById('interview-body');
        if (!body) return;
        const self = this;
        const s = this.getSuspect(this.currentPid);
        if (!s) { body.innerHTML = ''; return; }

        const statements = s.statements.filter(function (st) {
            return self.state.found[st.id];
        });

        const canAsk = s.statements.some(function (st) {
            return st.from === 'ask' && !self.state.found[st.id];
        });
        const hiddenConfront = s.statements.some(function (st) {
            return st.from === 'confront' && !self.state.found[st.id];
        });

        let html = '<div class="suspect-head">'
            + '<span class="suspect-avatar">' + s.emoji + '</span>'
            + '<div><div class="suspect-name">' + s.name + '</div>'
            + '<div class="suspect-role">' + s.role + '</div></div></div>'
            + '<p class="suspect-intro">' + s.intro + '</p>';

        if (s.profile) {
            html += '<div class="dossier">'
                + '<button class="dossier-toggle" onclick="playSfx(\'click\');app.toggleDossier()">'
                + (this.dossierOpen ? '收起档案 ▴' : '查看档案 ▾') + '</button>';
            if (this.dossierOpen) {
                html += '<div class="dossier-body">'
                    + '<span class="k">年龄</span><span class="v">' + s.profile.age + '</span>'
                    + '<span class="k">身份</span><span class="v">' + s.profile.job + '</span>'
                    + '<span class="k">关系</span><span class="v">' + s.profile.relation + '</span>'
                    + '<span class="k">自称</span><span class="v">' + s.profile.alibi + '</span>'
                    + '<span class="k">备注</span><span class="v">' + s.profile.note + '</span>'
                    + '</div>';
            }
            html += '</div>';
        }

        html += statements.map(function (st) {
            const fresh = !!self.state.fresh[st.id];
            return '<div class="statement' + (fresh ? ' is-fresh' : '') + '">'
                + '<span class="statement-tag">' + st.tag + '</span>'
                + st.text + '</div>';
        }).join('');

        if (!hiddenConfront && !canAsk && statements.length) {
            html += '<p class="confront-empty">他已经把知道的都说完了。</p>';
        }

        if (canAsk) {
            html += '<div class="interview-actions">'
                + '<button class="btn-ghost" onclick="playSfx(\'click\');app.askMore(\'' + s.pid + '\')">再问一句</button>'
                + '</div>';
        }

        // 对质区
        const picked = this.selectedEvidence
            ? this.caseData.evidence.filter(function (e) { return e.id === self.selectedEvidence; })[0]
            : null;

        html += '<div class="confront-box">'
            + '<div class="confront-title">对质</div>'
            + (picked
                ? '<div class="confront-picked">已选证物：' + picked.icon + ' ' + picked.name + '</div>'
                : '<div class="confront-empty">先在左侧点一件证物，再拿它来问话。</div>')
            + '<button class="btn-ghost" ' + (picked ? '' : 'disabled ')
            + 'onclick="playSfx(\'click\');app.confront(\'' + s.pid + '\')">出示给 ' + s.name + '</button>'
            + '</div>';

        if (this.lastResponse) {
            html += '<div class="confront-response ' + this.lastResponse.type + '">'
                + this.lastResponse.text + '</div>';
        }

        body.innerHTML = html;
    },

    toggleDossier() {
        this.dossierOpen = !this.dossierOpen;
        playSfx('click');
        this.renderInterview();
    },

    askMore(pid) {
        const s = this.getSuspect(pid);
        if (!s || !this.state) return;
        const target = s.statements.filter(function (st) {
            return st.from === 'ask' && !app.state.found[st.id];
        })[0];
        if (!target) { this.showToast('他没什么可补充的了'); return; }
        this.state.found[target.id] = true;
        this.state.fresh[target.id] = true;
        const added = this.checkDeductions();
        playSfx('click');
        this.renderSuspectTabs();
        this.renderInterview();
        this.renderStats();
        this.renderNotes();
        this.saveProgress();
        this.state.fresh = {};
        if (added > 0) {
            playSfx('clue');
            this.showToast('推理笔记 +' + added, 'gold');
        }
    },

    /* ---------- 对质 ---------- */
    confront(pid) {
        const s = this.getSuspect(pid);
        if (!s || !this.state) return;
        if (!this.selectedEvidence) {
            this.showToast('先选一件证物', 'red');
            return;
        }
        const evId = this.selectedEvidence;
        const entry = (s.confront || []).filter(function (c) {
            return c.evidence === evId && (c.requires || []).every(function (r) { return app.state.found[r]; });
        })[0];

        if (!entry) {
            this.state.misses++;
            this.lastResponse = { type: 'no', text: pickRandom(s.deflect) || '他摇了摇头，什么也没说。' };
            playSfx('wrong');
            this.showToast('这条证据没有打动对方', 'red');
        }
        else if (entry.unlock && !this.state.found[entry.unlock]) {
            this.state.found[entry.unlock] = true;
            this.state.fresh[entry.unlock] = true;
            this.state.breakthroughs++;
            this.lastResponse = { type: 'ok', text: entry.say };
            playSfx('correct');
            this.showToast('突破：他的说法变了', 'green');
        }
        else {
            this.lastResponse = { type: 'ok', text: entry.say };
            playSfx('click');
        }

        const added = this.checkDeductions();
        this.renderSuspectTabs();
        this.renderInterview();
        this.renderStats();
        this.renderNotes();
        this.saveProgress();
        if (added > 0) {
            playSfx('clue');
            this.showToast('推理笔记 +' + added, 'gold');
        }
    },

    /* ---------- 推理笔记 ---------- */
    checkDeductions() {
        if (!this.state) return 0;
        let added = 0;
        const self = this;
        this.caseData.deductions.forEach(function (d) {
            if (self.state.found[d.id]) return;
            const ready = d.needs.every(function (n) { return self.state.found[n]; });
            if (ready) {
                self.state.found[d.id] = true;
                self.state.fresh[d.id] = true;
                added++;
            }
        });
        return added;
    },

    setNotesTab(tab) {
        this.notesTab = tab;
        playSfx('click');
        this.renderNotes();
    },

    renderNotes() {
        const body = document.getElementById('notes-body');
        const count = document.getElementById('notes-count');
        if (!body) return;
        const self = this;

        const dTab = document.getElementById('ntab-deductions');
        const tTab = document.getElementById('ntab-timeline');
        if (dTab && dTab.classList) dTab.classList.toggle('is-active', this.notesTab === 'deductions');
        if (tTab && tTab.classList) tTab.classList.toggle('is-active', this.notesTab === 'timeline');

        if (this.notesTab === 'timeline') { this.renderTimeline(body, count); return; }

        const items = this.caseData.deductions.filter(function (d) { return self.state.found[d.id]; });
        if (count) count.textContent = items.length + '/' + this.caseData.deductions.length;

        if (!items.length) {
            body.innerHTML = '<p class="notes-empty">勘察证物、追问口供、用证据逼问——当你把两件事对上的时候，推论会自动出现在这里。</p>';
            return;
        }
        body.innerHTML = items.map(function (d, i) {
            return '<div class="note-item">'
                + '<span class="note-index">' + (i + 1 < 10 ? '0' : '') + (i + 1) + '</span>'
                + '<span>' + d.text + '</span></div>';
        }).join('');
    },

    renderTimeline(body, count) {
        const self = this;
        const items = this.caseData.timeline || [];
        let shown = 0;
        const html = items.map(function (t) {
            const ok = (t.needs || []).every(function (n) { return self.state.found[n]; });
            if (ok) shown++;
            return '<div class="timeline-item' + (ok ? '' : ' is-locked') + '">'
                + '<span class="timeline-time">' + (ok ? t.time : '--:--') + '</span>'
                + '<span>' + (ok ? t.text : '尚未确认') + '</span></div>';
        }).join('');

        body.innerHTML = html
            + '<div class="timeline-hint">已确认 ' + shown + '/' + items.length
            + ' 个时间点。勘察证物、逼出口供都会点亮新的节点。</div>';
        if (count) count.textContent = shown + '/' + items.length;
    },

    showHint() {
        if (!this.state) return;
        this.state.hints++;
        this.showToast('💡 ' + this.caseData.hint, 'gold');
        playSfx('clue');
    },

    /* ---------- 指控 ---------- */
    openAccuse() {
        if (!this.state) return;
        this.renderAccuse();
        this.showScreen('screen-accuse');
        playSfx('click');
    },

    backToInvestigation() {
        this.showScreen('screen-game');
    },

    renderAccuse() {
        const self = this;
        const acc = this.accusation;

        document.getElementById('accuse-suspects').innerHTML = this.caseData.suspects.map(function (s) {
            return '<button class="accuse-item' + (acc.pid === s.pid ? ' is-picked' : '') + '"'
                + ' onclick="playSfx(\'click\');app.pickAccuseSuspect(\'' + s.pid + '\')">'
                + '<span class="mark">✓</span>' + s.emoji + ' ' + s.name + '</button>';
        }).join('');

        document.getElementById('accuse-evidence').innerHTML = this.caseData.evidence.map(function (ev) {
            const picked = acc.evidence.indexOf(ev.id) >= 0;
            const locked = !picked && acc.evidence.length >= 2;
            return '<button class="accuse-item' + (picked ? ' is-picked' : '') + (locked ? ' is-locked' : '') + '"'
                + ' onclick="playSfx(\'click\');app.pickAccuseEvidence(\'' + ev.id + '\')">'
                + '<span class="mark">✓</span>' + ev.icon + ' ' + ev.name + '</button>';
        }).join('');

        document.getElementById('accuse-motives').innerHTML = this.caseData.motives.map(function (m) {
            return '<button class="accuse-item' + (acc.motive === m.id ? ' is-picked' : '') + '"'
                + ' onclick="playSfx(\'click\');app.pickMotive(\'' + m.id + '\')">'
                + '<span class="mark">✓</span>' + m.text + '</button>';
        }).join('');
    },

    pickAccuseSuspect(pid) {
        this.accusation.pid = pid;
        this.renderAccuse();
    },

    pickAccuseEvidence(evidenceId) {
        const idx = this.accusation.evidence.indexOf(evidenceId);
        if (idx >= 0) {
            this.accusation.evidence.splice(idx, 1);
        }
        else {
            if (this.accusation.evidence.length >= 2) {
                this.showToast('最多只能提交两项关键证据', 'red');
                return;
            }
            this.accusation.evidence.push(evidenceId);
        }
        this.renderAccuse();
    },

    pickMotive(mid) {
        this.accusation.motive = mid;
        this.renderAccuse();
    },

    submitAccusation() {
        const acc = this.accusation;
        if (!acc.pid) { this.showToast('还没选指控对象', 'red'); return; }
        if (acc.evidence.length !== 2) { this.showToast('需要两项关键证据', 'red'); return; }
        if (!acc.motive) { this.showToast('还没选动机', 'red'); return; }

        this.stopTimer();
        this.state.solved = true;
        this.clearProgress();
        const result = this.evaluate();
        this.renderResult(result);
        this.showScreen('screen-result');
        playSfx('verdict');
    },

    /* ---------- 判分 ---------- */
    evaluate() {
        const c = this.caseData;
        const t = c.truth;
        const acc = this.accusation;
        const culpritOk = acc.pid === t.culprit;
        const hits = acc.evidence.filter(function (e) { return t.evidence.indexOf(e) >= 0; }).length;
        const motiveOk = acc.motive === t.motive;

        const elapsed = this.state.elapsed;
        const overtime = Math.max(0, Math.floor((elapsed - 600) / 120)) * 3;
        let score = 55 + hits * 15 + (motiveOk ? 10 : 0)
            - this.state.misses * 5 - this.state.hints * 10 - overtime;

        let rank = 'D';
        if (culpritOk) {
            if (score >= 95 && hits === 2 && motiveOk) rank = 'S';
            else if (score >= 80 && hits >= 1) rank = 'A';
            else if (score >= 60) rank = 'B';
            else rank = 'C';
        }

        const culprit = this.getSuspect(t.culprit);

        return {
            culpritOk: culpritOk,
            hits: hits,
            motiveOk: motiveOk,
            rank: rank,
            score: score,
            elapsed: elapsed,
            culprit: culprit,
            accused: this.getSuspect(acc.pid)
        };
    },

    renderResult(r) {
        this.lastResult = r;
        const t = this.caseData.truth;
        const titles = {
            S: ['真相大白', '每一条证据都咬合在一起，你几乎没有多余的动作。'],
            A: ['案子结了', '结论站得住，但证据链上还有一处缝隙。'],
            B: ['勉强结案', '你抓对了人，可你说不清为什么是他。'],
            C: ['证据不足', '人是抓对了，卷宗却经不起辩护律师看。'],
            D: ['抓错人了', '真凶带着一个不属于他的结局离开了这间屋子。']
        };
        const tinfo = titles[r.rank] || titles.D;

        const badge = document.getElementById('verdict-badge');
        badge.textContent = r.rank;
        badge.className = 'verdict-badge rank-' + r.rank.toLowerCase();

        document.getElementById('verdict-title').textContent = tinfo[0];
        document.getElementById('verdict-sub').textContent = tinfo[1];

        document.getElementById('result-stats').innerHTML = [
            ['用时', fmtTime(r.elapsed)],
            ['失误', this.state.misses],
            ['突破', this.state.breakthroughs],
            ['关键证据', r.hits + ' / 2'],
            ['评级', r.rank]
        ].map(function (row) {
            return '<div class="stat-cell"><div class="k">' + row[0] + '</div><div class="v">' + row[1] + '</div></div>';
        }).join('');

        const accusedName = r.accused ? r.accused.name : '—';
        const realName = r.culprit ? r.culprit.name : '—';

        document.getElementById('truth-block').innerHTML =
            '<h3>卷宗复盘</h3>'
            + '<div class="truth-row"><span class="label">你指控</span><span class="value">'
            + accusedName + (r.culpritOk ? '（真凶）' : '（真凶是 ' + realName + '）') + '</span></div>'
            + '<div class="truth-row"><span class="label">关键证据</span><span class="value">命中 '
            + r.hits + ' / 2</span></div>'
            + '<div class="truth-row"><span class="label">动机</span><span class="value">'
            + (r.motiveOk ? '判断正确' : '判断有误') + '</span></div>'
            + '<div class="truth-row"><span class="label">推理链</span><span class="value">'
            + t.chain.map(function (line, i) { return (i + 1) + '. ' + line; }).join('<br>')
            + '</span></div>'
            + '<p class="truth-story">' + t.story + '</p>';

        // 记录：只有抓对人才进榜
        if (r.culpritOk) {
            const isBest = Leaderboard.submit(this.caseData.id, {
                rank: r.rank,
                elapsed: r.elapsed,
                misses: this.state.misses,
                at: Date.now()
            });
            if (isBest) this.showToast('本机最佳记录已更新', 'gold');
        }
    },

    shareResult() {
        const r = this.lastResult;
        if (!r) return;
        const text = '我在《侦探档案》的「' + this.caseData.title + '」拿到了 '
            + r.rank + ' 级，用时 ' + fmtTime(r.elapsed)
            + '，失误 ' + this.state.misses + ' 次。\n'
            + 'https://974180232-byte.github.io/detective-case/';
        const self = this;
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
                function () { self.showToast('成绩已复制到剪贴板', 'gold'); },
                function () { self.fallbackCopy(text); }
            );
        }
        else {
            this.fallbackCopy(text);
        }
    },

    fallbackCopy(text) {
        if (!document.createElement || !document.body) {
            this.showToast('当前环境不支持复制', 'red');
            return;
        }
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        this.showToast(ok ? '成绩已复制到剪贴板' : '复制失败，请手动选择文本', ok ? 'gold' : 'red');
    },

    /* ---------- 调试/扩展占位 ---------- */
    // 未来接云端排行榜时，在这里补一次 POST：
    // syncLeaderboard(record) { ... }
};

document.addEventListener('DOMContentLoaded', function () {
    app.init();
});
