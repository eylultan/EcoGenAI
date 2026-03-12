# This file contains core backend logic
from __future__ import annotations

import math
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import tiktoken

# Regions and complexity factors
Region = Literal[
    "europe",
    "north-america",
    "asia",
    "middle-east",
    "africa",
    "latin-america-and-caribbean",
    "unknown",
]
Complexity = Literal["simple", "summarisation", "reasoning"]
LocationMode = Literal["provider", "user-region"]

# Received JSON body from the frontend
class EstimateRequest(BaseModel):
    site: str = Field(default="unknown")
    model: str = Field(default="unknown")
    region: Region = Field(default="unknown")
    complexity: Complexity = Field(default="simple")
    prompt: str = Field(default="")
    response: str = Field(default="")
    tokens_in: int = Field(default=0, ge=0)
    tokens_out: int = Field(default=0, ge=0)
    location_mode: LocationMode = Field(default="provider")


class EstimateResponse(BaseModel):
    carbon_g: float
    energy_wh: float
    water_ml: float
    carbon_low: float
    carbon_high: float
    energy_low: float
    energy_high: float
    water_low: float
    water_high: float
    meta: dict


app = FastAPI(title="EcoGenAI backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Per-query energy lookup table: Three prompt-size buckets
# Jegham, N., Abdelatti, M., Koh, C.Y., Elmoubarki, L. and Hendawi, A., 2025. How Hungry is AI? Benchmarking Energy, Water, and Carbon Footprint of LLM Inference. arXiv preprint arXiv:2505.09598.
#
# Two data tiers:
#   [T4]:    Table 4 mean values from the published paper. These are the
#            mean values with reported standard deviations and
#            were preferred wherever available.
#   [DB]:   Jegham et al. Power BI dashboard median readings, manually
#           transcribed. Used only for GPT-5 family models that postdate
#           the paper's Table 4.
#
# Prompt size definitions (Section 4.2, Jegham et al., 2025):
#   SHORT:   100 input  +  300 output =    400 tokens total
#   MEDIUM:  1,000 input + 1,000 output =  2,000 tokens total
#   LONG:    10,000 input + 1,500 output = 11,500 tokens total
#
# Structure: { model_key: (short_wh, medium_wh, long_wh) }
#
# Non-monotonic models: some models consume less energy at longer prompts
# than medium ones. This is an empirical observation
# from the paper, not a data error. The interpolate_energy_wh() function
# applies a safety clamp to prevent negative extrapolation beyond LONG.
#
# GPT-5 routing tiers: GPT-5 uses adaptive model routing — the same
# "GPT-5" API call may be served by different underlying model sizes.
# The dashboard (Jegham et al., 2025) exposes these as separate routing tiers: high, medium,
# low, minimum, and nano/mini sub-variants.
# ---------------------------------------------------------------------------
MODEL_ENERGY_WH = {
    # GPT-4o 
    # model key            short    medium   long     source
    "gpt-4o":             (0.423,   1.215,   2.875),  # [T4] GPT-4o Mar'25
    "gpt-4o-mini":        (0.577,   1.897,   3.098),  # [T4] Nov'25
    "gpt-4.5":            (6.723,   20.500,  30.495), # [T4] May'25
    
    # GPT-4.1
    "gpt-4.1":            (0.871,   3.161,   4.833),  # [T4] Nov'25
    "gpt-4.1-mini":       (0.450,   1.545,   2.122),  # [T4] Nov'25
    "gpt-4.1-nano":       (0.207,   0.575,   0.827),  # [T4] Nov'25

    # Legacy GPT-4
    "gpt-4-turbo":        (1.699,   5.940,   9.877),  # [T4] Nov'25
    "gpt-4":              (1.797 ,  6.925,   6.925),  # [T4] long N/A, medium used as floor Nov'25

    # o-series reasoning models
    "o3":                 (1.177,  5.153,  12.222),  # [T4] Nov'25
    "o3-mini":            (0.674,  2.423,   3.525),  # [T4] Nov'25
    "o3-mini-high":       (3.012,  6.865,   5.389),  # [T4] Nov'25
    "o3-pro":             (30.51,  42.50,  42.10),   # [DB] March'26
    "o4-mini-high":       (3.649,  7.380,   7.237),  # [T4] Nov'25
    "o1":                 (2.268,  4.047,   6.181),  # [T4] Nov'25
    "o1-mini":            (0.535 , 1.547,   2.317),  # [T4] Nov'25

    # GPT-5: adaptive routing tiers [DB] 
    # All GPT-5 values are from the Jegham et al. Power BI dashboard (manually
    # transcribed March 2026); no Table 4 equivalents exist as these models
    # postdate the paper's data collection.
    # Energy values reflect the reasoning mode
    # "gpt-5" → GPT-5 (low), the default/cheapest routing tier.
    "gpt-5":              (4.86,    7.43,    9.69),   # [DB] GPT-5 low reasoning mode (default) March'26
    "gpt-5-low":          (4.86,    7.43,    9.69),   # [DB] explicit low reasoning mode March'26
    "gpt-5-minimum":      (1.63,    4.69,    6.62),   # [DB] GPT-5 minimal reasoning mode March'26
    "gpt-5-medium":       (16.30,  15.55,   20.66),   # [DB] March'26 medium reasoning mode
    "gpt-5-high":         (24.16,  28.75,   28.90),   # [DB] March'26 high reasoning mode

    # GPT-5 mini routing tiers
    "gpt-5-mini":         (3.03,    4.13,    4.93),   # [DB] same as medium - default
    "gpt-5-mini-minimum": (0.56,    1.64,    2.38),   # [DB] March'26 minimal reasoning mode
    "gpt-5-mini-medium":  (3.03,    4.13,    4.93),   # [DB] March'26 medium reasoning mode
    "gpt-5-mini-high":    (12.76,  14.12,   14.42),   # [DB] March'26 high reasoning mode

    # GPT-5 nano routing tiers
    "gpt-5-nano":         (3.58,    3.03,    4.12),   # [DB] same as medium - default
    "gpt-5-nano-minimum": (0.20,    0.51,    0.73),   # [DB] March'26 minimal reasoning mode
    "gpt-5-nano-medium":  (3.58,    3.03,    4.12),   # [DB] March'26 medium reasoning mode
    "gpt-5-nano-high":    (6.63,    6.00,    7.15),   # [DB] March'26 high reasoning mode

    # ChatGPT / auto-routing 
    # As of February 2026, ChatGPT's lineup is GPT-5.3 Instant (default)
    # and GPT-5.4 Thinking/Pro. No direct measurements exist so I used proxy mapping:
    #   GPT-5.3 Instant  → GPT-5 (low)    (4.86,    7.43,    9.69) [DB] March'26
    #   GPT-5.4 Thinking → GPT-5 (high)  (24.16,  28.75,   28.90) [DB] March'26
    #
    # chatgpt-auto: Auto mode weighted average (75% Instant, 25% Thinking)
    #   short  = 0.75×4.86 + 0.25×24.16 =  9.685 Wh
    #   medium = 0.75×7.43 + 0.25×28.75 = 12.76 Wh
    #   long   = 0.75×9.69 + 0.25×28.90 = 14.493 Wh
    #   NOTE: 75/25 routing split is a modelling assumption; OpenAI does not
    #   disclose routing percentages.
    "chatgpt-auto":       (9.685,   12.76,   14.493),  # [DB] weighted average
    "chatgpt":            (9.685,   12.76,   14.493),  # generic ChatGPT label: Auto

    # GPT-5.3 Instant: proxy: GPT-5 (low)
    "chatgpt-instant":    (4.86,    7.43,    9.69),   # [DB] March'26
    "gpt-5.3":            (4.86,    7.43,    9.69),   # [DB] March'26

    # GPT-5.4 Thinking/Pro: proxy: GPT-5 (high)
    "chatgpt-thinking":   (24.16,  28.75,   28.90),  # [DB] March'26 high reasoning mode
    "gpt-5.4-thinking":   (24.16,  28.75,   28.90),  # [DB] March'26 high reasoning mode
    "chatgpt-pro":        (24.16,  28.75,   28.90),  # [DB] March'26 high reasoning mode
    "gpt-5.4-pro":        (24.16,  28.75,   28.90),  # [DB] March'26 high reasoning mode

    # chatgpt-mini: proxy: GPT-5 mini (minimal)
    "chatgpt-mini":      (0.56,    1.64,    2.38),   # [DB] March'26 minimal reasoning mode

    # GPT-5.1 / GPT-5.2: legacy versioned models: same tier proxies as 5.3/5.4
    "gpt-5.1-instant":    (4.86,    7.43,    9.69),   # [DB] proxy: GPT-5 (low)
    "gpt-5.1-thinking":   (24.16,  28.75,   28.90),  # [DB] proxy: GPT-5 (high)
    "gpt-5.2-instant":    (4.86,    7.43,    9.69),   # [DB] proxy: GPT-5 (low)
    "gpt-5.2-thinking":   (24.16,  28.75,   28.90),  # [DB] proxy: GPT-5 (high)

    # Retired ChatGPT aliases (pre-Feb 2026)
    "chatgpt-4o":         (0.423,   1.215,   2.875),  # [T4] GPT-4o Mar'25
    "chatgpt-4o-mini":    (0.577,   1.897,   3.098),  # [T4] Nov'25
    "chatgpt-4.1":        (0.871,   3.161,   4.833),  # [T4] Nov'25

    "unknown":            (0.423,   1.215,   2.875),  # fallback to GPT-4o [T4] Mar'25
}

# Token totals for the three measured buckets
_BUCKET_TOKENS = (400, 2_000, 11_500)


def interpolate_energy_wh(model_key: str, total_tokens: int) -> float:

# Estimate per-query energy (Wh) for a given model and token count.

#Structure
#    • Below SHORT  : per-model sublinear power law, clamped at short_wh.
#    • SHORT→MEDIUM : piecewise-linear between the two measured anchors.
#    • MEDIUM→LONG  : piecewise-linear between the two measured anchors.
#    • Above LONG   : linear extrapolation from the medium→long gradient,
#                     with a safety clamp for non-monotonic models.
#    Source: Jegham et al. (2025) "How Hungry is AI?" arXiv:2505.09598v6.

    short_wh, medium_wh, long_wh = MODEL_ENERGY_WH.get(
        model_key, MODEL_ENERGY_WH["unknown"]
    )
    t_s, t_m, t_l = _BUCKET_TOKENS

    if total_tokens <= 0:
        return 0.0

    if total_tokens <= t_s:

        alpha = math.log(medium_wh / short_wh) / math.log(t_m / t_s)
        return min(short_wh, short_wh * (total_tokens / t_s) ** alpha)

    if total_tokens <= t_m:
        frac = (total_tokens - t_s) / (t_m - t_s)
        return short_wh + frac * (medium_wh - short_wh)

    if total_tokens <= t_l:
        frac = (total_tokens - t_m) / (t_l - t_m)
        return medium_wh + frac * (long_wh - medium_wh)


    slope = (long_wh - medium_wh) / (t_l - t_m)
    extrapolated = medium_wh + slope * (total_tokens - t_m)
    if long_wh < medium_wh:
        return max(long_wh, extrapolated)
    return max(0.0, extrapolated)


# Complexity factors, from dissertation Table 3.1
COMPLEXITY_FACTORS = {
    "simple": 1.0,
    "summarisation": 1.2,
    "reasoning": 1.5,
}

# Model: cloud provider mapping
#
# Carbon and water coefficients are keyed by provider, not user region.
# Inference occurs at the provider's data centre regardless of where the
# user is located, so provider-specific values from Jegham et al. (2025)
# Providers:
#   "azure"     — OpenAI models on Microsoft Azure (H200/H100 and A100)
#   "unknown"   — unrecognised model; falls back to global average

MODEL_PROVIDER: dict[str, str] = {
    # OpenAI → Azure
    "gpt-4o":             "azure",
    "gpt-4o-mini":        "azure",
    "gpt-4.1":            "azure",
    "gpt-4.1-mini":       "azure",
    "gpt-4.1-nano":       "azure",
    "gpt-4.5":            "azure",
    "gpt-4-turbo":        "azure",
    "gpt-3.5":            "azure",
    "o3":                 "azure",
    "o3-mini":            "azure",
    "o3-mini-high":       "azure",
    "o4-mini-high":       "azure",
    "gpt-5":              "azure",
    "gpt-5-low":          "azure",
    "gpt-5-minimum":      "azure",
    "gpt-5-medium":       "azure",
    "gpt-5-high":         "azure",
    "gpt-5-mini":         "azure",
    "gpt-5-mini-low":     "azure",
    "gpt-5-mini-medium":  "azure",
    "gpt-5-mini-high":    "azure",
    "gpt-5-nano":         "azure",
    "gpt-5-nano-low":     "azure",
    "gpt-5-nano-medium":  "azure",
    "gpt-5-nano-high":    "azure",
    # ChatGPT aliases: Azure (OpenAI-hosted)
    "chatgpt":            "azure",
    "chatgpt-auto":       "azure",
    "chatgpt-instant":    "azure",
    "chatgpt-thinking":   "azure",
    "chatgpt-pro":        "azure",
    "chatgpt-mini":       "azure",
    "chatgpt-4o":         "azure",
    "chatgpt-4o-mini":    "azure",
    "chatgpt-4.1":        "azure",
    "gpt-5.3":            "azure",
    "gpt-5.4-thinking":   "azure",
    "gpt-5.4-pro":        "azure",
    "gpt-5.1-instant":    "azure",
    "gpt-5.1-thinking":   "azure",
    "gpt-5.2-instant":    "azure",
    "gpt-5.2-thinking":   "azure",
    # OpenAI o1-series → Azure
    "o1":                 "azure",
    "o1-mini":            "azure",
    "o3-pro":             "azure",
    # OpenAI legacy → Azure
    "gpt-4":              "azure",
    # unknown
    "unknown":            "unknown",
}


# Provider carbon intensity (gCO2e / kWh)
# Source: Jegham et al. (2025) Table 1 — CIF column
#
#   Azure (OpenAI):   0.35 kgCO2e/kWh = 350.0 gCO2e/kWh  [ref 36]

PROVIDER_CARBON_INTENSITY_G_PER_KWH: dict[str, float] = {
    "azure":    350.0,
    "unknown":  445.9,  # Ember Climate 2024 world average
}

# Provider water intensity (mL / Wh) : two-components
# Source: Jegham et al. (2025) Table 1 (Nov 2025, v6) + Eq. 3
#
# Derivation from Jegham Table 1 Nov'25 v6 (converted to mL/Wh):
#   Azure:     (1/1.12)×300  + 4350 =  268 + 4350 = 4618 mL/kWh = 4.618 mL/Wh 
#   AWS:       (1/1.14)×180  + 5110 =  158 + 5110 = 5268 mL/kWh = 5.268 mL/Wh
#   DeepSeek:  (1/1.27)×1200 + 6016 =  945 + 6016 = 6961 mL/kWh = 6.961 mL/Wh
#   unknown:   simple average = (4.618 + 5.268 + 6.961) / 3 = 5.616 mL/Wh
#
# using provider-specific regional grid water intensity data (World Resources Institute, 2024).
PROVIDER_WATER_ML_PER_WH: dict[str, float] = {
    "azure":    4.618,  # (Nov v6, ref 35)
    "aws":      5.268,  # (Nov v6, ref 35) used only for average calc
    "deepseek": 6.961,   # (Nov v6, ref 35) used only for average calc
    "unknown":  5.616,  # simple average of above three
}

# Regional carbon intensity (gCO2e / kWh) : user geographic location mode
# Source: Ember Climate 2024 global electricity review
# Used only when location_mode == "user-region". 
REGION_CARBON_INTENSITY_G_PER_KWH: dict[str, float] = {
    "europe":        288.43,  # Ember Climate 2024 yearly aggregate
    "north-america": 361.43,  # Ember Climate 2024 yearly aggregate
    "asia":          579.33,  # Ember Climate 2024 yearly aggregate
    "middle-east":   637.58,  # Ember Climate 2024 yearly aggregate
    "africa":        543.77,  # Ember Climate 2024 world average
    "latin-america-and-caribbean": 253.39,  # Ember Climate 2024 world average
    "unknown":       477.13,  # Ember Climate 2024 world average
}

# Regional water intensity (mL / Wh) : user geographic location mode
#
# Primary source: Li, P., Yang, J., Islam, M.A. and Ren, S. (2025) 
#'Making AI less "thirsty": uncovering and addressing the secret water footprint of AI models', 
# Communications of the ACM, arXiv:2304.03271. Available at: https://doi.org/10.48550/arXiv.2304.03271 
#   Table 1 — per-location PUE, WUE_site, and EWIF (scope-2) values.
#
# Methodology: Jegham et al. (2025) Eq. 3 applied to Li et al. Table 1 data:
#   wr = (WUE_site / PUE) + EWIF
#
# Per-location wr derivations:
#
#   NORTH AMERICA:
#     State-level data preferred over Li et al. U.S. Average row
#
#     Virginia   wr: (0.140/1.140) + 2.385 = 0.123 + 2.385 = 2.508  
#     Texas      wr: (0.250/1.280) + 1.287 = 0.195 + 1.287 = 1.482  
#     Georgia    wr: (0.060/1.120) + 2.309 = 0.054 + 2.309 = 2.363  
#     Illinois   wr: (0.740/1.350) + 2.233 = 0.548 + 2.233 = 2.781  
#     Iowa       wr: (0.140/1.160) + 3.104 = 0.121 + 3.104 = 3.225  
#     Arizona    wr: (1.630/1.180) + 4.959 = 1.381 + 4.959 = 6.340  
#     Wyoming    wr: (0.130/1.110) + 2.574 = 0.117 + 2.574 = 2.691 
#
#    Sum:
#      2.508 + 1.482 + 2.363 + 2.781 + 3.225 + 6.340 + 2.691 + 5.350 = 26.74 mL/Wh
#      Average: 26.74 / 7 = 3.82 mL/Wh
#      
#
#   EUROPE — simple average of 5 Li et al. locations
#     Ireland:     (0.020/1.190) + 1.476 = 0.017 + 1.476 = 1.493
#     Netherlands: (0.060/1.140) + 3.445 = 0.053 + 3.445 = 3.498
#     Sweden:      (0.090/1.160) + 6.019 = 0.078 + 6.019 = 6.097
#     Denmark:     (0.010/1.160) + 3.180 = 0.009 + 3.180 = 3.189
#     Finland:     (0.010/1.120) + 4.542 = 0.009 + 4.542 = 4.551
#     Average = (1.493 + 3.498 + 6.097 + 3.189 + 4.551) / 5 = 3.766
#
#   ASIA — simple average of 2 Li et al. locations
#     India:     (0.000/1.430) + 3.445 = 0.000 + 3.445 = 3.445
#     Indonesia: (1.900/1.320) + 2.271 = 1.439 + 2.271 = 3.710
#     Average = (3.445 + 3.710) / 2 = 3.578
#     NOTE: China, Japan, South Korea absent from Li et al. lower confidence.
#
#   MIDDLE EAST — no Li et al. data; fallback to unknown (4.166)
#
#   AFRICA — no Li et al. data; fallback to unknown (4.166)
#
#   LATIN AMERICA — single Li et al. location
#     Mexico: (0.056/1.120) + 5.300 = 0.050 + 5.300 = 5.350
#
#   UNKNOWN — simple average of the four data-backed regions 
#     (3.82 + 3.766 + 3.578 + 5.350) / 4 = 4.129
# Used only when location_mode == "user-region".
REGION_WATER_ML_PER_WH: dict[str, float] = {
    "north-america":              3.82,
    "europe":                      3.766,
    "asia":                        3.578,
    "middle-east":                 4.129,
    "africa":                      4.129,
    "latin-america-and-caribbean": 5.350,
    "unknown":                     4.129,
}

# 
#  Uncertainty band: applied to energy, carbon, and water equally.
# Source: Jegham et al. (2025) Table 4, per-model standard deviations

UNCERTAINTY_BAND = (0.80, 1.20)  # ±20%

ENERGY_RANGE = UNCERTAINTY_BAND
CARBON_RANGE = UNCERTAINTY_BAND
WATER_RANGE  = UNCERTAINTY_BAND

# Tiktoken model map
TIKTOKEN_MODEL_MAP = {
    "gpt-3.5":            "gpt-3.5-turbo",
    "chatgpt":            "gpt-4o",   
    "chatgpt-auto":       "gpt-4o",
    "chatgpt-instant":    "gpt-4o",
    "chatgpt-thinking":   "gpt-4o",
    "chatgpt-pro":        "gpt-4o",
    "chatgpt-mini":       "gpt-4o",
    "chatgpt-4o":         "gpt-4o",
    "chatgpt-4o-mini":    "gpt-4o-mini",
    "chatgpt-4.1":        "gpt-4o",
    "gpt-5.3":            "gpt-4o",
    "gpt-5.4-thinking":   "gpt-4o",
    "gpt-5.4-pro":        "gpt-4o",
    "gpt-5.1-instant":    "gpt-4o",
    "gpt-5.1-thinking":   "gpt-4o",
    "gpt-5.2-instant":    "gpt-4o",
    "gpt-5.2-thinking":   "gpt-4o",
    "gpt-4o-mini":        "gpt-4o-mini",
    "gpt-4o":             "gpt-4o",
    "gpt-4.1":            "gpt-4o",
    "gpt-4.1-mini":       "gpt-4o",
    "gpt-4.1-nano":       "gpt-4o",
    "gpt-4.5":            "gpt-4o",
    "gpt-4-turbo":        "gpt-4o",
    "gpt-5":              "gpt-4o",
    "gpt-5-low":          "gpt-4o",
    "gpt-5-minimum":      "gpt-4o",
    "gpt-5-medium":       "gpt-4o",
    "gpt-5-high":         "gpt-4o",
    "gpt-5-mini":         "gpt-4o",
    "gpt-5-mini-low":     "gpt-4o",
    "gpt-5-mini-medium":  "gpt-4o",
    "gpt-5-mini-high":    "gpt-4o",
    "gpt-5-nano":         "gpt-4o",
    "gpt-5-nano-low":     "gpt-4o",
    "gpt-5-nano-medium":  "gpt-4o",
    "gpt-5-nano-high":    "gpt-4o",
    "o1":                 "gpt-4o",
    "o1-mini":            "gpt-4o",
    "o3-pro":             "gpt-4o",
    "gpt-4":              "gpt-4",
    "o3-mini":            "gpt-4o",
    "o3-mini-high":       "gpt-4o",
    "o3":                 "gpt-4o",
    "o4-mini-high":       "gpt-4o",
    "unknown":  "gpt-4o",
}


def normalize_tiktoken_model(model: str) -> str:
    key = (model or "").strip().lower()
    if not key:
        return "gpt-4o"
    return TIKTOKEN_MODEL_MAP.get(key, key)


def count_tokens(text: str, model: str = "gpt-4o") -> int:
    if not text:
        return 0
    tk_model = normalize_tiktoken_model(model)
    try:
        enc = tiktoken.encoding_for_model(tk_model)
    except KeyError:
        enc = tiktoken.get_encoding("cl100k_base")
    return len(enc.encode(text))


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/estimate", response_model=EstimateResponse)
def estimate(req: EstimateRequest):
    model_key = req.model.strip().lower() if req.model else "unknown"
    if model_key not in MODEL_ENERGY_WH:
        model_key = "unknown"

    # Complexity aware routing for ChatGPT Auto
 
    if model_key in ("chatgpt-auto", "chatgpt"):
        if req.complexity == "reasoning":
            model_key = "chatgpt-thinking"
        else:
            model_key = "chatgpt-instant"

    # Token counting
    token_model = normalize_tiktoken_model(model_key)
    tokens_in  = count_tokens(req.prompt,   token_model) if req.prompt   else max(0, int(req.tokens_in))
    tokens_out = count_tokens(req.response, token_model) if req.response else max(0, int(req.tokens_out))
    total_tokens = tokens_in + tokens_out

    # Complexity factor, dissertation 3.3, Table 3.1
    complexity_factor = COMPLEXITY_FACTORS.get(req.complexity, 1.0)

    base_energy_wh = interpolate_energy_wh(model_key, total_tokens)
    energy_wh = base_energy_wh * complexity_factor

    provider = MODEL_PROVIDER.get(model_key, "unknown")

    if req.location_mode == "user-region":
        user_region = req.region if req.region else "unknown"
        intensity_g_per_kwh = REGION_CARBON_INTENSITY_G_PER_KWH.get(
            user_region, REGION_CARBON_INTENSITY_G_PER_KWH["unknown"]
        )
        water_ml_per_wh = REGION_WATER_ML_PER_WH.get(
            user_region, REGION_WATER_ML_PER_WH["unknown"]
        )
    else:
        intensity_g_per_kwh = PROVIDER_CARBON_INTENSITY_G_PER_KWH[provider]
        water_ml_per_wh     = PROVIDER_WATER_ML_PER_WH[provider]

    carbon_g = (energy_wh / 1000.0) * intensity_g_per_kwh
    water_ml = energy_wh * water_ml_per_wh

    return EstimateResponse(
        carbon_g=carbon_g,
        energy_wh=energy_wh,
        water_ml=water_ml,
        energy_low=energy_wh  * ENERGY_RANGE[0],
        energy_high=energy_wh * ENERGY_RANGE[1],
        carbon_low=carbon_g   * CARBON_RANGE[0],
        carbon_high=carbon_g  * CARBON_RANGE[1],
        water_low=water_ml    * WATER_RANGE[0],
        water_high=water_ml   * WATER_RANGE[1],
        meta={
            "site": req.site,
            "model": model_key,
            "provider": provider,
            "region": req.region,
            "location_mode": req.location_mode,
            "complexity": req.complexity,
            "complexity_factor": complexity_factor,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "tokens_total": total_tokens,
            "base_energy_wh": base_energy_wh,
            "carbon_intensity_g_per_kwh": intensity_g_per_kwh,
            "water_ml_per_wh": water_ml_per_wh,
        },
    )