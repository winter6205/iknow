# 0098. 技能模型索引开场冻结；新建只追加 messages；进场史跟 session

Date: 2026-09-17
Status: accepted

开场 `<available_skills>` 仍是 system 会话快照（前缀资格线 / ADR-0043 执法）。会话内新出现的 **技能模型索引** 名不得改写该段；在调用模型前把 **只含新建** 的同形清单以 user 消息接到 messages 最末，并把 name 记入跟 session 落盘的 **索引进场史**。compact 不根据「增量消息是否还在」再贴 listing。已进场条目的文案变更靠新会话重冻，不靠再追加。

**Why not 改 system 冻表：** 违反相邻轮 tools+system deep-equal。  
**Why not 每轮整表刷新进 messages：** 与冻表重复、浪费 token、两份清单打架。  
**Why not 只从当前 transcript 回放入场史：** compact 吃掉增量后会再贴，等于重挂 listing。  
**Why not 子代理再做一套 diff：** spawn 时把父会话当时完整模型索引写入 worker 自己的冻表即可。

Amends ADR-0043（技能名在会话内变 → messages 尾，与手动 MCP 重连通知同档，不改 system）。Amends ADR-0046（10% 降档仍只作用于开场冻表；messages 里新建行带完整 description）。人侧 slash 与 `skill()` 资格见 `specs/skill-index-increment.md`，不在本 ADR 展开宿主投影。
