# EcoGenAI

A Chrome extension and Python backend that estimates the carbon, energy, and water footprint of ChatGPT interactions in real time.

> Full methodology, design decisions, and study results are documented in the dissertation PDF submitted alongside this codebase. This README covers data provenance, processing, and how to run the project.

---

## 1. Where the Data Came From

EcoGenAI estimates three environmental metrics per ChatGPT interaction: **carbon emissions (gCO₂e)**, **energy consumption (Wh)**, and **water usage (mL)**. All coefficients used in `app.py` are derived from the following published sources:

### Energy per query (Wh):  MODEL_ENERGY_WH in `app.py`
- **Primary source:** Nidhal Jegham, Marwan Abdelatti, Chan Young Koh, Lassad Elmoubarki, and
  Abdeltawab Hendawi. How hungry is ai? benchmarking energy, water, and carbon
  footprint of llm inference. arXiv preprint arXiv:2505.09598v6, November 2025.
  URL https://arxiv.org/abs/2505.09598. Accessed: 05 March 2026.
    - Per-model energy values for short (400 tokens), medium (2,000 tokens), and long (11,500 tokens) prompt buckets were taken from **Table 4** mean values.
    - GPT-5 family values (which postdate the paper's data collection) were manually transcribed from the authors' accompanying **Power BI dashboard** (accessed March 2026). These are labelled `[DB]` in the source comments in `app.py`.

### Carbon intensity (gCO₂e / kWh): PROVIDER_CARBON_INTENSITY_G_PER_KWH and REGION_CARBON_INTENSITY_G_PER_KWH in `app.py`
- **Provider mode:** Jegham et al. (2025) Table 1, CIF column. Azure (the cloud provider for all OpenAI/ChatGPT models): 350 gCO₂e/kWh.
- **User-region mode:** Ember Climate (2024). *Global Electricity Review.* Regional yearly aggregate grid intensity values for Europe, North America, Asia, Middle East, Africa, and Latin America & Caribbean.

### Water intensity (mL / Wh): PROVIDER_WATER_ML_PER_WH and REGION_WATER_ML_PER_WH in `app.py`
- **Provider mode:** Jegham et al. (2025) Table 1 (v6, November 2025). Per-provider WUE (water usage effectiveness) and EWIF (energy-based water impact factor) values for Azure, AWS, and DeepSeek. Combined using Jegham et al. Equation 3: `wr = (WUE_site / PUE) + EWIF`.
- **User-region mode:** Pengfei Li, Jianyi Yang, Mohammad A. Islam, and 
  Shaolei Ren. Making ai less “thirsty”. Communications of the ACM, 68(7):54–61, 2025. doi: 10.1145/3724499.
  URL https://doi.org/10.1145/3724499. Accessed: 18 October 2025., arXiv:2304.03271. Per-location PUE, WUE_site, and EWIF values from Table 1, aggregated to regional averages. Full per-location derivations are documented in inline comments in `app.py`.

### Complexity factors: COMPLEXITY_FACTORS in `app.py`
A multiplier is applied to the base energy figure based on detected prompt 
complexity: 1.0× (simple), 1.2× (medium reasoning), 1.5× (high reasoning)
. The rationale and derivation are discussed in **dissertation Section 3.3, 
Figure 3.1**.

### Uncertainty bands
A ±20% range is applied to all three metrics to produce low/high estimates. This is derived from the per-model standard deviations reported in Jegham et al. (2025) Table 4.

---

## 2. How the Data Was Processed

All estimation logic lives in **`app.py`** (FastAPI backend). The pipeline for each ChatGPT interaction is:

1. **Token counting** : the prompt and response texts are tokenised using 
   OpenAI's `tiktoken` library with the appropriate per-model encoding (see `TIKTOKEN_MODEL_MAP` in `app.py`).
2. **Energy interpolation** : the total token count is mapped to energy (Wh) 
   using piecewise-linear interpolation across three measured anchors from Jegham et al. Table 4. A power-law is used for sub-400-token queries; linear extrapolation (with a safety clamp for non-monotonic models) is used beyond 11,500 tokens. See `interpolate_energy_wh()` in `app.py`.
3. **Complexity adjustment** : the interpolated energy figure is multiplied 
   by the complexity factor. Complexity is classified automatically in 
   `contentScript.js` using keyword and word-count heuristics.
4. **Carbon calculation** : `carbon_g = (energy_wh / 1000) × 
carbon_intensity_g_per_kwh`. Intensity is looked up by cloud provider (default mode) or user-declared geographic region.
5. **Water calculation** : `water_ml = energy_wh × water_ml_per_wh`. 
   Intensity is looked up by provider or user-declared region.
6. **Uncertainty bands** : ±20% is applied to produce low and high estimates 
   for all three metrics.

The frontend (`contentScript.js`) intercepts ChatGPT prompts and responses via DOM observation and posts them to the backend. The panel (`panel.js`, `panel.html`, `panel.css`) renders the returned estimates alongside relatable analogies (e.g. Google searches, LED bulb hours, sips of water).


---

## 3. How to Run the Project

### Requirements
- Google Chrome (version 88 or later)
- Python 3.9 or later
- pip

### Step 1 — Install Python dependencies

Download and unzip this directory, then in a terminal:

```bash
cd backend
pip install -r requirements.txt
```

### Step 2 — Start the backend server

```bash
python -m uvicorn app:app --reload
```

You should see:
```
Uvicorn running on http://127.0.0.1:8000
```

> Keep this terminal open throughout use. The extension cannot calculate footprints without the backend running.

### Step 3 — Load the Chrome extension

1. Open Chrome → go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension` folder (the one containing `manifest.json`)
5. The **EcoGenAI Impact Panel** extension should appear with a green leaf icon

### Step 4 — Verify it works

1. Go to [chatgpt.com](https://chatgpt.com) and log in
2. A green side panel should appear on the right side of the screen
3. Send a message to ChatGPT
4. After the response completes, the panel should display carbon, energy, and water estimates

### Querying the backend directly

You can also call the `/estimate` endpoint directly to verify outputs:

```bash
curl -X POST http://127.0.0.1:8000/estimate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "prompt": "What is the capital of France?",
    "response": "The capital of France is Paris.",
    "complexity": "simple",
    "location_mode": "provider"
  }'
```

Expected response fields: `carbon_g`, `energy_wh`, `water_ml`, plus low/high uncertainty bounds and a `meta` object.

---

## 4. Troubleshooting

| Problem | Fix |
|---|---|
| Panel does not appear | Ensure the extension is enabled in `chrome://extensions`; refresh chatgpt.com |
| Panel shows no estimates | Confirm the backend is running; restart with `Ctrl+C` then re-run the uvicorn command |
| `pip` not found | Try `pip3`, or `python -m pip install -r requirements.txt` |
| Port already in use | Run on a different port: `python -m uvicorn app:app --reload --port 8001` |

---

## 5. File Overview

| File | Purpose                                                                  |
|---|--------------------------------------------------------------------------|
| `app.py` | FastAPI backend : all environmental estimation logic                     |
| `requirements.txt` | Python dependencies                                                      |
| `manifest.json` | Chrome extension manifest (Manifest V3)                                  |
| `contentScript.js` | DOM interaction, prompt/response interception, complexity classification |
| `panel.html` / `panel.css` / `panel.js` | Extension side panel UI                                                  |
| `icon*.png` | Extension icons                                                          |
| `User_Study_1_...xlsx` | Study 1 quantitative data                                                |
| `User_Study_2_Interview_P*.docx` | Study 2 interview transcripts                                            |
