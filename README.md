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

在一台真实机器的会话日志上（26,154 个事件、4 次摘要压缩）：

```
✗ constraint-lost: 232 of 268 session constraints did not survive the summary (13% kept)
     lost(negation): Do not approve again
     lost(negation): do not busy-poll status or keep a turn running just to wait
     lost(negation): 别急着上框架
✗ summary-hallucination: 5 specific claim(s) in the summary have no basis in the history it replaced
     item(rel-path): src/lexer.py
     item(env-var): CALL_CONV
```

**13% 幸存率**——和论文测出的 17% 高度吻合。摘要引用了一个历史中从不存在的 `src/lexer.py`，以及编译器符号 `CALL_CONV`/`STD_SYMBOLS`。

## 设计取舍

- **先读日志再写规则。** 第一版假设"压缩会删除事件"，在真实日志上被推翻：DSH 的事件日志是**只追加**的，压缩是**插入一段摘要**而不是删除事件——26k 事件里 1306 次工具调用，1306 个结果一个没少。所以"约束幸存率"审的是**摘要 vs 它替代的历史**，不是"日志里少了什么"。据此删掉了整个孤儿检测规则，重写了 token 记账。
- **注入的上下文不算丢失。** system-reminder、runtime snapshot、全局 AGENTS.md 每轮都重新注入，摘要不带它不是损失。不排除它们会让每次压缩看起来都灾难性（实测：488 条"丢失"里 219 条是这类噪音）。
- **误报是靠真实数据压下去的。** 路径正则从中文斜杠（`方案/数据/渠道`）、C 关键字（`/break/continue`）、编号列表（`/04/12/15/16/28`）、寄存器（`/U/UL/F`）、汇编助记符（`/addss/subss/mulss`）、IP 前缀（`127.0.0`）里逐一收窄，每一项都是先在真实日志上看到误报再修。
- **确定性**：没有 LLM 调用。"约束"按可识别的形式匹配（祈使否定、standing 要求、范围限定、硬标识符），保留判定允许合理的改写，但要求实体词共同出现。

## 开发

```sh
node --test test/    # 28 个单测 + 10 项集成测试
```

测试的 fixture 来自真实会话日志（26,154 事件那次压缩就是断言对象）。

## License

MIT
