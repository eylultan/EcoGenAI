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
Complexity = Literal["simple", "medium reasoning", "high reasoning"]
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


# Per-query energy lookup table: Three prompt-size buckets

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
    "gpt-4":              (1.797 ,  6.925,   6.925),  # [T4] long N/A, medium used 

    # o-series reasoning models
    "o3":                 (1.177,  5.153,  12.222),  # [T4] Nov'25
    "o3-mini":            (0.674,  2.423,   3.525),  # [T4] Nov'25
    "o3-mini-high":       (3.012,  6.865,   5.389),  # [T4] Nov'25
    "o3-pro":             (30.51,  42.50,  42.10),   # [DB] March'26
    "o4-mini-high":       (3.649,  7.380,   7.237),  # [T4] Nov'25
    "o1":                 (2.268,  4.047,   6.181),  # [T4] Nov'25
    "o1-mini":            (0.535 , 1.547,   2.317),  # [T4] Nov'25

    # GPT-5: adaptive routing tiers [DB] 
    "gpt-5":              (4.86,    7.43,    9.69),   # [DB] GPT-5 low reasoning mode (default) March'26
    "gpt-5-low":          (4.86,    7.43,    9.69),   # [DB] low reasoning mode March'26
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
    #   GPT-5.3 Instant  = GPT-5 (low)    
    #   GPT-5.4 Thinking = GPT-5 (high)
    # chatgpt-auto: Auto mode weighted average 75% Instant, 25% Thinking assumption
    "chatgpt-auto":       (9.685,   12.76,   14.493),  # [DB] weighted average
    "chatgpt":            (9.685,   12.76,   14.493),  # generic ChatGPT label: Auto

    # GPT-5.3 Instant = GPT-5 (low)
    "chatgpt-instant":    (4.86,    7.43,    9.69),   # [DB] March'26
    "gpt-5.3":            (4.86,    7.43,    9.69),   # [DB] March'26

    # GPT-5.4 Thinking/Pro = GPT-5 (high)
    "chatgpt-thinking":   (24.16,  28.75,   28.90),  # [DB] March'26 high reasoning mode
    "gpt-5.4-thinking":   (24.16,  28.75,   28.90),  # [DB] March'26 high reasoning mode
    "chatgpt-pro":        (24.16,  28.75,   28.90),  # [DB] March'26 high reasoning mode
    "gpt-5.4-pro":        (24.16,  28.75,   28.90),  # [DB] March'26 high reasoning mode

    # chatgpt-mini = GPT-5 mini (minimal)
    "chatgpt-mini":      (0.56,    1.64,    2.38),   # [DB] March'26 minimal reasoning mode

    # GPT-5.1 / GPT-5.2: legacy versioned models: same as 5.3/5.4
    "gpt-5.1-instant":    (4.86,    7.43,    9.69),   # [DB] proxy: GPT-5 (low)
    "gpt-5.1-thinking":   (24.16,  28.75,   28.90),  # [DB] proxy: GPT-5 (high)
    "gpt-5.2-instant":    (4.86,    7.43,    9.69),   # [DB] proxy: GPT-5 (low)
    "gpt-5.2-thinking":   (24.16,  28.75,   28.90),  # [DB] proxy: GPT-5 (high)

    # Retired ChatGPT aliases
    "chatgpt-4o":         (0.423,   1.215,   2.875),  # [T4] GPT-4o Mar'25
    "chatgpt-4o-mini":    (0.577,   1.897,   3.098),  # [T4] Nov'25
    "chatgpt-4.1":        (0.871,   3.161,   4.833),  # [T4] Nov'25

    "unknown":            (0.423,   1.215,   2.875),  # fallback to GPT-4o [T4] Mar'25
}

# Token totals for the three buckets
_BUCKET_TOKENS = (400, 2_000, 11_500)


def interpolate_energy_wh(model_key: str, total_tokens: int) -> float:

# Estimate per-query energy

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


# Complexity factors from dissertation 
COMPLEXITY_FACTORS = {
    "simple": 1.0,
    "medium reasoning": 1.2,
    "high reasoning": 1.5,
}


# Provider mode
#   "azure"     : OpenAI models on Microsoft Azure 
#   "unknown"   : unrecognised  & falls back to global average

MODEL_PROVIDER: dict[str, str] = {
    # OpenAI : Azure
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
    # OpenAI o1-series : Azure
    "o1":                 "azure",
    "o1-mini":            "azure",
    "o3-pro":             "azure",
    # OpenAI legacy : Azure
    "gpt-4":              "azure",
    # unknown
    "unknown":            "unknown",
}


# Provider carbon intensity 
PROVIDER_CARBON_INTENSITY_G_PER_KWH: dict[str, float] = {
    "azure":    350.0,
    "unknown":  477.13,  # Unknown (world average)
}

# Provider water intensity

PROVIDER_WATER_ML_PER_WH: dict[str, float] = {
    "azure":    4.618,  # Nov v6
    "aws":      5.268,  # Nov v6
    "deepseek": 6.961,   # Nov v6
    "unknown":  5.616,  # simple average of above three
}

# Regional carbon intensity (yearly) : user mode 

REGION_CARBON_INTENSITY_G_PER_KWH: dict[str, float] = {
    "europe":        288.43,  
    "north-america": 361.43,  
    "asia":          579.33,  
    "middle-east":   637.58,  
    "africa":        543.77,  
    "latin-america-and-caribbean": 253.39,  
    "unknown":       477.13,  #  world average : Ember Climate 2024
}

# Regional water intensity: user mode

REGION_WATER_ML_PER_WH: dict[str, float] = {
    "north-america":              3.82,
    "europe":                      3.766,
    "asia":                        3.578,
    "middle-east":                 4.129,
    "africa":                      4.129,
    "latin-america-and-caribbean": 5.350,
    "unknown":                     4.129,
}


#  Uncertainty band: applied to energy, carbon, & water 
UNCERTAINTY_BAND = (0.80, 1.20) 

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
        
        try:
            enc = tiktoken.get_encoding("o200k_base")
        except Exception:
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

    # ChatGPT Auto routing 
 
    if model_key in ("chatgpt-auto", "chatgpt"):
        if req.complexity == "high reasoning":
            model_key = "chatgpt-thinking"
        else:
            model_key = "chatgpt-instant"

    # Token counting
    token_model = normalize_tiktoken_model(model_key)
    tokens_in  = count_tokens(req.prompt,   token_model) if req.prompt   else max(0, int(req.tokens_in))
    tokens_out = count_tokens(req.response, token_model) if req.response else max(0, int(req.tokens_out))
    total_tokens = tokens_in + tokens_out

    # Complexity factor
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