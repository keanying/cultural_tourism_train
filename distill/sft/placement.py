"""训练集④：产品渠道投放模型（channel_placement）

任务：给定产品、目标客群、下月投放预算与约束，基于近 3 个月各渠道真实投放表现（来自分销渠道数据集），
输出分渠道预算分配、预期 GMV/ROAS 与人群定向建议。
方法：有效ROAS = 历史ROAS × 人群匹配系数(渠道目标客群占比 ÷ 各渠道平均占比)；
     按“边际收益递减”模型 GMV_c(s)=有效ROAS_c×K_c×(1-e^(-s/K_c))（K_c=近3月月均投放×2）
     以 5% 预算为步长贪心分配，受单渠道占比上限与边际ROAS门槛约束；结果可完全复算。
"""
import math

import numpy as np
import pandas as pd

from .. import config
from ..channels import CHANNEL_META
from ..segments import SEGMENTS
from ..sim_profiles import INTEREST_POOL
from .common import SftWriter, dumps, fmt_money, make_sample, num, pct

TASK = "channel_placement"
AD_CHANNELS = [c for c, m in CHANNEL_META.items() if m[5]]

SYSTEM = (
    "你是景区产品渠道投放策略专家。你的任务是基于【产品信息】【投放目标】【近3个月分渠道投放表现】与【约束条件】，"
    "给出下月分渠道预算分配方案，实现投放回报最大化且人群投放精准。必须按以下方法推理：\n"
    "1. 人群匹配系数=该渠道目标客群占比÷各渠道目标客群占比的平均值；有效ROAS=历史ROAS×人群匹配系数；\n"
    "2. 有效ROAS低于最低ROAS门槛的渠道直接剔除；\n"
    "3. 边际收益递减：渠道饱和参数K=近3月月均投放×2，投放s元的预期GMV=有效ROAS×K×(1-e^(-s/K))；"
    "本步增量ROAS=(GMV(s+步长)-GMV(s))÷步长；\n"
    "4. 以总预算5%为步长，每步投给本步增量ROAS最高且未超过单渠道占比上限的渠道；所有渠道本步增量ROAS均低于门槛时停止，剩余预算保留；\n"
    "5. 自检：分配合计+保留=总预算，单渠道占比不超上限，各渠道末步增量ROAS不低于门槛。\n"
    "输出格式：<thought>内给出逐步计算，<answer>内输出JSON。"
)


def gmv_fn(eff, K, s):
    return eff * K * (1 - math.exp(-s / K)) if K > 0 else 0.0


def build(channels: pd.DataFrame, n_samples: int = None):
    n_samples = n_samples or config.SFT_SAMPLES
    rng = np.random.default_rng(config.SEED + 404)
    df = channels[channels["channel"].isin(AD_CHANNELS)].copy()
    months = sorted(df["stat_month"].unique())
    keys = df[["poi_id", "product_id"]].drop_duplicates().values.tolist()
    grp = {(a, b): g for (a, b), g in df.groupby(["poi_id", "product_id"])}
    writer = SftWriter(TASK)
    agg_cache = {}
    while writer.n < n_samples:
        poi_id, pid = keys[rng.integers(len(keys))]
        g = grp[(poi_id, pid)]
        mi = int(rng.integers(3, len(months)))
        hist_m = months[mi - 3:mi]
        target_m = months[mi]
        ck = (poi_id, pid, mi)
        if ck in agg_cache:
            h, agg0 = agg_cache[ck]
        else:
            h = g[g["stat_month"].isin(hist_m)]
            agg0 = None if h.empty else h.groupby("channel").agg(exposure=("exposure", "sum"), clicks=("clicks", "sum"), orders=("orders", "sum"),
                                       gmv=("gmv", "sum"), spend=("marketing_spend", "sum"),
                                       commission=("commission_rate", "mean"),
                                       **{f"s_{s}": (f"seg_share_{s}", "mean") for s in SEGMENTS}).reset_index()
            agg_cache[ck] = (h, agg0)
        if agg0 is None:
            continue
        agg = agg0[agg0["spend"] > 0].copy()
        if len(agg) < 4:
            continue
        info = h.iloc[0]
        seg_tot = agg[[f"s_{s}" for s in SEGMENTS]].mean().sort_values(ascending=False)
        target_seg = seg_tot.index[int(rng.integers(0, 3))][2:]
        objective = rng.choice(["最大化目标客群GMV", "最大化目标客群GMV（兼顾拉新）"])
        monthly_spend = agg["spend"].sum() / 3
        budget = int(max(5000, round(monthly_spend * rng.uniform(0.6, 1.6) / 1000) * 1000))
        cap_share = float(rng.choice([0.4, 0.45, 0.5, 0.6]))
        min_roas = float(rng.choice([2.5, 3.0, 3.5, 4.0]))

        agg["ctr"] = agg["clicks"] / agg["exposure"].clip(lower=1)
        agg["cvr"] = agg["orders"] / agg["clicks"].clip(lower=1)
        agg["aov"] = agg["gmv"] / agg["orders"].clip(lower=1)
        agg["roas"] = agg["gmv"] / agg["spend"]
        agg["seg"] = agg[f"s_{target_seg}"].round(3)
        agg["spend"] = agg["spend"].round(0)
        mean_seg = agg["seg"].mean()
        agg["match"] = agg["seg"] / mean_seg
        agg["roas_r"] = agg["roas"].round(2)
        agg["match_r"] = agg["match"].round(3)
        agg["eff"] = (agg["roas_r"] * agg["match_r"]).round(3)
        agg["K"] = (agg["spend"] / 3 * 2).round(0)

        user_obj = {
            "产品信息": {"名称": info["product_name"], "景区": info["poi_name"], "城市": info["city"],
                     "类别": info["scenic_category"], "票种": info["ticket_type_name"], "售价": num(info["list_price"])},
            "投放目标": {"投放月份": target_m, "目标客群": target_seg, "优化目标": objective, "总预算": budget},
            "近3个月分渠道投放表现": [
                {"渠道": r.channel, "统计月份": f"{hist_m[0]}~{hist_m[-1]}", "曝光量": int(r.exposure), "点击率": pct(r.ctr, 2),
                 "转化率": pct(r.cvr, 2), "订单量": int(r.orders), "客单价": round(r.aov, 1), "GMV": round(r.gmv),
                 "营销费用": round(r.spend), "ROAS": r.roas_r, "佣金率": pct(r.commission, 1),
                 "目标客群占比": pct(r.seg, 1)}
                for r in agg.itertuples(index=False)],
            "约束条件": {"单渠道预算占比上限": pct(cap_share, 0), "最低ROAS门槛": min_roas, "分配步长": "总预算的5%"},
        }
        th = [f"1. 明确投放目标：{target_m}为「{info['product_name']}」投放，目标客群{target_seg}，{objective}；"
              f"总预算{budget}元，单渠道上限{pct(cap_share, 0)}（{int(budget * cap_share)}元），最低ROAS门槛{min_roas}。"]
        th.append(f"2. 计算人群匹配与有效ROAS（各渠道{target_seg}占比均值{pct(mean_seg, 2)}）：")
        for r in agg.itertuples(index=False):
            th.append(f"   - {r.channel}：匹配系数{pct(r.seg, 1)}÷{pct(mean_seg, 2)}={r.match_r}，有效ROAS={r.roas_r}×{r.match_r}={r.eff}，K={int(r.K)}。")
        keep = agg[agg["eff"] >= min_roas]
        drop = agg[agg["eff"] < min_roas]
        th.append("3. 剔除不达标渠道：" + ("；".join(f"{r.channel}有效ROAS {r.eff}<{min_roas}，剔除" for r in drop.itertuples(index=False))
                                    if len(drop) else "所有渠道有效ROAS均达到门槛，无剔除") + "。")
        # 贪心分配
        step = budget * 0.05
        alloc = {c: 0.0 for c in keep["channel"]}
        eff = dict(zip(keep["channel"], keep["eff"]))
        K = dict(zip(keep["channel"], keep["K"]))
        cap_amt = budget * cap_share
        remaining = budget
        stop_reason = "预算分配完毕"
        for _ in range(20):
            best, best_m = None, -1
            for c in alloc:
                if alloc[c] + step > cap_amt + 1e-6:
                    continue
                m = (gmv_fn(eff[c], K[c], alloc[c] + step) - gmv_fn(eff[c], K[c], alloc[c])) / step
                if m > best_m:
                    best, best_m = c, m
            if best is None:
                stop_reason = "各渠道均已达到单渠道占比上限"
                break
            if best_m < min_roas:
                stop_reason = f"各渠道下一步增量ROAS均已低于门槛{min_roas}"
                break
            alloc[best] += step
            remaining -= step
        remaining = round(remaining)
        th.append(f"4. 边际递减贪心分配（步长{fmt_money(step)}元，共{int(round((budget - remaining) / step))}步）：")
        plan = []
        tot_gmv = 0.0
        for c in sorted(alloc, key=lambda x: -alloc[x]):
            s = round(alloc[c])
            if s <= 0:
                first = gmv_fn(eff[c], K[c], step) / step
                th.append(f"   - {c}：首步增量ROAS {first:.2f}，未获得分配（{'低于门槛' if first < min_roas else '其他渠道增量回报更高'}）。")
                continue
            gm = gmv_fn(eff[c], K[c], s)
            mr = (gm - gmv_fn(eff[c], K[c], s - step)) / step
            tot_gmv += gm
            th.append(f"   - {c}：分配{s}元（{pct(s / budget, 0)}），预期GMV={eff[c]}×{int(K[c])}×(1-e^(-{s}/{int(K[c])}))={round(gm)}元，"
                      f"末步增量ROAS={mr:.2f}。")
            row = agg[agg["channel"] == c].iloc[0]
            tags = INTEREST_POOL[target_seg][:3]
            plan.append({"channel": c, "budget": s, "share": pct(s / budget, 0), "expected_gmv": round(gm),
                         "expected_roas": round(gm / s, 2), "last_step_roas": round(mr, 2),
                         "targeting": f"{target_seg}；兴趣：{'、'.join(tags)}",
                         "expected_orders": int(round(gm / row["aov"])) if row["aov"] > 0 else 0})
        used = budget - remaining
        th.append(f"5. 合规自检：分配合计{used}元+保留{remaining}元={budget}元；"
                  f"单渠道最高占比{pct(max([p['budget'] for p in plan] or [0]) / budget, 0)}≤{pct(cap_share, 0)}；"
                  f"各渠道末步增量ROAS均≥{min_roas}。整体预期GMV {round(tot_gmv)}元，"
                  f"整体ROAS {(tot_gmv / used if used else 0):.2f}。")
        if remaining > 0:
            th.append(f"   - 保留预算{remaining}元：{stop_reason}，建议留作机动或转投其他产品。")
        answer = {
            "target_segment": target_seg,
            "allocations": plan,
            "excluded_channels": [{"channel": r.channel, "reason": f"有效ROAS {r.eff}低于门槛{min_roas}"} for r in drop.itertuples(index=False)],
            "reserved_budget": remaining,
            "total_expected_gmv": round(tot_gmv),
            "overall_roas": round(tot_gmv / used, 2) if used else 0,
        }
        sid = f"{TASK}-{writer.n + 1:07d}"
        meta = {"poi_id": poi_id, "product_id": pid, "target_month": target_m, "target_segment": target_seg,
                "budget": budget, "allocation": {p["channel"]: p["budget"] for p in plan}, "source": "rule_engine"}
        writer.add(sid, make_sample(SYSTEM, user_obj, th, dumps(answer)), meta)
    return writer.close()
