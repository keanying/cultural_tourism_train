"""中国节假日日历、季节标签、天气模拟。

节假日安排依据国务院办公厅公布的 2024、2025 年放假安排（含调休上班日）。
天气为按气候带与月份的确定性模拟（同一城市同一天结果固定），用于构造外部特征。
"""
import datetime as dt
import hashlib
import math

from .geo import CITY, CLIMATE

START_DATE = dt.date(2024, 1, 1)
END_DATE = dt.date(2025, 12, 31)


def _rng_days(a, b):
    a, b = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
    return [a + dt.timedelta(days=i) for i in range((b - a).days + 1)]


HOLIDAYS = {}  # date -> 节日名
for name, a, b in [
    ("元旦", "2024-01-01", "2024-01-01"),
    ("春节", "2024-02-10", "2024-02-17"),
    ("清明节", "2024-04-04", "2024-04-06"),
    ("劳动节", "2024-05-01", "2024-05-05"),
    ("端午节", "2024-06-08", "2024-06-10"),
    ("中秋节", "2024-09-15", "2024-09-17"),
    ("国庆节", "2024-10-01", "2024-10-07"),
    ("元旦", "2025-01-01", "2025-01-01"),
    ("春节", "2025-01-28", "2025-02-04"),
    ("清明节", "2025-04-04", "2025-04-06"),
    ("劳动节", "2025-05-01", "2025-05-05"),
    ("端午节", "2025-05-31", "2025-06-02"),
    ("国庆中秋", "2025-10-01", "2025-10-08"),
]:
    for d in _rng_days(a, b):
        HOLIDAYS[d] = name

MAKEUP_WORKDAYS = {dt.date.fromisoformat(s) for s in [
    "2024-02-04", "2024-02-18", "2024-04-07", "2024-04-28", "2024-05-11",
    "2024-09-14", "2024-09-29", "2024-10-12",
    "2025-01-26", "2025-02-08", "2025-04-27", "2025-09-28", "2025-10-11",
]}

SCHOOL_VACATIONS = [
    ("寒假", dt.date(2024, 1, 20), dt.date(2024, 2, 25)),
    ("暑假", dt.date(2024, 7, 1), dt.date(2024, 8, 31)),
    ("寒假", dt.date(2025, 1, 15), dt.date(2025, 2, 16)),
    ("暑假", dt.date(2025, 7, 1), dt.date(2025, 8, 31)),
]

GOLDEN_WEEKS = {"春节", "国庆节", "国庆中秋"}
WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def all_dates():
    return [START_DATE + dt.timedelta(days=i) for i in range((END_DATE - START_DATE).days + 1)]


def day_type(d: dt.date) -> str:
    """法定节假日 / 周末 / 调休工作日 / 工作日"""
    if d in HOLIDAYS:
        return "法定节假日"
    if d in MAKEUP_WORKDAYS:
        return "调休工作日"
    if d.weekday() >= 5:
        return "周末"
    return "工作日"


def is_holiday(d: dt.date) -> bool:
    """是否为休息日（法定节假日或非调休周末）。"""
    return day_type(d) in ("法定节假日", "周末")


def holiday_name(d: dt.date):
    return HOLIDAYS.get(d)


def school_vacation(d: dt.date):
    for name, a, b in SCHOOL_VACATIONS:
        if a <= d <= b:
            return name
    return None


def season(d: dt.date) -> str:
    return {12: "冬季", 1: "冬季", 2: "冬季", 3: "春季", 4: "春季", 5: "春季",
            6: "夏季", 7: "夏季", 8: "夏季"}.get(d.month, "秋季")


def season_label(d: dt.date) -> str:
    """业务口径的季节标签，如“暑期旺季”“国庆黄金周”“冬季淡季”。"""
    h = HOLIDAYS.get(d)
    if h in ("春节",):
        return "春节黄金周"
    if h in ("国庆节", "国庆中秋"):
        return "国庆黄金周"
    if h == "劳动节":
        return "五一小长假"
    if h:
        return f"{h}小长假"
    sv = school_vacation(d)
    if sv == "暑假":
        return "暑期旺季"
    if sv == "寒假":
        return "寒假平季"
    if d.month in (4, 5, 9, 10):
        return "春秋旺季" if d.month in (4, 5) else "秋季旺季"
    if d.month in (3, 6, 11):
        return "平季"
    return "冬季淡季"


# ---------------- 天气模拟 ----------------
# 各气候带：年均气温中值、年温差半幅、各月降水概率（1-12 月）
_CLIMATE_PARAM = {
    "cold":         (5, 19, [.10, .10, .15, .25, .30, .45, .55, .50, .35, .25, .15, .12]),
    "temperate":    (13, 15, [.08, .10, .15, .22, .28, .38, .50, .45, .30, .20, .12, .08]),
    "subtropical":  (17.5, 11, [.35, .40, .45, .48, .50, .55, .45, .42, .35, .28, .28, .28]),
    "tropical":     (23.5, 6, [.20, .18, .20, .28, .42, .50, .52, .55, .48, .35, .25, .20]),
    "plateau_mild": (15.5, 6, [.06, .08, .10, .15, .30, .55, .60, .58, .45, .30, .12, .06]),
    "plateau":      (5, 10, [.05, .05, .08, .12, .22, .45, .55, .52, .38, .15, .06, .05]),
    "arid":         (9, 16, [.05, .05, .07, .10, .12, .15, .18, .16, .10, .07, .05, .05]),
}


def _u(*keys) -> float:
    """由 key 决定的 [0,1) 伪随机数，保证同城同日天气稳定。"""
    h = hashlib.md5("|".join(map(str, keys)).encode()).digest()
    return int.from_bytes(h[:8], "big") / 2 ** 64


def weather(city: str, d: dt.date) -> dict:
    info = CITY.get(city) or CITY["北京"]
    clim = CLIMATE.get(info["province"], "temperate")
    mean, amp, rain_p = _CLIMATE_PARAM[clim]
    # 7 月中旬最热
    doy = d.timetuple().tm_yday
    base = mean + amp * math.sin(2 * math.pi * (doy - 105) / 365)
    t_noise = (_u(city, d, "t") - 0.5) * 6
    high = round(base + 4 + t_noise)
    low = round(base - 4 + t_noise - _u(city, d, "r") * 2)
    u = _u(city, d, "w")
    p = rain_p[d.month - 1]
    if u < p:
        r = u / p
        if low <= 0 and high <= 3:
            cond = "小雪" if r < 0.7 else "中雪"
        elif d.month in (6, 7, 8) and r < 0.35:
            cond = "雷阵雨"
        elif r < 0.62:
            cond = "小雨"
        elif r < 0.88:
            cond = "中雨"
        else:
            cond = "大雨"
    else:
        r = (u - p) / (1 - p)
        if r < 0.5:
            cond = "晴"
        elif r < 0.8:
            cond = "多云"
        elif r < 0.95 or clim not in ("temperate", "cold"):
            cond = "阴"
        else:
            cond = "雾霾"
        if cond == "晴" and high >= 35:
            cond = "晴热高温"
    return {"weather": cond, "temp_high": high, "temp_low": low}


# 天气对景区客流的乘数（室外景区；室内场馆影响减半）
WEATHER_FACTOR = {
    "晴": 1.00, "多云": 1.02, "阴": 0.94, "雾霾": 0.88, "晴热高温": 0.86,
    "小雨": 0.82, "雷阵雨": 0.78, "中雨": 0.66, "大雨": 0.48, "小雪": 0.80, "中雪": 0.62,
}


def weather_factor(cond: str, indoor: bool = False) -> float:
    f = WEATHER_FACTOR.get(cond, 1.0)
    return 1 - (1 - f) / 2 if indoor else f
