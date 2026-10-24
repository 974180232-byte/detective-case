# 侦探档案 · Detective Casebook

单机侦探推理网页游戏。一次一桩案件：读完卷宗、勘察现场、审讯五名嫌疑人、用证物对质，最后提交指控。一局约 10-15 分钟。

纯静态站点：原生 HTML / CSS / JavaScript，无框架、无构建、无后端、无网络请求。

## 玩法

1. **案情简报** —— 看死者、死因、发现经过，记住每个人自称在哪里。
2. **现场勘察** —— 点击证物查看细节，第一眼看不出的东西会以「🔍 推断」提示。
3. **审讯** —— 选一名嫌疑人，读他的口供；「再问一句」能挤出第二段话。
4. **对质** —— 选中左侧某件证物，出示给嫌疑人。戳中要害他会改口，戳偏了会消耗你的失误数。
5. **推理笔记** —— 当两条线索对上，推论会自动出现，这是你真正的进度条。
6. **提交指控** —— 选凶手 + 两项关键证据 + 动机。评级 S / A / B / C / D。

评级只看三件事：人抓对没有、证据立不立得住、动机说没说对；失误、提示、超时会扣分。

## 本地运行

直接双击 `index.html` 即可（没有任何 `fetch` 或模块加载）。

想用本地服务器：

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
cases.js      案件数据（目前两桩：雨夜书房、钟楼十二响）
game.js       流程、状态、判定、渲染、音效、本机排行榜
push.ps1      自动提交脚本（失败无限重试）
```

## 新增一桩案件

只改 `cases.js`，往 `window.CASES` 数组里追加一个对象即可，无需改 `game.js`。结构见文件顶部的注释：

- `suspects[].statements[]`：`from` 为 `start`（初始）/ `ask`（「再问一句」）/ `confront`（被证据逼出）。
- `suspects[].confront[]`：`evidence` 是证物 id，`requires` 是前置 id 数组（用于链式逼问），`unlock` 解锁哪条证词。
- `deductions[]`：`needs` 里的 id 全部到手时，这条推论自动进入笔记。
- `truth`：`culprit`、两项 `evidence`、`motive`，以及结案页的复盘文案。

所有 id 必须全局唯一（建议 `ev-` / `s-` / `d-` / `m-` 前缀）。改完刷新页面即可验证。

## 排行榜（预留）

目前只有本机记录：`game.js` 里的 `Leaderboard` 把成绩写进 `localStorage`（`detective_records_v1`），只保留每桩案件的最佳评级。首页卡片会显示「最佳 S · 03:42」。

将来要接云端榜单，只需要替换 `Leaderboard.load / save` 两个方法（例如改成 Supabase 表），结算页的调用点已经是 fire-and-forget，不需要改流程。

## 已知限制

- 没有后端，成绩只存在本机，清缓存即丢。
- 调查进度不落盘：刷新页面会从头开始（一局只有 10 分钟，故意如此）。
- 案件是人工撰写的固定内容，暂未接入 AI 生成；`cases.js` 的数据结构已经可以直接作为生成结果的落地格式。
