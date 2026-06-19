# pi-spider-tools

Native [Pi coding agent](https://pi.dev) tools that expose [Spider Cloud](https://spider.cloud)
scraping, crawling, search, screenshot, and browser-automation capabilities.

It ships **two tool sets**, registered from separate entry files:

- **Core tier** (`src/spider.ts`) — stateless tools that call the Spider Cloud REST API directly.
- **Browser tier** (`src/browser.ts`) — stateful remote-browser automation backed by the
  [`spider-browser`](https://www.npmjs.com/package/spider-browser) package (WebSocket to Spider's
  pre-warmed browser fleet).

## Core tools

| Tool | Endpoint | Description |
| --- | --- | --- |
| `spider_scrape` | `POST /scrape` | Scrape a single URL; faster/cheaper than crawling. |
| `spider_crawl` | `POST /crawl` | Crawl a site following links up to a `limit`/`depth`. |
| `spider_search` | `POST /search` | Web search, optionally fetching each result's content. |
| `spider_links` | `POST /links` | Collect links without returning page content. |
| `spider_screenshot` | `POST /screenshot` | Capture a page screenshot (base64 PNG in the payload). |
| `spider_unblocker` | `POST /unblocker` | Fetch anti-bot-protected pages via the stealth unblocker. |
| `spider_transform` | `POST /transform` | Convert raw HTML to markdown/text (no web request). |
| `spider_get_credits` | `GET /data/credits` | Check remaining credit balance (free). |

## Browser tools

Stateful: `spider_browser_open` returns a `session_id` that the other tools take, and
`spider_browser_close` releases it. **Open sessions bill until closed** — they auto-close after
5 minutes of inactivity and on pi shutdown/reload, and at most 5 may be open at once.

| Tool | Description |
| --- | --- |
| `spider_browser_open` | Open a remote browser session; returns a `session_id`. |
| `spider_browser_navigate` | Navigate the session to a URL and wait for load. |
| `spider_browser_click` | Click an element by CSS selector. |
| `spider_browser_fill` | Fill a form field by CSS selector. |
| `spider_browser_screenshot` | Capture a screenshot (returned as an inline image). |
| `spider_browser_content` | Get the page HTML or visible text. |
| `spider_browser_evaluate` | Execute JavaScript in the page and return the result. |
| `spider_browser_wait_for` | Wait for a selector, navigation, or network idle. |
| `spider_browser_close` | Close the session and stop billing. |

## Result display

Core tools cap processing to the first **10 results** (the model is told when more were
available, e.g. `processed first 10 of 31 results`) and render a compact summary in the TUI
instead of dumping raw JSON — a one-line `N results` row that expands to a `title — url` list.
The full (capped) JSON is still sent to the model.

## Configuration

The extension reads `SPIDER_API_KEY` from the environment (pi does not load `.env` itself).
Get a key at <https://spider.cloud/api-keys>. Optional overrides:
`SPIDER_API_URL` (core REST base) and `SPIDER_BROWSER_URL` (browser fleet WebSocket).

### Primary: pass the key inline

Prefix the command with the key — the simplest way to run a one-off (works whether the
extension is installed or loaded with `-e`):

```bash
SPIDER_API_KEY=sk-... pi
```

### Optional: auto-load with direnv

To avoid typing the key each time, keep it in a gitignored `.env` at the workspace root and let
[direnv](https://direnv.net) load it whenever you enter the directory:

```bash
brew install direnv                          # once
echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc # once (then open a new terminal)

echo 'SPIDER_API_KEY=sk-...' > .env          # gitignored
printf 'dotenv\n' > .envrc                    # loads .env
direnv allow
```

Pi started from this directory then sees the key automatically. (Or, always on:
`echo 'export SPIDER_API_KEY="sk-..."' >> ~/.zshrc`.)

## Install

```bash
# install from npm (registers both tiers from package.json)
pi install npm:@spider/pi-spider-tools
pi list

# or try it for a single session without installing
pi -e npm:@spider/pi-spider-tools
```

### From a local clone (development)

```bash
# install by path (both tiers, from package.json)
pi install ./extensions/pi-spider-tools

# or load a single tier ad-hoc; /reload picks up edits
pi -e ./src/spider.ts          # core tools only
pi -e ./src/browser.ts         # browser tools only
pi -e ./src/spider.ts -e ./src/browser.ts   # both
```

## Commands

```
/spider           open the menu
/spider status    show API key status and which core tools are enabled
/spider tools     interactively toggle which core Spider tools are active
/spider enable     enable all core Spider tools
/spider disable    disable all core Spider tools
/spider help      show help

/spider-browser status   show API key status and open browser sessions
/spider-browser close    close all open browser sessions
/spider-browser help     show browser help
```

Core tool selection is persisted to `pi-spider-tools-settings.json` in your Pi agent directory
(`$PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent`).

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run check       # biome + typecheck
```

See parameter details for each endpoint at <https://spider.cloud/docs/api>.

## License

MIT
