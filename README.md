# 侦探档案 · Detective Casebook

单机侦探推理网页游戏。一次一桩案件：读完卷宗、勘察现场、审讯五名嫌疑人、用证物对质，最后提交指控。一局约 10-15 分钟。

纯静态站点：原生 HTML / CSS / JavaScript，无框架、无构建、无后端。唯一的网络请求是启动时拉取「每日一案」清单，失败就静默回退到内置案件。

## 玩法

1. **案发现场** —— 先读一段第一人称的现场记录：你看到什么、闻到什么、哪里不对劲。末尾是速记的现场要点。
2. **案情简报** —— 看死者、死因、发现经过，记住每个人自称在哪里。
3. **现场勘察** —— 左边是平面图，证物钉在它该在的位置；也可以点下面的列表。第一眼看不出的东西会以「🔍 推断」提示。
4. **审讯** —— 选一名嫌疑人，读他的口供；「再问一句」能挤出第二段话，「查看档案」有年龄、关系、自称的不在场证明。
5. **对质** —— 选中某件证物，出示给嫌疑人。戳中要害他会改口，戳偏了会消耗你的失误数。
6. **关联证据** —— 点「关联证据」打开组合台，从已勘察的证物和已获得的口供里挑两条建立关联。关联成立会生成推论并写进笔记；配错不扣失误，连错三次会高亮一条能用的线索。
7. **推理笔记** —— 「推论」记录你建立的关联，「时间线」点亮你确认的时间点，没查实的显示「尚未确认」。
8. **提交指控** —— 选凶手 + 两项关键证据 + 动机。评级 S / A / B / C / D，结案后可一键复制成绩。

评级只看三件事：人抓对没有、证据立不立得住、动机说没说对；失误、提示、超时会扣分。

## 本地运行

双击 `index.html` 可以玩内置案件，但浏览器会拦掉 `file://` 下的 `fetch`，每日一案拉不到（静默跳过，不报错）。要验证每日案件，用本地服务器：

```powershell
# 任选其一
python -m http.server 8080
npx serve .
```

然后访问 <http://localhost:8080>。

## 部署到 GitHub Pages

1. 在 GitHub 新建空仓库（不要勾 README / .gitignore）。
2. 在本目录执行一次：

```powershell
powershell -ExecutionPolicy Bypass -File .\push.ps1 -Message "feat: 侦探档案首版"
```

`push.ps1` 会自动 `add` / `commit` / `push`，失败会按递增间隔无限重试，直到推送成功。

3. 仓库 Settings → Pages → Source 选 **Deploy from a branch** → 分支 `main`、目录 `/ (root)` → Save。

一分钟后访问：`https://<你的用户名>.github.io/<仓库名>/`

## 目录结构

```
index.html    五个界面：案件列表 / 简报 / 调查台 / 指控 / 结案
style.css     全部样式（暗色卷宗风，三栏调查台，移动端单列）
cases.js      内置案件数据（雨夜书房、钟楼十二响）
game.js       流程、状态、判定、渲染、音效、本机排行榜、每日案件同步
daily/        每日一案：index.json 清单 + 每案一个 JSON
tools/        check-case.js 案件自检脚本
push.ps1      自动提交脚本（失败无限重试）
```

## 新增一桩案件

只改 `cases.js`，往 `window.CASES` 数组里追加一个对象即可，无需改 `game.js`。结构见文件顶部的注释：

- `scene`：案件开头的第一人称现场叙事（`title` + `paragraphs[]` + `notes[]` 速记要点）。
- `floorPlan`：`{ label, shapes[], spots[] }`，`spots[].evidence` 指向证物，坐标基于 280×160 的 viewBox；简报页和调查台共用同一份图，调查台上可点击。
- `timeline[]`：`{ time, text, needs[] }`，`needs` 里的 id 全部到手才会点亮，否则显示「尚未确认」。
- `suspects[].profile`：档案卡字段（`age` / `job` / `relation` / `alibi` / `note`），审讯页折叠展开。
- `suspects[].statements[]`：`from` 为 `start`（初始）/ `ask`（「再问一句」）/ `confront`（被证据逼出）。
- `suspects[].confront[]`：`evidence` 是证物 id，`requires` 是前置 id 数组（用于链式逼问），`unlock` 解锁哪条证词。
- `deductions[]`：`needs` 里的 id 全部到手时，这条推论自动进入笔记。
- `truth`：`culprit`、两项 `evidence`、`motive`，以及结案页的复盘文案。

所有 id 必须全局唯一（建议 `ev-` / `s-` / `d-` / `m-` 前缀）。改完刷新页面即可验证。

## 每日一案

首页统计条下方的横幅就是「每日一案」。选案顺序：

1. `daily/index.json` 里有今天日期、且这一案已被本机收录 → 用它；
2. 否则按日期在全部案件里轮换（`dayIndex() % cases.length`），保证任何时候都有案子可玩。

启动时 `game.js` 会 `fetch('daily/index.json')`，把最近 7 天里本机还没有的案件拉下来，存进 `localStorage`（`detective_daily_cases_v1`），成功后提示「新案件已收入档案柜」。**收录过的案件永久保留**，之后断网也能玩；`fetch` 失败（离线、`file://` 打开）时完全静默，内置案件不受影响。

```
daily/index.json       { "2026-10-24": "2026-10-24.json" }   日期 → 文件名
daily/2026-10-24.json  一个完整案件对象，schema 与 cases.js 一致
tools/check-case.js    发布前自检脚本
```

案件 `id` 必须写成 `daily-YYYY-MM-DD`，且与清单里的键一致——前端靠它判断「今天有没有新案」。

### 发布流程（人工触发，不是定时任务）

每天由作者说一句「生成今日案件」，然后：

1. 按 `cases.js` 的 schema 写 `daily/<今天>.json`（4 名嫌疑人 / 7 件证物 / 6 条推论，约 3000-4000 字）；
2. 在 `daily/index.json` 增加一行；
3. 跑自检，**必须 0 错误**：

   ```powershell
   node tools/check-case.js daily/2026-10-24.json
   ```

   检查内容：顶层字段齐全、id 不与已有案件重复、`deductions.needs` / `confront.evidence` / `confront.requires` / `confront.unlock` / `timeline.needs` / `floorPlan.spots` / `relations.a,b` / `truth.culprit` / `truth.motive` / `truth.evidence` 的引用全部闭合；另外会警告「有证物拿不到任何用途」「被逼问出的口供没有入口解锁」这类死内容。

4. 通过后提交推送：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\push.ps1 -Message "daily: 2026-10-24 末班电车"
   ```

GitHub Pages 约一分钟后生效，玩家下次刷新首页即自动收案。

校验不通过就停下，不要推送。宁可当天回退到轮换的旧案，也不要上线一桩点不动的案子。

## 排行榜（预留）

目前只有本机记录：`game.js` 里的 `Leaderboard` 把成绩写进 `localStorage`（`detective_records_v1`），只保留每桩案件的最佳评级。首页卡片会显示「最佳 S · 03:42」。

将来要接云端榜单，只需要替换 `Leaderboard.load / save` 两个方法（例如改成 Supabase 表），结算页的调用点已经是 fire-and-forget，不需要改流程。

## 已知限制

- 没有后端，成绩只存在本机，清缓存即丢。
- 调查进度自动存在本机（localStorage），刷新后首页会出现「未结案的卷宗」可继续；结案或主动放弃后清除。
- 每日一案是人工触发后生成并提交的，不是定时任务；没有新案的日子会回退到按日期轮换。
- 每日案件缓存在本机，清浏览器缓存后需要联网重新拉取（内置案件不受影响）。
- 每日案件的质量依赖发布前的人工抽检：`check-case.js` 只能保证「引用不断裂」，不能保证「只有唯一解」。偶尔需要真的玩一遍。
