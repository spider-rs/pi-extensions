/**
 * pi-spider-tools
 *
 * Native Pi coding agent tools for the Spider Cloud API (https://spider.cloud).
 * Mirrors the Core tool surface of spider-cloud-mcp-v2 by calling the Spider
 * Cloud REST API directly — no MCP server is run.
 *
 * Requires the SPIDER_API_KEY environment variable. Get a key at
 * https://spider.cloud/api-keys.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_API_URL = "https://api.spider.cloud";

function normalizeApiUrl(apiUrl: string | undefined): string {
	return (apiUrl?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
}

const state = {
	apiUrl: normalizeApiUrl(process.env.SPIDER_API_URL ?? process.env.SPIDER_BASE_URL),
};

function getApiKey(): string {
	const apiKey = process.env.SPIDER_API_KEY?.trim();
	if (!apiKey) {
		throw new Error(
			"SPIDER_API_KEY is required for pi-spider-tools. Run pi with the key inline, e.g. " +
				"SPIDER_API_KEY=sk-... pi (or load it from a gitignored .env via direnv). " +
				"Get a key at https://spider.cloud/api-keys.",
		);
	}
	return apiKey;
}

function hasApiKey(): boolean {
	return Boolean(process.env.SPIDER_API_KEY?.trim());
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const SPIDER_TOOL_NAMES = [
	"spider_scrape",
	"spider_crawl",
	"spider_search",
	"spider_links",
	"spider_screenshot",
	"spider_unblocker",
	"spider_transform",
	"spider_get_credits",
] as const;

type SpiderToolName = (typeof SPIDER_TOOL_NAMES)[number];

function isSpiderToolName(name: string): name is SpiderToolName {
	return (SPIDER_TOOL_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Settings persistence (atomic write-to-temp + rename)
// ---------------------------------------------------------------------------

const SETTINGS_FILE = join(
	process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
	"pi-spider-tools-settings.json",
);

interface SpiderSettings {
	/** Tools the user wants active. */
	tools: SpiderToolName[];
	updatedAt: number;
}

function defaultSettings(): SpiderSettings {
	return { tools: [...SPIDER_TOOL_NAMES], updatedAt: 0 };
}

function normalizeSettings(raw: unknown): SpiderSettings {
	if (typeof raw !== "object" || raw === null) return defaultSettings();
	const record = raw as Record<string, unknown>;
	const tools = Array.isArray(record.tools)
		? SPIDER_TOOL_NAMES.filter((name) => (record.tools as unknown[]).includes(name))
		: [...SPIDER_TOOL_NAMES];
	const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : 0;
	return { tools, updatedAt };
}

async function loadSettings(): Promise<SpiderSettings> {
	let text: string;
	try {
		text = await readFile(SETTINGS_FILE, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return defaultSettings();
		throw error;
	}
	try {
		return normalizeSettings(JSON.parse(text));
	} catch {
		return defaultSettings();
	}
}

async function saveSettings(settings: SpiderSettings): Promise<void> {
	await mkdir(dirname(SETTINGS_FILE), { recursive: true });
	const tempFile = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		await rename(tempFile, SETTINGS_FILE);
	} catch (error) {
		await rm(tempFile, { force: true }).catch(() => undefined);
		throw error;
	}
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function spiderRequest(
	method: "GET" | "POST",
	path: string,
	body: unknown,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const apiKey = getApiKey();
	const response = await fetch(`${state.apiUrl}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
	});

	const responseText = await response.text();
	const payload = parseResponseBody(responseText);

	if (!response.ok) {
		throw new Error(
			`Spider ${method} ${path} returned ${response.status} ${response.statusText}: ` +
				formatPayload(payload),
		);
	}

	return payload;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function parseResponseBody(text: string): unknown {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function formatPayload(payload: unknown): string {
	if (typeof payload === "string") return payload;
	try {
		return JSON.stringify(payload);
	} catch {
		return String(payload);
	}
}

/** Drop undefined values so we only send parameters the caller set. */
function cleanObject<T extends Record<string, unknown>>(input: T): Partial<T> {
	const output: Partial<T> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value !== undefined) output[key as keyof T] = value as T[keyof T];
	}
	return output;
}

/** Cap the number of results we process/return so we don't flood the model or UI. */
const MAX_RESULTS = 10;

interface SpiderResultMeta {
	total?: number;
	shown?: number;
	capped: boolean;
}

interface SpiderDetails {
	payload: unknown;
	meta: SpiderResultMeta;
}

/** Find the primary results array in a Spider payload (root array or `.content`). */
function resultList(payload: unknown): unknown[] | undefined {
	if (Array.isArray(payload)) return payload;
	if (payload && typeof payload === "object") {
		const content = (payload as Record<string, unknown>).content;
		if (Array.isArray(content)) return content;
	}
	return undefined;
}

/** Cap the primary results array to MAX_RESULTS, preserving the payload's shape. */
function capPayload(payload: unknown): SpiderDetails {
	if (Array.isArray(payload)) {
		const total = payload.length;
		const capped = total > MAX_RESULTS;
		return {
			payload: capped ? payload.slice(0, MAX_RESULTS) : payload,
			meta: { total, shown: Math.min(total, MAX_RESULTS), capped },
		};
	}
	if (payload && typeof payload === "object") {
		const record = payload as Record<string, unknown>;
		if (Array.isArray(record.content)) {
			const total = record.content.length;
			const capped = total > MAX_RESULTS;
			return {
				payload: capped ? { ...record, content: record.content.slice(0, MAX_RESULTS) } : payload,
				meta: { total, shown: Math.min(total, MAX_RESULTS), capped },
			};
		}
	}
	return { payload, meta: { capped: false } };
}

/** Build a tool result: cap the payload, JSON-encode for the model, keep details for rendering. */
function spiderResult(payload: unknown) {
	const details = capPayload(payload);
	let text = JSON.stringify(details.payload, null, 2);
	if (details.meta.capped) {
		text += `\n\n[pi-spider-tools: processed first ${details.meta.shown} of ${details.meta.total} results]`;
	}
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

/** One-line summary of a single result item (search hit, link, crawled page, …). */
function itemSummary(item: unknown): string {
	if (typeof item === "string") return item;
	if (item && typeof item === "object") {
		const o = item as Record<string, unknown>;
		const title = typeof o.title === "string" ? o.title.trim() : "";
		const url = typeof o.url === "string" ? o.url.trim() : "";
		if (title && url) return `${title} — ${url}`;
		return url || title || JSON.stringify(o).slice(0, 100);
	}
	return String(item);
}

/**
 * Compact result renderer shared by every core tool: a one-line summary by default,
 * a short list (or trimmed JSON) when the row is expanded — instead of dumping raw JSON.
 */
function renderSpiderResult(
	result: AgentToolResult<unknown>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
): Component {
	if (isPartial) return new Text(theme.fg("warning", "…"), 0, 0);

	const details = result.details as SpiderDetails | undefined;
	const list = details ? resultList(details.payload) : undefined;

	let text: string;
	if (list) {
		const total = details?.meta.total ?? list.length;
		text = theme.fg("success", `${list.length} result${list.length === 1 ? "" : "s"}`);
		if (details?.meta.capped) text += theme.fg("warning", ` (of ${total})`);
	} else {
		text = theme.fg("success", "done");
	}

	if (expanded) {
		if (list) {
			for (const item of list.slice(0, MAX_RESULTS)) {
				text += `\n${theme.fg("dim", itemSummary(item))}`;
			}
		} else {
			const content = result.content[0];
			if (content?.type === "text") {
				const lines = content.text.split("\n");
				for (const line of lines.slice(0, 15)) text += `\n${theme.fg("dim", line)}`;
				if (lines.length > 15) {
					text += `\n${theme.fg("muted", "… (expand the row or read the full result)")}`;
				}
			}
		}
	}

	return new Text(text, 0, 0);
}

/** Show a footer status while a tool runs, then clear it. */
async function withStatus<T>(
	ctx: ExtensionContext,
	label: string,
	fn: () => Promise<T>,
): Promise<T> {
	ctx.ui.setStatus("spider", label);
	try {
		return await fn();
	} finally {
		ctx.ui.setStatus("spider", undefined);
	}
}

// ---------------------------------------------------------------------------
// Shared parameter fragments
// ---------------------------------------------------------------------------

const ReturnFormat = Type.Optional(
	Type.String({
		description:
			"Output format: markdown, raw (HTML), text, commonmark, html2text, bytes, or xml. " +
			"Defaults to the Spider API default.",
	}),
);

const RequestMode = Type.Optional(
	Type.String({
		description:
			"Request engine: 'http' (fast, no JS), 'chrome' (headless browser), or 'smart' " +
			"(http with chrome fallback).",
	}),
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const scrapeTool = defineTool({
	name: "spider_scrape",
	label: "Spider: Scrape",
	description:
		"Scrape a single URL via Spider Cloud and return its content in the requested format. " +
		"Faster and cheaper than crawling when you only need one page.",
	promptSnippet: "Scrape one URL through Spider Cloud",
	promptGuidelines: [
		"Use spider_scrape for a single page; use spider_crawl to follow links across a site.",
		"If SPIDER_API_KEY is missing, report the configuration error instead of retrying.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "The URL to scrape." }),
		return_format: ReturnFormat,
		request: RequestMode,
		readability: Type.Optional(
			Type.Boolean({ description: "Apply readability to extract the main article content." }),
		),
		root_selector: Type.Optional(
			Type.String({ description: "CSS selector to limit extraction to a page region." }),
		),
		proxy_enabled: Type.Optional(
			Type.Boolean({ description: "Route the request through Spider's premium proxies." }),
		),
		cache: Type.Optional(
			Type.Boolean({ description: "Allow Spider to serve a cached response when available." }),
		),
		metadata: Type.Optional(
			Type.Boolean({ description: "Include extracted page metadata in the response." }),
		),
	}),
	renderResult: renderSpiderResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 spider scrape", async () => {
			const payload = await spiderRequest("POST", "/scrape", cleanObject(params), signal);
			return spiderResult(payload);
		});
	},
});

const crawlTool = defineTool({
	name: "spider_crawl",
	label: "Spider: Crawl",
	description:
		"Crawl a website starting from a URL, following links up to a limit/depth, and return " +
		"content from every page reached.",
	promptSnippet: "Crawl a website through Spider Cloud",
	promptGuidelines: [
		"Always set a sensible 'limit' to control cost; crawling bills per page fetched.",
		"If SPIDER_API_KEY is missing, report the configuration error instead of retrying.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "The starting URL to crawl." }),
		limit: Type.Optional(
			Type.Number({ description: "Maximum number of pages to fetch. Strongly recommended." }),
		),
		depth: Type.Optional(
			Type.Number({ description: "Maximum link depth to follow from the starting URL." }),
		),
		return_format: ReturnFormat,
		request: RequestMode,
		readability: Type.Optional(
			Type.Boolean({ description: "Apply readability to extract main content per page." }),
		),
		proxy_enabled: Type.Optional(
			Type.Boolean({ description: "Route requests through Spider's premium proxies." }),
		),
		cache: Type.Optional(
			Type.Boolean({ description: "Allow Spider to serve cached responses when available." }),
		),
		budget: Type.Optional(
			Type.Record(Type.String(), Type.Number(), {
				description: 'Per-path crawl budget, e.g. { "*": 10, "/blog": 5 }.',
			}),
		),
	}),
	renderResult: renderSpiderResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 spider crawl", async () => {
			const payload = await spiderRequest("POST", "/crawl", cleanObject(params), signal);
			return spiderResult(payload);
		});
	},
});

const searchTool = defineTool({
	name: "spider_search",
	label: "Spider: Search",
	description:
		"Search the web via Spider Cloud and optionally fetch the content of each result page.",
	promptSnippet: "Search the web through Spider Cloud",
	promptGuidelines: [
		"Set fetch_page_content only when you actually need page bodies; it costs more.",
		"If SPIDER_API_KEY is missing, report the configuration error instead of retrying.",
	],
	parameters: Type.Object({
		search: Type.String({ description: "The search query." }),
		num: Type.Optional(Type.Number({ description: "Number of search results to return." })),
		fetch_page_content: Type.Optional(
			Type.Boolean({ description: "Crawl each result and include its content." }),
		),
		return_format: ReturnFormat,
		country: Type.Optional(
			Type.String({ description: "Two-letter country code to localize results, e.g. 'us'." }),
		),
		language: Type.Optional(
			Type.String({ description: "Two-letter language code for results, e.g. 'en'." }),
		),
	}),
	renderResult: renderSpiderResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 spider search", async () => {
			const payload = await spiderRequest("POST", "/search", cleanObject(params), signal);
			return spiderResult(payload);
		});
	},
});

const linksTool = defineTool({
	name: "spider_links",
	label: "Spider: Links",
	description: "Collect links from a page or site without returning page content.",
	promptSnippet: "Collect links from a site through Spider Cloud",
	promptGuidelines: [
		"Use spider_links for URL discovery; it is cheaper than a full crawl.",
		"If SPIDER_API_KEY is missing, report the configuration error instead of retrying.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "The URL to collect links from." }),
		limit: Type.Optional(Type.Number({ description: "Maximum number of links to return." })),
		depth: Type.Optional(Type.Number({ description: "Maximum link depth to traverse." })),
		external_domains: Type.Optional(
			Type.Boolean({ description: "Include links pointing to external domains." }),
		),
		request: RequestMode,
	}),
	renderResult: renderSpiderResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 spider links", async () => {
			const payload = await spiderRequest("POST", "/links", cleanObject(params), signal);
			return spiderResult(payload);
		});
	},
});

const screenshotTool = defineTool({
	name: "spider_screenshot",
	label: "Spider: Screenshot",
	description: "Capture a screenshot of a page. Returns a base64-encoded PNG in the response.",
	promptSnippet: "Screenshot a page through Spider Cloud",
	promptGuidelines: [
		"The screenshot is returned as base64 PNG data in the JSON payload.",
		"If SPIDER_API_KEY is missing, report the configuration error instead of retrying.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "The URL to screenshot." }),
		full_page: Type.Optional(
			Type.Boolean({ description: "Capture the full scrollable page instead of the viewport." }),
		),
		request: RequestMode,
	}),
	renderResult: renderSpiderResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 spider screenshot", async () => {
			const payload = await spiderRequest("POST", "/screenshot", cleanObject(params), signal);
			return spiderResult(payload);
		});
	},
});

const unblockerTool = defineTool({
	name: "spider_unblocker",
	label: "Spider: Unblocker",
	description:
		"Fetch content from sites protected by anti-bot systems using Spider's stealth unblocker.",
	promptSnippet: "Bypass anti-bot protection through Spider Cloud",
	promptGuidelines: [
		"Use spider_unblocker only when a normal scrape is blocked; it costs more.",
		"If SPIDER_API_KEY is missing, report the configuration error instead of retrying.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "The URL to fetch through the unblocker." }),
		return_format: ReturnFormat,
		proxy_enabled: Type.Optional(
			Type.Boolean({ description: "Route through Spider's premium proxies." }),
		),
	}),
	renderResult: renderSpiderResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 spider unblocker", async () => {
			const payload = await spiderRequest("POST", "/unblocker", cleanObject(params), signal);
			return spiderResult(payload);
		});
	},
});

const transformTool = defineTool({
	name: "spider_transform",
	label: "Spider: Transform",
	description:
		"Convert raw HTML you already have into clean markdown or text. Performs no web request, " +
		"so it does not consume crawl credits.",
	promptSnippet: "Transform HTML to markdown/text through Spider Cloud",
	promptGuidelines: [
		"Use spider_transform when you already hold HTML and just need it cleaned up.",
		"If SPIDER_API_KEY is missing, report the configuration error instead of retrying.",
	],
	parameters: Type.Object({
		data: Type.Array(
			Type.Object({
				html: Type.String({ description: "Raw HTML content to transform." }),
				url: Type.Optional(
					Type.String({ description: "Optional source URL used to resolve relative links." }),
				),
			}),
			{ description: "One or more HTML documents to transform." },
		),
		return_format: ReturnFormat,
		readability: Type.Optional(
			Type.Boolean({ description: "Apply readability before converting." }),
		),
	}),
	renderResult: renderSpiderResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 spider transform", async () => {
			const payload = await spiderRequest("POST", "/transform", cleanObject(params), signal);
			return spiderResult(payload);
		});
	},
});

const getCreditsTool = defineTool({
	name: "spider_get_credits",
	label: "Spider: Credits",
	description: "Check the remaining Spider Cloud credit balance for the configured API key.",
	promptSnippet: "Check Spider Cloud credit balance",
	promptGuidelines: [
		"Use spider_get_credits to confirm the key works and check the balance; it is free.",
		"If SPIDER_API_KEY is missing, report the configuration error instead of retrying.",
	],
	parameters: Type.Object({}),
	renderResult: renderSpiderResult,
	async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 spider credits", async () => {
			const payload = await spiderRequest("GET", "/data/credits", undefined, signal);
			return spiderResult(payload);
		});
	},
});

const SPIDER_TOOLS = [
	scrapeTool,
	crawlTool,
	searchTool,
	linksTool,
	screenshotTool,
	unblockerTool,
	transformTool,
	getCreditsTool,
] as const;

// ---------------------------------------------------------------------------
// Active-tool reconciliation
// ---------------------------------------------------------------------------

/**
 * Apply the saved tool selection: keep every non-Spider tool as-is, and enable
 * only the Spider tools the user has chosen.
 */
function applyToolSelection(pi: ExtensionAPI, enabled: SpiderToolName[]): void {
	const current = pi.getActiveTools();
	const enabledSet = new Set<string>(enabled);
	const preserved = current.filter((name) => !isSpiderToolName(name));
	pi.setActiveTools([...preserved, ...enabled.filter((name) => enabledSet.has(name))]);
}

function currentlyEnabledSpiderTools(pi: ExtensionAPI): SpiderToolName[] {
	return pi.getActiveTools().filter(isSpiderToolName);
}

// ---------------------------------------------------------------------------
// /spider command
// ---------------------------------------------------------------------------

type CommandAction = "menu" | "help" | "status" | "tools" | "enable" | "disable" | "unknown";

const COMMAND_ACTIONS: { value: string; description: string }[] = [
	{ value: "help", description: "Show pi-spider-tools help" },
	{ value: "status", description: "Show API key status and enabled tools" },
	{ value: "tools", description: "Toggle which Spider tools are active" },
	{ value: "enable", description: "Enable all Spider tools" },
	{ value: "disable", description: "Disable all Spider tools" },
];

function parseCommand(args: string): CommandAction {
	const command = args.trim().toLowerCase();
	if (!command) return "menu";
	if (command === "help") return "help";
	if (command === "status") return "status";
	if (command === "tools" || command === "select" || command === "toggle") return "tools";
	if (command === "enable" || command === "on") return "enable";
	if (command === "disable" || command === "off") return "disable";
	return "unknown";
}

const HELP_TEXT = [
	"pi-spider-tools — Spider Cloud scraping & crawling for Pi.",
	"",
	"Provide SPIDER_API_KEY inline: SPIDER_API_KEY=sk-... pi",
	"(or load it from a gitignored .env via direnv). Get a key at https://spider.cloud/api-keys.",
	"Optionally set SPIDER_API_URL to override the API base URL.",
	"",
	"Tools: spider_scrape, spider_crawl, spider_search, spider_links,",
	"spider_screenshot, spider_unblocker, spider_transform, spider_get_credits.",
	"",
	"Commands: /spider status | tools | enable | disable | help",
].join("\n");

async function reportStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const enabled = currentlyEnabledSpiderTools(pi);
	const keyState = hasApiKey() ? "set" : "MISSING";
	const lines = [
		`SPIDER_API_KEY: ${keyState}`,
		`API URL: ${state.apiUrl}`,
		`Enabled tools (${enabled.length}/${SPIDER_TOOL_NAMES.length}): ${
			enabled.length ? enabled.join(", ") : "none"
		}`,
	];
	ctx.ui.notify(lines.join("\n"), hasApiKey() ? "info" : "warning");
}

async function toggleTools(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"Tool selection needs interactive mode. Use /spider enable or disable.",
			"warning",
		);
		return;
	}
	const enabled = new Set<SpiderToolName>(currentlyEnabledSpiderTools(pi));
	for (;;) {
		const options = [
			...SPIDER_TOOL_NAMES.map((name) => `${enabled.has(name) ? "✓" : " "} ${name}`),
			"Done",
		];
		const choice = await ctx.ui.select("Toggle Spider tools", options);
		if (!choice || choice === "Done") break;
		const name = choice.slice(2) as SpiderToolName;
		if (isSpiderToolName(name)) {
			if (enabled.has(name)) enabled.delete(name);
			else enabled.add(name);
		}
	}
	const selection = SPIDER_TOOL_NAMES.filter((name) => enabled.has(name));
	applyToolSelection(pi, selection);
	await saveSettings({ tools: selection, updatedAt: Date.now() });
	ctx.ui.notify(
		`Spider tools enabled: ${selection.length ? selection.join(", ") : "none"}`,
		"info",
	);
}

async function setAllTools(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	enable: boolean,
): Promise<void> {
	const selection = enable ? [...SPIDER_TOOL_NAMES] : [];
	applyToolSelection(pi, selection);
	await saveSettings({ tools: selection, updatedAt: Date.now() });
	ctx.ui.notify(`All Spider tools ${enable ? "enabled" : "disabled"}.`, "info");
}

async function handleSpiderCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	let action = parseCommand(args);

	if (action === "menu") {
		if (!ctx.hasUI) {
			ctx.ui.notify(HELP_TEXT, "info");
			return;
		}
		const choice = await ctx.ui.select(
			"pi-spider-tools",
			COMMAND_ACTIONS.map((a) => `${a.value} — ${a.description}`),
		);
		if (!choice) return;
		action = parseCommand(choice.split(" ")[0] ?? "");
	}

	switch (action) {
		case "help":
			ctx.ui.notify(HELP_TEXT, "info");
			return;
		case "status":
			await reportStatus(pi, ctx);
			return;
		case "tools":
			await toggleTools(pi, ctx);
			return;
		case "enable":
			await setAllTools(pi, ctx, true);
			return;
		case "disable":
			await setAllTools(pi, ctx, false);
			return;
		default:
			ctx.ui.notify(`Unknown /spider command. ${HELP_TEXT}`, "warning");
	}
}

function commandCompletions(prefix: string) {
	const lower = prefix.trim().toLowerCase();
	return COMMAND_ACTIONS.filter((action) => action.value.startsWith(lower)).map((action) => ({
		value: action.value,
		label: action.value,
		description: action.description,
	}));
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function spiderExtension(pi: ExtensionAPI): void {
	for (const tool of SPIDER_TOOLS) {
		pi.registerTool(tool);
	}

	pi.registerCommand("spider", {
		description: "Spider Cloud tools: status, enable/disable, and help",
		getArgumentCompletions: (prefix) => commandCompletions(prefix),
		handler: async (args, ctx) => {
			await handleSpiderCommand(pi, args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const settings = await loadSettings().catch(() => defaultSettings());
		applyToolSelection(pi, settings.tools);
		if (!hasApiKey()) {
			ctx.ui.notify(
				"pi-spider-tools: SPIDER_API_KEY is not set. Run pi inline with " +
					"SPIDER_API_KEY=sk-... pi ... (or load it from a gitignored .env via direnv). " +
					"https://spider.cloud/api-keys",
				"warning",
			);
		}
	});
}
