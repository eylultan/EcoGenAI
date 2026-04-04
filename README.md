# EcoGenAI — Participant Setup Guide

Estimates the carbon, energy, and water footprint of your ChatGPT interactions in real time.

> Setup takes approximately 5–10 minutes. Please complete all steps before the study begins.

---

## Requirements

Before you begin, make sure you have the following:

- **Google Chrome** (version 88 or later)
- **Python 3.9 or later**: download from [python.org](https://www.python.
  org/downloads/)
- **pip** — usually included with Python; verify by running `pip --version` in a terminal
- **A ChatGPT account** at [chatgpt.com](https://chatgpt.com)

---

## 1. Install & Start the Backend

### 1.0 Install Python dependencies
Downlaod this directory as zip file, can be found under the green code button. Unizp the directory and place it in an easy access location.

### 1.1 Install Python dependencies

Open a terminal (Mac: Terminal / Windows: Command Prompt or PowerShell) 
Navigate to the backend folder of this directory,
   you can use 
   ```bash
   cd location_of_folder 
   cd backend
   ```
and run:

```bash
pip install -r requirements.txt
```

### 1.2 Start the backend server

```bash
python -m uvicorn app:app --reload
```

You should see:

```
Uvicorn running on http://127.0.0.1:8000
```

> Leave this terminal open for the entire study session. The extension cannot calculate footprints without the backend running.

---

## 2. Install the Chrome Extension

1. Open **Google Chrome**
2. Go to `chrome://extensions` in the address bar
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the `extension` folder (the one containing `manifest.json`)
6. The **EcoGenAI Impact Panel** extension should appear with a green leaf icon

> If you see "Manifest file is missing or unreadable", make sure you selected the folder itself, not a file inside it.

---

## 3. Verify Everything is Working

1. Go to [chatgpt.com](https://chatgpt.com) and log in
2. A green side panel should appear on the right side of the screen
3. Send a message to ChatGPT
4. After the response completes, the panel should display carbon, energy, and water estimates

> If estimates appear after your first message, setup is complete and you are ready for the study.

---

## 4. Troubleshooting

### Panel does not appear
- Make sure the extension is enabled in `chrome://extensions`
- Refresh the chatgpt.com page
- Check the green leaf icon is visible in the Chrome toolbar

### Panel shows an error or no estimates
- Confirm the backend is running (`Uvicorn running on http://127.0.0.1:8000` in your terminal)
- Restart the backend: press `Ctrl+C` in the terminal, then run the `uvicorn` command again
- Reload the extension: go to `chrome://extensions` and click the refresh icon on EcoGenAI

### `pip` command not found
- Try `pip3` instead of `pip`
- On Windows, try `python -m pip install ...`

### Port already in use
- Run the backend on a different port:
  ```bash
  python -m uvicorn app:app --reload --port 8001
  ```
- Then open the EcoGenAI panel settings and update the backend URL to `http://localhost:8001`

---

## 5. Questions or Issues

If you encounter any issues not covered above, please contact myself before the study session begins. Do not proceed until EcoGenAI is displaying estimates correctly.
