#!/usr/bin/env bash
# 一键复现：清洗 -> 5 个明细数据集 -> 5 个训练集 -> 质量校验
# 可选环境变量：CT_DATASET_ROWS(默认200000) CT_SFT_SAMPLES(默认100000) CT_SEED
set -euo pipefail
cd "$(dirname "$0")"
python -m distill.catalog
python -m distill.build_datasets
python -m distill.build_sft
python -m distill.validate
# 可选：大模型润色（需配置 LLM_PROVIDER / LLM_API_KEY / LLM_MODEL）
# python -m distill.llm_refine --task combo_recommend --ratio 0.2
# python -m distill.llm_refine --task dynamic_pricing --ratio 0.1
# python -m distill.llm_refine --task business_insight --ratio 0.1
