# 🧩 Pi Extensions

A collection of extensions for the [Pi coding agent](https://pi.dev) — native tools and commands within the Pi coding agent community. This repo currently ships one extension, with more on the way.

## 📦 Pi extension packages

| Pi extension | What it adds | Install |
| --- | --- | --- |
| [pi-spider-tools](./extensions/pi-spider-tools) | 🕷 [Spider Cloud](https://spider.cloud) web scraping, crawling, search, and remote browser automation as native Pi tools | `pi install npm:@spider/pi-spider-tools` |

> More extensions will be added here over time. Each lives in its own directory under
> `extensions/` and is self-contained.

## 🚀 Quick start

Requires the [Pi coding agent](https://pi.dev). Install from npm and it registers its tools
globally:

```bash
# install for everyday use (adds it to ~/.pi/agent/settings.json)
pi install npm:@spider/pi-spider-tools
pi list

# or try it for a single session without installing
pi -e npm:@spider/pi-spider-tools
```

Working from a local clone of this repo instead? Install by path:

```bash
pi install ./extensions/pi-spider-tools
```

Extensions read their credentials from the environment. The simplest way is to pass the key
inline:

```bash
SPIDER_API_KEY=sk-... pi
```

To avoid typing it each time, keep it in a gitignored `.env` and let
[direnv](https://direnv.net) load it automatically when you enter the directory:

```bash
brew install direnv
echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc   # then open a new terminal

echo 'SPIDER_API_KEY=sk-...' > .env             # gitignored
printf 'dotenv\n' > .envrc                       # already present in this repo
direnv allow
```

## 🛠️ Extension use cases

### 🕸️ Web scraping & crawling — [pi-spider-tools](./extensions/pi-spider-tools)

Give the agent first-class access to [Spider Cloud](https://spider.cloud). It ships **two tool
tiers**:

- **Core** — stateless REST tools: `spider_scrape`, `spider_crawl`, `spider_search`,
  `spider_links`, `spider_screenshot`, `spider_unblocker`, `spider_transform`, and
  `spider_get_credits`.
- **Browser** — stateful remote-browser automation backed by Spider's pre-warmed fleet:
  `spider_browser_open`/`navigate`/`click`/`fill`/`screenshot`/`content`/`evaluate`/`wait_for`/`close`.

Manage them with the `/spider` and `/spider-browser` commands. See the
[extension README](./extensions/pi-spider-tools/README.md) for the full tool reference and
configuration options.

## 🧑‍💻 Local development

Each extension is a standalone npm package. Work inside its directory:

```bash
cd extensions/pi-spider-tools
npm install
npm run typecheck    # tsc --noEmit
npm run check        # biome + typecheck
npm run format       # biome --write

# run against your local Pi while iterating; /reload picks up edits
pi -e ./src/spider.ts -e ./src/browser.ts
```

Extensions are written in TypeScript against `@earendil-works/pi-coding-agent`; Pi loads `.ts`
files directly, so there's no build step.

## 🗂️ Repository structure

```
pi-extensions/
├── .envrc                     # direnv: loads .env into the shell
├── .env.example               # template for required secrets
├── README.md
└── extensions/
    └── pi-spider-tools/        # Spider Cloud tools (core + browser tiers)
        ├── src/
        │   ├── spider.ts        # core REST tools
        │   └── browser.ts       # remote browser tools
        ├── package.json
        ├── tsconfig.json
        ├── biome.json
        └── README.md
```

## 📄 License

MIT
