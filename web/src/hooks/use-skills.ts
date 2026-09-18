/**
 * spec skill-index-increment SC8（Web 半边）—— slash 候选「当场热」。
 *
 * 装配时拉一次 `GET /api/v1/skills` 就够不到 SC8：服务端已按**现行**技能根
 * 作答（hub 侧 rescan），但客户端只在挂载时拉一次 —— 之后装的技能永远不进
 * `/` 候选，要刷新整页才看得见。
 *
 * ## 为什么选「窗口重新获得焦点」而不是轮询 / 每次发送前拉
 *
 * - **轮询**：`/skills` 是纯读盘 + 全根扫描，为一个「装了技能」这种低频事件
 *   常年打服务端，代价与收益不成比例；`useSubagentsPolling` / `useAsksPolling`
 *   那两条轮询服务的是**会话内高频变化**的状态，技能面不是。
 * - **每次发送前拉**：会把一次网络往返塞进发送关键路径；用户在别处
 *   （终端 / 编辑器）装完技能回到页面，正是「focus」这个信号，且它发生在
 *   任何发送**之前** —— 打开窗口时就已刷新，比发送前拉早且不挡发送。
 * - **focus** 也覆盖「reload 后切回来」：切走期间装的技能回来即见。
 *
 * 失败**不清空**已知候选（命中失败 → 保留最近一次成功结果）：一次网络抖动
 * 不该让 `/` 面变空；首次拉取失败仍是空清单（与改造前 `setSkills([])` 等价）。
 */
import { useEffect, useState } from "react";
import * as api from "../api/client";
import type { SkillSummary } from "../api/types";

export function useSkills(): readonly SkillSummary[] {
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);

  useEffect(() => {
    // 卸载 / 重挂后到达的响应丢弃：stale 响应不得写进新一次的 state
    // （与 useSubagentsPolling 的 alive-ref 同款纪律）。
    let alive = true;
    const refresh = (): void => {
      void api
        .listSkills()
        .then((res) => {
          if (alive) setSkills(res.skills);
        })
        .catch(() => {
          // EXIT: 重取失败 → 保留已知候选（首次失败时就是空清单）。可见性
          // 由既有 composer 行为承担：候选照旧，不弹错误横幅。
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
    };
  }, []);

  return skills;
}
