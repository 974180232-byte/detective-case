/* ===========================================================
   每日案件自检脚本
   -----------------------------------------------------------
   用法：
     node tools/check-case.js daily/2026-10-24.json

   只做「结构性」检查：字段是否齐全、id 引用是否闭合、
   唯一解所需的钩子是否还在。不判断文笔，也不判断逻辑是否成立。

   退出码 0 = 可以发布；1 = 有错误，不要提交。
   =========================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const target = process.argv[2];

if (!target) {
    console.error('用法: node tools/check-case.js <case.json>');
    process.exit(1);
}

const filePath = path.resolve(process.cwd(), target);
if (!fs.existsSync(filePath)) {
    console.error('找不到文件: ' + filePath);
    process.exit(1);
}

/* 读 cases.js 里的内置案件，用于 id 查重 */
function loadBuiltIn() {
    try {
        const src = fs.readFileSync(path.join(root, 'cases.js'), 'utf8');
        const ctx = { window: {} };
        vm.createContext(ctx);
        vm.runInContext(src, ctx, { filename: 'cases.js' });
        return Array.isArray(ctx.window.CASES) ? ctx.window.CASES : [];
    } catch (e) {
        return [];
    }
}

/* 读 daily 目录下其它案件，同样参与 id 查重 */
function loadOtherDailies(skip) {
    const dir = path.join(root, 'daily');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(function (f) { return f.endsWith('.json') && f !== 'index.json'; })
        .map(function (f) { return path.join(dir, f); })
        .filter(function (p) { return path.resolve(p) !== skip; })
        .map(function (p) {
            try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
        })
        .filter(Boolean);
}

const errors = [];
const warns = [];
function err(msg) { errors.push(msg); }
function warn(msg) { warns.push(msg); }

let c;
try {
    c = JSON.parse(fs.readFileSync(filePath, 'utf8'));
} catch (e) {
    console.error('JSON 解析失败: ' + e.message);
    process.exit(1);
}

/* ---------- 1. 顶层字段 ---------- */
const topRequired = ['id', 'title', 'subtitle', 'cover', 'difficulty', 'duration', 'tags', 'desc',
    'brief', 'scene', 'timeline', 'floorPlan', 'suspects', 'evidence', 'deductions', 'motives', 'truth', 'hint'];
topRequired.forEach(function (k) {
    if (c[k] === undefined || c[k] === null || c[k] === '') err('缺少字段: ' + k);
});
['suspects', 'evidence', 'deductions', 'motives', 'timeline', 'tags'].forEach(function (k) {
    if (c[k] !== undefined && !Array.isArray(c[k])) err(k + ' 必须是数组');
});
if (c.brief && typeof c.brief === 'object') {
    ['date', 'place', 'victim', 'cause', 'found', 'summary'].forEach(function (k) {
        if (!c.brief[k]) err('brief 缺少字段: ' + k);
    });
}
if (c.scene && typeof c.scene === 'object') {
    if (!Array.isArray(c.scene.paragraphs) || !c.scene.paragraphs.length) err('scene.paragraphs 不能为空');
}
if (c.truth && typeof c.truth === 'object') {
    ['culprit', 'evidence', 'motive', 'chain', 'story'].forEach(function (k) {
        if (c.truth[k] === undefined) err('truth 缺少字段: ' + k);
    });
    if (Array.isArray(c.truth.chain) && c.truth.chain.length < 3) {
        warn('truth.chain 少于 3 条，结案复盘会显得单薄');
    }
}

/* ---------- 2. id 查重 ---------- */
const others = loadBuiltIn().concat(loadOtherDailies(filePath));
others.forEach(function (o) {
    if (o && o.id === c.id) err('案件 id 与已有案件重复: ' + c.id);
});

/* ---------- 3. 收集 id ---------- */
const suspects = Array.isArray(c.suspects) ? c.suspects : [];
const evidence = Array.isArray(c.evidence) ? c.evidence : [];
const deductions = Array.isArray(c.deductions) ? c.deductions : [];
const motives = Array.isArray(c.motives) ? c.motives : [];

if (suspects.length < 3) warn('嫌疑人少于 3 人，排查感偏弱');
if (suspects.length > 6) warn('嫌疑人多于 6 人，一局可能过长');

const pids = {};
const evIds = {};
const stIds = {};
const pidList = [];
const evList = [];
const stList = [];

suspects.forEach(function (s, i) {
    if (!s || !s.pid) { err('suspects[' + i + '] 缺少 pid'); return; }
    if (pids[s.pid]) err('嫌疑人 pid 重复: ' + s.pid);
    pids[s.pid] = s;
    pidList.push(s.pid);
    ['name', 'role', 'emoji', 'tagline', 'intro'].forEach(function (k) {
        if (!s[k]) err(s.pid + ' 缺少字段: ' + k);
    });
    (s.statements || []).forEach(function (st) {
        if (!st.id) { err(s.pid + ' 有一条口供缺少 id'); return; }
        if (stIds[st.id]) err('口供 id 重复: ' + st.id);
        stIds[st.id] = s.pid;
        stList.push(st.id);
        if (['start', 'ask', 'confront'].indexOf(st.from) < 0) {
            err(st.id + ' 的 from 只能是 start / ask / confront');
        }
    });
    const starts = (s.statements || []).filter(function (st) { return st.from === 'start'; });
    if (!starts.length) err(s.pid + ' 没有 from:"start" 的口供，开局审问他会是空的');
    if (!(s.confront || []).length) warn(s.pid + ' 没有 confront 条目，无法被证据逼问');
});

evidence.forEach(function (e, i) {
    if (!e || !e.id) { err('evidence[' + i + '] 缺少 id'); return; }
    if (evIds[e.id]) err('证物 id 重复: ' + e.id);
    evIds[e.id] = e;
    evList.push(e.id);
    ['icon', 'name', 'spot', 'desc', 'insight'].forEach(function (k) {
        if (!e[k]) err(e.id + ' 缺少字段: ' + k);
    });
});

/* ---------- 4. 引用闭合 ---------- */
function needEv(id, where) {
    if (!evIds[id]) err(where + ' 引用了不存在的证物: ' + id);
}
function needSt(id, where) {
    if (!stIds[id]) err(where + ' 引用了不存在的口供: ' + id);
}

suspects.forEach(function (s) {
    (s.confront || []).forEach(function (cf, i) {
        const where = s.pid + '.confront[' + i + ']';
        if (!cf.evidence) err(where + ' 缺少 evidence');
        else needEv(cf.evidence, where);
        (cf.requires || []).forEach(function (r) { needSt(r, where + '.requires'); });
        if (cf.unlock) needSt(cf.unlock, where + '.unlock');
        if (!cf.say) err(where + ' 缺少 say');
    });
});

deductions.forEach(function (d, i) {
    if (!d.id) err('deductions[' + i + '] 缺少 id');
    if (!Array.isArray(d.needs) || d.needs.length < 2) {
        err((d.id || 'deductions[' + i + ']') + ' 的 needs 至少需要两项');
        return;
    }
    d.needs.forEach(function (n) {
        if (!evIds[n] && !stIds[n]) err(d.id + ' 的 needs 引用了不存在的 id: ' + n);
    });
    if (!d.text) err(d.id + ' 缺少 text');
});

(c.timeline || []).forEach(function (t, i) {
    if (!t.time || !t.text) err('timeline[' + i + '] 缺少 time 或 text');
    (t.needs || []).forEach(function (n) {
        if (!evIds[n] && !stIds[n]) err('timeline[' + i + '] 的 needs 引用了不存在的 id: ' + n);
    });
});

if (c.floorPlan && Array.isArray(c.floorPlan.spots)) {
    c.floorPlan.spots.forEach(function (sp, i) {
        if (sp.evidence) needEv(sp.evidence, 'floorPlan.spots[' + i + ']');
    });
}

(c.relations || []).forEach(function (r, i) {
    if (!pids[r.a]) err('relations[' + i + '].a 不存在: ' + r.a);
    if (!pids[r.b]) err('relations[' + i + '].b 不存在: ' + r.b);
    if (r.a === r.b) err('relations[' + i + '] 指向同一个人: ' + r.a);
    if (!r.label || !r.detail) err('relations[' + i + '] 缺少 label 或 detail');
});

motives.forEach(function (m, i) {
    if (!m.id || !m.text) err('motives[' + i + '] 缺少 id 或 text');
});

/* ---------- 5. 真相 ---------- */
if (c.truth) {
    if (!pids[c.truth.culprit]) err('truth.culprit 不在嫌疑人里: ' + c.truth.culprit);
    if (!motives.filter(function (m) { return m.id === c.truth.motive; }).length) {
        err('truth.motive 不在动机列表里: ' + c.truth.motive);
    }
    if (!Array.isArray(c.truth.evidence) || c.truth.evidence.length !== 2) {
        err('truth.evidence 必须恰好是两项');
    } else {
        c.truth.evidence.forEach(function (id) { needEv(id, 'truth.evidence'); });
        const uniq = c.truth.evidence.filter(function (v, i, a) { return a.indexOf(v) === i; });
        if (uniq.length !== 2) err('truth.evidence 两项不能相同');
    }
}

/* ---------- 6. 死内容警告 ---------- */
const usedEv = {};
suspects.forEach(function (s) {
    (s.confront || []).forEach(function (cf) { if (cf.evidence) usedEv[cf.evidence] = true; });
});
deductions.forEach(function (d) {
    (d.needs || []).forEach(function (n) { if (evIds[n]) usedEv[n] = true; });
});
evList.forEach(function (id) {
    if (!usedEv[id]) warn(id + ' 既不能对质、也不参与推论，玩家拿到它没有任何用途');
});

const unlocked = {};
suspects.forEach(function (s) {
    (s.confront || []).forEach(function (cf) { if (cf.unlock) unlocked[cf.unlock] = true; });
});
deductions.forEach(function (d) {
    (d.needs || []).forEach(function (n) { if (stIds[n]) unlocked[n] = true; });
});
Object.keys(stIds).forEach(function (id) {
    const owner = pids[stIds[id]];
    const from = ((owner.statements || []).filter(function (x) { return x.id === id; })[0] || {}).from;
    // start 开局就有；ask 由「再问一句」取；只有 confront 必须被某条对质解锁
    if (from === 'confront' && !unlocked[id]) {
        warn(id + ' 是被逼问出的口供，但没有任何 confront 条目 unlock 它');
    }
});

/* ---------- 输出 ---------- */
const name = c.title || c.id || target;
console.log('');
console.log('案件：' + name + '  (' + (c.id || '无 id') + ')');
console.log('嫌疑人 ' + pidList.length + ' · 证物 ' + evList.length
    + ' · 口供 ' + stList.length + ' · 推论 ' + deductions.length
    + ' · 动机 ' + motives.length + ' · 时间线 ' + ((c.timeline || []).length));

warns.forEach(function (w) { console.log('  ! ' + w); });
errors.forEach(function (e) { console.log('  ✗ ' + e); });

console.log('');
if (errors.length) {
    console.log('未通过：' + errors.length + ' 个错误，' + warns.length + ' 个警告。不要发布。');
    process.exit(1);
}
console.log('通过：0 个错误，' + warns.length + ' 个警告。');
