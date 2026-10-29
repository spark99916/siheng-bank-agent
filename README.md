> 本项目已选定 **pi 三段式**，另一条路线已删除。启动：`cd track-pi && npm start`，端口 18150。

# 银行智能体启动包

## 怎么跑起来

这个项目是 **Node.js + TypeScript**，不是 Java —— 不需要 JDK、Maven、Gradle，也没有编译步骤。
唯一前置条件是 Node.js ≥ 22（内置类型擦除，`.ts` 直接执行），仓库零运行时依赖，**不需要 `npm install`**。

```bash
node --version                      # 需要 v22 或更高
cd track-pi && npm start            # 启动，默认 http://127.0.0.1:18150/
```

浏览器打开 <http://127.0.0.1:18150/> 就是完整界面（前端构建产物由同一个服务托管）。
试试：`查一下余额` / `转给小王 100 元` / `取消云幕视频会员` / `把理财全部赎回`。

不想开浏览器就直接打接口（JSON-RPC，`POST /rpc`）：

```bash
curl -X POST http://127.0.0.1:18150/rpc -H "content-type: application/json" \
  -d '{"method":"chat","params":["demo","查一下余额"]}'
```

方法：`chat` / `confirm` / `plan` / `cancel` / `state` / `reset` / `audit` / `tamper`。

### 换端口、接真实模型

```bash
PORT=18200 npm start                # 换端口
LLM_API_KEY=sk-... npm start        # 接 DeepSeek；默认 base https://api.deepseek.com、模型 deepseek-flash
```

不配 `LLM_API_KEY` 时走离线确定性通道，全部功能照常可用 —— 判定与执行不依赖模型，模型只负责措辞与多步规划。

### 常用校验

```bash
node scripts/check.mjs                                      # 结构自检 + 密钥扫描，期望 61/61
node --test scripts/rules.test.mjs scripts/loop.test.mjs    # 单元测试，期望 105 通过
node scripts/verify-cases.mjs                               # 端到端验收，期望 96/96（自起自停、含真重启）
node scripts/params-table.mjs --check                       # 参数对照表回源码校验，期望 23/23
node scripts/params-table.mjs --write                       # 重新生成 docs/08 金融参数对照表
node scripts/demo.mjs                                       # 一键演示跑稿，录屏照着念
node scripts/smoke.mjs                                      # 冒烟
node channels/run-webhook.mjs                               # webhook 渠道，http://127.0.0.1:18140/
```

### 跑不起来时

- `EADDRINUSE :18150` —— 上一个实例没退。`netstat -ano | findstr :18150` 查到 PID 后 `taskkill /PID <pid> /F`；或直接 `PORT=18200 npm start`。
- `Unknown file extension ".ts"` —— Node 低于 22，升级 Node。
- `npm start` 报找不到 package.json —— 没进 `track-pi/`。`cd track-pi` 后再跑，或在根目录 `node track-pi/src/index.ts`。
- 界面空白 —— `web/dist` 缺失。`npm --prefix web install && npm --prefix web run build`。

## 这个仓库现在能演示什么

启动包只给了骨架，下面这些是补上去的，全部有实测证据（`node scripts/verify-cases.mjs` 96 条用例）。

- **六个场景全覆盖，赛题子项补到最后两个**：转账（人名/手机号/备注/预约/**拆分 AA 收款**）、账单分析（本月/上月/近三月/今年）、理财操作（货架对比、风险适当性、申购、赎回）、卡片管理（锁定、挂失、额度调整、办卡）、订阅代扣（识别、7 天提醒、取消）、跨场景联动（多步计划/**生日前 2 天自动下单鲜花蛋糕**）。
- **AA 收款按总额判限额，不按人均**：480 元 4 人每人 120 元；500 元 3 人除不尽时零头由发起人承担，收款单三个数相加恒等于总额。按人均判的话拆成 20 个人就能绕过所有限额。
- **生日礼遇是「预锁 → 到期下单」两步**：一句话拆成锁 1000 元 + 登记生日前 2 天 09:00 下单；下单资格来自预锁额度（无锁不下单、超预算不下单），到点扣 458 元、释放 542 元，预锁过期则如实取消。调度器每 60 秒一拍，`tick` 可传时间做确定性验收。
- **会算账，不只是会办事**：说「分期月费率 0.6%、分 12 期、本金 12000 元」，系统给出每期还款 1072.00 元、手续费 864.00 元，以及**真实年化 13.03%**（复利口径 13.84%）—— 名义年费率 7.2% 是它自己算的乘 12，同一个回复里必须同时给出，且要点明「月费率不能直接乘 12 当年化」。真实年化用 IRR 反解（二分法），不用速算近似；参数越界（期数不在 1—60、月费率不在 0—5%）直接拦红，不硬凑一个数。
- **判定不能只看交易形状**：同样 3 笔、每笔 54 元、收款人各异的两批转账，形状读数（笔数、每笔、合计、笔间极差、与限额的关系）一字不差；差别全在证据 —— `aml_check` 逐项核对 AA 收款单、收款人是否在册、有没有能覆盖本批金额的消费，且**一笔消费只能解释一次分摊**。三项证据齐全也只判黄（补凭证后人工放行），证据不足判红、线上不执行。「读懂意图就放行」不是可解释 AI，那是 AI 自我批准。
- **四十三条判定规则**：`tool-whitelist`、`base-level`、`actor-tier`、`tier-insufficient`、`grounding`、`irreversible`、`payee-from-remark`、`payee-from-card-number`、`external-risk`、`external-degraded`、`single-limit`、`daily-limit`、`midnight-burst`、`new-payee`、`reversibility`、`frequency`、`suitability`、`min-amount`、`split-headcount`、`split-share`、`split-limit`、`split-daily`、`split-outsider`、`gift-no-date`、`gift-lead`、`gift-items`、`gift-no-lock`、`gift-over-budget`、`gift-lock-pending`、`gift-budget`、`installment-quote`、`installment-nominal`、`installment-misleading`、`installment-invalid`、`aml-shape`、`aml-structuring`、`aml-hugging`、`aml-not-split`、`aml-record`、`aml-relationship`、`aml-purpose`、`aml-explained`、`aml-evidence-gap`。每条都有独立 rule 名与含具体数字的 detail，界面最多显示两行。
- **权限分级是二维的**：主体档位（普通/金卡/私行）× 操作风险。同一句「转给小王 800 元」，普通客户判红、金卡客户判黄，判定里写明按哪个档位判的。
- **任务规划与回滚**：一句话里有两件事会被拆成多步（`先查一下余额，然后把云端音乐取消`），每步单独判定与留痕；任一步判红或执行失败则整链停下，并把能撤的按逆序撤回去 —— 撤不掉的（转账、取消订阅）如实说明，不返回假成功。
- **幻觉防护**：模型给出的金额与收款人必须能在原文或通讯录里找到依据，找不到就判红（`grounding`），不给"模型编一个收款人"留口子。
- **确认时重算**：发令牌到用户点确认之间状态若已变化，按确认时的状态重判，升级成红就停手。
- **外部服务两路**：汇率换算与反欺诈筛查都走 stdio JSON-RPC，3 秒超时。反欺诈结论进判定（高→红 / 中→黄 / 低→记一条），服务挂了降级为需确认并写明哪条链路不通；服务挂掉时内置工具照常可用。
- **渠道**：Web 前端与通用 webhook，支持 HMAC 验签与 messageId 幂等，渠道层只转发不做判定。
- **审计可校验、可演示**：哈希链逐条串联，记操作主体；`DEMO_TAMPER=on` 时可现场改一条，链立刻断在那一位置。
- **落盘与重启**：审计追加写 JSONL（逐行 fsync），状态与会话原子写；杀掉进程重起后审计、余额、待确认令牌、日累计都还在。`PERSIST=off` 可退回纯内存。
- **账务日口径**：日累计按业务时区与账务日切分点统计（`BIZ_TZ_OFFSET_MIN` / `ACCOUNT_DAY_CUTOFF`），并补了跨账务日连笔规则（`midnight-burst`）。
- **账单真实口径**：商户名归一（分支括号、`-旗舰店` 后缀、中英混排）、MCC 码分类、退款冲正；异常按同类其他交易的中位数判，回复里写出基准与倍数。

运行方式、接口、校验命令与常见报错见上面的「怎么跑起来」。三分钟演示跑稿见 `scripts/demo.mjs` 与 `演示脚本.md`，交付自述见 `自述.md`。

一句话：两条可魔改的 Agent 框架路线，加一套完整的工程配套，帮你在三天内交出一个能演示、能评审、能答辩的银行智能体项目。

## 第一步：选路线

包里有两条路线，正式开工前先选一条，选完另一条删掉。

把 `prompts/01-选择路线.md` 整段复制给 AI 助手，它会问你两个问题，然后替你删。

不想用提示词就手动执行。

```powershell
node scripts/pick-track.mjs pi
```

两条路线的差别，一句话：pi 改一处立刻见效，Cordis 分层更清楚但要多花半天。三天时间建议 pi。

详细的对比与决策树见 `docs/01-两条路线怎么选.md`。

## 这个包解决什么问题

大部分同学卡在三个地方。

一是不知从哪下手。赛题给了六个场景、三条门槛，但没有给起点。

二是框架选不明白。有人推荐插件化的重型框架，有人推荐单文件循环，两种说法都对，但混在一起就无从下手。

三是工程配套缺失。只写了一个对话接口，没有子代理分工、没有评审清单、没有版本管理、没有渠道接入，答辩时无法证明「这是完整软件工程」。

这个包把三件事一次解决：两条路线的可运行骨架、一套子代理与评审流程、一批开箱即用的技能与外部服务。

## 先看这里

按顺序读三份，大约二十分钟。

| 顺序 | 文件 | 解决什么 |
|---|---|---|
| 1 | `docs/00-从这里开始.md` | 三步走完，拿到能跑的骨架 |
| 2 | `docs/06-零基础装环境.md` | 电脑上没装 Node 也能从头装好 |
| 3 | `docs/02-三天怎么排.md` | 把三天切成可交付的段 |

`AGENTS.md` 是给 AI 助手的规范，按层读，不要一次读完。

## 两条路线

两条路线共用前端、技能、外部服务与渠道适配，差异在运行时编排层。

| 维度 | Cordis 路线 | pi 路线 |
|---|---|---|
| 目录 | `track-cordis/` | `track-pi/` |
| 核心思想 | 插件即服务，依赖注入，生命周期可控 | Agent 包状态，Transport 管模型，Extension 管能力 |
| 适合 | 多人分工、要长期演进、要演示架构分层 | 单人快速迭代、想改一处立刻见效 |
| 学习曲线 | 需要理解 Context 与 Service | 需要理解三段式的职责边界 |
| 答辩说法 | 展示服务注册表与插件热插拔 | 展示钩子链与状态机 |
| 端口 | 18160 | 18150 |

两条路线都能通过赛题的三条门槛，选哪条只取决于团队规模与时间。

## 目录导览

```
bank-agent-starter/
├─ AGENTS.md                  给 AI 助手的分层规范（L0 到 L5）
├─ VERSION.md                 版本号规则与演进约定
├─ CHANGELOG.md               变更记录
├─ docs/                      七篇说明，从装环境到交付
├─ prompts/                   三段可直接复制的提示词
├─ agents/                    六个子代理定义
├─ review/                    四份评审清单
├─ skills/                    五个可加载技能
├─ mcp/                       三个外部服务与清单
├─ channels/                  企业微信与通用 webhook 适配
├─ track-cordis/              路线 A 运行时
├─ track-pi/                  路线 B 运行时
├─ web/                       两条路线共用的前端
└─ scripts/                   自检、冒烟、版本升级、选路线
```

## 三天最短路径

第一天：选路线、装环境、跑通自检，然后把意图解析补到六类，三色判定补到四维度。

第二天：三个场景端到端，接一个外部服务与一个渠道。

第三天：安全清单全过，录三分钟视频，写自述，提交。

细节见 `docs/02-三天怎么排.md`，每天要用的提示词见 `prompts/02-三天冲刺.md`。

## 自检

```powershell
node scripts/check.mjs          # 结构完整性、密钥扫描、JSON 合法性
node scripts/smoke.mjs          # 两条路线各跑四条对话
node scripts/pick-track.mjs pi  # 选路线并删除另一条
```

自检不过不要提交。

## 环境要求

Node.js 22 或更高。没装的话按 `docs/06-零基础装环境.md` 走，里面写了国内镜像配置。

国内网络下先换源，一条命令。

```powershell
npm config set registry https://registry.npmmirror.com
```

## 边界声明

这个包不含任何真实的银行接口，所有账户、账单、产品都是合成数据。

外部服务里的汇率、征信、费率是演示值，不能用于真实业务。

包里的安全设计参考了生产实践，但不构成合规认证。
