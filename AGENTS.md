# AGENTS

Notes for UI testing and iteration on the VPS.

## UI loop (VPS)

- Use the Vite UI for design iteration (skip Tauri on the VPS): `cd conductor/desktop && npm run dev` in tmux.
- Wait for `http://localhost:1420/`.
- Capture screenshots with headless Chromium via Puppeteer (one-time setup in `/tmp/puppeteer-run`):

```bash
mkdir -p /tmp/puppeteer-run
cd /tmp/puppeteer-run
npm init -y
npm install puppeteer
```

```bash
LD_LIBRARY_PATH=/home/tako/.local/opt/gtk/usr/lib/x86_64-linux-gnu:/home/tako/.local/opt/x11/usr/lib/x86_64-linux-gnu \
node -e "const puppeteer=require('puppeteer');(async()=>{const b=await puppeteer.launch({args:['--no-sandbox','--disable-setuid-sandbox'],headless:true});const p=await b.newPage();await p.setViewport({width:1280,height:720});await p.goto('http://localhost:1420/',{waitUntil:'networkidle2',timeout:60000});await new Promise(r=>setTimeout(r,1000));await p.screenshot({path:'/tmp/conductor-desktop.png',fullPage:true});await b.close();})().catch(err=>{console.error(err);process.exit(1);});"
```

- The browser UI may show a "Backend error" banner because Tauri APIs are not available in the browser. This is expected for layout review.

## Gemini for UI review

- If the user explicitly asks to use Gemini, prefer `gemini -m gemini-3-flash-preview` on the screenshot and instruct it not to change code.
