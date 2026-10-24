/* ===========================================================
   侦探档案 · 单机推理
   流程：选案 → 简报 → 调查（勘察/审讯/对质/笔记）→ 指控 → 结案
   无依赖、无构建、无网络请求（排行榜为本地实现，见 Leaderboard）
   =========================================================== */

const RECORDS_KEY = 'detective_records_v1';
const MUTE_KEY = 'detective_muted_v1';
const PROGRESS_KEY = 'detective_progress_v1';
const DAILY_KEY = 'detective_daily_v1';
const DAILY_CASES_KEY = 'detective_daily_cases_v1';

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

/* ---------------- 每日一案 ----------------
   按本地日期算出一桩当日案件，同一天所有设备一致，隔天自动换案。
   当日最好成绩单独存一份，跨天自动作废。 */
const Daily = {
    load() {
        try { return JSON.parse(localStorage.getItem(DAILY_KEY) || 'null'); }
        catch (e) { return null; }
    },
    today() {
        const rec = this.load();
        return rec && rec.date === todayKey() ? rec : null;
    },
    record(caseId, rank, elapsed) {
        const old = this.today();
        if (old && old.caseId === caseId) {
            const oldScore = Leaderboard.staticRank(old.rank);
            const newScore = Leaderboard.staticRank(rank);
            if (oldScore > newScore || (oldScore === newScore && old.elapsed <= elapsed)) return false;
        }
        const rec = {
            date: todayKey(), caseId: caseId, rank: rank,
            elapsed: elapsed, at: Date.now()
        };
        try { localStorage.setItem(DAILY_KEY, JSON.stringify(rec)); } catch (e) { }
        return true;
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

/* 本地日期：YYYY-MM-DD */
function todayKey() {
    const t = new Date();
    const m = t.getMonth() + 1;
    const d = t.getDate();
    return t.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

/* 本地日序号：相邻两天必然差 1，用来轮换每日案件 */
function dayIndex() {
    const t = new Date();
    return Math.floor(new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() / 86400000);
}

function dayLabel() {
    const t = new Date();
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][t.getDay()];
    return (t.getMonth() + 1) + ' 月 ' + t.getDate() + ' 日 · ' + week;
}

/* 每日案件缓存：{ 'YYYY-MM-DD': 案件对象 }，一旦收录就永久保留在本机 */
function loadDailyCases() {
    try {
        const raw = JSON.parse(localStorage.getItem(DAILY_CASES_KEY) || '{}');
        return raw && typeof raw === 'object' ? raw : {};
    }
    catch (e) { return {}; }
}

function saveDailyCases(map) {
    try { localStorage.setItem(DAILY_CASES_KEY, JSON.stringify(map)); }
    catch (e) { /* 配额或隐私模式，忽略 */ }
}

/* 难度文字 → 星级。新案件沿用「入门 / 进阶 / 困难 / 极难」即可自动识别 */
function diffStars(level) {
    const s = String(level || '');
    if (s.indexOf('入门') >= 0 || s.indexOf('简单') >= 0) return 1;
    if (s.indexOf('进阶') >= 0 || s.indexOf('普通') >= 0 || s.indexOf('中等') >= 0) return 2;
    if (s.indexOf('困难') >= 0 || s.indexOf('高级') >= 0) return 3;
    if (s.indexOf('极难') >= 0 || s.indexOf('地狱') >= 0) return 4;
    return 2;
}

function starsText(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += '★';
    return out;
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
    combinePick: [],
    combineHint: null,
    combineMisses: 0,
    combineStatus: { text: '', cls: '' },
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
        this.syncDailyCases();
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
        const base = (typeof window !== 'undefined' && Array.isArray(window.CASES)) ? window.CASES : [];
        const extra = this.cachedCases();
        if (!extra.length) return base;
        const ids = {};
        base.forEach(function (c) { ids[c.id] = true; });
        return base.concat(extra.filter(function (c) { return c && c.id && !ids[c.id]; }));
    },

    /* 已收录的每日案件，按日期升序 */
    cachedCases() {
        const map = loadDailyCases();
        return Object.keys(map).sort().map(function (k) { return map[k]; })
            .filter(function (c) {
                return c && c.id && Array.isArray(c.suspects) && Array.isArray(c.evidence);
            });
    },

    /* 拉取 daily/index.json，把最近几天未收录的案件存进本机（失败静默） */
    syncDailyCases() {
        const self = this;
        if (typeof fetch !== 'function') return;
        const stamp = Date.now();
        fetch('daily/index.json?t=' + stamp, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (index) {
                if (!index || typeof index !== 'object') return null;
                const cached = loadDailyCases();
                const missing = Object.keys(index).sort().slice(-7).filter(function (d) {
                    return !cached[d];
                });
                if (!missing.length) return null;
                return Promise.all(missing.map(function (d) {
                    return fetch('daily/' + index[d] + '?t=' + stamp)
                        .then(function (r) { return r.ok ? r.json() : null; })
                        .catch(function () { return null; });
                })).then(function (list) {
                    const map = loadDailyCases();
                    let added = 0;
                    list.forEach(function (c, i) {
                        if (!c || !c.id || map[missing[i]]) return;
                        map[missing[i]] = c;
                        added++;
                    });
                    if (!added) return;
                    saveDailyCases(map);
                    self.renderHome();
                    self.showToast('新案件已收入档案柜', 'gold');
                });
            })
            .catch(function () { /* 离线或 file:// 打开时静默跳过 */ });
    },

    renderHome() {
        const list = document.getElementById('case-list');
        if (!list) return;
        const cases = this.allCases();

        const kicker = document.getElementById('home-kicker');
        if (kicker) kicker.textContent = 'CASE ARCHIVE · ' + cases.length + ' 卷宗在册';

        let taken = 0, solved = 0, bestRank = '';
        cases.forEach(function (c) {
            const best = Leaderboard.bestOf(c.id);
            if (!best) return;
            taken++;
            if (best.rank !== 'D') solved++;
            if (!bestRank || Leaderboard.staticRank(best.rank) > Leaderboard.staticRank(bestRank)) {
                bestRank = best.rank;
            }
        });
        this.renderHomeStats(taken, solved, bestRank, cases.length);

        list.innerHTML = cases.map(function (c, i) {
            const best = Leaderboard.bestOf(c.id);
            const bestText = best
                ? '最佳 ' + best.rank + ' · ' + fmtTime(best.elapsed)
                : '未结案';
            const no = 'No.' + (i + 1 < 10 ? '0' : '') + (i + 1);
            const seal = best
                ? '<span class="case-seal' + (best.rank === 'D' ? ' is-fail' : '') + '">'
                    + (best.rank === 'D' ? '未结案' : '已结案') + '</span>'
                : '';
            return '<button class="case-card" onclick="playSfx(\'click\');app.openCase(\'' + c.id + '\')">'
                + '<div class="case-cover">'
                + '<span class="case-cover-emoji">' + c.cover + '</span>'
                + '<span class="case-cover-no">' + no + '</span>'
                + seal
                + '</div>'
                + '<div class="case-tags">'
                + '<span class="case-tag is-diff">' + starsText(diffStars(c.difficulty))
                + ' ' + c.difficulty + '</span>'
                + '<span class="case-tag">' + c.duration + '</span>'
                + '</div>'
                + '<div><div class="case-title">' + c.title + '</div>'
                + '<div class="case-sub">' + c.subtitle + '</div></div>'
                + '<div class="case-desc">' + c.desc + '</div>'
                + '<div class="case-meta"><span>' + c.tags.join(' · ') + '</span>'
                + '<span class="case-best">' + bestText + '</span></div>'
                + '</button>';
        }).join('') + this.buildGhostCards(cases.length, Math.max(0, 3 - cases.length % 3));

        this.renderDaily();
        this.renderResumeSlot();
    },

    /* ---------- 每日一案 ---------- */
    dailyCase() {
        const todayId = 'daily-' + todayKey();
        const picked = this.cachedCases().filter(function (c) { return c.id === todayId; })[0];
        if (picked) return picked;
        const cases = this.allCases();
        if (!cases.length) return null;
        return cases[dayIndex() % cases.length];
    },

    renderDaily() {
        const box = document.getElementById('daily-slot');
        if (!box) return;
        const c = this.dailyCase();
        if (!c) { box.innerHTML = ''; return; }

        const rec = Daily.today();
        const done = !!(rec && rec.caseId === c.id && rec.rank !== 'D');
        const p = this.loadProgress();
        const going = !!(p && p.caseId === c.id && p.isDaily && !done);

        let btn = '接手今日案件 →';
        let note = '每天一桩，明日换案';
        if (done) {
            btn = '再办一次 →';
            note = '今日已完成 · ' + rec.rank + ' 级 · ' + fmtTime(rec.elapsed);
        }
        else if (going) {
            btn = '继续今日案 →';
            const seen = Object.keys(p.seen || {}).length;
            note = '已勘察 ' + seen + '/' + c.evidence.length + ' 件证物';
        }

        const idx = this.allCases().findIndex(function (x) { return x.id === c.id; });
        const no = 'No.' + (idx + 1 < 10 ? '0' : '') + (idx + 1);

        box.innerHTML = '<div class="daily-card' + (done ? ' is-done' : '') + '">'
            + '<span class="daily-mark">' + c.cover + '</span>'
            + '<div class="daily-main">'
            + '<span class="daily-kicker">每日一案 · ' + dayLabel() + '</span>'
            + '<div class="daily-title">' + c.title
            + '<span class="daily-no">' + no + '</span>'
            + '<span class="daily-stars">' + starsText(diffStars(c.difficulty)) + '</span></div>'
            + '<p class="daily-desc">' + c.desc + '</p>'
            + '</div>'
            + '<div class="daily-side">'
            + '<button class="daily-btn" onclick="playSfx(\'click\');app.openDailyCase()">' + btn + '</button>'
            + '<span class="daily-note' + (done ? ' is-done' : '') + '">' + note + '</span>'
            + '</div>'
            + '</div>';
    },

    openDailyCase() {
        const c = this.dailyCase();
        if (!c) return;
        const p = this.loadProgress();
        if (p && p.caseId === c.id && p.isDaily) { this.resumeCase(); return; }
        this.openCase(c.id, true);
    },

    renderHomeStats(taken, solved, bestRank, total) {
        const box = document.getElementById('home-stats');
        if (!box) return;
        const items = [
            { label: '已接手', value: taken + '<em>/' + total + '</em>', cls: '' },
            { label: '已结案', value: solved + '<em>桩</em>', cls: solved ? 'is-gold' : '' },
            { label: '最佳评级', value: bestRank || '—', cls: bestRank ? (bestRank === 'D' ? 'is-fail' : 'is-gold') : '' }
        ];
        box.innerHTML = items.map(function (it) {
            return '<div class="home-stat">'
                + '<span class="stat-value ' + it.cls + '">' + it.value + '</span>'
                + '<span class="stat-label">' + it.label + '</span>'
                + '</div>';
        }).join('');
    },

    buildGhostCards(used, n) {
        let html = '';
        for (let i = 0; i < n; i++) {
            const no = 'No.' + (used + i + 1 < 10 ? '0' : '') + (used + i + 1);
            html += '<div class="case-card is-ghost">'
                + '<div class="case-cover"><span class="case-cover-emoji">🗂️</span>'
                + '<span class="case-cover-no">' + no + '</span></div>'
                + '<div class="ghost-title">档案整理中</div>'
                + '<div class="ghost-desc">这一格的卷宗还在誊抄。先把眼前的案子办完，档案柜里还有空位。</div>'
                + '</div>';
        }
        return html;
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
                isDaily: !!this.state.isDaily,
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
        const dc = this.dailyCase();
        if (p.isDaily && dc && dc.id === p.caseId) { slot.innerHTML = ''; return; }
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
            isDaily: !!p.isDaily,
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
        this.combinePick = [];
        this.combineHint = null;
        this.combineStatus = { text: '', cls: '' };
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
    openCase(caseId, isDaily) {
        const c = this.allCases().filter(function (x) { return x.id === caseId; })[0];
        if (!c) return;
        this.dailyPending = !!isDaily;
        this.caseData = c;
        this.state = null;
        this.currentPid = null;
        this.selectedEvidence = null;
        this.focusPersonId = null;

        const idx = this.allCases().findIndex(function (x) { return x.id === c.id; });
        document.getElementById('brief-no').textContent =
            'CASE FILE No.' + (idx + 1 < 10 ? '0' : '') + (idx + 1);
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

        const planBox = document.getElementById('brief-plan');
        if (planBox) {
            planBox.innerHTML = this.buildFloorPlanSvg(c.floorPlan, false);
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

        this.renderRelationMap();
        this.renderRelationDetail();

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
            isDaily: !!this.dailyPending,
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
        this.combinePick = [];
        this.combineHint = null;
        this.combineStatus = { text: '', cls: '' };
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
        this.renderFloorPlan();
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
        this.renderEvidence();
        this.renderFloorPlan();
        this.renderEvidenceDetail();
        this.renderInterview();
        this.renderStats();
        this.renderNotes();
        this.saveProgress();
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
        playSfx('click');
        this.renderSuspectTabs();
        this.renderInterview();
        this.renderStats();
        this.renderNotes();
        this.saveProgress();
        this.state.fresh = {};
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

        this.renderSuspectTabs();
        this.renderInterview();
        this.renderStats();
        this.renderNotes();
        this.saveProgress();
    },

    /* ---------- 现场平面图 ---------- */
    buildFloorPlanSvg(fp, interactive) {
        if (!fp) return '';
        const self = this;

        const shapes = (fp.shapes || []).map(function (s) {
            if (s.type === 'rect') {
                const cls = (s.w >= 200 || s.h >= 100) ? 'fp-room' : 'fp-furniture';
                return '<rect class="' + cls + '" x="' + s.x + '" y="' + s.y + '" width="' + s.w
                    + '" height="' + s.h + '" rx="1"/>';
            }
            if (s.type === 'line') {
                return '<line class="fp-line" x1="' + s.x1 + '" y1="' + s.y1
                    + '" x2="' + s.x2 + '" y2="' + s.y2 + '"/>';
            }
            if (s.type === 'label') {
                return '<text class="fp-label" x="' + s.x + '" y="' + s.y + '">' + s.text + '</text>';
            }
            return '';
        }).join('');

        const spots = (fp.spots || []).map(function (sp) {
            const seen = !!(self.state && self.state.seen[sp.evidence]);
            const active = self.selectedEvidence === sp.evidence;
            const cls = 'fp-spot' + (seen ? ' is-seen' : '') + (active ? ' is-active' : '');
            const ev = self.caseData.evidence.filter(function (e) { return e.id === sp.evidence; })[0];
            const name = sp.name || (ev ? ev.name : '');
            const click = interactive
                ? ' onclick="playSfx(\'click\');app.selectEvidence(\'' + sp.evidence + '\')"'
                : '';
            return '<g class="' + cls + '"' + click + '>'
                + '<circle cx="' + sp.x + '" cy="' + sp.y + '" r="6.5"/>'
                + '<text x="' + sp.x + '" y="' + (sp.y + 13) + '" text-anchor="middle">' + name + '</text>'
                + '</g>';
        }).join('');

        return '<svg viewBox="0 0 280 160" xmlns="http://www.w3.org/2000/svg">'
            + shapes + spots + '</svg>';
    },

    renderFloorPlan() {
        const box = document.getElementById('floor-plan');
        if (!box || !this.caseData) return;
        box.innerHTML = this.buildFloorPlanSvg(this.caseData.floorPlan, true);
    },

    /* ---------- 证据关联台 ---------- */
    openCombine() {
        if (!this.state) return;
        this.combinePick = [];
        this.combineHint = null;
        this.combineStatus = { text: '', cls: '' };
        this.renderCombine();
        const modal = document.getElementById('combine-modal');
        if (modal) modal.classList.remove('hidden');
        playSfx('click');
    },

    closeCombine() {
        const modal = document.getElementById('combine-modal');
        if (modal) modal.classList.add('hidden');
        this.combinePick = [];
        this.combineHint = null;
        this.combineStatus = { text: '', cls: '' };
    },

    combineItems() {
        const self = this;
        const evidences = this.caseData.evidence.filter(function (e) {
            return self.state.seen[e.id];
        }).map(function (e) {
            return { id: e.id, icon: e.icon, label: e.name, kind: 'ev' };
        });

        const statements = [];
        this.caseData.suspects.forEach(function (s) {
            s.statements.forEach(function (st) {
                if (!self.state.found[st.id]) return;
                statements.push({
                    id: st.id,
                    icon: s.emoji,
                    label: s.name + '：' + st.text,
                    kind: 'st'
                });
            });
        });

        return { evidences: evidences, statements: statements };
    },

    renderCombine() {
        const items = this.combineItems();
        const self = this;
        const picked = this.combinePick;
        const all = items.evidences.concat(items.statements);

        const pickedBox = document.getElementById('combine-picked');
        if (pickedBox) {
            pickedBox.innerHTML = [0, 1].map(function (i) {
                const id = picked[i];
                const item = id ? all.filter(function (x) { return x.id === id; })[0] : null;
                return '<span class="combine-slot' + (item ? ' is-filled' : '') + '">'
                    + (item ? item.icon + ' ' + item.label : '选择第 ' + (i + 1) + ' 条线索')
                    + '</span>';
            }).join('');
        }

        const renderList = function (list) {
            if (!list.length) return '<p class="notes-empty">还没有可用的线索。</p>';
            return list.map(function (x) {
                return '<button class="combine-item' + (picked.indexOf(x.id) >= 0 ? ' is-picked' : '')
                    + (self.combineHint === x.id ? ' is-hint' : '') + '"'
                    + ' onclick="playSfx(\'click\');app.pickCombine(\'' + x.id + '\')">'
                    + '<span class="ci-icon">' + x.icon + '</span>'
                    + '<span>' + x.label + '</span></button>';
            }).join('');
        };

        const evBox = document.getElementById('combine-evidence');
        const stBox = document.getElementById('combine-statements');
        if (evBox) evBox.innerHTML = renderList(items.evidences);
        if (stBox) stBox.innerHTML = renderList(items.statements);

        const status = document.getElementById('combine-status');
        if (status) {
            const s = this.combineStatus || { text: '', cls: '' };
            status.className = 'combine-status' + (s.cls ? ' is-' + s.cls : '');
            status.textContent = s.text || '';
        }
    },

    pickCombine(id) {
        const idx = this.combinePick.indexOf(id);
        if (idx >= 0) {
            this.combinePick.splice(idx, 1);
        }
        else {
            if (this.combinePick.length >= 2) {
                this.showToast('一次只能关联两条线索', 'red');
                return;
            }
            this.combinePick.push(id);
        }
        this.combineStatus = { text: '', cls: '' };
        this.renderCombine();
    },

    findHintPair() {
        const self = this;
        const target = this.caseData.deductions.filter(function (d) {
            if (self.state.found[d.id]) return false;
            return (d.needs || []).every(function (n) { return self.state.found[n]; });
        })[0];
        if (!target || !target.needs || target.needs.length !== 2) return null;
        return { a: target.needs[0], b: target.needs[1] };
    },

    doCombine() {
        if (!this.state) return;
        if (this.combinePick.length !== 2) {
            this.showToast('先选两条线索', 'red');
            return;
        }
        const a = this.combinePick[0];
        const b = this.combinePick[1];

        const hit = this.caseData.deductions.filter(function (d) {
            if (!d.needs || d.needs.length !== 2) return false;
            return d.needs.indexOf(a) >= 0 && d.needs.indexOf(b) >= 0;
        })[0];

        if (hit) {
            if (this.state.found[hit.id]) {
                this.combineStatus = { text: '这条关联你已经记下了：' + hit.text, cls: 'ok' };
            }
            else {
                this.state.found[hit.id] = true;
                this.combineStatus = { text: '关联成立 —— ' + hit.text, cls: 'ok' };
                playSfx('clue');
                this.showToast('推理笔记 +1', 'gold');
                this.saveProgress();
            }
            this.renderNotes();
            this.renderStats();
            this.combinePick = [];
            this.combineHint = null;
            this.renderCombine();
            return;
        }

        this.combineMisses++;
        this.combineStatus = { text: '这两件事对不上。换个角度试试。', cls: 'no' };
        playSfx('wrong');

        if (this.combineMisses % 3 === 0) {
            const pair = this.findHintPair();
            if (pair) {
                this.combineHint = pair.a;
                this.combineStatus = { text: '提示：高亮的这条线索，能和对面的某一条对上。', cls: 'ok' };
            }
        }
        this.combinePick = [];
        this.renderCombine();
    },

    /* ---------- 推理笔记 ---------- */

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

        const tabMap = {
            deductions: 'ntab-deductions',
            timeline: 'ntab-timeline',
            dossier: 'ntab-dossier'
        };
        Object.keys(tabMap).forEach(function (key) {
            const el = document.getElementById(tabMap[key]);
            if (el && el.classList) el.classList.toggle('is-active', app.notesTab === key);
        });

        if (this.notesTab === 'timeline') { this.renderTimeline(body, count); return; }
        if (this.notesTab === 'dossier') { this.renderDossier(body, count); return; }

        const items = this.caseData.deductions.filter(function (d) { return self.state.found[d.id]; });
        if (count) count.textContent = items.length + '/' + this.caseData.deductions.length;

        if (!items.length) {
            body.innerHTML = '<p class="notes-empty">勘察证物、追问口供，然后点「关联证据」把两条线索放在一起——关联成立，推论就会记在这里。</p>';
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

    /* ---------- 关系网 ---------- */
    buildRelationSvg() {
        const self = this;
        const people = this.caseData.suspects;
        const relations = this.caseData.relations || [];
        const n = people.length;
        const cx = 150, cy = 128, radius = 92;
        const pos = {};

        people.forEach(function (p, i) {
            const ang = -Math.PI / 2 + i * 2 * Math.PI / n;
            pos[p.pid] = { x: cx + radius * Math.cos(ang), y: cy + radius * Math.sin(ang) };
        });

        const lines = relations.map(function (rel) {
            const a = pos[rel.a], b = pos[rel.b];
            if (!a || !b) return '';
            const on = self.focusPersonId && (rel.a === self.focusPersonId || rel.b === self.focusPersonId);
            return '<line class="rel-line' + (on ? ' is-on' : '') + '" x1="' + a.x.toFixed(1)
                + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"/>';
        }).join('');

        const nodes = people.map(function (p) {
            const pt = pos[p.pid];
            const on = self.focusPersonId === p.pid;
            return '<g class="rel-node' + (on ? ' is-on' : '') + '"'
                + ' onclick="app.focusPerson(\'' + p.pid + '\')">'
                + '<circle cx="' + pt.x.toFixed(1) + '" cy="' + pt.y.toFixed(1) + '" r="21"/>'
                + '<text class="rel-emoji" x="' + pt.x.toFixed(1) + '" y="' + (pt.y + 5).toFixed(1)
                + '" text-anchor="middle">' + p.emoji + '</text>'
                + '<text class="rel-name" x="' + pt.x.toFixed(1) + '" y="' + (pt.y + 34).toFixed(1)
                + '" text-anchor="middle">' + p.name + '</text>'
                + '</g>';
        }).join('');

        return '<svg viewBox="0 0 300 268" xmlns="http://www.w3.org/2000/svg">'
            + lines + nodes + '</svg>';
    },

    renderRelationMap() {
        const box = document.getElementById('relation-map');
        if (!box || !this.caseData) return;
        box.innerHTML = this.buildRelationSvg();
    },

    renderRelationDetail() {
        const box = document.getElementById('relation-detail');
        if (!box || !this.caseData) return;
        const self = this;
        const pid = this.focusPersonId;
        if (!pid) {
            box.innerHTML = '点一个人，看看他和这屋子里其他人的关系。';
            return;
        }
        const person = this.caseData.suspects.filter(function (s) { return s.pid === pid; })[0];
        const list = (this.caseData.relations || []).filter(function (r) {
            return r.a === pid || r.b === pid;
        });
        if (!person || !list.length) {
            box.innerHTML = '这个人在这间屋子里没有更多关系。';
            return;
        }
        box.innerHTML = '<div class="rel-focus">' + person.emoji + ' ' + person.name + ' 的关系</div>'
            + list.map(function (r) {
                const otherId = r.a === pid ? r.b : r.a;
                const other = self.caseData.suspects.filter(function (s) { return s.pid === otherId; })[0];
                return '<div class="rel-row">'
                    + '<div class="rel-pair">' + (other ? other.name : '？') + ' · ' + r.label + '</div>'
                    + '<div class="rel-text">' + r.detail + '</div></div>';
            }).join('');
    },

    focusPerson(pid) {
        this.focusPersonId = this.focusPersonId === pid ? null : pid;
        this.renderRelationMap();
        this.renderRelationDetail();
        playSfx('click');
    },

    /* ---------- 卷宗附件 ---------- */
    renderDossier(body, count) {
        const docs = this.caseData.dossier || [];
        if (count) count.textContent = docs.length ? docs.length + ' 份' : '';
        if (!docs.length) {
            body.innerHTML = '<p class="notes-empty">这一案还没有归档文件。</p>';
            return;
        }
        body.innerHTML = docs.map(function (d) {
            return '<div class="doc-item">'
                + '<div class="doc-type">' + d.type + '</div>'
                + '<div class="doc-title">' + d.title + '</div>'
                + '<p class="doc-body">' + d.body + '</p>'
                + '</div>';
        }).join('');
    },

    showHint() {
        if (!this.state) return;
        this.state.hints++;
        this.saveProgress();

        const pair = this.findHintPair();
        if (pair) {
            this.openCombine();
            this.combineHint = pair.a;
            this.combineStatus = { text: '已经有两条线索能对上了，先拿高亮的这条去配。', cls: 'ok' };
            this.renderCombine();
            playSfx('clue');
            this.showToast('有一组线索可以关联，试试组合台', 'gold');
            return;
        }

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

        const idx = this.allCases().findIndex(function (x) { return x.id === app.caseData.id; });
        const no = idx >= 0 ? idx + 1 : 1;
        const reportNo = document.getElementById('report-no');
        if (reportNo) {
            reportNo.textContent = (this.state && this.state.isDaily ? '每日一案 · ' : '')
                + 'No.' + (no < 10 ? '0' : '') + no
                + ' · ' + new Date().toLocaleDateString('zh-CN');
        }
        const seal = document.getElementById('result-seal');
        if (seal) {
            seal.textContent = r.culpritOk ? '已结案' : '未结案';
            seal.className = 'seal' + (r.culpritOk ? '' : ' is-fail');
        }

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
            if (this.state.isDaily) {
                const dailyNew = Daily.record(this.caseData.id, r.rank, r.elapsed);
                this.showToast(dailyNew ? '每日一案已记入档案' : '今日已有更好的成绩', 'gold');
            }
            else if (isBest) {
                this.showToast('本机最佳记录已更新', 'gold');
            }
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
