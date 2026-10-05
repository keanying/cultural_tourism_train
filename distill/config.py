"""全局配置：路径、规模、随机种子。可用环境变量覆盖。"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_ZIP = os.path.join(ROOT, "ctrip_china_scenic_tickets.zip")
WORK_DIR = os.environ.get("CT_WORK_DIR", os.path.join(ROOT, "work"))
RAW_CSV = os.path.join(WORK_DIR, "ctrip_china_scenic_tickets.csv")
CACHE_DIR = os.path.join(WORK_DIR, "cache")
OUTPUT_DIR = os.environ.get("CT_OUTPUT_DIR", os.path.join(ROOT, "output"))
DATASET_DIR = os.path.join(OUTPUT_DIR, "datasets")
SFT_DIR = os.path.join(OUTPUT_DIR, "sft")

SEED = int(os.environ.get("CT_SEED", 20240801))

# 明细数据集规模（每个数据集行数）
DATASET_ROWS = int(os.environ.get("CT_DATASET_ROWS", 200_000))
# 每个模型训练集样本数（train+val+test 合计）
SFT_SAMPLES = int(os.environ.get("CT_SFT_SAMPLES", 100_000))
# 训练/验证/测试切分比例
SPLIT = (0.94, 0.03, 0.03)

# 日度运营辅助表覆盖的核心景区数（2 年 × N 个景区 ≈ 20 万行）
CORE_POI_COUNT = int(os.environ.get("CT_CORE_POIS", 274))

# 单个分片文件上限（GitHub 单文件限制 100MB，留余量）
SHARD_MAX_BYTES = 45 * 1024 * 1024
