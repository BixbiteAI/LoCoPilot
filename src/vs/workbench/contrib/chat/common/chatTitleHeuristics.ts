/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Rule-based (non-LLM) chat session title generation.
 *
 * The LLM-based titler (see `provideChatTitle` in chatSetupProviders.ts) costs a full extra
 * round-trip to the local model on the very first turn of every session - it occupies the single
 * server slot, warms nothing useful, and burns prompt + output tokens purely for a label. This
 * module derives an equivalent short label from the user's first message with regex/keyword rules,
 * at zero token cost.
 *
 * It is also the error fallback: if the LLM titler is re-enabled and it fails, times out, or
 * returns nothing usable, callers fall back to `generateHeuristicChatTitle`.
 *
 * Output is UPPERCASE, of the shape `INTENT: SUBJECT` (e.g. `FIX: LOGIN TOKEN REFRESH`) or just
 * `INTENT` when the message carries no meaningful subject (e.g. a bare greeting).
 */

/** Hard cap on the produced title. Tabs/lists elide well past this. */
const MAX_TITLE_LENGTH = 56;

/** How many subject words we keep after the intent label. */
const MAX_SUBJECT_WORDS = 5;

/** Title used when there is nothing at all to work with. */
export const DEFAULT_CHAT_TITLE = 'NEW CHAT';

/**
 * Intent buckets, matched in order - the FIRST match wins, so more specific intents must come
 * before more generic ones (e.g. DEBUG before QUESTION, since "why does X crash" is a debug ask).
 * `strip` removes the matched lead-in from the subject so the label isn't repeated in the subject.
 */
interface IIntentRule {
	readonly label: string;
	readonly match: RegExp;
	/** When true the intent stands alone and the subject is dropped (greetings, thanks, ...). */
	readonly subjectless?: boolean;
}

const INTENT_RULES: readonly IIntentRule[] = [
	// --- Social / non-task -----------------------------------------------------------------
	{
		label: 'GREETING',
		match: /^\s*(hi|hii+|hey+|hello+|yo|sup|howdy|namaste|hola|greetings|good\s+(morning|afternoon|evening|day))\b/i,
		subjectless: true
	},
	{
		label: 'THANKS',
		match: /^\s*(thanks?|thank\s+you|thx|ty|appreciate\s+it|nice\s+work|great\s+job|awesome|perfect)\b\s*[!.]*\s*$/i,
		subjectless: true
	},
	{
		label: 'CAPABILITIES',
		match: /\b(who\s+are\s+you|what\s+can\s+you\s+do|what\s+are\s+you|introduce\s+yourself|your\s+capabilities)\b/i,
		subjectless: true
	},

	// --- Diagnosis first: "why is X broken" is a debug ask, not a plain question -------------
	{
		label: 'FIX',
		match: /\b(fix|repair|resolve|patch|unbreak|correct)\b/i
	},
	{
		label: 'DEBUG',
		match: /\b(debug|bug|crash(es|ed|ing)?|error|exception|traceback|stack\s*trace|stacktrace|fail(s|ed|ing|ure)?|broken|not\s+working|doesn'?t\s+work|isn'?t\s+working|regression|hang(s|ing)?|freeze|frozen|leak|oom|out\s+of\s+memory|panic|segfault|timeout|throws?)\b/i
	},

	// --- Concrete engineering asks ----------------------------------------------------------
	{
		label: 'TEST',
		match: /\b(unit\s+tests?|integration\s+tests?|write\s+tests?|add\s+tests?|test\s+coverage|testcase|test\s+case|spec\s+for|mocha|jest|pytest)\b/i
	},
	{
		label: 'REVIEW',
		match: /\b(review|audit|critique|code\s+smell|feedback\s+on|sanity\s+check|look\s+over)\b/i
	},
	{
		label: 'REFACTOR',
		match: /\b(refactor|clean\s*up|cleanup|restructure|reorganize|simplify|extract|dedupe|de-?duplicate|rewrite|tidy)\b/i
	},
	{
		label: 'OPTIMIZE',
		match: /\b(optimi[sz]e|speed\s+up|faster|performance|perf|latency|memory\s+usage|reduce\s+(size|cost|tokens?)|benchmark|profil(e|ing))\b/i
	},
	{
		label: 'SECURITY',
		match: /\b(security|vulnerabilit(y|ies)|cve|exploit|sanitiz(e|ation)|xss|sql\s*injection|csrf|auth\s+bypass|secrets?\s+leak)\b/i
	},
	{
		label: 'MIGRATE',
		match: /\b(migrat(e|ion)|upgrade|port\s+to|convert\s+to|translate\s+to|switch\s+to|move\s+from)\b/i
	},
	// DOCS before SETUP: "update the README with install instructions" is a docs task even though
	// it mentions "install".
	{
		label: 'DOCS',
		match: /\b(document|documentation|docs|readme|changelog|comment\s+(this|the)|jsdoc|docstring|write\s+up)\b/i
	},
	{
		label: 'SETUP',
		match: /\b(install|set\s*up|setup|configure|config|bootstrap|scaffold|initiali[sz]e|deploy|ci\/cd|pipeline|docker|env\s+var)\b/i
	},
	{
		label: 'REMOVE',
		match: /\b(remove|delete|drop|revert|undo|roll\s*back|get\s+rid\s+of|disable|comment\s+out)\b/i
	},
	{
		label: 'BUILD',
		match: /\b(implement|create|build|add|generate|make|write|develop|introduce|support\s+for|new\s+(feature|component|endpoint|page|screen|api))\b/i
	},
	{
		label: 'UPDATE',
		match: /\b(update|change|modify|edit|adjust|tweak|rename|replace|replace\s+with|set\s+the|enhance|improve|extend)\b/i
	},
	{
		label: 'SEARCH',
		match: /\b(find|search|where\s+is|where\s+are|locate|look\s+for|which\s+file|grep|list\s+all|show\s+me\s+all)\b/i
	},
	{
		label: 'EXPLAIN',
		match: /\b(explain|what\s+(is|are|does|do)|how\s+(do|does|can|would|to)|why\s+(is|are|does|do)|walk\s+me\s+through|understand|difference\s+between|tell\s+me\s+about|summari[sz]e|describe)\b/i
	},
	{
		label: 'QUESTION',
		match: /^\s*(can|could|should|would|is|are|do|does|did|will|has|have|which|who|when|where|what|why|how)\b/i
	},
];

/** Verb-ish lead-ins and filler that add nothing to a title. */
const STOP_WORDS = new Set([
	'a', 'about', 'above', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as',
	'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
	'can', 'could',
	'did', 'do', 'does', 'doing', 'done', 'down', 'during', 'each', 'few', 'for', 'from', 'further',
	'get', 'give', 'go', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his',
	'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'kindly', 'let', 'like', 'll', 'many',
	'may', 'me', 'might', 'mine', 'more', 'most', 'must', 'my', 'need', 'no', 'nor', 'not', 'now',
	'of', 'off', 'on', 'once', 'one', 'only', 'or', 'other', 'ought', 'our', 'ours', 'out', 'over',
	'own', 'per', 'please', 'pls', 'put', 'really', 'same', 'shall', 'she', 'should', 'so', 'some',
	'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they',
	'this', 'those', 'through', 'to', 'too', 'try', 'under', 'until', 'up', 'us', 'use', 'using',
	've', 'very', 'want', 'was', 'we', 'were', 'what', 'when', 'where', 'whether', 'which', 'while',
	'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours',
	// intent verbs themselves - already captured by the label
	'add', 'adjust', 'build', 'change', 'check', 'convert', 'create', 'debug', 'delete', 'edit',
	'enhance', 'explain', 'find', 'fix', 'generate', 'implement', 'improve', 'install', 'make',
	'migrate', 'modify', 'move', 'optimize', 'optimise', 'refactor', 'remove', 'rename', 'replace',
	'review', 'rewrite', 'search', 'set', 'setup', 'show', 'simplify', 'summarize', 'summarise',
	'support', 'test', 'tests', 'tell', 'understand', 'update', 'upgrade', 'walk', 'write',
]);

/**
 * Strip everything that would make a noisy title: fenced code, inline code, images/links,
 * chat attachment references, markdown emphasis, urls and raw punctuation runs.
 */
function normalizeMessage(message: string): string {
	let text = message;
	text = text.replace(/```[\s\S]*?```/g, ' ');             // fenced code blocks
	text = text.replace(/~~~[\s\S]*?~~~/g, ' ');             // alternative fences
	text = text.replace(/`([^`]*)`/g, ' $1 ');               // inline code -> keep the identifier
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');       // images
	text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, ' $1 ');   // links -> keep the label
	text = text.replace(/<[^>\s][^>]*>/g, ' ');              // html/xml-ish tags
	text = text.replace(/https?:\/\/\S+/gi, ' ');            // urls
	text = text.replace(/#(file|selection|sym|codebase|folder|terminal):\S*/gi, ' '); // chat refs
	text = text.replace(/[*_~>#]+/g, ' ');                   // markdown emphasis / quoting
	text = text.replace(/\s+/g, ' ');
	return text.trim();
}

/** True for tokens worth keeping in a title (identifiers, file names, domain words). */
function isMeaningfulWord(word: string): boolean {
	if (word.length < 2) {
		return false;
	}
	if (STOP_WORDS.has(word.toLowerCase())) {
		return false;
	}
	// Keep anything with a letter or digit; drop pure punctuation/emoji runs.
	return /[a-z0-9]/i.test(word);
}

/**
 * Pull the most title-worthy words out of the message. File names and code identifiers are
 * preferred, since they are what actually distinguishes one session from another.
 */
function extractSubject(text: string): string {
	// Only look at the first sentence/line - the rest is usually elaboration.
	const firstSentence = text.split(/(?<=[.!?])\s+|\n/)[0] || text;

	const rawTokens = firstSentence.split(/[\s,;:()[\]{}"'`]+/).filter(Boolean);
	const words: string[] = [];
	const seen = new Set<string>();

	// Pass 1: file names / paths / dotted or camelCase identifiers carry the most signal.
	for (const token of rawTokens) {
		const cleaned = token.replace(/^[^\w./\\-]+|[^\w./\\-]+$/g, '');
		if (!cleaned) {
			continue;
		}
		const looksLikeIdentifier = /\.[a-z]{1,5}$/i.test(cleaned) || /[a-z][A-Z]/.test(cleaned) || /[_/\\]/.test(cleaned);
		if (looksLikeIdentifier && isMeaningfulWord(cleaned)) {
			// For a path keep only the last segment so titles stay short.
			const short = cleaned.split(/[/\\]/).filter(Boolean).pop() || cleaned;
			const key = short.toLowerCase();
			if (!seen.has(key)) {
				seen.add(key);
				words.push(short);
			}
		}
	}

	// Pass 2: remaining content words, in the order the user wrote them.
	for (const token of rawTokens) {
		if (words.length >= MAX_SUBJECT_WORDS) {
			break;
		}
		const cleaned = token.replace(/^[^\w./\\-]+|[^\w./\\-]+$/g, '');
		if (!cleaned || !isMeaningfulWord(cleaned)) {
			continue;
		}
		// Paths were already reduced to their last segment in pass 1 - key on that same short form
		// so "src/utils/parser.ts" doesn't get added again next to "parser.ts".
		const short = cleaned.split(/[/\\]/).filter(Boolean).pop() || cleaned;
		const key = short.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		words.push(short);
	}

	return words.slice(0, MAX_SUBJECT_WORDS).join(' ');
}

function truncate(title: string): string {
	if (title.length <= MAX_TITLE_LENGTH) {
		return title;
	}
	// Cut on a word boundary where possible so we don't end mid-identifier.
	const clipped = title.substring(0, MAX_TITLE_LENGTH);
	const lastSpace = clipped.lastIndexOf(' ');
	return (lastSpace > MAX_TITLE_LENGTH * 0.6 ? clipped.substring(0, lastSpace) : clipped).trim();
}

/**
 * Classify a message into one of the {@link INTENT_RULES} buckets.
 * Exported for tests and for anyone wanting the bucket without the formatted title.
 */
export function classifyChatIntent(message: string): { label: string; subjectless: boolean } {
	const text = normalizeMessage(message);
	if (!text) {
		return { label: DEFAULT_CHAT_TITLE, subjectless: true };
	}
	for (const rule of INTENT_RULES) {
		if (rule.match.test(text)) {
			return { label: rule.label, subjectless: !!rule.subjectless };
		}
	}
	return { label: 'CHAT', subjectless: false };
}

/**
 * Build an UPPERCASE session title from the user's first message using rules only - no model call.
 *
 * Examples:
 *   "hi there"                              -> "GREETING"
 *   "fix the login token refresh bug"       -> "FIX: LOGIN TOKEN REFRESH BUG"
 *   "can you explain how chatModel.ts works"-> "EXPLAIN: CHATMODEL.TS WORKS"
 *   "add a dark theme to the settings page" -> "BUILD: DARK THEME SETTINGS PAGE"
 */
export function generateHeuristicChatTitle(message: string | undefined | null): string {
	if (!message || typeof message !== 'string') {
		return DEFAULT_CHAT_TITLE;
	}

	const text = normalizeMessage(message);
	if (!text) {
		return DEFAULT_CHAT_TITLE;
	}

	const { label, subjectless } = classifyChatIntent(text);
	if (subjectless) {
		return truncate(label.toUpperCase());
	}

	const subject = extractSubject(text);
	if (!subject) {
		// No content words left (e.g. "please do it") - fall back to the raw first line so the
		// session is still recognizable rather than a wall of identical intent labels.
		const firstLine = text.split('\n')[0].trim();
		return truncate((firstLine || label).toUpperCase());
	}

	return truncate(`${label}: ${subject}`.toUpperCase());
}
