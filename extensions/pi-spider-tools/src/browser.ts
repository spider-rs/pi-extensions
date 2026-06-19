/**
 * pi-spider-tools — browser tier
 *
 * Stateful remote-browser automation backed by the `spider-browser` package,
 * which connects to Spider's pre-warmed browser fleet over WebSocket. Mirrors
 * the Browser tool surface of spider-cloud-mcp-v2.
 *
 * Sessions are held in-process: spider_browser_open returns a session_id that
 * the other tools take, and spider_browser_close releases it. Open sessions bill
 * until closed, so sessions auto-close after 5 minutes of inactivity and on pi
 * shutdown/reload.
 *
 * Requires SPIDER_API_KEY. Get a key at https://spider.cloud/api-keys.
 */

import { randomUUID } from "node:crypto";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SpiderBrowser } from "spider-browser";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Shared helpers (kept local so this entry file is self-contained)
// ---------------------------------------------------------------------------

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

function jsonResult(payload: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}

async function withStatus<T>(
	ctx: ExtensionContext,
	label: string,
	fn: () => Promise<T>,
): Promise<T> {
	ctx.ui.setStatus("spider-browser", label);
	try {
		return await fn();
	} finally {
		ctx.ui.setStatus("spider-browser", undefined);
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

const SESSION_TIMEOUT_MS = 5 * 60_000;
const MAX_SESSIONS = 5;

type BrowserChoice = "auto" | "chrome" | "firefox";

interface BrowserSession {
	browser: SpiderBrowser;
	browserType: string;
	timer: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, BrowserSession>();

/** Reset a session's inactivity timer; the session auto-closes when it fires. */
function touch(sessionId: string, session: BrowserSession): void {
	clearTimeout(session.timer);
	session.timer = setTimeout(() => {
		void closeSession(sessionId);
	}, SESSION_TIMEOUT_MS);
	session.timer.unref?.();
}

async function openSession(options: {
	browser?: BrowserChoice;
	stealth?: number;
}): Promise<{ session_id: string; browser: string }> {
	if (sessions.size >= MAX_SESSIONS) {
		throw new Error(
			`Maximum ${MAX_SESSIONS} concurrent browser sessions reached. ` +
				"Close one with spider_browser_close before opening another.",
		);
	}
	const apiKey = getApiKey();
	// Allow pointing at a non-default browser fleet (e.g. a local spider-cloud
	// backend) via SPIDER_BROWSER_URL; otherwise spider-browser uses its default
	// wss://browser.spider.cloud.
	const serverUrl = process.env.SPIDER_BROWSER_URL?.trim() || undefined;
	const browser = new SpiderBrowser({
		apiKey,
		browser: options.browser ?? "auto",
		stealth: options.stealth,
		...(serverUrl ? { serverUrl } : {}),
	});
	await browser.init();
	const sessionId = randomUUID();
	const session: BrowserSession = {
		browser,
		browserType: browser.browser,
		timer: setTimeout(() => {
			void closeSession(sessionId);
		}, SESSION_TIMEOUT_MS),
	};
	session.timer.unref?.();
	sessions.set(sessionId, session);
	return { session_id: sessionId, browser: browser.browser };
}

/** Look up a live session and refresh its timer, or throw a helpful error. */
function getSession(sessionId: string): BrowserSession {
	const session = sessions.get(sessionId);
	if (!session) {
		throw new Error(
			`No active browser session '${sessionId}'. Open one with spider_browser_open. ` +
				"Sessions expire after 5 minutes of inactivity.",
		);
	}
	touch(sessionId, session);
	return session;
}

async function closeSession(sessionId: string): Promise<number> {
	const session = sessions.get(sessionId);
	if (session) {
		clearTimeout(session.timer);
		sessions.delete(sessionId);
		await session.browser.close().catch(() => undefined);
	}
	return sessions.size;
}

async function closeAllSessions(): Promise<number> {
	const ids = [...sessions.keys()];
	for (const id of ids) {
		await closeSession(id);
	}
	return ids.length;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const BROWSER_TOOL_NAMES = [
	"spider_browser_open",
	"spider_browser_navigate",
	"spider_browser_click",
	"spider_browser_fill",
	"spider_browser_screenshot",
	"spider_browser_content",
	"spider_browser_evaluate",
	"spider_browser_wait_for",
	"spider_browser_close",
] as const;

const MISSING_KEY_GUIDELINE =
	"If SPIDER_API_KEY is missing, report the configuration error instead of retrying.";

const openTool = defineTool({
	name: "spider_browser_open",
	label: "Spider Browser: Open",
	description:
		"Open a remote browser session on Spider's fleet and return a session_id. Pass that " +
		"session_id to the other spider_browser_* tools, and close it with spider_browser_close " +
		"when done (open sessions bill until closed).",
	promptSnippet: "Open a remote Spider browser session",
	promptGuidelines: [
		"Always call spider_browser_close when finished; sessions cost credits while open.",
		`At most ${MAX_SESSIONS} sessions can be open at once. ${MISSING_KEY_GUIDELINE}`,
	],
	parameters: Type.Object({
		browser: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("chrome"), Type.Literal("firefox")], {
				description: "Browser to use. Defaults to 'auto' (server picks).",
			}),
		),
		stealth: Type.Optional(
			Type.Number({ description: "Stealth/proxy tier 1-3. 0 or omitted means auto-escalate." }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 browser open", async () => {
			const result = await openSession(params);
			return jsonResult(result);
		});
	},
});

const navigateTool = defineTool({
	name: "spider_browser_navigate",
	label: "Spider Browser: Navigate",
	description: "Navigate an open browser session to a URL and wait for it to load.",
	promptSnippet: "Navigate a Spider browser session to a URL",
	promptGuidelines: [MISSING_KEY_GUIDELINE],
	parameters: Type.Object({
		session_id: Type.String({ description: "Session id from spider_browser_open." }),
		url: Type.String({ description: "The URL to navigate to." }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 browser navigate", async () => {
			const { browser } = getSession(params.session_id);
			await browser.goto(params.url);
			const page = browser.page;
			return jsonResult({ url: await page.url(), title: await page.title() });
		});
	},
});

const clickTool = defineTool({
	name: "spider_browser_click",
	label: "Spider Browser: Click",
	description: "Click an element matching a CSS selector in an open browser session.",
	promptSnippet: "Click an element in a Spider browser session",
	promptGuidelines: [MISSING_KEY_GUIDELINE],
	parameters: Type.Object({
		session_id: Type.String({ description: "Session id from spider_browser_open." }),
		selector: Type.String({ description: "CSS selector of the element to click." }),
		timeout: Type.Optional(
			Type.Number({ description: "Max ms to wait for the selector. Default 10000." }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 browser click", async () => {
			const { browser } = getSession(params.session_id);
			const page = browser.page;
			await page.waitForSelector(params.selector, params.timeout ?? 10_000);
			await page.click(params.selector);
			await sleep(500);
			return jsonResult({ clicked: params.selector, url: await page.url() });
		});
	},
});

const fillTool = defineTool({
	name: "spider_browser_fill",
	label: "Spider Browser: Fill",
	description: "Fill a form field matching a CSS selector with text in an open browser session.",
	promptSnippet: "Fill a form field in a Spider browser session",
	promptGuidelines: [MISSING_KEY_GUIDELINE],
	parameters: Type.Object({
		session_id: Type.String({ description: "Session id from spider_browser_open." }),
		selector: Type.String({ description: "CSS selector of the input to fill." }),
		value: Type.String({ description: "Text to type into the field." }),
		timeout: Type.Optional(
			Type.Number({ description: "Max ms to wait for the selector. Default 10000." }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 browser fill", async () => {
			const { browser } = getSession(params.session_id);
			const page = browser.page;
			await page.waitForSelector(params.selector, params.timeout ?? 10_000);
			await page.fill(params.selector, params.value);
			return jsonResult({ filled: params.selector, valueLength: params.value.length });
		});
	},
});

const screenshotTool = defineTool({
	name: "spider_browser_screenshot",
	label: "Spider Browser: Screenshot",
	description: "Capture a screenshot of the current page in an open browser session.",
	promptSnippet: "Screenshot the current page in a Spider browser session",
	promptGuidelines: [MISSING_KEY_GUIDELINE],
	parameters: Type.Object({
		session_id: Type.String({ description: "Session id from spider_browser_open." }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 browser screenshot", async () => {
			const { browser } = getSession(params.session_id);
			const data = await browser.page.screenshot();
			return {
				content: [{ type: "image" as const, data, mimeType: "image/png" }],
				details: { bytes: data.length },
			};
		});
	},
});

const contentTool = defineTool({
	name: "spider_browser_content",
	label: "Spider Browser: Content",
	description: "Get the current page's HTML or visible text from an open browser session.",
	promptSnippet: "Read the current page content in a Spider browser session",
	promptGuidelines: [MISSING_KEY_GUIDELINE],
	parameters: Type.Object({
		session_id: Type.String({ description: "Session id from spider_browser_open." }),
		format: Type.Optional(
			Type.Union([Type.Literal("html"), Type.Literal("text")], {
				description: "Return raw HTML or visible text. Default 'html'.",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 browser content", async () => {
			const { browser } = getSession(params.session_id);
			const page = browser.page;
			const content =
				params.format === "text"
					? String(await page.evaluate("document.body.innerText"))
					: await page.content();
			return jsonResult({
				url: await page.url(),
				title: await page.title(),
				content,
				length: content.length,
			});
		});
	},
});

const evaluateTool = defineTool({
	name: "spider_browser_evaluate",
	label: "Spider Browser: Evaluate",
	description:
		"Execute JavaScript in the page context of an open browser session and return its result.",
	promptSnippet: "Run JavaScript in a Spider browser session",
	promptGuidelines: [MISSING_KEY_GUIDELINE],
	parameters: Type.Object({
		session_id: Type.String({ description: "Session id from spider_browser_open." }),
		expression: Type.String({ description: "JavaScript expression to evaluate in the page." }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 browser evaluate", async () => {
			const { browser } = getSession(params.session_id);
			const result = await browser.page.evaluate(params.expression);
			return jsonResult({ result });
		});
	},
});

const waitForTool = defineTool({
	name: "spider_browser_wait_for",
	label: "Spider Browser: Wait For",
	description:
		"Wait for a selector to appear, for navigation to settle, or for network idle in an open " +
		"browser session.",
	promptSnippet: "Wait for a condition in a Spider browser session",
	promptGuidelines: [
		"Provide 'selector' to wait for an element, set 'navigation' to wait for a load, or " +
			`neither to wait for network idle. ${MISSING_KEY_GUIDELINE}`,
	],
	parameters: Type.Object({
		session_id: Type.String({ description: "Session id from spider_browser_open." }),
		selector: Type.Optional(Type.String({ description: "CSS selector to wait for." })),
		navigation: Type.Optional(
			Type.Boolean({ description: "Wait for navigation/page load instead of a selector." }),
		),
		timeout: Type.Optional(Type.Number({ description: "Max ms to wait. Default 30000." })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 browser wait", async () => {
			const { browser } = getSession(params.session_id);
			const page = browser.page;
			const timeout = params.timeout ?? 30_000;
			let waited: string;
			if (params.selector) {
				await page.waitForSelector(params.selector, timeout);
				waited = `selector ${params.selector}`;
			} else if (params.navigation) {
				await page.waitForNavigation(timeout);
				waited = "navigation";
			} else {
				await page.waitForNetworkIdle(timeout);
				waited = "network idle";
			}
			return jsonResult({ waitedFor: waited, url: await page.url() });
		});
	},
});

const closeTool = defineTool({
	name: "spider_browser_close",
	label: "Spider Browser: Close",
	description:
		"Close a browser session and stop its billing. Returns the number of sessions still open.",
	promptSnippet: "Close a Spider browser session",
	promptGuidelines: ["Always close sessions when done to stop billing."],
	parameters: Type.Object({
		session_id: Type.String({ description: "Session id from spider_browser_open." }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return withStatus(ctx, "🕷 browser close", async () => {
			const remaining = await closeSession(params.session_id);
			return jsonResult({ closed: params.session_id, remaining });
		});
	},
});

const BROWSER_TOOLS = [
	openTool,
	navigateTool,
	clickTool,
	fillTool,
	screenshotTool,
	contentTool,
	evaluateTool,
	waitForTool,
	closeTool,
] as const;

// ---------------------------------------------------------------------------
// /spider-browser command
// ---------------------------------------------------------------------------

const COMMAND_ACTIONS: { value: string; description: string }[] = [
	{ value: "status", description: "Show API key status and open browser sessions" },
	{ value: "close", description: "Close all open browser sessions" },
	{ value: "help", description: "Show pi-spider-tools browser help" },
];

const HELP_TEXT = [
	"pi-spider-tools (browser tier) — remote browser automation via Spider's fleet.",
	"",
	"Provide SPIDER_API_KEY inline: SPIDER_API_KEY=sk-... pi",
	"(or load it from a gitignored .env via direnv). https://spider.cloud/api-keys",
	"",
	"Tools: spider_browser_open, navigate, click, fill, screenshot, content,",
	"evaluate, wait_for, close.",
	"",
	`Sessions auto-close after 5 minutes idle; at most ${MAX_SESSIONS} can be open at once.`,
	"Commands: /spider-browser status | close | help",
].join("\n");

async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	let action = args.trim().toLowerCase();
	if (!action && ctx.hasUI) {
		const choice = await ctx.ui.select(
			"pi-spider-tools browser",
			COMMAND_ACTIONS.map((a) => `${a.value} — ${a.description}`),
		);
		if (!choice) return;
		action = choice.split(" ")[0] ?? "";
	}

	switch (action) {
		case "":
		case "help":
			ctx.ui.notify(HELP_TEXT, "info");
			return;
		case "status":
			ctx.ui.notify(
				[
					`SPIDER_API_KEY: ${hasApiKey() ? "set" : "MISSING"}`,
					`Open sessions: ${sessions.size}/${MAX_SESSIONS}`,
				].join("\n"),
				hasApiKey() ? "info" : "warning",
			);
			return;
		case "close": {
			const closed = await closeAllSessions();
			ctx.ui.notify(`Closed ${closed} browser session(s).`, "info");
			return;
		}
		default:
			ctx.ui.notify(`Unknown /spider-browser command. ${HELP_TEXT}`, "warning");
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

export default function spiderBrowserExtension(pi: ExtensionAPI): void {
	for (const tool of BROWSER_TOOLS) {
		pi.registerTool(tool);
	}

	pi.registerCommand("spider-browser", {
		description: "Spider browser sessions: status, close all, and help",
		getArgumentCompletions: (prefix) => commandCompletions(prefix),
		handler: async (args, ctx) => {
			await handleCommand(args, ctx);
		},
	});

	// Close any open browser sessions when pi shuts down or reloads, so we never
	// leak a billing session.
	pi.on("session_shutdown", async () => {
		await closeAllSessions();
	});
}

export { BROWSER_TOOL_NAMES };
