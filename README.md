# dsh-compaction-audit — 压缩质量审计（DSH 插件）

> 上下文压缩是唯一一个**静默删除信息**的操作：模型继续自信地回答，而被赋予的约束已经没了。
> 论文 *Lost in Compaction*（arXiv 2608.11242）实测：现有压缩器平均只保留 **17%** 的会话约束，
> 多数压缩后表现还不如不压缩。这个生态里每个压缩插件**都把质量清单当成自己设计文档里的待办**，
> 没有一个把检查器做出来。

这个插件就是那个检查器。它读原始会话事件日志，审计**任何一个压缩器**产出的摘要——它自己的或别人的。纯确定性，不调 LLM：答错就是规则有 bug，有名字可查。

## 安装

```sh
dsh plugin --profile desktop add @bushizhanghan/dsh-compaction-audit
```

重启 DSH 后生效。**只读**：从不写你的会话日志。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `compaction_audit` | 审计单个会话：约束幸存、摘要幻觉、幽灵引用、token 记账、无据裁剪 |
| `compaction_audit_sweep` | 扫描所有会话，按严重度排序，看哪段对话被压缩伤得最重 |
| `compaction_audit_diff` | 单个压缩的细部对照：摘要替代了什么、丢了哪些约束、留下哪些 |
| `compaction_audit_log_check` | 日志结构完整性：每次工具调用都有结果、序号无跳断 |

## 检查清单

| 规则 | 级别 | 抓什么 |
|---|---|---|
| `log-invariant-broken` | ✗ error | 工具调用没有配对结果——日志被截断，**其他所有结论都因此失效** |
| `summary-hallucination` | ✗ error | 摘要发明了历史里从未出现的路径/版本/端口/标识符（模型会信它） |
| `constraint-lost` | ✗ error / ! warn | 用户给的 standing 指令（不要X / 必须Y / 只准Z）摘要没带上；幸存率 <50% 报 error |
| `prune-unaccounted` | ! warn | 裁掉的 token 远超所替代的消息——通常是工具输出无声消失 |
| `token-accounting` | ! warn | 摘要几乎和它声称释放的一样大（压缩-回填-再压缩的 thrashing） |
| `ghost-reference` | ! warn | 摘要说"如上所述"，而所指内容已不在上下文中 |
| `no-summary` / `no-history` | · info | 该次压缩没有摘要可审，不是问题 |
| `prune-only-session` | · info | 只有微裁剪、没有摘要压缩 |

## 它在真实数据上发现了什么

在一台真实机器的会话日志上（26,370 个事件、4 次摘要压缩）：

```
✗ constraint-lost: 41 of 60 session constraints did not survive the summary (31% kept)
     lost(negation): Do not approve again
     lost(negation): do not busy-poll status or keep a turn running just to wait
     lost(negation): 别急着上框架
✗ summary-hallucination: 7 specific claim(s) in the summary have no basis in the history it replaced
     item(rel-path): tools/edge_test.py
     item(env-var): PROGRESS
```

**最后一次压缩只保住 31% 的约束**，前三次在 13%–15%——和论文测出的 17% 吻合。摘要里还有历史中从不存在的 `tools/edge_test.py`、`PROGRESS` 这类具体标识符。

同一个会话里 **291 次 `compaction/start`，287 次 `compaction/end` 带 provider 错误，只有 4 次真的产出摘要**——报"291 次压缩"会让人以为压缩跑了 291 次，所以现在拆成 `started / summarised / failed` 三个数。

## 设计取舍

- **先读日志再写规则。** 第一版假设"压缩会删除事件"，在真实日志上被推翻：DSH 的事件日志是**只追加**的，压缩是**插入一段摘要**而不是删除事件——26k 事件里 1306 次工具调用，1306 个结果一个没少。所以"约束幸存率"审的是**摘要 vs 它替代的历史**，不是"日志里少了什么"。据此删掉了整个孤儿检测规则，重写了 token 记账。
- **"它替代的历史"要看 `shadowedSeqs`，不能取"startSeq 之前的一切"。** 第二次以后的压缩，前面那段文本早被上一次摘要折叠掉了，拿全部前序文本去审等于拿它没见过的历史判它——实测第 4 次压缩会报 561 条约束，而它真正替代的只有 141 条。
- **工具输出也算"模型看过的东西"。** 文件名、符号、常量大多是通过工具结果进场的，只拿消息文本当来源会把模型引用它读到的东西判成"编造"。
- **前一次摘要的正文也算来源。** 摘要是在"已经含前序摘要的界面"上写的，不把前序摘要算进来，所有继承来的标识符都会被误判成编造。
- **注入的上下文不算丢失。** system-reminder、runtime snapshot、全局 AGENTS.md 每轮都重新注入，摘要不带它不是损失。不排除它们会让每次压缩看起来都灾难性（实测：488 条"丢失"里 219 条是这类噪音）。
- **误报是靠真实数据压下去的。** 路径正则从中文斜杠（`方案/数据/渠道`）、C 关键字（`/break/continue`）、编号列表（`/04/12/15/16/28`）、寄存器（`/U/UL/F`）、汇编助记符（`/addss/subss/mulss`）、IP 前缀（`127.0.0`）里逐一收窄，每一项都是先在真实日志上看到误报再修。
- **确定性**：没有 LLM 调用。"约束"按可识别的形式匹配（祈使否定、standing 要求、范围限定、硬标识符），保留判定允许合理的改写，但要求实体词共同出现。

## 开发

```sh
node --test          # 29 个单测 + 1 个集成脚本（内含 11 项断言，失败时退出码非 0）
```

测试的 fixture 来自真实会话日志（26,154 事件那次压缩就是断言对象）。

## License

MIT
