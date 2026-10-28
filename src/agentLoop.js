import { createHash } from 'crypto';
import { execFileSync } from 'node:child_process';
import { processApprovalScope, createApprovalScope } from './approvalGrants.js';
import { pruneSessions as pruneEmbodimentSessions, describeSession } from './embodimentSession.js';
import { WorkspacePerception } from './perception.js';
import { audioFormatForMimeType } from './providers/base.js';
import { TaskBuffer } from './taskBuffer.js';
import { TOOL_DEFINITIONS, getDynamicTools, resolveTool, canonicalToolName } from './tools/registry.js';
import { selfRepairToolCall, generateSelfRepairDiagnostic } from './tools/toolSelfRepair.js';
import { Sandbox } from './sandbox.js';
import { auditLog } from './auditLog.js';
import { hasMatchingHook, runConfiguredHooks } from './hooks.js';
import { loadConfig } from './config.js';
import { isDevEmulator } from './devMode.js';
import { TokenTracker } from './tokenTracker.js';
import { getMemoryContextString } from './memory.js';
import { MemoryManager } from './memoryManager.js';
import { cortexDb } from './cortex/vectorDb.js';
import { buildStructuralSummary, condenseAndSave } from './cortex/autoCondenser.js';
import { analyzeTask, buildTaskBrief, packsFromShape } from './taskShape.js';
import { lookupPlan, recordPlan, recordPlanAsync, recordMiss, renderPlanHint, toStep, recordAPCPipelineLatency, lookupAlternativeStep, failureClass } from './planCache.js';
import { routedConfig } from './modelRouter.js';
import { assessStep, isThrashing } from './uncertainty.js';
import { assessDecisionRequirement, isMutatingToolCall, requiresImplementationPlan } from './decisionPolicy.js';
import { requiresToolApproval, withToolAutonomyMode } from './approvalPolicy.js';
import { AGENT_USER_POLICY } from './agentPolicy.js';
import { VFETracker } from './vfeTracker.js';
import { coldObserver } from './observer/coldObserver.js';
import { TimeMachine, recoveryUserMessage } from './timeMachine.js';
import { routePacks, packForTool, isCoreTool, isGameIntent, isWebIntent, getPackCatalogue, PACK_PLAYBOOKS, PACKS } from './toolPacks.js';
import { determineToolScope, filterSuppressedPacks, resolveLazyPlaybooks, SmartToolsGovernor } from './smartToolsUse.js';
import { resolveCharPool, measureMessages, resultCapFor, decayToolResults, buildWindow, compactInPlace, describeDroppedMessages, sanitizeSequences, applyProgressiveCompaction, snipOversizedToolOutputs } from './contextManager.js';
// Provider imports
import { detectWorkspaceDomains, ensureSkillRepo, getSkillDomainHeader } from './skillsManager.js';
import { spillToolResult, buildSpillNotice, buildDecayPointer, pruneOutputStore } from './outputStore.js';
import { beginTask as beginCheckpointTask, captureBeforeMutation, pruneStore as pruneCheckpointStore, resolveProjectRoot } from './checkpoints.js';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { analyzeFiles, formatFindings, isScannableFile } from './slopDetector.js';
import { suggestMovements, formatMovementBrief } from './designPalettes.js';
import { createProvider } from './providers/factory.js';
import { resolveMentionedContext } from './promptMentions.js';
import { isLaunchOnlyPrompt, launchScopeError } from './launchIntent.js';
import { StreamingCodePreview, NativeCodeObserver, codeProgressFromAction } from './tui/codeProgress.js';
import { StallGuardController } from './stallGuard.js';
import { buildRecoverableDroppedSummary, pruneStaleToolObservations, shortenOversizedToolObservations } from './historyPruner.js';
import { UnifiedBudgetEnforcer, EfficiencyCheckpoint, actionLimitFor, noncachedTokens } from './providers/budgetEnforcer.js';
export function isActionableTaskPrompt(text) {
    const t = (text || '').trim();
    if (!t)
        return false;
    const pureGreeting = /^(hi|hello|hey|yo|good\s+(morning|afternoon|evening))[.!?, ]*$/i.test(t);
    if (pureGreeting)
        return false;
    const actionKeywords = /\b(create|build|make|write|code|implement|fix|optimize|refactor|generate|add|setup|install|run|open|launch|start|play|serve|preview|deploy|delete|remove|update|change|test|review|inspect|search|find|download)\b/i;
    return actionKeywords.test(t);
}
export function isGenericHandoffResponse(text) {
    const answer = (text || '').trim();
    if (!answer || answer.length > 500)
        return false;
    const lower = answer.toLowerCase();
    const handoff = /\b(let me know what you would like to do next|what would you like me to do next|how (can|may) i help|what can i help you with|feel free to (ask|tell me))\b/i.test(lower);
    const verifiedOutcome = /\b(completed|changed|set the (desktop|wallpaper)|saved|created|installed|verified|downloaded|finished)\b/i.test(lower);
    return handoff && !verifiedOutcome;
}
export function isDesktopWallpaperChangePrompt(text) {
    return /\b(?:change|set|switch|replace)\b[\s\S]{0,100}\b(?:desktop picture|wallpaper|desktop background)\b|\b(?:desktop picture|wallpaper|desktop background)\b[\s\S]{0,100}\b(?:change|set|switch|replace)\b/i.test(text || '');
}
function readMacDesktopPictures() {
    try {
        return execFileSync('osascript', ['-e', 'tell application "System Events" to get picture of every desktop'], {
            encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore']
        }).trim() || null;
    }
    catch {
        return null;
    }
}
export function isExecutionOrLaunchTaskPrompt(text) {
    const t = (text || '').trim();
    if (!t)
        return false;
    return /\b(open|launch|start|run|play|serve|preview)\b/i.test(t)
        && !/\b(create|build|make|write|code|implement|generate|refactor)\b/i.test(t);
}
export function isCodeAuthoringTaskPrompt(text) {
    const t = (text || '').trim();
    if (!t)
        return false;
    if (isExecutionOrLaunchTaskPrompt(t))
        return false;
    return /\b(create|build|make|write|code|implement|generate|game|3js|threejs|three\.js|app)\b/i.test(t);
}
export function isDirectGameTask(text) {
    return /\b(three\.?js|3js|webgl|canvas|html5|pygame)\b/i.test(text)
        && !/\b(godot|unity|unreal|full engine)\b/i.test(text);
}
/**
 * Detects when an agent response is an intermediate mid-task progress note or
 * transition announcement (e.g. "Real assets verified. Writing the Tesla-style
 * redesign now." or "Let me look at the newer assets... Pulling their real
 * stills and confirming embeddability.") rather than a finished answer.
 */
export function isMidTaskProgressText(text) {
    if (!text || typeof text !== 'string')
        return false;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 480)
        return false;
    const lower = trimmed.toLowerCase();
    if (lower.includes('?') ||
        lower.includes('let me know') ||
        lower.includes('how can i help') ||
        lower.includes('how may i help') ||
        lower.includes('how can i assist') ||
        lower.includes('what would you like') ||
        lower.includes('what can i help') ||
        lower.includes('feel free to')) {
        return false;
    }
    if (trimmed.includes('```'))
        return false;
    const sentences = trimmed
        .split(/(?:(?<=[.!])\s+|\n+)/)
        .map(s => s.trim())
        .filter(Boolean);
    const lastSentence = (sentences[sentences.length - 1] || trimmed).trim();
    const lastLower = lastSentence.toLowerCase();
    if (trimmed.length <= 280 && (trimmed.endsWith(':') || trimmed.endsWith('...') || trimmed.endsWith('…'))) {
        return true;
    }
    const intentPrefixes = [
        'let me ',
        "i'll ",
        'i will ',
        'now i ',
        'now let me ',
        "now i'll ",
        'now i will ',
        'next, i ',
        'next i ',
        "next, i'll ",
        "next i'll ",
        'first, i ',
        'first i ',
        'let us ',
        "let's ",
        'i shall ',
        'we will ',
        "we'll ",
        'i am going to ',
        "i'm going to ",
        'going to '
    ];
    if (intentPrefixes.some(prefix => lastLower.startsWith(prefix) || lower.startsWith(prefix))) {
        if (!/\b(?:task completed|all done|everything is ready|finished|complete\.)\b/i.test(lastSentence)) {
            return true;
        }
    }
    const gerundStart = /^(?:now\s+|next,?\s+|currently\s+|still\s+)?(?:writing|pulling|checking|inspecting|building|creating|updating|applying|implementing|generating|fetching|downloading|testing|running|fixing|setting up|configuring|refactoring|adding|modifying|replacing|launching|starting|verifying|confirming|reading|searching|analyzing|preparing|compiling|rendering|extracting|installing|opening|switching|retrying|continuing)\b/i;
    if (gerundStart.test(lastSentence) && lastSentence.length <= 220) {
        return true;
    }
    const actionNowSuffix = /\b(?:writing|pulling|checking|inspecting|building|creating|updating|applying|implementing|generating|fetching|downloading|testing|running|fixing|configuring|refactoring|adding|modifying|replacing|launching|starting|verifying|confirming|reading|searching|analyzing|preparing|compiling|rendering|extracting)\b[^.!?\n]{1,120}\b(?:now|next)\.?$/i;
    if (actionNowSuffix.test(lastSentence)) {
        return true;
    }
    return false;
}
const SYSTEM_PROMPT = `You are Causyne Agent, an autonomous local AI agent. Your capabilities are the tools actually available in this session. Never invent a capability or claim an action occurred without evidence.

# Your Capabilities
Use only tools actually present and permitted in this session. Read each tool result before reporting an outcome. A user message that only asks a question or greets you may be answered directly without calling a tool.

${AGENT_USER_POLICY}

# Project Conventions
Follow the selected project's existing style and architecture. Check dependencies and tool schemas before use. Preserve unrelated behavior.

# Operational Guidelines & Communication
- **Language Reflection**: Dynamically reflect and match the exact language used by the user in their prompt. Respond naturally in that same language without mentioning language policies.
- **Ruthless Conciseness**: Answer concisely with fewer than 4 lines unless detail is requested. No preambles ("Okay, I will now...") or postambles ("I have finished..."). One-word answers are best for simple questions.
- **Evidence-Based Recovery Reports**: State only observed tool results and checks. Never claim a failed task was fixed without a passing check. Keep failure reports brief; if the user requests a detailed report, write it to a Markdown file in their selected workspace and give its path instead of dumping it into chat.
- **Status Updates**: For substantial work, give brief progress notes while using tools. Use a tool when it contributes to the task, and report what it actually returned.
- **Clarify Only When Needed**: Make routine implementation choices yourself. Ask when an unresolved choice or missing user-only input genuinely blocks progress; continue independent work while waiting.
- **No Chitchat**: Tools are for actions, text output is *only* for communication. Do not add explanatory comments within tool calls or code blocks.
- **File Paths**: ALWAYS output the absolute path of any file you create, modify, or generate so the user knows exactly where it is.

# Task Management & Planning
- Use update_plan to create a visible implementation checklist before complex implementation. Create atomic, verb-led, verifiable steps and keep exactly one step in progress.
- Check off completed TODOs immediately before reporting progress. Do not batch up multiple task completions.
- Reconcile and close the todo list when all goal tasks are done. If the user asks you to implement, do not output a separate text-based plan. Just build and display the todo list.

# Durable Decisions
- Use request_decision when multiple materially different architecture, product, data, security, or workflow directions are valid. Give 2-4 concrete options with consequences; the UI adds a custom-answer choice.
- A decision is separate from permission. Do not ask for routine implementation details that can be resolved from the repository. Even in Mode C, pause for an unresolved durable architecture decision before changing the system.

# Efficient Tool Use
- Batch independent searches and reads when useful. Keep edits, dependent operations, approvals, and verification in a safe order. Never run conflicting writes concurrently.

# Context Understanding & Searching
- Semantic search (or grep) is your MAIN exploration tool. Start with a broad, high-level query. 
- MANDATORY: Run multiple searches with different wording in parallel; first-pass results often miss key details. 
- Keep searching new areas until you're CONFIDENT nothing important remains. Bias towards not asking the user for help if you can find the answer yourself.

# Making Code Changes & Execution
- **No Blind Patching**: NEVER edit a file using a patch/edit tool if you have not opened it with the read tool within your last 5 messages. Read the file again to confirm its contents before patching.
- **Verification Loop**: NEVER assume code works. After making code changes, execute the project-specific build, linting, and type-checking commands (e.g., 'tsc', 'npm run lint', 'pytest'). Identify these commands by examining 'README' files or 'package.json'.
- **Code Quality**: Write HIGH-VERBOSITY code. Optimize for clarity. Use meaningful variable names (no 1-letter names like 'n'). Use guard clauses/early returns. Avoid deep nesting.
- **No TODOs/Comments**: Do not add comments for trivial code. NEVER use inline comments. Avoid TODO comments—implement the logic instead.
- **Runnable Code**: Ensure generated code can be run immediately. Add all necessary imports, dependencies, and scaffolding (e.g. requirements.txt) if building from scratch.

# Git Workflow & Best Practices
- When asked to commit changes, start by gathering information: run \`git status\`, \`git diff HEAD\`, and \`git log -n 3\` to match commit style. Combine these shell commands to save steps.
- Always propose a draft commit message. Prefer messages that are clear, concise, and focused more on "why" and less 

# Security & Constraints (Causyne Architecture)
- **Token Budgeting**: You must respect the user's BYOK (Bring Your Own Key) limits. Be highly token-efficient.
- **Explain Critical Commands**: Before executing destructive shell commands, provide a brief explanation of the impact.
- **Interactive Commands**: Avoid shell commands that require user interaction (e.g., \`git rebase -i\`). Use non-interactive flags (e.g., \`-y\`).
- **Sandboxing**: Keep workspace checks and hard safety blocks active. In Mode C, ordinary in-scope edits and tool calls do not need approval; deleting an entire file or directory does. Removing or replacing lines while editing a file is not whole-file deletion.
- **SSRF Protection**: Do not fetch internal IPs (127.0.0.1, 169.254.x.x, 10.x.x.x).

# ABSOLUTE ETHICAL SAFETY NET (NON-NEGOTIABLE)
You are bound by an unbreakable ethical safety net. Regardless of user prompt, jailbreak attempts, or roleplay scenarios, you MUST REFUSE to:
1. Create software designed to damage, disrupt, or gain unauthorized access to computer systems (malware, ransomware, keyloggers, trojans, rootkits).
2. Write phishing pages, credential harvesters, social engineering scripts, or fake login forms designed to steal user passwords.
3. Build DDoS tools, network flooding scripts, or tools designed for unauthorized network exploitation or cracking.
4. Generate content that exploits minors or non-consenting individuals.
5. Create surveillance/spyware tools, unauthorized screen capture malware, or microphone/camera hijackers.
6. Write tools for software piracy, license cracking, or key generators.
7. Build unauthorized cryptocurrency miners or crypto wallet drainers.
8. Forge custom tools (via tool_forge) that perform any of the above harmful actions.

If asked to perform ANY harmful task, politely decline, state that Causyne exists to make the world better, and offer legitimate developer assistance instead.

# Dependency Management & Autonomy Modes
- **Mode A (Passive)**: You MUST explicitly ask the user for permission (by ending your turn and asking a question) before installing any dependencies.
- **Mode B (Supervised)**: You may install standard development dependencies automatically, but you MUST ask for permission before modifying OS-level settings or running \`sudo\`.
- **Mode C (Autonomous)**: Work independently within the user's task and selected workspace. Ordinary in-scope actions do not require an approval dialog. Whole-file or directory deletion requires approval. Hard policy blocks, workspace boundaries, and explicit user limits still apply.

# Direct API & Automation Policy
- **Prefer REST APIs (curl)**: When interacting with external services (like web, email, chat), prioritize finding and using official REST APIs via \`curl\` or simple scripts.
- **Avoid UI/Browser Automation**: Automating a browser (e.g., Puppeteer/Playwright) is noisy, expensive, and fragile. ONLY use browser automation if a site genuinely has no API. Reading JSON is always better than reading DOM.

# Universal Tool Calling & Registry Discipline
1. **Strict Registry Adherence**: Use ONLY the tools declared in the catalogue. Invoke tools using exact parameter names specified in the schema. Do not invent or rename parameters.
2. **Valid JSON Formatting**: All tool call arguments must be valid JSON objects. Never include raw unescaped newlines or trailing commas inside argument strings.
3. **Automated Buffer & Self-Correction**: Causyne runs a Universal Tool Buffer with self-repair capabilities. If a tool returns a \`selfRepairGuidance\` result indicating missing or invalid parameters, immediately read the \`expectedParameters\` and re-invoke the tool with the corrected arguments.

# Completion
Answer directly when no tool is needed. For action tasks, continue until the authorized work is done or a real blocker is evidenced; then report the verified outcome or blocker concisely.
`;
function getProviderSpecificPrompt(provider = '') {
    const p = provider.toLowerCase();
    if (p === 'anthropic') {
        return `ANTHROPIC BRAIN ACTIVATION:
You are Claude — a model with exceptional analytical depth and nuanced reasoning. Leverage your strengths:
- Use <thinking> tags for complex multi-step reasoning before acting.
- You excel at understanding subtle context and edge cases. Apply this to architecture decisions.
- Your creativity is rooted in deep understanding, not randomness. When designing UIs, draw from your vast knowledge of design history, typography, and color theory.
- Self-critique: Before finalizing any creative output, internally evaluate "Does this look like generic AI output?" If yes, redesign.
- Ensure all tool calls strictly match the schema without omitting required fields. Avoid conversational filler completely.`;
    }
    if (p === 'openai') {
        return `OPENAI BRAIN ACTIVATION:
You are GPT — a model with exceptional parallel reasoning and creative synthesis. Leverage your strengths:
- Execute maximum parallel tool calls. You can read 5 files, search 3 patterns, and write 2 files simultaneously.
- Your training includes vast exposure to award-winning web design. Channel this: think of specific real-world sites you've seen (Stripe, Linear, Vercel, Apple) and synthesize NEW aesthetics from them.
- When generating creative work, push beyond the first idea. Your strength is in synthesis — combine unexpected influences.`;
    }
    if (p === 'deepseek') {
        return `DEEPSEEK BRAIN ACTIVATION:
You are DeepSeek — a model with outstanding code generation and mathematical reasoning. Leverage your strengths:
- Pay close attention to raw JSON formatting. Avoid escaping quotes unnecessarily.
- Your code output is exceptionally clean and well-structured. Use this for building pixel-perfect CSS layouts.
- For creative tasks: your training data includes massive open-source design repositories. Access this knowledge — don't default to generic patterns.
- Self-verify: After generating UI code, mentally render it. Does it look unique? If not, iterate.`;
    }
    if (p === 'qwen') {
        return `QWEN BRAIN ACTIVATION:
You are Qwen — a model with exceptional multilingual capability and creative breadth. Leverage your strengths:
- Pay close attention to raw JSON formatting. Avoid escaping quotes unnecessarily.
- Your training includes diverse cultural design traditions (Eastern minimalism, European modernism, etc.). Draw from this diversity.
- For web tasks: vary your design approach. Don't repeat the same layout structure across projects.`;
    }
    if (p === 'muse' || p === 'meta') {
        return `MUSE BRAIN ACTIVATION:
You are Muse Spark — a model built for long-horizon coding and multi-step agentic work, with a 1,048,576-token context window. Leverage your strengths:
- You are tuned for tool loops that run for many steps. Do not stop early to summarise progress; keep acting until the task is actually finished.
- Your context is enormous. Read the surrounding files before you edit — you can afford to understand the whole module, and guessing is a choice, not a constraint.
- You emit fewer tokens than earlier versions for the same work. Spend that budget on correctness, not on narration.
- You can see: images, video frames, and PDFs all reach you. After building any UI, screenshot it and look at what you actually produced.
- For creative work: your training spans design history far beyond the templates. A layout that looks like every other AI-generated page is a failure, not a default.`;
    }
    if (p === 'gemini') {
        return `GEMINI BRAIN ACTIVATION:
You are Gemini — a multimodal model with strong visual-spatial reasoning. Leverage your strengths:
- You can reason about visual layouts spatially. Use this when designing page compositions.
- Your training includes vast visual data. When building UIs, think in terms of visual hierarchy, whitespace rhythm, and typographic scale.
- After building a web page, use the screenshot tool to visually verify your work. You can see — use this advantage.`;
    }
    if (p === 'ollama') {
        return `LOCAL MODEL ACTIVATION:
You are running locally — respect the user's hardware constraints. Be token-efficient but don't sacrifice quality.
- Focus on clean, minimal implementations that work on first try.
- For creative work: simplicity can be beautiful. Japanese minimalism, Swiss design — these are aesthetically powerful AND computationally light.`;
    }
    if (p === 'xai' || p === 'grok') {
        return `GROK BRAIN ACTIVATION:
You are Grok — a model highly optimized for speed and parallel tool execution.
- Prioritize direct, functional solutions over verbose explanations.
- Execute maximum parallel tool calls when searching or refactoring code.
- Your personality is unapologetic and highly technical. Focus purely on the most efficient code path.`;
    }
    if (p === 'moonshot' || p === 'kimi') {
        return `KIMI BRAIN ACTIVATION:
You are Kimi — a model powered by KDA (Kimi Delta Attention) with a massive context window.
- Leverage your massive memory to reason holistically about the entire codebase structure before making surgical edits.
- You excel at end-to-end programming and agentic task decomposition.
- When reading large files, synthesize the global context. Do not lose track of the big picture.`;
    }
    return "";
}
/**
 * The system message carrying an invoked skill — or null when none is active.
 *
 * A pure function, and deliberately exported: this is the single link that was
 * missing. `/skills <id>` printed the file to the terminal and returned, so the
 * body never entered a request and no API call was made at all. Building it
 * here rather than inline in run() means it can be tested for what it actually
 * produces, instead of by reading the source and hoping.
 *
 * Returned as an ARRAY so the caller spreads it, which keeps the systemMessages
 * literal readable.
 */
export function skillSystemMessage(skill) {
    if (!skill || typeof skill.content !== 'string' || !skill.content.trim())
        return null;
    return [{
            role: 'system',
            content: `THE USER HAS INVOKED A SKILL: ${skill.id}\n\n`
                + 'Follow this procedure for the current task. It is a working method, not a document to '
                + 'summarise back — carry out its steps, and treat each "Done when:" line as the condition '
                + 'that must actually hold before moving on. Where it conflicts with your general approach, '
                + 'the skill wins; where it conflicts with your safety rules or the workspace boundaries, '
                + 'those win and you say so.\n\n'
                + '--- BEGIN SKILL ---\n'
                + skill.content
                + '\n--- END SKILL ---',
            // Stable for the whole task, so it anchors the cache rather than
            // invalidating the cached prefix on every step.
            cacheAnchor: true
        }];
}
export function explainNetworkError(error, config = {}) {
    const cause = error && error.cause;
    const code = (cause && (cause.code || cause.errno)) || '';
    let host = '';
    try {
        const raw = config.baseUrl && String(config.baseUrl).trim();
        if (raw)
            host = new URL(raw).host;
    }
    catch (e) { /* a malformed base URL is itself worth reporting, below */ }
    const REASONS = {
        ENOTFOUND: 'the host could not be resolved (DNS)',
        EAI_AGAIN: 'DNS lookup failed — the network may be down or captive',
        ECONNREFUSED: 'nothing accepted the connection on that host and port',
        ECONNRESET: 'the connection was reset before a reply arrived',
        ETIMEDOUT: 'the connection timed out',
        UND_ERR_CONNECT_TIMEOUT: 'the connection timed out',
        UND_ERR_HEADERS_TIMEOUT: 'the server accepted the connection but never replied',
        EHOSTUNREACH: 'that host is unreachable from this network',
        ENETUNREACH: 'this machine has no route to the network',
        EPIPE: 'the connection closed mid-request',
        CERT_HAS_EXPIRED: 'the TLS certificate has expired',
        DEPTH_ZERO_SELF_SIGNED_CERT: 'the TLS certificate is self-signed — a proxy may be intercepting',
        UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the TLS certificate could not be verified — a proxy may be intercepting',
        SELF_SIGNED_CERT_IN_CHAIN: 'a self-signed certificate is in the chain — a proxy may be intercepting'
    };
    const reason = REASONS[code] || (code ? `the connection failed (${code})` : 'the connection failed');
    const where = host ? ` reaching ${host}` : '';
    const provider = config.provider ? ` via ${config.provider}` : '';
    const checks = [];
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENETUNREACH') {
        checks.push('confirm this machine is online');
        if (host)
            checks.push(`confirm ${host} is the endpoint you meant — /config changes it`);
    }
    else if (code === 'ECONNREFUSED') {
        checks.push(host
            ? `confirm something is listening on ${host}`
            : 'confirm your local model server is running');
    }
    else if (String(code).startsWith('CERT') || String(code).includes('SELF_SIGNED')) {
        checks.push('a corporate proxy is likely intercepting TLS — the CA needs to be trusted');
    }
    else {
        checks.push('retry in a moment; if it persists, check the network and the configured endpoint');
    }
    return `Could not reach the model${provider}${where}: ${reason}.\n`
        + checks.map((check) => `  - ${check}`).join('\n');
}
// classifyError() returns this for every connection-level failure. Assembled
// the same way the classifier does, so the two can never drift apart.
const NETWORK_ERROR_TYPE = "network_error";
export class AgentLoop {
    /**
     * How many times in a row the same class of failure may repeat before the
     * loop gives up.
     *
     * Three is enough to ride out a blip and few enough that a genuinely broken
     * endpoint is reported in seconds rather than after the whole step budget.
     */
    static MAX_CONSECUTIVE_FAILURES = 3;
    constructor(eventSink, taskId, userPrompt, options = {}) {
        this.eventSink = eventSink;
        this.taskId = taskId;
        this.userPrompt = userPrompt;
        this.workspaceRoot = typeof options.workspaceRoot === 'string' && options.workspaceRoot
            ? options.workspaceRoot
            : process.cwd();
        this.autonomyOverride = null;
        this.approvalScope = options.approvalScope && typeof options.approvalScope.isAlwaysAllowed === 'function'
            ? options.approvalScope
            : processApprovalScope;
        this.config = loadConfig();
        this.sandbox = new Sandbox();
        // Retire spilled tool outputs past their retention window. Fire-and-forget
        // at task start rather than on a timer: nothing may run in the background
        // (rule ZM-01), and a task boundary is often enough for a 7-day window.
        try {
            pruneOutputStore();
        }
        catch (e) { /* never block a task on housekeeping */ }
        try {
            pruneCheckpointStore();
        }
        catch (e) { /* never block a task on housekeeping */ }
        try {
            pruneEmbodimentSessions();
        }
        catch (e) { /* never block a task on housekeeping */ }
        // Set by the caller when the user invokes a skill by name. Its body becomes
        // a system message for the task; see systemMessages [4].
        this.activeSkill = null;
        // Consecutive same-class failures, for the retry ceiling below.
        this.consecutiveFailures = 0;
        this.lastFailureType = null;
        this.perception = new WorkspacePerception();
        this.taskBuffer = new TaskBuffer();
        this.tokenTracker = new TokenTracker();
        this.llm = this.initializeProvider();
        this.memoryManager = new MemoryManager(this.workspaceRoot, options.memorySessionId || null);
        this.messages = this.memoryManager.loadHistory(); // Persistent context window
        this.stepsCompleted = 0;
        this.consecutiveCommands = 0;
        this.circuitBreakerUnlocked = false;
        this.stopRequested = false;
        this.pendingApprovals = new Map(); // Maps toolCallId -> resolve function
        this.waitForDecision = async () => null;
        this._decisionAnswers = new Map();
        this._decisionRequirement = { required: false, kind: 'architecture', reason: '' };
        this._decisionResolved = true;
        this._implementationPlan = [];
        this._implementationPlanRequired = false;
        // A delegated subagent can tighten these two ceilings. They are applied
        // after every config refresh so run() cannot accidentally replace a
        // worker's declared bounds with the parent tier defaults.
        this.maxStepsCeiling = null;
        this.taskTokenLimit = null;
        // Limits based on tier/budget & emulator fast bypass
        this.updateTierLimits();
        this.consecutiveThinkingSteps = 0;
        this.consecutiveBlockedActions = 0; // V8 Transcendence: Circuit Breaker
        this.recentActionSignatures = [];
        this.consecutiveReadOnlySteps = 0;
        this.stallGuard = new StallGuardController();
        this.smartToolsGovernor = new SmartToolsGovernor();
        this._smartToolsNudge = null;
        // Sovereign Progressive Disclosure: which capability packs have entered the
        // context window for this task. Nothing is disabled — see src/toolPacks.js.
        this.unlockedPacks = new Set();
        this.unlockedTools = new Set();
        // sha256 of every large tool result seen this task -> the step that produced
        // it. Lets a verbatim repeat collapse to a pointer instead of paying twice.
        this._observationDigests = new Map();
        // Unlock sequence drives append-only tool ordering, which is what keeps the
        // prompt-cache prefix intact when a pack loads mid-task.
        this.unlockOrder = [];
        this.workspaceContext = null;
        this.activeSubproject = null;
        this.taskShape = null;
        // Budget for the billed Tier 2 Cortex condensation pass.
        this._cortexPassesUsed = 0;
        // Per-task memo for context that is constant for the whole task but used to
        // be recomputed on every single step (cortex retrieval, skills index,
        // design detection, workspace domain scan).
        this.staticContext = null;
        this.vfeTracker = new VFETracker();
        this._lessonSimilarity = 0;
        this._paradigmShiftPending = false;
        // Completion guards fire at most once per task. Previously they were gated
        // on consecutiveThinkingSteps, which resets on every tool call, so the
        // agent could be blocked from finishing over and over until it burned the
        // entire 300-step budget on a task that was already done.
        this.gameGuardFired = false;
        this.webGuardFired = false;
        // P6: rendered surfaces this task wrote, for the anti-slop gate to read back.
        this.webArtifacts = new Set();
        this.slopReviewAttempts = 0;
        this.slopLastAuditHash = '';
        this.gameCascadeState = { active: true, currentStage: 1, stageHistory: [], verificationPassed: false };
        this.gameToolStats = { godot_act: 0, game_asset_fetch: 0, game_build_html5: 0, last_godot_action: null };
        this.webVerificationState = { screenshotTaken: false, browserActUsed: false }; // V8 Transcendence: Anti-Slop Guard
        this.abortController = new AbortController();
        // V5: Context compaction tracking
        this._lastCompactionIndex = null;
        this.timeMachine = new TimeMachine();
        this.isInitialized = false;
        this.taskTemperature = 0.1; // Default
        // Set only on a delegated subagent loop; null means "the full catalogue".
        this.toolScope = null;
    }
    /** True when this loop's own conversation scope has a standing approval. */
    isAlwaysAllowed(toolName) {
        return this.approvalScope.isAlwaysAllowed(toolName);
    }
    /**
     * Reset all standing tool approvals, allowlists, and autonomy overrides.
     *
     * Critical security invariant (Claude Code Architecture, p. 24):
     * When a session is forked or reset, permissions and standing approvals
     * must NEVER carry over into the new branch. A forked session starts with
     * fresh, ungranted permissions so that user authorization must be re-verified.
     */
    resetApprovalScope() {
        if (this.approvalScope && typeof this.approvalScope.revokeAllAlways === 'function') {
            this.approvalScope.revokeAllAlways();
        }
        this.approvalScope = createApprovalScope();
        this.autonomyOverride = null;
        this.circuitBreakerUnlocked = false;
        this.pendingApprovals.clear();
    }
    // V6: Adaptive Temperature based on task intent
    determineTemperature(prompt) {
        if (!prompt)
            return 0.1;
        const lower = prompt.toLowerCase();
        // Creative / Open-ended tasks get higher temp
        if (lower.includes("brainstorm") || lower.includes("write a story") || lower.includes("creative") || lower.includes("poem") || lower.includes("novel") || lower.includes("screenplay")) {
            return 0.5;
        }
        // Web Design / UI tasks get creative-code temp (Anti-Slop: warm enough for diversity, cool enough for valid code)
        if (lower.includes("website") || lower.includes("landing page") || lower.includes("web app") || lower.includes("dashboard") || lower.includes("portfolio") || lower.includes("ui design") || lower.includes("homepage") || lower.includes("frontend")) {
            return 0.4;
        }
        // Conversational / Explanatory tasks get medium temp
        if (lower.includes("explain") || lower.includes("how does") || lower.includes("what is") || lower.includes("teach me")) {
            return 0.3;
        }
        // Code / Technical / Precision tasks get low temp
        return 0.1;
    }
    /**
     * Load a capability pack into the context window, recording the sequence.
     *
     * Order matters for cost, not just bookkeeping: tool definitions sit at the
     * front of the cached prefix, so appending is nearly free while reordering
     * invalidates the cache for the tools, the system prompt and every message.
     */
    unlockPack(packName) {
        if (!packName || this.unlockedPacks.has(packName))
            return false;
        this.unlockedPacks.add(packName);
        this.unlockOrder.push(packName);
        return true;
    }
    recordWebArtifact(candidate) {
        if (typeof candidate !== 'string' || !isScannableFile(candidate))
            return;
        const expanded = candidate.startsWith('~/')
            ? path.join(os.homedir(), candidate.slice(2))
            : candidate;
        this.webArtifacts.add(path.resolve(this.workspaceRoot, expanded));
    }
    /**
     * Build the parts of the system context that are constant for a whole task.
     * Called once per task rather than once per step.
     */
    async buildStaticContext() {
        let lessonsLearned = '';
        this._lessonSimilarity = 0;
        if (this.currentTaskPrompt) {
            try {
                const matches = await cortexDb.search(this.currentTaskPrompt, 2);
                if (matches.length > 0) {
                    lessonsLearned = `\n\n🧠 DIGITAL BRAIN (LESSONS LEARNED FROM PAST MISTAKES):\n` + matches.map((m) => `- ${m.text}`).join('\n');
                    this._lessonSimilarity = matches[0].similarity || 0;
                    this.debugLog(`cortex search hit: ${(this._lessonSimilarity * 100).toFixed(0)}% similarity`);
                }
            }
            catch (e) {
                this.debugLog(`cortex retrieval failed: ${e.message}`);
            }
        }
        // Anti-Slop: Design Context Awareness (what design system is already installed)
        let designContext = '';
        try {
            const detectedDesign = await this.perception.detectDesignContext(this.workspaceRoot);
            if (detectedDesign && detectedDesign.length > 0) {
                designContext = `\nDETECTED DESIGN SYSTEM IN WORKSPACE: ${detectedDesign.join(', ')} — USE THIS. Do NOT install a conflicting system.`;
            }
        }
        catch (e) { }
        // Anti-Slop: Creative Pattern Memory (prevents repeating the same design approach)
        let antiRepeatDirective = '';
        if (this.currentTaskPrompt && isWebIntent(this.currentTaskPrompt)) {
            try {
                const recentPatterns = await cortexDb.getRecentCreativePatterns(5);
                if (recentPatterns.length > 0) {
                    antiRepeatDirective = `\n\n🎨 CREATIVE DIVERSITY (DO NOT REPEAT RECENT PATTERNS):\n` +
                        recentPatterns.map((p) => `- ${p}`).join('\n') +
                        `\nChoose a DIFFERENT design approach, color palette, and font combination than the above.`;
                }
            }
            catch (e) { }
        }
        // Universal skills awareness
        let universalSkillsContext = '';
        try {
            const detectedDomains = detectWorkspaceDomains(this.workspaceRoot);
            if (detectedDomains.length > 0) {
                this.debugLog(`detected workspace domains: ${detectedDomains.join(', ')}`);
                for (const domain of detectedDomains) {
                    ensureSkillRepo(domain);
                }
                universalSkillsContext = getSkillDomainHeader(detectedDomains);
            }
        }
        catch (e) {
            this.debugLog(`skill domain detection failed: ${e.message}`);
        }
        // Plan cache lookup. Deterministic and local: no model call, no network.
        // Goes in the per-task STATIC block, which is byte-identical every step and
        // already carries a cache anchor, so a hit costs its own tokens exactly
        // once per task rather than once per step.
        let planHint = '';
        try {
            planHint = renderPlanHint(this._planMatch);
        }
        catch (e) {
            this.debugLog(`plan cache hint skipped: ${e.message}`);
        }
        return { lessonsLearned, designContext, antiRepeatDirective, universalSkillsContext, planHint };
    }
    rearmAbortController() {
        this.abortController = new AbortController();
    }
    abort() {
        this.stopRequested = true;
        if (this.abortController) {
            this.abortController.abort();
        }
        if (this.llm && typeof this.llm.abort === 'function') {
            try {
                this.llm.abort();
            }
            catch {
                // ignore provider abort errors
            }
        }
        else if (this.llm && typeof this.llm.close === 'function') {
            try {
                void this.llm.close();
            }
            catch {
                // ignore provider close errors
            }
        }
        if (this.pendingApprovals && this.pendingApprovals.size > 0) {
            for (const toolCallId of [...this.pendingApprovals.keys()]) {
                this.handleApprovalResponse(toolCallId, false);
            }
        }
    }
    setAutonomyMode(mode) {
        const normalized = String(mode || '').trim().toUpperCase();
        if (!['A', 'B', 'C'].includes(normalized)) {
            throw new Error('autonomy mode must be A, B, or C');
        }
        this.autonomyOverride = normalized;
        this.config.autonomyMode = normalized;
    }
    /**
     * A provider for UTILITY work — condensation, classification, filtering.
     *
     * Same provider, cheaper model. Condensing a dropped transcript is mechanical
     * text work whose output the machine consumes, and paying a flagship rate for
     * it is the clearest waste in the loop: on Anthropic it is $5/$25 against
     * Haiku's $1/$5. Built lazily and cached, because most tasks never compact at
     * all and constructing a second provider they will not use is its own cost.
     *
     * Falls back to the reasoning provider whenever the router declines — an
     * unknown provider, a config override, or a route that would change the
     * training-data posture. Utility work still has to happen.
     *
     * @returns {any}
     */
    utilityProvider() {
        if (this._utilityLlm)
            return this._utilityLlm;
        try {
            const { config, route } = routedConfig(this.config, 'condense');
            if (!route.routed) {
                this._utilityLlm = this.llm;
                this.debugLog(`utility route: ${route.reason}`);
            }
            else {
                this._utilityLlm = createProvider(config);
                this.debugLog(`utility route: ${this.config.model} -> ${route.model}`);
            }
        }
        catch (e) {
            this._utilityLlm = this.llm; // a routing failure must never stop a task
            this.debugLog(`utility route failed, staying on the reasoning model: ${e.message}`);
        }
        return this._utilityLlm;
    }
    initializeProvider() {
        if (!this.config?.provider)
            return null;
        return createProvider(this.config);
    }
    /**
     * Tools that only observe. Nothing here writes to disk, mutates process
     * state, spends money, or can require approval — which is what makes running
     * several of them at once safe and order-independent.
     *
     * Deliberately an allowlist. A denylist would silently start prefetching
     * every tool added in the future, including destructive ones.
     */
    static READ_ONLY_TOOLS = new Set([
        'fs_read', 'fs_list', 'fs_find', 'fs_search',
        'code_search_ast', 'code_list_symbols', 'code_search_ripgrep', 'codebase_search',
        'web_fetch', 'web_search', 'pdf_read', 'fs_read_skill',
        'check_system_specs', 'process_list', 'view_image'
    ]);
    /** How many reads may be in flight at once. */
    static PREFETCH_CONCURRENCY = 6;
    /**
     * Start the read-only calls of one assistant turn concurrently.
     *
     * @returns {Map<string, Promise<object|null>>} keyed by tool_call_id. A entry
     *   resolves to the tool result, or to null when the call was not eligible,
     *   was denied by the sandbox, or threw — in every one of those cases the
     *   serial loop executes it normally and keeps its own error handling.
     */
    prefetchReadOnlyCalls(toolCalls) {
        const prefetched = new Map();
        if (!Array.isArray(toolCalls) || toolCalls.length < 2)
            return prefetched;
        // Mode A promises approval before every tool, including reads. Starting a
        // read here would execute it before the serial approval and hook gates.
        if ((this.config.autonomyMode || 'C') === 'A')
            return prefetched;
        const eligible = [];
        for (const toolCall of toolCalls) {
            const capacity = Math.min(this.smartToolsGovernor?.inspectionCapacity ?? 2, this.efficiencyBudget?.getRemainingActions() ?? 35);
            if (eligible.length >= capacity)
                break;
            const functionName = canonicalToolName(toolCall.function.name);
            if (!AgentLoop.READ_ONLY_TOOLS.has(functionName))
                continue;
            // Prefetch begins before the serial dispatch path. If this tool has a
            // PreToolUse hook, running it here would create a temporal pre-trust
            // window where the read happens before the hook can deny it.
            if (hasMatchingHook(this.config.hooks, 'PreToolUse', functionName))
                continue;
            let args;
            try {
                args = typeof toolCall.function.arguments === 'string'
                    ? JSON.parse(toolCall.function.arguments || '{}')
                    : (toolCall.function.arguments || {});
            }
            catch (e) {
                continue; // malformed arguments are the serial loop's business
            }
            // The same guard the serial path applies, applied before anything runs.
            let validation;
            try {
                validation = this.sandbox.validate(functionName, args);
            }
            catch (e) {
                continue;
            }
            if (!validation || validation.allowed === false || validation.risk !== 'safe')
                continue;
            const tool = resolveTool(functionName);
            if (!tool || typeof tool.execute !== 'function')
                continue;
            eligible.push({ toolCall, functionName, args, tool });
        }
        if (eligible.length < 2)
            return prefetched;
        // A bounded worker pool rather than a bare Promise.all: a model can emit a
        // large batch, and opening fifty file handles or fifty sockets at once
        // would trade one problem for another.
        let cursor = 0;
        const resolvers = new Map();
        for (const item of eligible) {
            prefetched.set(item.toolCall.id, new Promise(resolve => resolvers.set(item.toolCall.id, resolve)));
        }
        const worker = async () => {
            while (cursor < eligible.length) {
                const item = eligible[cursor++];
                const resolve = resolvers.get(item.toolCall.id);
                if (this.stopRequested || this.abortController.signal.aborted) {
                    resolve(null);
                    continue;
                }
                try {
                    resolve(await withToolAutonomyMode(this.config.autonomyMode || 'C', () => item.tool.execute(item.args, {
                        signal: this.abortController.signal,
                        parentLoop: this,
                        ...this.sandbox
                    })));
                }
                catch (e) {
                    resolve(null); // let the serial path fail it, with its own retries
                }
            }
        };
        const lanes = Math.min(AgentLoop.PREFETCH_CONCURRENCY, eligible.length);
        for (let i = 0; i < lanes; i++)
            worker();
        return prefetched;
    }
    emitEvent(messageObj) {
        if (this.eventSink && this.eventSink.readyState === 1) {
            this.eventSink.send(JSON.stringify({ taskId: this.taskId, ...messageObj }));
        }
    }
    // WHAT BELONGS HERE: things the user would want to know even though they did
    // not ask — a file was written on their behalf, a limit was reached. Not
    // internal telemetry. Converting the old console.log calls to notices fixed
    // the display corruption but kept the noise, and three lines of task-shape and
    // tier sizing after every invocation is exactly the clutter neither reference
    // shows. Diagnostics go to debugLog().
    notice(message, tone = 'muted') {
        this.emitEvent({ type: 'notice', tone, message: String(message) });
    }
    /**
     * Diagnostics, off by default.
     *
     * These are for whoever is debugging Causyne, not for the person using it.
     * Printed unconditionally they are both noise and a second uncontrolled writer
     * to a terminal the prompt is repainting. Behind CAUSYNE_DEBUG they cost
     * nothing in a normal session, and stderr keeps them out of a piped stdout.
     */
    debugLog(message) {
        if (process.env.CAUSYNE_DEBUG !== '1')
            return;
        process.stderr.write(`[causyne] ${message}\n`);
    }
    handleApprovalResponse(toolCallId, approved) {
        if (this.pendingApprovals.has(toolCallId)) {
            const resolve = this.pendingApprovals.get(toolCallId);
            resolve(approved);
            this.pendingApprovals.delete(toolCallId);
        }
    }
    updateImplementationPlan(update) {
        this._implementationPlan = update.plan.map((item) => ({ ...item }));
        this.emitEvent({
            type: 'agent_plan',
            explanation: update.explanation || '',
            plan: this._implementationPlan.map((item) => ({ status: item.status, text: item.step, id: item.id }))
        });
        auditLog.log({
            event: 'implementation_plan_updated', taskId: this.taskId,
            steps: this._implementationPlan.length,
            completed: this._implementationPlan.filter((item) => item.status === 'completed').length
        });
    }
    async requestDecision(request) {
        const fingerprint = createHash('sha256')
            .update(JSON.stringify({ kind: request.kind, question: request.question, options: request.options.map((option) => option.id) }))
            .digest('hex');
        const remembered = this._decisionAnswers.get(fingerprint);
        if (remembered)
            return remembered;
        this.emitEvent({ type: 'decision_request', request });
        auditLog.log({ event: 'decision_requested', taskId: this.taskId, kind: request.kind, optionCount: request.options.length });
        const answer = await this.waitForDecision(request);
        if (!answer || typeof answer.label !== 'string' || !answer.label.trim()) {
            this.emitEvent({ type: 'decision_result', request, answer: null });
            return null;
        }
        const normalized = {
            requestId: request.id,
            optionId: typeof answer.optionId === 'string' ? answer.optionId : null,
            label: answer.label.trim(),
            custom: answer.custom === true
        };
        this._decisionAnswers.set(fingerprint, normalized);
        if (request.kind === 'architecture')
            this._decisionResolved = true;
        this.emitEvent({ type: 'decision_result', request, answer: normalized });
        auditLog.log({ event: 'decision_answered', taskId: this.taskId, kind: request.kind, custom: normalized.custom });
        return normalized;
    }
    mutationCheckpoint(functionName, args = {}) {
        if (!isMutatingToolCall(functionName, args))
            return null;
        if (this._decisionRequirement.required && !this._decisionResolved) {
            return 'ARCHITECTURE_DECISION_REQUIRED: Before changing the system, call request_decision with kind "architecture", 2-4 concrete options, their consequences, and a clear reason. Do not ask about routine details; this checkpoint exists because the current request crosses a durable architecture boundary.';
        }
        if (this._implementationPlanRequired && this._implementationPlan.length === 0) {
            return 'IMPLEMENTATION_PLAN_REQUIRED: Call update_plan with atomic, verifiable steps and exactly one in_progress step before mutating this complex task.';
        }
        return null;
    }
    updateTierLimits() {
        this.config = loadConfig();
        if (this.autonomyOverride)
            this.config.autonomyMode = this.autonomyOverride;
        if (typeof this.initializeProvider === 'function') {
            const nextProvider = this.initializeProvider();
            if (nextProvider) {
                this.llm = nextProvider;
                this._utilityLlm = null; // the route is derived from the model; re-derive it
            }
        }
        if (this.tokenTracker) {
            this.tokenTracker.config = this.config;
            this.tokenTracker.budget = this.config.tokenBudget || { enabled: false };
        }
        // verified entitlement). Developer emulator mode is a hardened, secret-gated
        // override for local development on a Fast-tier emulator — see devMode.js.
        const devMode = isDevEmulator(this.config);
        this.activeTier = devMode ? 'super_max' : (this.config.tier || 'premium');
        if (this.config.maxStepsPerTask) {
            this.maxSteps = this.config.maxStepsPerTask;
        }
        else if (this.activeTier === 'super_max') {
            this.maxSteps = 600;
        }
        else if (this.activeTier === 'max') {
            this.maxSteps = 400;
        }
        else {
            this.maxSteps = 300;
        }
        if (Number.isInteger(this.maxStepsCeiling) && this.maxStepsCeiling > 0) {
            this.maxSteps = Math.min(this.maxSteps, this.maxStepsCeiling);
        }
        if (Number.isInteger(this.taskTokenLimit) && this.taskTokenLimit > 0 && this.tokenTracker) {
            this.tokenTracker.budget = {
                ...this.tokenTracker.budget,
                enabled: true,
                hardStop: true,
                maxTokensPerTask: this.taskTokenLimit
            };
        }
        this.maxCircuitBreaker = this.maxSteps;
    }
    async run() {
        this.stopRequested = false;
        // A task that was stopped must not poison the next one — see
        // rearmAbortController(). This has to happen before any tool can run.
        this.rearmAbortController();
        // Refresh tier limits on every task run
        this.updateTierLimits();
        if (!this.llm) {
            throw new Error("API Key Required. Causyne is a 100% Sovereign BYOK Engine. Please configure your API Provider and Key in Settings.");
        }
        // 1. PERCEIVE — runs once per task so the agent starts with real workspace
        // awareness instead of burning steps rediscovering it. The result used to be
        // assigned to a local variable and thrown away.
        auditLog.log({ event: 'task_start', taskId: this.taskId, request: this.userPrompt });
        this.initialDesktopPictures = process.platform === 'darwin' && isDesktopWallpaperChangePrompt(this.userPrompt || '')
            ? readMacDesktopPictures() : null;
        // Preserve an explicit workspace selected by the caller (for example ACP).
        // The constructor already defaults to process.cwd() when none was supplied.
        coldObserver.beginTask(this.taskId);
        this.timeMachine.reset();
        this.emitEvent({ type: 'status', message: 'Analyzing workspace...' });
        // P2: open the undo group for this task. This snapshots the CONVERSATION as
        // well as the workspace tree, because restoring files while chat_history
        // still claims the edits happened leaves the agent believing in a disk state
        // that no longer exists. Fail-open — never blocks the task.
        await beginCheckpointTask({
            taskId: this.taskId,
            prompt: this.userPrompt,
            // The working directory FIRST, always.
            //
            // This passed sandbox.workspacePaths, which is the broad default SCOPE —
            // the places the agent is permitted to touch, not the place it is working.
            // beginTask() snapshots the first three, so on a default install it
            // captured /Users/Shared and /home (5.6 MB of files nobody was editing)
            // and never captured the project the user was actually in. Permission and
            // location are different questions; undo needs the location.
            // beginTask() de-duplicates and takes the first three.
            // The PROJECT, not the process's working directory.
            //
            // started inside a project. Started from the home directory — which is
            // simply what happens when someone opens a terminal and types the command
            // — cwd is $HOME, the snapshot blew past MAX_TREE_FILES and was recorded
            // as `too_many_files`, and the permission-scope fallbacks then captured
            // /Users/Shared and /home: 5.6 MB of files nobody has ever edited. Every
            // task produced a checkpoint containing nothing worth restoring, which is
            // why undo appeared to do nothing no matter where it was invoked.
            //
            // resolveProjectRoot walks up for a real project marker and refuses to
            // return $HOME or a system root, so the checkpoint covers the code being
            // worked on or honestly covers nothing at all.
            workspaceRoots: [
                resolveProjectRoot(this.workspaceRoot),
                this.workspaceRoot,
                ...(this.sandbox.grantAllAccess ? [] : (this.sandbox.workspacePaths || []))
            ].filter(Boolean)
        });
        try {
            this.workspaceContext = await this.perception.buildContext(this.workspaceRoot);
        }
        catch (perceptionError) {
            this.debugLog(`workspace scan failed: ${perceptionError.message}`);
            this.workspaceContext = null;
        }
        if (this.stopRequested || this.abortController?.signal?.aborted) {
            auditLog.log({ event: 'task_interrupted', taskId: this.taskId });
            return;
        }
        // 2. ANALYSE TASK SHAPE & PRE-WARM CAPABILITY PACKS.
        // A game request gets the full game toolset from step one with no discovery
        // round trip, while a "rename my files" request never pays the 7,282 tokens
        // those 21 schemas cost. The shape analysis additionally tells the model the
        // ORDER to work in, which saves whole exploratory steps.
        this.gameGuardFired = false;
        this.webGuardFired = false;
        this.webArtifacts = new Set();
        this.slopReviewAttempts = 0;
        this.slopLastAuditHash = '';
        this.staticContext = null;
        // Plan cache: the procedure THIS task follows, and the template (if any)
        // that was offered to it. Both reset per task — a plan is a property of one
        // request, not of the session.
        this._planSteps = [];
        this._offeredPlanId = null;
        this._planSimilarity = 0;
        this._planMatch = null;
        this._lessonSimilarity = 0;
        this._lastToolResult = null;
        this._paradigmShiftPending = false;
        this._implementationPlan = [];
        this._decisionAnswers = new Map();
        this._decisionRequirement = assessDecisionRequirement(this.userPrompt || '');
        this._decisionResolved = !this._decisionRequirement.required;
        this._taskStartedAt = performance.now();
        this._totalPlanMs = 0;
        this._totalActMs = 0;
        if (this.vfeTracker)
            this.vfeTracker.reset();
        if (this.userPrompt) {
            this.taskShape = analyzeTask(this.userPrompt, this.workspaceContext);
            this._implementationPlanRequired = requiresImplementationPlan(this.userPrompt, this.taskShape?.archetype || '', this.taskShape?.confidence || '');
            // request_decision is comparatively large and most tasks never need it.
            // On providers without server-side schema deferral, expose it from the
            // first model call only when the deterministic task policy found an
            // unresolved durable choice. This keeps the resident prompt within its
            // measured budget without making the checkpoint undiscoverable.
            if (this._decisionRequirement.required)
                this.unlockedTools.add('request_decision');
            // SmartToolsUse preloads likely tools but never changes a delegated
            // subagent's permission scope. A task's intent is a routing hint, not an
            // authorization boundary: later tool_search results must remain usable.
            const smartScope = determineToolScope(this.userPrompt, this.taskShape);
            if (smartScope.toolScope) {
                for (const tool of smartScope.toolScope)
                    this.unlockedTools.add(tool);
                this.debugLog(`[SmartToolsUse] preloaded ${smartScope.toolScope.size} tools (${smartScope.archetype})`);
            }
            // Scored routing, with the regex router as a safety net, filtered by SmartToolsUse suppression
            const scored = packsFromShape(this.taskShape);
            const fallback = routePacks(this.userPrompt, this.workspaceContext);
            const candidatePacks = filterSuppressedPacks([...scored, ...fallback], this.userPrompt);
            for (const pack of candidatePacks) {
                if (pack === 'game' && isDirectGameTask(this.userPrompt))
                    continue;
                this.unlockPack(pack);
            }
            // Reuse a known route before the first model call. Exact keyword-set
            // matches are always eligible; fuzzy reuse requires at least medium task
            // classification confidence because APC's threshold study shows that
            // aggressive fuzzy hits trade accuracy for speed.
            try {
                this._planMatch = lookupPlan({
                    prompt: this.userPrompt,
                    archetype: this.taskShape ? this.taskShape.archetype : '',
                    allowFuzzy: this.taskShape?.confidence !== 'low'
                });
                if (this._planMatch) {
                    this._offeredPlanId = this._planMatch.template.id;
                    this._planSimilarity = this._planMatch.similarity;
                    for (const step of this._planMatch.template.steps || []) {
                        if (!step.ok || !resolveTool(step.tool))
                            continue;
                        this.unlockedTools.add(step.tool);
                        const pack = packForTool(step.tool);
                        if (pack)
                            this.unlockPack(pack);
                    }
                    this.debugLog(`plan cache ${this._planMatch.matchType || 'fuzzy'} hit `
                        + `${(this._planMatch.similarity * 100).toFixed(0)}% `
                        + `(${this._planMatch.template.steps.length} steps, `
                        + `${this._planMatch.telemetry?.lookupMs?.toFixed(2) || '0.00'} ms)`);
                }
            }
            catch (e) {
                this.debugLog(`plan cache lookup skipped: ${e.message}`);
            }
            this.debugLog(`task shape: ${this.taskShape.archetype} (${this.taskShape.confidence} confidence)`);
        }
        if (!this.isInitialized) {
            const activeTier = this.activeTier;
            const charPoolLimit = resolveCharPool(activeTier, this.config.maxCharPool);
            const devTag = isDevEmulator(this.config) ? ' (dev emulator)' : '';
            // Was a console.log carrying a hardcoded \x1b[1m\x1b[36m, which ignored
            // NO_COLOR outright. The renderer paints this through the theme.
            // Internal sizing, and already implied by the header's `tier` field.
            this.debugLog(`tier ${activeTier}${devTag} | ${this.maxSteps} steps | ${charPoolLimit} char context`);
            this.isInitialized = true;
        }
        this.taskTemperature = this.determineTemperature(this.userPrompt);
        if (this.unlockedPacks.size > 0) {
            this.debugLog(`capability packs pre-warmed: ${[...this.unlockedPacks].join(', ')}`);
        }
        if (this.userPrompt) {
            // 1b. RESOLVE @ MENTIONS FOR REFERENCED FILES, DIRECTORIES & SUBPROJECTS
            try {
                const subprojects = this.workspaceContext?.subprojects || [];
                const mentionResult = await resolveMentionedContext(this.userPrompt, {
                    cwd: this.workspaceRoot,
                    subprojects
                });
                if (mentionResult.detectedSubproject) {
                    this.activeSubproject = mentionResult.detectedSubproject;
                    this.notice(`Focused on subproject '${mentionResult.detectedSubproject}'`);
                }
                else if (subprojects.length > 0) {
                    for (const sp of subprojects) {
                        if (sp.length >= 2) {
                            const boundaryRegex = new RegExp(`(?:^|\\s|["'\`(@/\\\\])${sp.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:$|\\s|["'\`):,/\\\\])`, 'i');
                            if (boundaryRegex.test(this.userPrompt)) {
                                this.activeSubproject = sp;
                                this.notice(`Focused on subproject '${sp}'`);
                                break;
                            }
                        }
                    }
                }
                if (mentionResult.referencedContext) {
                    this.userPrompt += mentionResult.referencedContext;
                    this.notice(`Loaded ${mentionResult.mentions.length} referenced @ mention(s) into context`);
                }
            }
            catch (mentionErr) {
                this.debugLog(`mention resolution error: ${mentionErr.message}`);
            }
            this.currentTaskPrompt = this.userPrompt; // Save for notification later
            // V5: Multimodal Attachments Support
            if (this.attachments && this.attachments.length > 0) {
                let contentArray = [{ type: 'text', text: this.userPrompt }];
                for (const att of this.attachments) {
                    if (att.type === 'image') {
                        contentArray.push({
                            type: 'image_url',
                            image_url: { url: `data:${att.mimeType};base64,${att.base64}` }
                        });
                    }
                    else if (att.type === 'audio') {
                        // be hardcoded to 'mp3' while the recorder produced AAC/m4a, so every
                        // clip was mislabelled and the provider failed on decode. att.mimeType
                        // has always been on the wire; it is now actually read.
                        const audioFormat = audioFormatForMimeType(att.mimeType);
                        // cap during reassembly; this is the final, vendor-specific ceiling,
                        // reported as a Causyne message rather than an opaque upstream 400.
                        const audioBytes = Math.round((att.base64?.length || 0) * 0.75);
                        const byteCeiling = this.llm?.maxAudioBytes;
                        if (byteCeiling && audioBytes > byteCeiling) {
                            contentArray[0].text +=
                                `\n\n[SYSTEM NOTIFICATION: The user's voice clip (${Math.round(audioBytes / 1024)} KB) exceeds the ${Math.round(byteCeiling / 1024)} KB limit of the selected model and was not attached. Ask the user to record a shorter clip.]`;
                            this.notice(`voice clip dropped: ${audioBytes} B over the ${byteCeiling} B provider limit`);
                        }
                        else if (!this.llm?.supportsAudio) {
                            // model that cannot hear — a stale capability advertisement. Say so
                            // in-band; prepareMessages would otherwise strip it further down
                            // and the user would never learn why nothing was heard.
                            // Before giving up: the provider may ship a dedicated
                            // speech-to-text model on this same key. Meta does, and it is the
                            // whole answer to Muse Spark 1.3 being both the recommended model
                            // and the one that cannot hear.
                            let transcript = null;
                            let transcribeError = null;
                            if (typeof this.llm?.transcribeAudio === 'function') {
                                try {
                                    transcript = await this.llm.transcribeAudio(att.base64, att.mimeType);
                                }
                                catch (e) {
                                    transcribeError = e.message;
                                }
                            }
                            if (transcript) {
                                contentArray[0].text +=
                                    `\n\n[VOICE TRANSCRIPT: The user spoke rather than typed. The selected model cannot take audio directly, so the clip was transcribed by this provider's speech-to-text model. Treat the following as the user's own words: "${transcript}"]`;
                                this.notice(`voice clip transcribed (${transcript.length} chars) — the chat model cannot hear`, 'accent');
                            }
                            else {
                                // Name the way out when the provider knows one. A refusal the
                                // user cannot act on is worse than the limitation it reports.
                                const alternative = typeof this.llm?.audioAlternative === 'function'
                                    ? this.llm.audioAlternative()
                                    : null;
                                const route = alternative
                                    ? `Ask them to switch to ${alternative}, which accepts audio on this same provider and key, or to use the on-device transcription instead.`
                                    : 'Ask them to switch to an audio-capable model, or to use the on-device transcription instead.';
                                contentArray[0].text +=
                                    `\n\n[SYSTEM NOTIFICATION: The user sent a voice recording but the selected model cannot process audio. ${route}]`;
                                this.notice(transcribeError
                                    ? `voice clip dropped: transcription failed — ${transcribeError}`
                                    : alternative
                                        ? `voice clip dropped: ${this.config.model} cannot hear — ${alternative} can`
                                        : 'voice clip dropped: selected model does not support audio input', transcribeError ? 'warn' : 'muted');
                            }
                        }
                        else {
                            contentArray.push({
                                type: 'input_audio',
                                input_audio: {
                                    data: att.base64,
                                    format: audioFormat
                                }
                            });
                        }
                    }
                    else if (att.type === 'document') {
                        const fs = await import('fs');
                        const path = await import('path');
                        // Ensure unique name to prevent overwriting
                        const safeName = att.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                        const writePath = path.join(this.workspaceRoot, safeName);
                        fs.writeFileSync(writePath, Buffer.from(att.base64, 'base64'));
                        contentArray[0].text += `\n\n[SYSTEM NOTIFICATION: The user attached a document named '${safeName}'. It has been saved to your workspace at ./${safeName}. Please use your file reading tools to examine its contents.]`;
                        this.notice(`saved attached document to ${writePath}`);
                    }
                }
                this.messages.push({ role: 'user', content: contentArray });
            }
            else {
                const lastMsg = this.messages[this.messages.length - 1];
                if (lastMsg && lastMsg.role === 'user' && typeof lastMsg.content === 'string' && lastMsg.content.trim() === this.userPrompt.trim()) {
                    lastMsg.content = this.userPrompt;
                }
                else {
                    this.messages.push({ role: 'user', content: this.userPrompt });
                }
            }
            this.userPrompt = null; // Clear so we don't push it again
            this.attachments = null; // Clear attachments
        }
        this.stepsCompleted = 0;
        // Fresh per task. A digest from a previous task would point at a step
        // number the model can no longer see, which is worse than paying twice.
        this._observationDigests = new Map();
        this.consecutiveCommands = 0;
        this.circuitBreakerUnlocked = false;
        this.recentActionSignatures = [];
        this.consecutiveReadOnlySteps = 0;
        this.stallGuard.reset();
        this.smartToolsGovernor.reset();
        this._smartToolsNudge = null;
        this.tokenTracker.resetTask();
        const turnArchetype = determineToolScope(this.currentTaskPrompt || '', this.taskShape).archetype;
        const efficiency = this.config.efficiency || {};
        this.efficiencyBudget = new UnifiedBudgetEnforcer(Number.isFinite(efficiency.maxTurnTokens) && efficiency.maxTurnTokens > 0 ? efficiency.maxTurnTokens : 100_000, Number.isSafeInteger(efficiency.maxTurnActions) && efficiency.maxTurnActions > 0 ? efficiency.maxTurnActions : actionLimitFor(turnArchetype));
        let modelCallIndex = 0;
        let mediaExplorationRecoveries = 0;
        // The core loop governed by Sovereign Human-in-the-Loop Checkpoints
        while (!this.stopRequested) {
            if (this.stopRequested) {
                this.emitEvent({ type: 'error', message: 'Task killed by user.' });
                auditLog.log({ event: 'task_killed', taskId: this.taskId });
                break;
            }
            this.emitEvent({ type: 'status', message: 'Thinking...' });
            try {
                this.smartToolsGovernor.beginModelStep();
                // Insert at the model boundary, never between one assistant tool-call
                // message and the matching tool results in a multi-call batch.
                if (this._smartToolsNudge) {
                    this.messages.push({ role: 'system', content: this._smartToolsNudge });
                    this._smartToolsNudge = null;
                }
                // --- V8 MEMORY ARCHITECTURE: DECAY → WINDOW → REAL COMPACTION ---
                // The window is no longer only a view over an ever-growing array. Old
                // tool payloads decay into stubs, and anything amputated is physically
                // replaced by a summary, so memory, disk and CPU all stay bounded.
                const activeTier = isDevEmulator(this.config) ? 'super_max' : (this.config.tier || 'premium');
                const MAX_CHAR_POOL = resolveCharPool(activeTier, this.config.maxCharPool);
                // 5-Stage Progressive Compaction (Claude Code Architecture / Research Section E):
                // Stage 0 (HLCE Ephemeral Decay) + Stage 2 (Snip >15K tokens / 60K chars) +
                // Stage 1 (Budget Reduction >70%) + Stage 3 (Microcompact) + Stage 4 (Context Collapse >85%)
                const observationPrune = pruneStaleToolObservations(this.messages, {
                    keepRecent: this.config.keepRecentToolResults ?? 4,
                    minChars: 600,
                    taskId: this.taskId
                });
                const oversizedPrune = shortenOversizedToolObservations(this.messages, {
                    taskId: this.taskId
                });
                const compaction = applyProgressiveCompaction(this.messages, MAX_CHAR_POOL, {
                    // historyPruner preserves full output before eliding it. The legacy
                    // decay path cannot promise that recovery, so keep it disabled here.
                    enableEphemeralDecay: false,
                    // The legacy snipper can discard data when a disk spill fails. The
                    // recoverable TypeScript path above owns all oversized tool output.
                    snipOptions: { threshold: Number.MAX_SAFE_INTEGER },
                    budgetKeepRecent: Number.MAX_SAFE_INTEGER,
                    collapseKeepRecent: Number.MAX_SAFE_INTEGER
                });
                compaction.totalReclaimed += observationPrune.reclaimedChars + oversizedPrune.reclaimedChars;
                if (observationPrune.pruned > 0) {
                    compaction.stagesFired.push(`recoverable_observation_decay:${observationPrune.pruned}`);
                }
                if (oversizedPrune.pruned > 0) {
                    compaction.stagesFired.push(`recoverable_oversized_output:${oversizedPrune.pruned}`);
                }
                if (compaction.totalReclaimed > 0) {
                    this.debugLog(`progressive compaction reclaimed ${(compaction.totalReclaimed / 1024).toFixed(1)} KB [${compaction.stagesFired.join(', ')}]`);
                    auditLog.log({
                        event: 'context_compaction', taskId: this.taskId,
                        kind: 'progressive', stages: compaction.stagesFired,
                        reclaimedChars: compaction.totalReclaimed,
                        finalChars: compaction.finalChars,
                        limitChars: MAX_CHAR_POOL
                    });
                }
                const { window: slidingWindow, splitIndex } = buildWindow(this.messages, MAX_CHAR_POOL);
                // What the context window actually holds right now.
                //
                // The footer's context meter was being fed `usedTokens` — the CUMULATIVE
                // token spend of the whole task — and divided by a CHARACTER pool. Two
                // unit errors compounding: after 16 steps it read 290,069 against
                // 120,000 and, because the meter clamped at 99, displayed "290K (99%)"
                // while the real window sat around a quarter full. A meter pinned at 99%
                // for most of a run answers no question at all.
                //
                // Measured, not extrapolated: this is the same array the request is
                // built from, one line after it is built.
                this._contextChars = measureMessages(slidingWindow);
                this._contextLimitChars = MAX_CHAR_POOL;
                // Real compaction: physically collapse the amputated range so the array
                // stops growing. Index 0 (the Root Anchor / original user intent) is
                // never compacted away.
                if (splitIndex >= 1) {
                    const dropped = this.messages.slice(1, splitIndex + 1);
                    if (dropped.length > 0) {
                        const compactSummary = buildRecoverableDroppedSummary(dropped, buildStructuralSummary(dropped) || describeDroppedMessages(dropped));
                        const removed = compactInPlace(this.messages, splitIndex, compactSummary);
                        this._lastCompactionIndex = null;
                        this.debugLog(`compacted ${removed} messages out of the live context`);
                        auditLog.log({
                            event: 'context_compaction', taskId: this.taskId,
                            kind: 'summary', removedMessages: removed,
                            retainedSummaryChars: compactSummary.length,
                            limitChars: MAX_CHAR_POOL
                        });
                        this.notice(`Context compacted: ${removed} earlier messages condensed into a reviewable summary.`);
                        // V5 Cortex tiered condensation. Tier 1 (structural, free) always
                        // runs so the Digital Brain keeps learning on every provider. Tier 2
                        // (semantic, billed) is capped per task and fully tracked.
                        condenseAndSave(dropped, this.utilityProvider(), this.tokenTracker, {
                            enableLlmPass: this.config.enableCortexCondenser !== false,
                            maxLlmPasses: this.config.maxCortexCondenserPasses ?? 3,
                            passesUsed: this._cortexPassesUsed
                        }).then((outcome) => {
                            if (outcome.semantic)
                                this._cortexPassesUsed++;
                        }).catch(() => { });
                    }
                }
                // Resolve the active toolset before assembling the prompt: the task
                // brief only cites tools the model can actually see right now.
                // Providers with native schema deferral (Anthropic: `defer_loading` +
                // `tool_search_tool_regex`) keep the whole core in context for free —
                // the API holds the schemas server-side and expands them on demand,
                // with no discovery round trip. Every OTHER provider was serialising
                // all 24 core schemas into every request. There, ship the small resident
                // set and let `tool_search` — the same mechanism that already
                // unlocks packs — fetch the rest.
                const residentOnly = this.llm.supportsToolSearch?.() !== true;
                let dynamicTools = await getDynamicTools(this.config.autonomyMode, this.llm.supportsVision, {
                    unlockedPacks: this.unlockedPacks,
                    unlockedTools: this.unlockedTools,
                    unlockOrder: this.unlockOrder,
                    grantAllTools: this.config.grantAllTools === true,
                    allowedTools: this.sandbox.allowedTools,
                    deniedTools: this.config.deniedTools,
                    residentOnly
                });
                // A delegated subagent runs with a declared toolScope. Enforcing it
                // here — the one place the catalogue is assembled — is what makes the
                // scope real; the previous implementation accepted the argument and
                // ignored it entirely (finding D-7).
                if (this.toolScope instanceof Set && this.toolScope.size > 0) {
                    dynamicTools = dynamicTools.filter((t) => this.toolScope.has(t.name));
                }
                const dynamicToolNames = dynamicTools.map((t) => t.name);
                // Dynamically inject the absolute latest System context
                const autonomyMode = this.config.autonomyMode || 'C';
                const allowedPaths = this.sandbox.grantAllAccess
                    ? "/ (ALL ACCESS GRANTED - You can read/write anywhere EXCEPT system protected folders like /etc or /System)"
                    : (this.sandbox.workspacePaths ? this.sandbox.workspacePaths.join(', ') : this.workspaceRoot);
                const providerPrompt = getProviderSpecificPrompt(this.config.provider);
                const memoryContext = getMemoryContextString();
                // --- PER-TASK STATIC CONTEXT (computed once, not once per step) ---
                // Cortex retrieval, design detection, creative-pattern lookup and the
                // workspace domain scan are all constant for the duration of a task, but
                // used to run on every single iteration: a SQLite query, several
                // directory scans and a skills-index rebuild per step. They also churned
                // the prompt prefix whenever a result shifted, costing cache hits.
                if (!this.staticContext) {
                    this.staticContext = await this.buildStaticContext();
                }
                const { lessonsLearned, designContext, antiRepeatDirective, universalSkillsContext, planHint } = this.staticContext;
                // --- WORKSPACE AWARENESS ---
                // perception.buildContext() output used to be computed and discarded,
                // leaving the agent blind and forcing it to rediscover the project with
                // ls/cat on every task.
                let workspaceSummary = '';
                if (this.workspaceContext) {
                    const ctx = this.workspaceContext;
                    const facts = [
                        ctx.cwd && `Working directory: ${ctx.cwd}`,
                        this.activeSubproject && `Active project focus: ${this.activeSubproject}`,
                        ctx.projectName && `Workspace project: ${ctx.projectName}`,
                        ctx.os && `OS: ${ctx.os}`,
                        ctx.framework && `Framework: ${ctx.framework}`,
                        ctx.projectType && `Project type: ${ctx.projectType}`,
                        ctx.packageManager && `Package manager: ${ctx.packageManager}`,
                        ctx.gitBranch && `Git branch: ${ctx.gitBranch}`,
                        ctx.gitStatus && `Git status: ${ctx.gitStatus}`,
                        Array.isArray(ctx.subprojects) && ctx.subprojects.length > 0 && `Subprojects in workspace: ${ctx.subprojects.join(', ')}`,
                        Array.isArray(ctx.keyFiles) && ctx.keyFiles.length > 0 && `Key files: ${ctx.keyFiles.slice(0, 25).join(', ')}`
                    ].filter(Boolean);
                    if (facts.length > 0) {
                        workspaceSummary = `\n\n📂 WORKSPACE CONTEXT (already scanned for you — do NOT waste steps rediscovering this):\n${facts.join('\n')}`;
                    }
                }
                // --- PROMPT ASSEMBLY, ORDERED STABLE → VOLATILE ---
                // Every provider's prompt cache binds on an identical prefix. Anthropic
                // marks it explicitly with cache_control (up to 4 breakpoints); OpenAI,
                // DeepSeek and Gemini match the longest stable prefix automatically. So
                // each block that is constant within a task carries its own cache anchor,
                // and the ONLY bytes that can change between steps live in a single
                // volatile block kept dead last. Previously just [1] was anchored, so the
                // pack catalogue and the whole workspace/memory/skills context were
                // re-billed on every step even though they never changed mid-task.
                // LazyPlaybook: disclose multi-page mandates only when tools from that domain
                // have been actively invoked or explicitly demanded. Otherwise emit micro-indicators.
                const observedTools = (this._planSteps || []).map((step) => step.tool);
                const lazyPlaybookResult = resolveLazyPlaybooks(this.unlockedPacks, observedTools, this.userPrompt);
                const activePlaybooks = [
                    lazyPlaybookResult.fullPlaybooks,
                    lazyPlaybookResult.microAnnouncements
                ].filter(Boolean).join('\n\n');
                // The task brief turns "here are 28 tools" into "here is the order to
                // use them in", which is where whole exploratory steps get saved.
                const taskBrief = this.taskShape
                    ? buildTaskBrief(this.taskShape, dynamicToolNames)
                    : '';
                // Uncertainty gate. Every input is already in hand — no sampling, no
                // second model, no network. Returns '' for a confident step, and that
                // empty string is the point: reflecting on every step is the waste the
                // gating literature exists to prevent.
                let uncertaintyDirective = '';
                let uncertaintyTemperatureDelta = 0;
                try {
                    const lastAssistant = [...this.messages].reverse()
                        .find((m) => m.role === 'assistant' && typeof m.content === 'string');
                    const vfeStatus = this.vfeTracker ? this.vfeTracker.getStatus() : { isPlateau: false };
                    const isVfePlateau = Boolean(this._paradigmShiftPending || vfeStatus.isPlateau);
                    const verdict = assessStep({
                        consecutiveFailures: this.consecutiveFailures,
                        lastResult: this._lastToolResult,
                        recentTools: (this._planSteps || []).map((step) => step.tool),
                        planSimilarity: this._planSimilarity,
                        lessonSimilarity: this._lessonSimilarity,
                        vfePlateau: isVfePlateau,
                        assistantText: lastAssistant ? lastAssistant.content : ''
                    });
                    uncertaintyDirective = verdict.directive;
                    uncertaintyTemperatureDelta = verdict.temperatureDelta || 0;
                    if (isVfePlateau) {
                        this._paradigmShiftPending = false;
                    }
                    if (verdict.directive) {
                        this.debugLog(`uncertainty ${verdict.uncertainty.toFixed(2)} (${verdict.level}): ${verdict.signals.join(', ')}`);
                        auditLog.log({
                            event: 'uncertainty_gate', taskId: this.taskId, step: this.stepsCompleted,
                            level: verdict.level, score: Number(verdict.uncertainty.toFixed(3)), signals: verdict.signals
                        });
                    }
                }
                catch (e) {
                    this.debugLog(`uncertainty gate skipped: ${e.message}`);
                }
                const systemMessages = [
                    // [1] stable for the entire task — the primary cache anchor.
                    { role: 'system', content: SYSTEM_PROMPT, cacheAnchor: true },
                    // [2] changes only when a capability pack unlocks (append-only), so it
                    // is stable within a task and gets its own breakpoint.
                    {
                        role: 'system',
                        content: `${taskBrief ? taskBrief + '\n\n' : ''}${getPackCatalogue(this.unlockedPacks)}${activePlaybooks ? '\n\n' + activePlaybooks : ''}`,
                        cacheAnchor: true
                    },
                    // [3] per-task STATIC context — provider activation, detected design,
                    // the one-time workspace scan, Cortex lessons, creative-diversity and
                    // the skills index. All from this.staticContext (computed once) so it
                    // is byte-identical every step; cached.
                    {
                        role: 'system',
                        content: `${providerPrompt}${designContext}${workspaceSummary}${lessonsLearned}${planHint ? '\n' + planHint + '\n' : ''}${antiRepeatDirective}\n${universalSkillsContext}`,
                        cacheAnchor: true
                    },
                    // [4] THE INVOKED SKILL, when the user named one.
                    //
                    // This is what makes `/skills <id> <instruction>` mean anything. Before
                    // it existed the command printed the skill to the terminal and called
                    // `continue` — the body never entered a request, the trailing
                    // instruction was dropped on the floor, and no API call was made at
                    // all. "Activating" a skill was a document viewer.
                    //
                    // Its own message rather than appended to [3]: [3] is the per-task
                    // static anchor and appending here would invalidate that cache every
                    // time a different skill is invoked. This one is stable for the task,
                    // so it anchors too.
                    ...(skillSystemMessage(this.activeSkill) || []),
                    // [5] VOLATILE tail — the only bytes that may differ between steps:
                    // autonomy/workspace paths (change via config) and persistent memory
                    // (grows via memory_write mid-task). Kept LAST and UNcached so a change
                    // here never invalidates the cached prefix in [1]-[3].
                    {
                        role: 'system',
                        content: `${uncertaintyDirective ? uncertaintyDirective + '\n\n' : ''}${describeSession(this.taskId)}CURRENT AUTONOMY MODE: ${autonomyMode}\nALLOWED WORKSPACE PATHS: ${allowedPaths}\n(You MUST NOT write files outside these paths!)\n\n🧠 PERSISTENT MEMORY (FACTS LEARNED ABOUT THE USER):\n${memoryContext}`
                    }
                ];
                // Dev-only visibility into what fills each step's prompt. Set
                // CAUSYNE_TOKEN_DEBUG=1 to see the cached prefix ([1]-[3]) vs the volatile
                // tail ([4]) and confirm the cache is doing its job (pair it with the
                // "Prompt cache hit" line logged after the call).
                if (process.env.CAUSYNE_TOKEN_DEBUG === '1') {
                    const chars = (m) => (typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content || '').length);
                    const windowChars = slidingWindow.reduce((sum, m) => sum + chars(m), 0);
                    this.debugLog(`[token] sys1_base=${chars(systemMessages[0])} sys2_packs=${chars(systemMessages[1])} `
                        + `sys3_static(cached)=${chars(systemMessages[2])} sys4_volatile=${chars(systemMessages[3])} `
                        + `tools=${JSON.stringify(dynamicTools).length} window=${windowChars} (chars)`);
                }
                // --- SOVEREIGN ROOT ANCHOR PRESERVATION ---
                // Ensure the original User Blueprint / Root Intent (`this.messages[0]`) is NEVER amputated
                // by the sliding window, regardless of how many steps or tool outputs accumulate.
                const rootAnchor = [];
                // The `slidingWindow.length > 0` guard is GONE on purpose. It meant an
                // empty window skipped the anchor too, and a request of nothing but
                // system blocks is a 400 on every provider. The window can no longer be
                // empty (contextManager.buildWindow), but the anchor must not depend on
                // that staying true.
                if (this.messages.length > 0 && slidingWindow[0] !== this.messages[0] && this.messages[0].role === 'user') {
                    rootAnchor.push(this.messages[0]);
                }
                // Final Assembly for the LLM. sanitizeSequences guarantees every
                // assistant tool_calls block is followed by matching tool results and
                // drops orphans that would otherwise 400 the provider.
                let prunedMessages = sanitizeSequences([...systemMessages, ...rootAnchor, ...slidingWindow]);
                // THE INVARIANT, ENFORCED AT THE LAST POSSIBLE MOMENT.
                //
                // Every provider rejects a request whose messages carry no `user` or
                // `tool` turn. Two separate paths above can produce one — an empty
                // window, and sanitizeSequences dropping orphaned tool results — and
                // relying on either to be correct forever is how a 340,000-token run
                // died at step 13 with nothing to show for it. Checked here because
                // this is the last place the shape is still ours to fix.
                if (!prunedMessages.some((m) => m.role === 'user' || m.role === 'tool')) {
                    const root = this.messages.find((m) => m.role === 'user');
                    prunedMessages = [
                        ...prunedMessages,
                        root || { role: 'user', content: 'Continue the task from where you left off.' }
                    ];
                    this.debugLog('request had no user/tool message; re-anchored before sending');
                }
                // BUDGET CEILING, CHECKED BEFORE SPENDING RATHER THAN AFTER.
                //
                // trackUsage() below stops the loop once the ceiling has ALREADY been
                // passed, so a run always overshot by one step — with ~9,000-token
                // steps a 299,000 ceiling landed near 308,000. Asking first is what
                // makes a ceiling mean the number the user typed.
                // A peer CLI may execute many model steps inside one chat() call.
                // Pass the remaining hard budget into peers that expose per-step usage.
                const budget = this.tokenTracker.budget || {};
                const hardBudget = (budget.enabled && budget.hardStop) ||
                    (Number.isInteger(this.taskTokenLimit) && this.taskTokenLimit > 0);
                const taskLimit = Number.isInteger(this.taskTokenLimit) && this.taskTokenLimit > 0
                    ? this.taskTokenLimit : Number(budget.maxTokensPerTask || 0);
                const dailyLimit = budget.enabled && budget.hardStop
                    ? Number(budget.maxTokensPerDay || 0) : 0;
                const dailyUsed = hardBudget && dailyLimit > 0
                    ? (await this.tokenTracker.getDailyUsage()).totalTokens : 0;
                const configuredRemainingBudget = hardBudget
                    ? Math.min(taskLimit > 0 ? taskLimit - this.tokenTracker.taskTokens : Infinity, dailyLimit > 0 ? dailyLimit - dailyUsed : Infinity) : Infinity;
                const remainingBudget = Math.min(configuredRemainingBudget, this.efficiencyBudget.getRemainingTokens());
                if (remainingBudget <= 0) {
                    this.emitEvent({ type: 'budget_warning', message: 'Token budget reached before the next model call.' });
                    break;
                }
                // trackUsage reloads persisted settings; restore the per-task profile
                // limit before the predictive check on each iteration.
                if (Number.isInteger(this.taskTokenLimit) && this.taskTokenLimit > 0) {
                    this.tokenTracker.budget = { ...budget, enabled: true, hardStop: true, maxTokensPerTask: this.taskTokenLimit };
                }
                const affordability = this.tokenTracker.canAffordAnotherStep();
                if (!affordability.allowed) {
                    this.emitEvent({ type: 'budget_warning', message: affordability.reason });
                    this.emitEvent({ type: 'notice', message: 'Stopped before the token ceiling. Nothing was truncated mid-step.' });
                    // A plan that was offered and did NOT carry the task through loses
                    // rank, so a stale template stops being suggested forever. Only the
                    // denominator moves here — recordPlan() is what awards a win.
                    if (this._offeredPlanId) {
                        try {
                            recordMiss(this._offeredPlanId);
                        }
                        catch (e) { /* never block a stop */ }
                    }
                    auditLog.log({
                        event: 'task_stopped_on_budget', taskId: this.taskId,
                        used: affordability.used, limit: affordability.limit, projected: affordability.projected
                    });
                    break;
                }
                // 2. PLAN (Call LLM). dynamicTools was resolved above so the task brief
                // could reference the tools actually in context.
                let hasStreamedChunk = false;
                const streamingCode = new StreamingCodePreview();
                const nativeCodeObserver = new NativeCodeObserver(this.workspaceRoot, event => this.emitEvent(event));
                let reasoningAccumulated = '';
                let thoughtStartedAt = 0;
                this.emitEvent({ type: 'status', message: 'Thinking…' });
                this.emitEvent({ type: 'agent_activity', activity: 'Thinking…' });
                const planStepStart = performance.now();
                const nativeControl = new AbortController();
                let nativeCheckpoint = null;
                const invocation = ++modelCallIndex;
                const response = await this.llm.chat(prunedMessages, {
                    taskId: this.taskId,
                    conversationId: this.memoryManager?.sessionId || this.taskId,
                    taskIntent: isLaunchOnlyPrompt(this.currentTaskPrompt || this.userPrompt || '') ? 'launch' : 'general',
                    taskArchetype: determineToolScope(this.currentTaskPrompt || this.userPrompt || '', this.taskShape).archetype,
                    maxTokensThisCall: Number.isFinite(remainingBudget) ? remainingBudget : undefined,
                    tokenLimit: Number.isFinite(remainingBudget) && remainingBudget > 0 ? remainingBudget : undefined,
                    maxNativeActions: this.efficiencyBudget.getRemainingActions(),
                    workspaceRoot: this.workspaceRoot,
                    tools: dynamicTools,
                    // IARS couples escalation to a wider search. Bounded so a stuck task
                    // cannot climb into randomness across repeated escalations.
                    temperature: Math.min(1, this.taskTemperature + uncertaintyTemperatureDelta),
                    coreToolCount: dynamicTools.filter((t) => isCoreTool(t.name)).length,
                    signal: this.abortController?.signal
                        ? AbortSignal.any([this.abortController.signal, nativeControl.signal]) : nativeControl.signal,
                    onReasoningChunk: (chunk) => {
                        if (this.stopRequested || this.abortController?.signal?.aborted)
                            return;
                        if (!thoughtStartedAt)
                            thoughtStartedAt = Date.now();
                        reasoningAccumulated += chunk;
                        this.emitEvent({
                            type: 'agent_reasoning',
                            content: reasoningAccumulated,
                            delta: chunk,
                            streaming: true,
                            elapsedMs: Date.now() - thoughtStartedAt
                        });
                    },
                    onChunk: (_chunk) => {
                        if (this.stopRequested || this.abortController?.signal?.aborted)
                            return;
                        if (!hasStreamedChunk) {
                            hasStreamedChunk = true;
                            this.emitEvent({ type: 'status', message: 'Responding…' });
                            this.emitEvent({ type: 'agent_activity', activity: 'Responding…' });
                        }
                        const preview = streamingCode.accept(_chunk);
                        if (preview)
                            this.emitEvent(preview);
                    },
                    onNativeAction: (action) => {
                        if (this.stopRequested || this.abortController?.signal?.aborted)
                            return;
                        if (!action || typeof action.name !== 'string')
                            return;
                        if (action.status === 'running') {
                            try {
                                this.efficiencyBudget.recordAction(`${invocation}:${action.id || `${action.name}:${action.detail || ''}`}`);
                            }
                            catch (error) {
                                if (error instanceof EfficiencyCheckpoint) {
                                    nativeCheckpoint = error;
                                    nativeControl.abort();
                                }
                                return;
                            }
                        }
                        const nativeCode = codeProgressFromAction(action.name, { ...(action.parameters && typeof action.parameters === 'object' ? action.parameters : {}),
                            path: action.parameters?.path || action.parameters?.Path || action.detail || '' }, `provider:${action.name}:${action.detail || ''}`, action.status === 'completed' ? 'done' : action.status === 'failed' ? 'failed' : 'working', 'provider');
                        if (nativeCode) {
                            this.emitEvent(nativeCode);
                            nativeCodeObserver.handle(nativeCode);
                            if (nativeCode.phase === 'done' && ['Creating', 'Editing'].includes(nativeCode.operation)) {
                                this.recordWebArtifact(nativeCode.path);
                            }
                        }
                        const detail = action.detail ? ` ${action.detail}` : '';
                        if (action.status === 'running') {
                            this.emitEvent({ type: 'status', message: `Acting: ${action.name}${detail}` });
                            this.emitEvent({ type: 'agent_activity', activity: `Acting: ${action.name}${detail}` });
                        }
                        else if (action.status === 'completed') {
                            this.emitEvent({ type: 'notice', tone: 'muted', nativeStep: true, message: `Antigravity ${action.name}${detail}` });
                        }
                        else if (action.status === 'failed') {
                            this.emitEvent({ type: 'warning', message: `Antigravity could not ${action.name}${detail}` });
                        }
                    }
                }).catch((error) => { throw nativeCheckpoint || error; })
                    .finally(() => nativeCodeObserver.dispose());
                this._totalPlanMs = (this._totalPlanMs || 0) + (performance.now() - planStepStart);
                if (this.stopRequested || this.abortController?.signal?.aborted) {
                    auditLog.log({ event: 'task_interrupted', taskId: this.taskId });
                    break;
                }
                const finalCodePreview = streamingCode.flush();
                if (finalCodePreview)
                    this.emitEvent(finalCodePreview);
                // The call came back. Whatever went wrong before is no longer
                // consecutive — without this reset, one failure at step 2 and another
                // at step 200 would count toward the same ceiling and stop a task that
                // was working perfectly well.
                this.consecutiveFailures = 0;
                this.lastFailureType = null;
                // Track tokens. usage carries cachedPromptTokens / cacheWriteTokens so
                // the cost estimate reflects the real cache-discounted bill.
                const tracking = await this.tokenTracker.trackUsage(response.usage.promptTokens, response.usage.completionTokens, (msg) => this.emitEvent({ type: 'budget_warning', message: msg }), response.usage);
                // Private numeric telemetry only. The daily ledger aggregates calls,
                // so it cannot attribute usage to a task or distinguish provider data
                // from the character-count fallback used by some ACP peers.
                auditLog.log({
                    event: 'model_usage', scope: 'agent_loop_primary',
                    taskId: this.taskId, step: this.stepsCompleted,
                    provider: this.config.provider || 'unknown',
                    promptTokens: response.usage.promptTokens,
                    completionTokens: response.usage.completionTokens,
                    cachedPromptTokens: response.usage.cachedPromptTokens || 0,
                    noncachedTokens: noncachedTokens(response.usage),
                    measurement: response.usage.measurement || 'unspecified',
                    cacheMeasurement: response.usage.cacheMeasurement || 'unspecified',
                    costBasis: /^(acp(?:\/|$)|antigravity$|agy$)/i.test(String(this.config.provider || ''))
                        ? 'external_subscription_unavailable' : 'rate_card_estimate',
                    callEstimatedCostUsd: this.tokenTracker.calculateCost(response.usage.promptTokens, response.usage.completionTokens, response.usage)
                });
                this.efficiencyBudget.recordUsage(response.usage);
                const cachedTokens = response.usage.cachedPromptTokens || 0;
                if (cachedTokens > 0) {
                    this.debugLog(`prompt cache hit: ${cachedTokens.toLocaleString()} of ${response.usage.promptTokens.toLocaleString()} input tokens served from cache`);
                }
                //
                // ALWAYS read (AgentViewModel: `optInt("dailyTokens", optInt("usedTokens",
                // — which this frame set to the TASK total. The card therefore drew task
                // tokens against `maxTokensPerDay` and read 29% while the daily limiter
                // fired at 1,001,877 / 1,000,000. The contract existed on one side only.
                //
                // Context is reported in characters against the character pool, the unit
                // the window is actually budgeted in. The renderer converts once, using
                // the project's own CHAR_POOLS convention, instead of comparing a token
                // count to a character limit.
                this.emitEvent({
                    type: 'usage_update',
                    usedTokens: tracking.dailyTokens || 0,
                    dailyTokens: tracking.dailyTokens || 0,
                    dailyCostUsd: tracking.dailyCostUsd || 0,
                    dailyLimit: tracking.dailyLimit || 0,
                    taskTokens: tracking.taskTokens || 0,
                    taskCostUsd: tracking.taskCostUsd || 0,
                    taskLimit: tracking.taskLimit || 0,
                    costUsd: tracking.costUsd || 0,
                    lifetimeTokens: tracking.lifetimeTokens || 0,
                    lifetimeCostUsd: tracking.lifetimeCostUsd || 0,
                    contextChars: this._contextChars || 0,
                    contextLimitChars: this._contextLimitChars || 0,
                    cachedTokens
                });
                if (!tracking.allowed) {
                    this.emitEvent({ type: 'error', message: tracking.reason });
                    break;
                }
                // Add assistant response to history. This is the ONLY place the turn is
                // recorded — the completion and guard branches below used to push it a
                // second time, duplicating every finished turn in the history.
                const hasToolCalls = Boolean(response.toolCalls && response.toolCalls.length > 0);
                const assistantMsg = {
                    role: 'assistant',
                    // An assistant message with neither text nor tool calls is rejected by
                    // some providers, so a terminal turn always carries something.
                    content: response.content || (hasToolCalls ? '' : 'Task completed.')
                };
                if (hasToolCalls) {
                    assistantMsg.tool_calls = response.toolCalls;
                }
                if (response.reasoningContent) {
                    assistantMsg.reasoning_content = response.reasoningContent;
                }
                else if (reasoningAccumulated) {
                    assistantMsg.reasoning_content = reasoningAccumulated;
                }
                const finalReasoning = response.reasoningContent || reasoningAccumulated;
                if (finalReasoning) {
                    this.emitEvent({
                        type: 'agent_reasoning',
                        content: finalReasoning,
                        streaming: false,
                        elapsedMs: thoughtStartedAt ? Date.now() - thoughtStartedAt : 0
                    });
                }
                // Kept verbatim on the turn. A thinking-enabled model that gets its own
                // thinking blocks back is continuing a thought; one that does not is
                // starting over, and with tool_use in the same turn the API can reject
                // the sequence outright.
                if (response.thinkingBlocks) {
                    assistantMsg.thinking_blocks = response.thinkingBlocks;
                }
                this.messages.push(assistantMsg);
                if (response.content && hasToolCalls) {
                    this.emitEvent({ type: 'agent_message', content: response.content });
                }
                const externalActions = Array.isArray(response.externalActions)
                    ? response.externalActions
                    : [];
                const completedExternalActions = externalActions.filter((a) => a && a.status === 'completed');
                const failedExternalActions = externalActions.filter((a) => a && a.status === 'failed');
                const hasExternalActions = completedExternalActions.length > 0;
                const isIncompleteTurn = Boolean(response.incompleteTurn);
                if (hasExternalActions) {
                    this.stepsCompleted += completedExternalActions.length;
                    for (const extAction of completedExternalActions) {
                        const actionName = String(extAction.name || '').toLowerCase();
                        const detailPath = typeof extAction.detail === 'string' ? extAction.detail.trim() : '';
                        if (['write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'fs_write', 'fs_edit', 'multiedit'].includes(actionName) && detailPath) {
                            this.recordWebArtifact(detailPath);
                        }
                        // A native action's name is not evidence that a model inspected
                        // pixels. Keep visual verification false unless a real image result
                        // has reached a vision-capable provider.
                        if (['browser_get_dom', 'read_browser_page'].includes(actionName)) {
                            this.webVerificationState.browserActUsed = true;
                        }
                    }
                }
                // If no tool calls, check if the agent is just thinking/planning or actually done
                if (!response.toolCalls || response.toolCalls.length === 0) {
                    const contentText = response.content || '';
                    const lower = contentText.toLowerCase();
                    const taskPrompt = (this.currentTaskPrompt || this.userPrompt || '').trim();
                    const isActionable = isActionableTaskPrompt(taskPrompt);
                    if (isActionable && isGenericHandoffResponse(contentText) && (hasExternalActions || this.stepsCompleted > 0)) {
                        this.emitEvent({ type: 'error', message: 'The provider returned a generic handoff after tool activity. The requested outcome was not verified; no completion is recorded.' });
                        this.memoryManager.saveHistory(this.messages);
                        break;
                    }
                    // A native workspace action already changed the workspace. Do not
                    // demand a Causyne tool call for the same work, and do not treat the
                    // turn as a no-op.
                    if (!hasExternalActions && failedExternalActions.length > 0 && this.consecutiveThinkingSteps < 2) {
                        this.consecutiveThinkingSteps++;
                        const blocked = failedExternalActions
                            .map((a) => `${a.name}${a.detail ? ` (${a.detail})` : ''}`)
                            .join(', ');
                        this.emitEvent({ type: 'status', message: 'Native action blocked; switching to Causyne tools...' });
                        this.emitEvent({ type: 'agent_activity', activity: 'Retrying blocked action through Causyne…' });
                        this.messages.push({
                            role: 'system',
                            content: `[SYSTEM NOTICE: Your native action(s) were blocked: ${blocked}. Do not retry native terminal or browser tools. Instead use Causyne's XML tool call format, for example <tool_call>{"name": "sysRun", "arguments": {"command": "..."}}</tool_call>.]`
                        });
                        this.memoryManager.saveHistory(this.messages);
                        continue;
                    }
                    const isQuestionOrGreeting = lower.includes('?') ||
                        lower.includes('let me know') ||
                        lower.includes('how can i help') ||
                        lower.includes('how may i help') ||
                        lower.includes('how can i assist') ||
                        lower.includes('what would you like') ||
                        lower.includes('what can i help') ||
                        lower.includes('feel free to');
                    // Action Enforcement on Step 0:
                    // If the user instructed an actionable task (e.g. "create a 3js game..."), but the model
                    // replied with a greeting, polite pleasantry, question, or refusal without calling any tools:
                    if (!hasExternalActions && this.stepsCompleted === 0 && isActionable && (isQuestionOrGreeting || lower.includes('hello') || lower.includes('hi '))) {
                        this.messages.pop();
                        if (this.consecutiveThinkingSteps >= 2) {
                            this.emitEvent({ type: 'error', message: 'The selected model did not follow the task after three attempts. No work was completed.' });
                            this.memoryManager.saveHistory(this.messages);
                            break;
                        }
                        this.consecutiveThinkingSteps++;
                        this.emitEvent({ type: 'status', message: 'Enforcing task execution: rejecting greeting on actionable instruction...' });
                        this.emitEvent({ type: 'agent_activity', activity: 'Enforcing tool execution…' });
                        this.messages.push({
                            role: 'system',
                            content: isLaunchOnlyPrompt(taskPrompt)
                                ? `[CURRENT TASK: "${taskPrompt}". The user asked to open the existing project. Inspect it, start its existing server in the background if needed, verify readiness, and open it. Do not write or edit files. Use the appropriate Causyne tools now.]`
                                : `[CRITICAL ACTION MANDATE: The user explicitly instructed: "${taskPrompt}". You responded with a greeting or inquiry without performing any actions or writing any code. Do NOT reply with greetings, pleasantries, or ask how to help. You must immediately invoke the appropriate tools (e.g., fs_write, sysRun) to implement the user's request.]`
                        });
                        this.memoryManager.saveHistory(this.messages);
                        continue;
                    }
                    const thinkingKeywords = ['let me ', "i'll ", 'i will ', 'now i ', 'next, i ', 'first, i ', 'checking ', 'trying to ', 'let us ', 'going to ', 'i shall', 'we will', 'i am going to'];
                    const isMidTaskProgress = !isQuestionOrGreeting && isMidTaskProgressText(contentText);
                    const isThinking = !isQuestionOrGreeting && (isMidTaskProgress || thinkingKeywords.some(kw => lower.includes(kw)));
                    if (!hasExternalActions && (isThinking || isIncompleteTurn) && this.consecutiveThinkingSteps < 3) {
                        this.consecutiveThinkingSteps++;
                        this.emitEvent({ type: 'status', message: 'Agent planning next steps...' });
                        this.emitEvent({ type: 'agent_activity', activity: 'Planning next actionable steps…' });
                        // assistantMsg was already pushed above — pushing it again here
                        // duplicated the whole turn in history on every nudge.
                        this.messages.push({
                            role: 'system',
                            content: isIncompleteTurn
                                ? '[SYSTEM NOTICE: Your previous turn ended before completion. Continue immediately from where you left off and invoke the next appropriate tool to complete the task.]'
                                : '[SYSTEM NOTICE: You provided reasoning/planning without calling any tools. Please invoke the next appropriate tool now to continue progressing on the task.]'
                        });
                        this.memoryManager.saveHistory(this.messages);
                        continue;
                    }
                    if (hasExternalActions && (isIncompleteTurn || isMidTaskProgress) && this.consecutiveThinkingSteps < 3) {
                        this.consecutiveThinkingSteps++;
                        if (response.content) {
                            this.emitEvent({ type: 'agent_message', content: response.content });
                        }
                        this.emitEvent({ type: 'status', message: 'Continuing task execution...' });
                        this.emitEvent({ type: 'agent_activity', activity: 'Continuing mid-task execution…' });
                        this.messages.push({
                            role: 'system',
                            content: isIncompleteTurn
                                ? '[SYSTEM NOTICE: Your previous turn ended while the task was still in progress. Continue immediately from where you left off and execute the remaining steps to complete the task.]'
                                : '[SYSTEM NOTICE: You announced the next step without executing it. Continue immediately from where you left off and execute the remaining file edits or tool calls to complete the task.]'
                        });
                        this.memoryManager.saveHistory(this.messages);
                        continue;
                    }
                    if (hasExternalActions) {
                        this.consecutiveThinkingSteps = 0;
                    }
                    if (!hasExternalActions && this.stepsCompleted === 0 && this.consecutiveThinkingSteps < 2) {
                        if (isActionable || lower.includes('turn completed') || lower.includes('no output produced') || !contentText.trim()) {
                            this.consecutiveThinkingSteps++;
                            this.emitEvent({ type: 'status', message: 'Nudging agent to execute actionable steps...' });
                            this.emitEvent({ type: 'agent_activity', activity: 'Nudging agent to invoke tools…' });
                            this.messages.push({
                                role: 'system',
                                content: `[SYSTEM NOTICE: An action or task was requested ("${taskPrompt}"), but no tools were called. Please invoke the appropriate tool by outputting: <tool_call>{"name": "tool_name", "arguments": {...}}</tool_call> to execute the task.]`
                            });
                            this.memoryManager.saveHistory(this.messages);
                            continue;
                        }
                    }
                    if (!hasExternalActions && this.stepsCompleted === 0 && isActionable) {
                        this.messages.pop();
                        this.emitEvent({ type: 'error', message: 'The selected model returned text without taking any action. No work was completed.' });
                        this.memoryManager.saveHistory(this.messages);
                        break;
                    }
                    // --- COMPLETION GUARDS ---
                    // Two hard rules learned the expensive way:
                    //   1. Match on word boundaries. Substring matching made 'ui' fire on
                    //      "build"/"quick"/"requirements" and 'race' fire on "trace",
                    //      dragging ordinary scripting tasks into game/web enforcement.
                    //   2. Fire at most once per task. These used to be gated on
                    //      consecutiveThinkingSteps, which resets on every tool call, so
                    //      a guard could block completion indefinitely and burn the whole
                    //      step budget on an already-finished task.
                    const isGameTask = !isLaunchOnlyPrompt(taskPrompt) && isGameIntent(taskPrompt);
                    this.gameToolStats = this.gameToolStats || { godot_act: 0, game_asset_fetch: 0, game_build_html5: 0, last_godot_action: null };
                    if (isGameTask && !this.gameGuardFired) {
                        // Production-depth enforcement is opt-in for full production tasks.
                        const needsDepth = this.config.enforceGameDepth === true && this.stepsCompleted < 50;
                        if (needsDepth) {
                            this.gameGuardFired = true;
                            this.emitEvent({ type: 'status', message: '⚡ Sovereign Game Guard: Checking production depth...' });
                            const guardMsg = `[SOVEREIGN DEPTH NOTICE: You are building a Full Production Game with enforceGameDepth enabled. Current step count: ${this.stepsCompleted}. Expand the game with more levels, richer UI, complex enemy AI, or more assets before finishing. If the task is genuinely complete, state so and finish.]`;
                            this.messages.push({ role: 'system', content: guardMsg });
                            this.memoryManager.saveHistory(this.messages);
                        }
                    }
                    // P6 — ANTI-SLOP GATE (Vision §7, ENFORCED)
                    //
                    // The visual guard below makes the agent LOOK at its work, but the
                    // agent was the only judge of what it saw — and a model that just
                    // emitted a purple gradient hero does not reliably call it generic.
                    // This reads the HTML/CSS actually written and scores it. Weighted and
                    // threshold-based, never a single tripwire: a guard with false
                    // positives gets switched off (the ZM-09 lesson).
                    if (!isLaunchOnlyPrompt(taskPrompt) && isWebIntent(taskPrompt) && this.webArtifacts.size > 0) {
                        try {
                            const files = [];
                            for (const artifactPath of this.webArtifacts) {
                                if (files.length >= 50)
                                    break;
                                try {
                                    const stat = fsSync.lstatSync(artifactPath);
                                    if (!stat.isFile() || stat.size > 512_000)
                                        continue;
                                    files.push({ path: artifactPath, content: fsSync.readFileSync(artifactPath, 'utf8') });
                                }
                                catch (_error) { /* deleted or moved since: nothing to judge */ }
                            }
                            if (files.length === 0) {
                                this.emitEvent({ type: 'error', message: 'Web design audit could not read the generated files; the result was not verified as complete.' });
                                this.memoryManager.saveHistory(this.messages);
                                break;
                            }
                            const result = analyzeFiles(files);
                            if (result.verdict === 'slop') {
                                const auditHash = createHash('sha256')
                                    .update(files.map(file => `${file.path}\0${file.content}`).join('\0'))
                                    .digest('hex');
                                const recent = Array.isArray(this.staticContext?.recentMovements) ? this.staticContext.recentMovements : [];
                                const brief = formatMovementBrief(suggestMovements(recent, 3));
                                auditLog.log({
                                    event: 'anti_slop_notice', taskId: this.taskId,
                                    score: result.score, signals: result.findings.map((f) => f.id)
                                });
                                this.emitEvent({ type: 'status', message: `⚡ Anti-Slop Audit: design scored ${result.score}` });
                                if (this.slopReviewAttempts >= 2 || auditHash === this.slopLastAuditHash) {
                                    this.emitEvent({ type: 'error', message: `Web design audit still found generic patterns (score ${result.score}); the result was not verified as complete.` });
                                    this.memoryManager.saveHistory(this.messages);
                                    break;
                                }
                                this.slopReviewAttempts++;
                                this.slopLastAuditHash = auditHash;
                                this.messages.push({ role: 'system', content: formatFindings(result, brief) });
                                this.memoryManager.saveHistory(this.messages);
                                continue;
                            }
                            if (result.findings.length > 0) {
                                auditLog.log({
                                    event: 'anti_slop_pass', taskId: this.taskId,
                                    score: result.score, verdict: result.verdict,
                                    signals: result.findings.map((f) => f.id)
                                });
                            }
                        }
                        catch (e) {
                            this.debugLog(`anti-slop gate failed: ${e.message}`);
                            this.emitEvent({ type: 'error', message: 'Web design audit failed; the result was not verified as complete.' });
                            this.memoryManager.saveHistory(this.messages);
                            break;
                        }
                    }
                    // Web Visual Validation Guard (Anti-Slop / Transcendence)
                    const isWebTask = !isLaunchOnlyPrompt(taskPrompt) && isWebIntent(taskPrompt);
                    if (isWebTask && !this.webGuardFired && this.stepsCompleted > 0) {
                        const hasVision = this.llm.supportsVision !== false;
                        // Finding D-6: this guard used to demand `screenshot` /
                        // `vision_inspect_ui` unconditionally. Both need the browser and
                        // capture packages, which are provisioned only after the user
                        // consents — so on a fresh install the guard was ordering the agent
                        // to use a tool that could not run. Ask for the capability once;
                        // if it was declined, fall through to the path that needs nothing.
                        let visionReady = false;
                        let visionDeclined = false;
                        let browserReady = false;
                        let browserDeclined = false;
                        let browserRuntimeError = '';
                        try {
                            const { groupStatus, isGroupDeclined } = await import('./provisioning/capabilityProvisioner.js');
                            visionReady = groupStatus('vision').state === 'ready';
                            visionDeclined = isGroupDeclined('vision');
                            browserReady = groupStatus('browser').state === 'ready';
                            browserDeclined = isGroupDeclined('browser');
                            if (browserReady) {
                                const { resolveBrowserRuntime } = await import('./browser/browserRuntime.js');
                                try {
                                    resolveBrowserRuntime();
                                }
                                catch (error) {
                                    browserReady = false;
                                    browserRuntimeError = error instanceof Error ? error.message : String(error);
                                }
                            }
                        }
                        catch (e) { /* treat as not ready */ }
                        let webGuardMsg = '';
                        if (browserRuntimeError) {
                            webGuardMsg = `[WEB CHECK: The browser capability is granted, but its runtime cannot launch: ${browserRuntimeError} Do not request the same grant again or claim a rendered-page check. Inspect the source and report the runtime blocker. This check fires once.]`;
                        }
                        else if (!browserReady && !browserDeclined) {
                            webGuardMsg = `[ANTI-SLOP CHECK: You are building a Web/UI project and must inspect it before finishing, but the dedicated browser capability is not enabled yet. Call \`manage_local_dependencies\` with action "grant_capability" and group "browser" to request the Causyne Browser runtime. If the user declines, read the final compiled HTML/CSS instead. This check fires once.]`;
                        }
                        else if (hasVision && !visionReady && !visionDeclined) {
                            webGuardMsg = `[ANTI-SLOP CHECK: The browser is available, but desktop screen capture is not enabled. Call \`manage_local_dependencies\` with action "grant_capability" and group "vision" to request it, or use \`browser_act\` snapshots and its workspace-scoped screenshot action. This check fires once.]`;
                        }
                        else if (hasVision && visionReady && !this.webVerificationState.screenshotTaken) {
                            webGuardMsg = `[ANTI-SLOP CHECK: You are building a Web/UI project but attempted to finish without VISUALLY verifying your work. Use \`screenshot\` or \`vision_inspect_ui\` to look at the UI in a browser. A saved file is not evidence that the model saw the image. If capture fails, report that visual verification was not completed. This check fires once.]`;
                        }
                        else if ((!hasVision || visionDeclined) && browserReady && !this.webVerificationState.browserActUsed && !this.webVerificationState.screenshotTaken) {
                            webGuardMsg = `[WEB CHECK: You are building a Web/UI project. Use \`browser_act\` with preview and a workspace-relative HTML filePath, then snapshot to inspect the rendered DOM. A screenshot file by itself is not visual inspection. If browser access fails, read the final HTML/CSS and report that visual verification was not completed. This check fires once.]`;
                        }
                        if (webGuardMsg) {
                            this.webGuardFired = true;
                            // The verification tools live in the web pack; make sure they are
                            // actually in context before demanding the agent use them.
                            this.unlockPack('web');
                            this.emitEvent({ type: 'status', message: '⚡ Anti-Slop Check: Visual/semantic verification recommended.' });
                            this.messages.push({ role: 'system', content: webGuardMsg });
                            this.memoryManager.saveHistory(this.messages);
                            if (browserReady || (hasVision && visionReady)) {
                                continue;
                            }
                        }
                    }
                    // Tool availability and a completed plan are not evidence of visual
                    // inspection. A failed browser/capture attempt must not become a
                    // successful task merely because the provider says "verified".
                    if (isWebTask && this.stepsCompleted > 0
                        && !this.webVerificationState.browserActUsed
                        && !this.webVerificationState.screenshotTaken) {
                        this.emitEvent({
                            type: 'error',
                            message: 'The web files may have changed, but rendered-page verification did not succeed. The task remains unverified; no completion is recorded.'
                        });
                        auditLog.log({ event: 'task_unverified', taskId: this.taskId, reason: 'web_render_not_inspected' });
                        this.memoryManager.saveHistory(this.messages);
                        break;
                    }
                    // Cold Observer: Overconfidence & Loop Verification Check
                    {
                        try {
                            const coldAudit = await coldObserver.auditTurnVerification({
                                taskId: this.taskId,
                                userPrompt: this.currentTaskPrompt || this.userPrompt || '',
                                agentClaim: response.content || '',
                                toolHistory: [],
                                stepsCompleted: this.stepsCompleted
                            });
                            if (coldAudit.overconfident) {
                                const recovery = this.timeMachine.observe('observer_verification', {}, {
                                    success: false, error: coldAudit.discrepancy
                                }, coldObserver.getToolOutcomes(this.taskId));
                                this.emitEvent({ type: 'status', message: `Cold Observer: ${coldAudit.discrepancy}` });
                                if (recovery.kind === 'stop') {
                                    this.stopRequested = true;
                                    this.emitEvent({ type: 'error', message: recoveryUserMessage(recovery, 'Verification') });
                                    break;
                                }
                                this.messages.push({
                                    role: 'system',
                                    content: `${coldAudit.coldDirective} ${recovery.guidance}`
                                });
                                this.memoryManager.saveHistory(this.messages);
                                continue;
                            }
                        }
                        catch (_err) {
                            // Cold observer fail-open
                        }
                    }
                    if (process.platform === 'darwin' && isDesktopWallpaperChangePrompt(taskPrompt)) {
                        const currentDesktopPictures = readMacDesktopPictures();
                        if (!this.initialDesktopPictures || !currentDesktopPictures || currentDesktopPictures === this.initialDesktopPictures) {
                            this.emitEvent({ type: 'error', message: 'The desktop wallpaper change was not confirmed by macOS readback. The task remains incomplete.' });
                            this.memoryManager.saveHistory(this.messages);
                            break;
                        }
                    }
                    if (response.content) {
                        this.emitEvent({ type: 'agent_message', content: response.content });
                    }
                    this.emitEvent({ type: 'status', message: 'Task completed.' });
                    this.memoryManager.saveHistory(this.messages); // Save final state
                    // The task worked. Keep the route so the next one like it does not
                    // have to rediscover it. Deterministic: we already watched every step
                    // run, so asking a model to summarise it would be paying for a worse
                    // copy of a fact we hold.
                    try {
                        const planPayload = {
                            prompt: this.currentTaskPrompt || this.userPrompt,
                            archetype: this.taskShape ? this.taskShape.archetype : '',
                            steps: this._planSteps || []
                        };
                        recordPlanAsync(planPayload).then((stored) => {
                            if (stored)
                                this.debugLog(`plan cached asynchronously: ${stored.steps.length} steps, ${stored.wins}/${stored.uses} wins`);
                        }).catch(() => { });
                        recordAPCPipelineLatency({
                            planMs: this._totalPlanMs || 0,
                            actMs: this._totalActMs || 0,
                            cacheLookupMs: this._planMatch?.telemetry?.lookupMs || 0,
                            totalMs: performance.now() - (this._taskStartedAt || performance.now())
                        });
                    }
                    catch (e) {
                        this.debugLog(`plan cache write skipped: ${e.message}`);
                    }
                    auditLog.log({ event: 'task_complete', taskId: this.taskId, steps: this.stepsCompleted });
                    this.emitEvent({ type: 'task_complete', taskId: this.taskId });
                    break;
                }
                this.consecutiveThinkingSteps = 0; // Reset thinking counter when tools are called
                // 3a. PREFETCH — run the independent read-only calls of this batch
                // concurrently (finding D-8).
                //
                // Every competitive agent batches independent reads; this loop executed
                // them strictly one after another, so six `fs_read`s cost six full
                // round trips of tool latency.
                //
                // The serial loop below preserves ordering and approval gates. The
                // only difference from prefetching is that a
                // read-only result may already be sitting in this map by the time the
                // loop reaches it. Restructuring the 400-line body into a batch would
                // have been the obvious approach and a far worse one: it is dense with
                // `break`s, approval waits and circuit breakers, and a subtle reordering
                // there is exactly the class of silent defect this whole remediation
                // exists to clean up.
                //
                // Safety rules that make this sound:
                //   * Only tools on the read-only allowlist are eligible. Nothing that
                //     writes, deletes, executes or asks for approval is ever prefetched.
                //   * The sandbox is consulted FIRST, with the same call the serial path
                //     makes, so a denied path is never read behind the guard's back.
                //   * Only a SUCCESSFUL prefetch is consumed. A failure is discarded and
                //     the serial path executes normally, so TimeMachine sees its outcome.
                const prefetched = this.prefetchReadOnlyCalls(response.toolCalls);
                // 3. ACT (Execute tool calls)
                for (const toolCall of response.toolCalls) {
                    if (this.stopRequested || this.abortController?.signal?.aborted)
                        break;
                    // Canonicalise once, here. Every downstream comparison — the sandbox's
                    // risk classification, the approval gates, the game cascade lists —
                    // matches on this string, so if it is not the catalogue name those
                    // checks silently never fire.
                    const functionName = canonicalToolName(toolCall.function.name);
                    const tool = resolveTool(functionName);
                    const toolSchema = tool?.schema?.parameters || tool?.schema?.input_schema;
                    const repair = selfRepairToolCall(toolCall, toolSchema, {
                        cwd: this.workspaceRoot || process.cwd()
                    });
                    if (repair.error) {
                        this.messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: functionName,
                            content: JSON.stringify({
                                success: false,
                                error: `Invalid JSON in arguments: ${repair.error}`,
                                selfRepairGuidance: {
                                    tool: functionName,
                                    instruction: 'Ensure arguments are passed as a valid JSON object without unescaped control characters or trailing commas.'
                                }
                            })
                        });
                        continue;
                    }
                    let args = repair.args;
                    const phaseAdmission = this.smartToolsGovernor.interceptAction(functionName, args || {});
                    if (!phaseAdmission.allowed) {
                        this.messages.push({ role: 'tool', tool_call_id: toolCall.id, name: functionName,
                            content: JSON.stringify({ success: false, checkpoint: 'synthesis', error: phaseAdmission.reason }) });
                        auditLog.log({ event: 'smart_tools_checkpoint', taskId: this.taskId, tool: functionName, phase: 'synthesis' });
                        continue;
                    }
                    if (repair.repaired && repair.repairs.length > 0) {
                        this.debugLog(`[TOOL SELF-REPAIR] Healed tool call '${functionName}': ${repair.repairs.join(', ')}`);
                    }
                    if (isLaunchOnlyPrompt(this.currentTaskPrompt || this.userPrompt || '')) {
                        const scopeError = launchScopeError(functionName, args || {});
                        if (scopeError) {
                            this.emitEvent({ type: 'step_error', tool: functionName, error: scopeError, toolCallId: toolCall.id });
                            this.messages.push({ role: 'tool', tool_call_id: toolCall.id, name: functionName,
                                content: JSON.stringify({ success: false, error: scopeError }) });
                            continue;
                        }
                        if (args && ['sysRun', 'sysRunBg', 'terminal_persistent_shell'].includes(functionName) && !args.cwd) {
                            args.cwd = this.workspaceRoot;
                        }
                    }
                    // Universal Repetition & Infinite Loop Circuit Breakers (Token Hemorrhage Guard)
                    if (!Array.isArray(this.recentActionSignatures)) {
                        this.recentActionSignatures = [];
                    }
                    let actionSig = `${functionName}:${JSON.stringify(args || {})}`;
                    if (functionName === 'sysRun' || functionName === 'sysRunBg') {
                        const rawCmd = String(args?.command || '').trim();
                        if (/python[0-9.]*\s+.*import\s+numpy/i.test(rawCmd)) {
                            actionSig = 'sysRun:probe:numpy';
                        }
                        else if (/python[0-9.]*\s+(--version|-V|-c\s+['"]print)/i.test(rawCmd)) {
                            actionSig = 'sysRun:probe:python';
                        }
                        else if (/node\s+(--version|-v)/i.test(rawCmd)) {
                            actionSig = 'sysRun:probe:node';
                        }
                        else if (/(?:ps\s+aux|pgrep|lsof|netstat|ss\s+-)/i.test(rawCmd)) {
                            actionSig = 'sysRun:probe:process_or_port';
                        }
                        else {
                            actionSig = `${functionName}:${rawCmd.replace(/\s+/g, ' ')}`;
                        }
                    }
                    // Always record action signature into recent history FIRST
                    this.recentActionSignatures.push(actionSig);
                    if (this.recentActionSignatures.length > 20) {
                        this.recentActionSignatures.shift();
                    }
                    // Universal Intelligent Loop Guard & Stall Breaker (Hermes / Claude Code architecture)
                    const isExecTask = isExecutionOrLaunchTaskPrompt(this.currentTaskPrompt || this.userPrompt || '');
                    const isAuthoringTask = !isExecTask && isCodeAuthoringTaskPrompt(this.currentTaskPrompt || this.userPrompt || '');
                    const guardDecision = this.stallGuard.beforeCall(functionName, args || {}, {
                        isAuthoringTask
                    });
                    if (guardDecision.action === 'block') {
                        this.emitEvent({ type: 'step_error', tool: functionName, error: guardDecision.message, toolCallId: toolCall.id });
                        auditLog.log({ event: 'tool_blocked', taskId: this.taskId, tool: functionName, args, reason: guardDecision.message });
                        this.messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: functionName,
                            content: JSON.stringify({
                                success: false,
                                error: guardDecision.code,
                                CRITICAL_INSTRUCTION: guardDecision.message
                            })
                        });
                        continue;
                    }
                    if (guardDecision.action === 'halt') {
                        this.emitEvent({ type: 'step_error', tool: functionName, error: guardDecision.message, toolCallId: toolCall.id });
                        auditLog.log({ event: 'task_killed_circuit_breaker', taskId: this.taskId, reason: guardDecision.message });
                        this.abort();
                        break;
                    }
                    if (isAuthoringTask && this.stallGuard.distinctInspectionCount === 12) {
                        this.messages.push({
                            role: 'system',
                            content: `[CRITICAL ACTION MANDATE: You have performed 12 consecutive inspection steps without writing code. If you have gathered sufficient context, proceed to creating or editing implementation files using fs_write/fs_edit.]`
                        });
                    }
                    this.emitEvent({ type: 'step_start', tool: functionName, args: args, toolCallId: toolCall.id });
                    const codeAction = codeProgressFromAction(functionName, args || {}, toolCall.id);
                    if (codeAction)
                        this.emitEvent(codeAction);
                    this.consecutiveCommands++;
                    // Sovereign Game Pre-Flight Interceptor (v1.3.13)
                    const isGameTaskExec = !isLaunchOnlyPrompt(this.currentTaskPrompt || this.userPrompt || '') && isGameIntent(this.currentTaskPrompt || this.userPrompt || '');
                    const ALL_GAME_TOOLS_LIST = [
                        'godot_act', 'game_asset_fetch', 'game_build_html5',
                        'game_lore_forge', 'game_dialogue_tree_gen', 'game_quest_arc_builder',
                        'game_animation_rig', 'game_ai_behavior_tree', 'game_cinematic_sequencer',
                        'game_asset_harvest', 'game_audio_synth', 'game_vfx_emitter_gen',
                        'game_shader_forge', 'game_scene_build', 'game_entity_spawner',
                        'game_tilemap_gen', 'game_ui_hud_builder', 'game_economy_balancer',
                        'game_data_forge', 'check_system_specs', 'game_web_runtime_inspector', 'game_canvas_audit'
                    ];
                    if (ALL_GAME_TOOLS_LIST.includes(functionName)) {
                        // Stage progression
                        if (['check_system_specs', 'godot_act'].includes(functionName))
                            this.gameCascadeState.currentStage = Math.max(this.gameCascadeState.currentStage, 2);
                        if (['game_lore_forge', 'game_dialogue_tree_gen', 'game_quest_arc_builder'].includes(functionName))
                            this.gameCascadeState.currentStage = Math.max(this.gameCascadeState.currentStage, 3);
                        if (['game_animation_rig', 'game_ai_behavior_tree', 'game_cinematic_sequencer'].includes(functionName))
                            this.gameCascadeState.currentStage = Math.max(this.gameCascadeState.currentStage, 4);
                        if (['game_asset_harvest', 'game_audio_synth', 'game_vfx_emitter_gen'].includes(functionName))
                            this.gameCascadeState.currentStage = Math.max(this.gameCascadeState.currentStage, 5);
                        if (['game_shader_forge', 'game_scene_build', 'game_entity_spawner'].includes(functionName))
                            this.gameCascadeState.currentStage = Math.max(this.gameCascadeState.currentStage, 6);
                        if (['game_tilemap_gen', 'game_ui_hud_builder', 'game_economy_balancer', 'game_build_html5'].includes(functionName))
                            this.gameCascadeState.currentStage = Math.max(this.gameCascadeState.currentStage, 7);
                        if (functionName === 'game_web_runtime_inspector' || functionName === 'game_canvas_audit') {
                            this.gameCascadeState.verificationPassed = true;
                        }
                    }
                    // Sovereign Cascade Intercept neutralized: coding and execution tools execute freely without artificial stage enforcement.
                    if (functionName === 'game_build_html5' && args.template === 'custom' && args.customScript) {
                        const scr = args.customScript;
                        if (scr.includes('c.drw ?') && !scr.includes('drw(')) {
                            this.messages.push({
                                role: 'tool', tool_call_id: toolCall.id, name: functionName,
                                content: JSON.stringify({ success: false, error: 'AST SANITIZER: Detected ternary check for c.drw but no actual drw() method definition found! Fix and retry.' })
                            });
                            continue;
                        }
                        if (scr.includes('ctx.translate(-cam.x, -cam.y)') && (scr.includes('c.x - cam.x') || scr.includes('c.y - cam.y'))) {
                            this.messages.push({
                                role: 'tool', tool_call_id: toolCall.id, name: functionName,
                                content: JSON.stringify({ success: false, error: 'AST SANITIZER: Detected double translation! You are translating context by cam and then manually subtracting cam again inside drawing calls!' })
                            });
                            continue;
                        }
                    }
                    // 4-Layer Security Sandbox Validation
                    // 2. Sandbox Security Validation (CRITICAL FIX: Prevent Infinite Loop on Block)
                    const validation = this.sandbox.validate(functionName, args);
                    if (!validation.allowed) {
                        this.consecutiveBlockedActions++;
                        // Hard Circuit Breaker (Transcendence Context Consciousness)
                        if (this.consecutiveBlockedActions >= 4) {
                            const fatalMsg = `FATAL ERROR: Infinite Token Drain Detected. Agent repeatedly attempted blocked/forbidden actions 4 times in a row. Forcibly aborting task to save tokens.`;
                            this.emitEvent({ type: 'step_error', tool: functionName, error: fatalMsg, toolCallId: toolCall.id });
                            auditLog.log({ event: 'task_killed_circuit_breaker', taskId: this.taskId, reason: fatalMsg });
                            // Save memory of failure for RLTF
                            cortexDb.saveMemory(this.currentTaskPrompt || 'Unknown task', 'Agent stubbornly repeated blocked actions causing an infinite loop.', `Do NOT repeat ${functionName} with these exact arguments, as it is permanently blocked by Sandbox. Ensure you respect ALLOWED WORKSPACE PATHS.`).catch(() => { });
                            this.abort();
                            break;
                        }
                        auditLog.log({ event: 'tool_blocked', taskId: this.taskId, tool: functionName, args, reason: validation.reason });
                        coldObserver.recordToolOutcome(this.taskId, functionName, args, {
                            success: false,
                            error: validation.reason
                        });
                        this.emitEvent({ type: 'step_error', tool: functionName, error: validation.reason, toolCallId: toolCall.id });
                        // Feed error back to LLM with absolute command to stop repeating
                        this.messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: functionName,
                            content: JSON.stringify({
                                success: false,
                                error: validation.reason,
                                CRITICAL_INSTRUCTION: "DO NOT RETRY THIS EXACT ACTION. The Sandbox blocked it. Ensure you only write to paths inside ALLOWED WORKSPACE PATHS, or use a different approach. Repeating this will drain tokens."
                            })
                        });
                        continue;
                    }
                    this.consecutiveBlockedActions = 0; // Reset counter on allowed action
                    // Resolve and validate before asking the user for approval. Unknown or
                    // malformed calls should self-correct without creating approval fatigue.
                    if (!tool || typeof tool.execute !== 'function') {
                        this.messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: functionName,
                            content: JSON.stringify({
                                success: false,
                                error: `Tool "${functionName}" does not exist. Call tool_search with a description of the capability you need to discover the correct tool.`
                            })
                        });
                        continue;
                    }
                    if (!isCoreTool(functionName) && !this.unlockedTools.has(functionName)) {
                        const pack = packForTool(functionName);
                        if (this.unlockPack(pack)) {
                            this.debugLog(`unlocked capability pack "${pack}" for ${functionName}`);
                        }
                        this.unlockedTools.add(functionName);
                    }
                    const validationErrors = this.validateToolArgs(functionName, args);
                    if (validationErrors) {
                        const diagnostic = generateSelfRepairDiagnostic(functionName, args, validationErrors, tool?.schema?.parameters || tool?.schema?.input_schema);
                        this.messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: functionName,
                            content: JSON.stringify(diagnostic)
                        });
                        continue;
                    }
                    const checkpointError = this.mutationCheckpoint(functionName, args);
                    if (checkpointError) {
                        this.messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: functionName,
                            content: JSON.stringify({
                                success: false,
                                error: checkpointError
                            })
                        });
                        continue;
                    }
                    // A policy hook runs after the built-in sandbox but before any user
                    // approval prompt, so a deterministic denial never asks the user to
                    // approve work that will be rejected anyway.
                    const preHook = await this.runPreToolUse(functionName, args, toolCall.id);
                    if (preHook && preHook.denied) {
                        auditLog.log({
                            event: 'hook_denied', taskId: this.taskId, hookEvent: 'PreToolUse',
                            tool: functionName, reason: preHook.reason || 'hook denied'
                        });
                        coldObserver.recordToolOutcome(this.taskId, functionName, args, {
                            success: false,
                            error: `PreToolUse hook denied "${functionName}".`
                        });
                        this.messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: functionName,
                            content: JSON.stringify({
                                success: false,
                                error: `PreToolUse hook denied "${functionName}".`,
                                hookFeedback: (preHook.messages || []).join('\n') || undefined
                            })
                        });
                        continue;
                    }
                    // Approval flow for dangerous actions (Mode A/B) or ALWAYS for heavy AI downloads
                    // The schema name is manage_local_dependencies. Comparing against the
                    // old alias meant this consent gate never fired and multi-GB model
                    // downloads ran unannounced.
                    const isHeavyAiDownload = functionName === 'manage_local_dependencies' &&
                        ['pipInst', 'fetchBin', 'fetchMod'].includes(args.action);
                    // Cold Observer: Assess blast radius and mutation risk
                    try {
                        const coldMutation = await coldObserver.evaluateMutation(functionName, args, {
                            workspaceRoot: this.workspaceRoot
                        });
                        if (coldMutation.veto) {
                            this.emitEvent({
                                type: 'status',
                                message: `Cold Observer Veto: Action blocked (${coldMutation.reason})`
                            });
                            coldObserver.recordToolOutcome(this.taskId, functionName, args, {
                                success: false,
                                error: `[COLD OBSERVER VETO]: ${coldMutation.reason}`
                            });
                            this.messages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                name: functionName,
                                content: JSON.stringify({
                                    success: false,
                                    error: `[COLD OBSERVER VETO]: ${coldMutation.reason}. Modify your approach to avoid project damage.`
                                })
                            });
                            continue;
                        }
                        if (coldMutation.requiresConfirmation) {
                            validation.risk = 'dangerous';
                        }
                    }
                    catch (_err) {
                        // Cold observer mutation assessment fail-open
                    }
                    // A standing grant can avoid repeat prompts in supervised modes.
                    // Mode C is autonomous for in-scope work. Whole-file deletion asks
                    // unless this session explicitly granted the fs_delete tool; a broad
                    // shell grant cannot authorize deletion. Sandbox denials and observer
                    // vetoes have already run and are never lifted by prompt policy.
                    const standingApproval = this.isAlwaysAllowed(functionName);
                    const needsToolApproval = requiresToolApproval({
                        mode: this.config.autonomyMode || 'C',
                        tool: functionName,
                        args,
                        risk: validation.risk,
                        heavyDownload: isHeavyAiDownload,
                        standingApproval
                    });
                    if (standingApproval && !needsToolApproval && this.config.autonomyMode !== 'C') {
                        auditLog.log({
                            event: 'approval_auto_granted', taskId: this.taskId,
                            tool: functionName, risk: validation.risk, reason: 'allow_always'
                        });
                    }
                    if (needsToolApproval) {
                        // Wait for local approval
                        this.emitEvent({ type: 'approval_request', toolCallId: toolCall.id, tool: functionName, args, risk: validation.risk });
                        const approved = await this.waitForApproval(toolCall.id);
                        if (!approved) {
                            if (this.stopRequested || this.abortController?.signal?.aborted)
                                break;
                            coldObserver.recordToolOutcome(this.taskId, functionName, args, {
                                success: false,
                                error: 'User denied this action'
                            });
                            this.messages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                name: functionName,
                                content: JSON.stringify({ success: false, error: 'User denied this action' })
                            });
                            continue;
                        }
                    }
                    // P2: snapshot the files this call is about to change, before it runs.
                    // Only the mutating fs tools match; everything else returns immediately.
                    // Fail-open by contract — this can never block or fail a tool call.
                    const restorePoints = captureBeforeMutation(functionName, args, {
                        taskId: this.taskId,
                        step: this.stepsCompleted
                    });
                    // Say that a restore point exists.
                    //
                    // The ids came back and were dropped on the floor, so checkpointing
                    // ran on every mutating call and the user was never told — /undo was
                    // there the whole time with nothing pointing at it. On the Stage this
                    // also marks the rail, which is what makes scrolling back double as
                    // finding somewhere to roll back TO.
                    if (restorePoints.length > 0) {
                        this.emitEvent({
                            type: 'checkpoint',
                            taskId: this.taskId,
                            count: restorePoints.length,
                            tool: functionName,
                            path: args.path || args.file_path || null,
                            step: this.stepsCompleted
                        });
                    }
                    // TimeMachine tracks actual failures across tool results and thrown
                    // errors. It only rewinds reasoning; it never replays side effects.
                    let result;
                    let duration;
                    this.efficiencyBudget.recordAction();
                    try {
                        const startTime = Date.now();
                        const actStart = performance.now();
                        // A concurrent read from the prefetch pass above, if it succeeded.
                        const ready = prefetched.get(toolCall.id);
                        const early = ready ? await ready : null;
                        result = (early && early.success)
                            ? early
                            : await withToolAutonomyMode(this.config.autonomyMode || 'C', () => tool.execute(args, { signal: this.abortController.signal, parentLoop: this, ...this.sandbox }));
                        duration = Date.now() - startTime;
                        this._totalActMs = (this._totalActMs || 0) + (performance.now() - actStart);
                    }
                    catch (toolError) {
                        if (this.stopRequested || this.abortController?.signal?.aborted || toolError?.name === 'AbortError') {
                            auditLog.log({ event: 'task_interrupted', taskId: this.taskId, tool: functionName });
                            break;
                        }
                        duration = 0;
                        const errorType = this.classifyError(toolError);
                        const failure = { success: false, error: String(toolError?.message || toolError) };
                        const alternativeRoute = lookupAlternativeStep({
                            failedTool: functionName,
                            why: failureClass(failure),
                            archetype: this.taskShape?.archetype
                        });
                        if (alternativeRoute) {
                            this.debugLog(`[APC RE-PLANNING] Learned alternative: ${alternativeRoute.suggestedTool} (${alternativeRoute.reason})`);
                        }
                        coldObserver.recordToolOutcome(this.taskId, functionName, args, failure);
                        const recovery = this.timeMachine.observe(functionName, args, failure, coldObserver.getToolOutcomes(this.taskId));
                        auditLog.log({ event: 'tool_failure', taskId: this.taskId,
                            tool: functionName, attempt: recovery.attempt, errorType });
                        if (codeAction)
                            this.emitEvent({ ...codeAction, phase: 'failed' });
                        this.emitEvent({ type: 'step_error', tool: functionName,
                            error: `${errorType}: ${failure.error} (${recovery.attempt}/${recovery.maxAttempts})`,
                            toolCallId: toolCall.id });
                        this.messages.push({ role: 'tool', tool_call_id: toolCall.id,
                            name: functionName, content: JSON.stringify({ ...failure,
                                errorType, timeMachine: recovery.guidance,
                                ...(alternativeRoute ? { apcReplanAlternative: alternativeRoute.suggestedTool, apcReplanReason: alternativeRoute.reason } : {}) }) });
                        this.stallGuard.observeCall(functionName, args || {}, failure, toolCall.id, true);
                        this.memoryManager.saveHistory(this.messages);
                        if (errorType === 'fatal' || recovery.kind === 'stop' || recovery.kind === 'human') {
                            this.stopRequested = true;
                            this.emitEvent({ type: 'error', message: recoveryUserMessage(recovery, functionName) });
                            break;
                        }
                        continue;
                    }
                    auditLog.log({
                        event: 'tool_exec',
                        taskId: this.taskId,
                        tool: functionName,
                        success: result.success,
                        duration_ms: duration
                    });
                    // Stage 3 seam: PostToolUse hook. A no-op that always allows today; when
                    // hooks are configured it can mark a completed call failed (e.g. a
                    // formatter rejecting a write) so the model sees it. Neutral until then.
                    const postHook = await this.runPostToolUse(functionName, args, result);
                    if (postHook && postHook.denied) {
                        result = {
                            ...result,
                            success: false,
                            error: postHook.reason || `PostToolUse hook rejected "${functionName}".`,
                            hookFeedback: (postHook.messages || []).join('\n') || undefined
                        };
                    }
                    if (result && result.success !== false && !result.error && ['fs_write', 'fs_edit', 'MultiEdit'].includes(functionName)) {
                        this.recordWebArtifact(args.path || args.file_path);
                    }
                    if (['screenshot', 'vision_inspect_ui'].includes(functionName) && this.llm.supportsVision !== false && result?.success === true && result?._is_image_marker === true) {
                        this.webVerificationState.screenshotTaken = true;
                    }
                    if (functionName === 'browser_act' && result?.success === true) {
                        const browserResults = Array.isArray(result.data) ? result.data : [];
                        if (browserResults.some((item) => ['snapshot', 'scrape'].includes(item?.action))) {
                            this.webVerificationState.browserActUsed = true;
                        }
                    }
                    // The journal is the observer's own record of what actually ran. It
                    // is written only after post-hook review, so a formatter that rejects
                    // a write is remembered as a failure rather than a success.
                    const observedResult = result?._is_image_marker === true
                        ? { success: true, _is_image_marker: true, filename: result.filename, mimeType: result.mimeType }
                        : result;
                    coldObserver.recordToolOutcome(this.taskId, functionName, args, observedResult);
                    const recovery = this.timeMachine.observe(functionName, args, observedResult, coldObserver.getToolOutcomes(this.taskId));
                    if (recovery.kind === 'replan') {
                        this.emitEvent({ type: 'status', message: `TimeMachine: approach change after ${recovery.attempt} failed attempts.` });
                    }
                    if (recovery.kind === 'stop' || recovery.kind === 'human') {
                        this.stopRequested = true;
                        this.emitEvent({ type: 'error', message: recoveryUserMessage(recovery, functionName) });
                    }
                    if (result && (result.success === false || typeof result.error === 'string')) {
                        result = { ...result, timeMachine: recovery.guidance };
                    }
                    if (this.stopRequested) {
                        this.messages.push({ role: 'tool', tool_call_id: toolCall.id,
                            name: functionName, content: JSON.stringify(result) });
                        this.memoryManager.saveHistory(this.messages);
                        break;
                    }
                    // PROGRESSIVE DISCLOSURE: honour unlock signals from tool_search.
                    // The control fields are stripped before the result reaches the LLM.
                    if (result && (result._unlock_tools || result._unlock_packs)) {
                        for (const packName of result._unlock_packs || []) {
                            this.unlockPack(packName);
                        }
                        for (const toolName of result._unlock_tools || []) {
                            this.unlockedTools.add(toolName);
                        }
                        delete result._unlock_tools;
                        delete result._unlock_packs;
                        this.debugLog(`capability packs loaded: ${[...this.unlockedPacks].join(', ') || 'core only'}`);
                    }
                    // Buffer output for disconnect resilience
                    await this.taskBuffer.appendOutput(this.taskId, { tool: functionName, result: observedResult });
                    if (codeAction)
                        this.emitEvent({ ...codeAction,
                            phase: result?.success === false || typeof result?.error === 'string' ? 'failed' : 'done' });
                    this.emitEvent({ type: result?.success === false || typeof result?.error === 'string' ? 'step_error' : 'step_complete',
                        tool: functionName, result: result._is_image_marker ? '[IMAGE DATA]' : result, toolCallId: toolCall.id });
                    this.stepsCompleted++;
                    // The procedure, as it actually ran. Tool name plus a whitelisted
                    // action token only — planCache.toStep() reads no paths, arguments or
                    // command lines, so what is cached is a route and never a transcript.
                    try {
                        if (Array.isArray(this._planSteps)) {
                            const stepSuccess = Boolean(result && result.success !== false && !result.error);
                            this._planSteps.push(toStep(functionName, args, stepSuccess, result));
                            this._lastToolResult = observedResult;
                            // Active Inference: Record step prediction error into VFE rolling tracker
                            if (this.vfeTracker) {
                                const isThrash = isThrashing((this._planSteps || []).map((s) => s.tool), functionName);
                                const vfeOutcome = this.vfeTracker.recordStep({
                                    tool: functionName,
                                    success: stepSuccess,
                                    result,
                                    consecutiveFailures: this.consecutiveFailures,
                                    isThrashing: isThrash
                                });
                                if (vfeOutcome.paradigmShift) {
                                    this.debugLog(`[ACTIVE INFERENCE] VFE plateau detected: mean=${vfeOutcome.mean}, var=${vfeOutcome.variance}. Triggering paradigm shift.`);
                                    this._paradigmShiftPending = true;
                                }
                            }
                        }
                    }
                    catch (e) { /* a plan is never worth failing a step for */ }
                    const ALL_GAME_TOOLS = [
                        'godot_act', 'game_asset_fetch', 'game_build_html5',
                        'game_lore_forge', 'game_dialogue_tree_gen', 'game_quest_arc_builder',
                        'game_animation_rig', 'game_ai_behavior_tree', 'game_cinematic_sequencer',
                        'game_asset_harvest', 'game_audio_synth', 'game_vfx_emitter_gen',
                        'game_shader_forge', 'game_scene_build', 'game_entity_spawner',
                        'game_tilemap_gen', 'game_ui_hud_builder', 'game_economy_balancer',
                        'game_data_forge', 'check_system_specs', 'game_web_runtime_inspector', 'game_canvas_audit'
                    ];
                    if (ALL_GAME_TOOLS.includes(functionName)) {
                        // this.hasUsedGameTools is deprecated by this.gameCascadeState
                        this.gameToolStats = this.gameToolStats || { godot_act: 0, game_asset_fetch: 0, game_build_html5: 0, last_godot_action: null };
                        this.gameToolStats[functionName] = (this.gameToolStats[functionName] || 0) + 1;
                        if (functionName === 'godot_act' && args && args.action) {
                            this.gameToolStats.last_godot_action = args.action;
                        }
                    }
                    // Sovereign 100-Step Circuit Breaker Checkpoint Gate
                    if (this.consecutiveCommands === 100 && !this.circuitBreakerUnlocked) {
                        if (this.config.autonomyMode === 'C') {
                            this.circuitBreakerUnlocked = true;
                            this.emitEvent({ type: 'status', message: `Continuing within the configured ${this.maxSteps}-step task limit.` });
                        }
                        else {
                            this.emitEvent({
                                type: 'approval_request',
                                toolCallId: 'circuit_breaker_100_' + this.stepsCompleted,
                                tool: 'circuit_breaker_checkpoint',
                                args: {
                                    consecutiveCommands: this.consecutiveCommands,
                                    stepsCompleted: this.stepsCompleted,
                                    activeTier: this.activeTier,
                                    maxTierSteps: this.maxSteps,
                                    message: `⚡ Circuit Breaker Checkpoint (100 steps reached). Approve to unlock and continue using your remaining ${this.activeTier.toUpperCase()} tier budget (up to ${this.maxSteps} steps total)?`
                                },
                                risk: 'info'
                            });
                            const approved = await this.waitForApproval('circuit_breaker_100_' + this.stepsCompleted);
                            if (!approved) {
                                this.stopRequested = true;
                                this.emitEvent({ type: 'status', message: 'Task stopped at 100-step circuit breaker checkpoint by user.' });
                                break;
                            }
                            this.circuitBreakerUnlocked = true;
                            this.emitEvent({ type: 'status', message: `⚡ Circuit breaker unlocked! Resuming execution up to ${this.maxSteps} tier budget...` });
                        }
                    }
                    // Sovereign Tier Budget Extension Checkpoint Gate
                    if (this.stepsCompleted >= this.maxSteps) {
                        if (this.config.autonomyMode === 'C') {
                            this.stopRequested = true;
                            this.emitEvent({ type: 'error', message: `Task reached the configured ${this.maxSteps}-step limit without verified completion.` });
                        }
                        else {
                            const extensionBatch = (this.activeTier === 'super_max') ? 600 : ((this.activeTier === 'max') ? 400 : 300);
                            this.emitEvent({
                                type: 'approval_request',
                                toolCallId: 'tier_extension_' + this.stepsCompleted,
                                tool: 'tier_budget_extension',
                                args: {
                                    stepsCompleted: this.stepsCompleted,
                                    activeTier: this.activeTier,
                                    currentMaxSteps: this.maxSteps,
                                    message: `⚡ Tier Limit Reached (${this.stepsCompleted} / ${this.maxSteps} steps). The agent needs more steps to fulfill your intent. Approve to unlock another +${extensionBatch} steps for your ${this.activeTier.toUpperCase()} tier?`
                                },
                                risk: 'info'
                            });
                            const approved = await this.waitForApproval('tier_extension_' + this.stepsCompleted);
                            if (!approved) {
                                this.stopRequested = true;
                                this.emitEvent({ type: 'status', message: `Task stopped at ${this.maxSteps}-step tier limit by user.` });
                                break;
                            }
                            this.maxSteps += extensionBatch;
                            this.maxCircuitBreaker = this.maxSteps;
                            this.emitEvent({ type: 'status', message: `⚡ Tier budget extended (+${extensionBatch} steps unlocked, new limit: ${this.maxSteps}). Resuming task...` });
                        }
                    }
                    // SmartToolsUse tracks actual local tool calls, without denying
                    // useful inspection during long research or code tasks.
                    const phaseNudge = this.smartToolsGovernor.observe(functionName, args || {}, result);
                    if (phaseNudge)
                        this._smartToolsNudge = phaseNudge;
                    else if (this.smartToolsGovernor.snapshot().phase === 'execution')
                        this._smartToolsNudge = null;
                    // Feed result back to LLM (4. OBSERVE)
                    if (result && result._is_image_marker) {
                        if (!this.llm.supportsVision) {
                            // Fallback when vision streaming payload is not active on model
                            this.messages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                name: functionName,
                                content: `[Image captured: ${result.filename || 'image'} (${result.mimeType || 'image/png'}). This provider cannot receive image pixels; visual inspection was not completed.]`
                            });
                        }
                        else {
                            // Provider-specific format.
                            //
                            // This used to read `this.llm.constructor.name.includes('OpenAI')`.
                            // Constructor names are not a stable provider identifier and can
                            // change during packaging. Each provider declares its wire shape
                            // explicitly.
                            const imageContent = this.llm.imagePayloadFormat === 'openai' ? {
                                type: "image_url",
                                image_url: { url: `data:${result.mimeType};base64,${result.base64}` }
                            } : {
                                type: "image",
                                source: {
                                    type: "base64",
                                    media_type: result.mimeType,
                                    data: result.base64
                                }
                            };
                            // We MUST push the tool return FIRST so tool_calls is immediately followed by tool messages
                            this.messages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                name: functionName,
                                content: `Image successfully captured: ${result.filename || 'image'}. Passing to vision observation.`
                            });
                            // Then push the user observation message containing the image data block
                            this.messages.push({
                                role: 'user',
                                content: [
                                    imageContent,
                                    {
                                        type: "text",
                                        text: `Image successfully loaded into vision context: ${result.filename || ''}`
                                    }
                                ]
                            });
                        }
                    }
                    else {
                        // SOVEREIGN CONTEXT WINDOW PROTECTION.
                        // The previous implementation spread `...result` and only shortened
                        // `output`, so tools that return their payload under a different key
                        // (browser_act and blender_act return `log`) leaked the full
                        // untruncated blob into history — and gained a redundant `output`
                        // field on top. Truncate whichever string field is actually large.
                        let resultString = JSON.stringify(result);
                        // Per tool, not one number for all of them. A build log and a
                        // source file are not equally worth their space in the window.
                        const MAX_RESULT_CHARS = resultCapFor(functionName);
                        let spill = null;
                        if (resultString.length > MAX_RESULT_CHARS) {
                            // A1: spill the WHOLE result to disk before shortening it. The
                            // previous code threw the overflow away, so the only way back to
                            // it was re-running the tool — a second full execution and a
                            // second full-size result in the window. Now the bytes survive
                            // behind a path and recovery is one bounded read.
                            // The raw result, not JSON.stringify(result): JSON escapes every
                            // newline, which would land a large payload on a single line and
                            // make the fs_read/ripgrep recovery route we advertise useless.
                            spill = spillToolResult(result, {
                                taskId: this.taskId,
                                step: this.stepsCompleted,
                                tool: functionName
                            });
                            const TRUNCATION_NOTICE = buildSpillNotice(spill);
                            const truncatedResult = {};
                            // Budget shared across every oversized string field on the result.
                            let budget = MAX_RESULT_CHARS - 2000;
                            for (const [key, value] of Object.entries(result)) {
                                if (typeof value === 'string' && value.length > 500) {
                                    const allowance = Math.max(0, Math.min(value.length, budget));
                                    budget -= allowance;
                                    truncatedResult[key] = allowance < value.length
                                        ? value.substring(0, allowance) + TRUNCATION_NOTICE
                                        : value;
                                }
                                else if (value !== null && typeof value === 'object') {
                                    const serialized = JSON.stringify(value);
                                    if (serialized.length > budget) {
                                        truncatedResult[key] = spill
                                            ? `[${key} omitted here: ${(serialized.length / 1024).toFixed(1)} KB. The complete result is saved at ${spill.path} — read or search that file rather than re-running.]`
                                            : `[${key} omitted: ${(serialized.length / 1024).toFixed(1)} KB. Re-run with narrower arguments if you need it.]`;
                                    }
                                    else {
                                        budget -= serialized.length;
                                        truncatedResult[key] = value;
                                    }
                                }
                                else {
                                    truncatedResult[key] = value;
                                }
                            }
                            resultString = JSON.stringify(truncatedResult);
                        }
                        // B5 — OBSERVATION COMPACTION.
                        //
                        // ARC Prize measured the same GPT-6 Astra weights at 62.7% under a
                        // note-passing harness and 99.9% under one that compacts and reuses
                        // prior work — with 49% FEWER tokens. Re-reading a file the agent
                        // already read, or re-listing an unchanged directory, pays full
                        // price for bytes that are verbatim identical to bytes already in
                        // the window.
                        //
                        // Replacing the repeat with a pointer is not a loss of information:
                        // "identical to step N" is strictly MORE informative than the bytes
                        // alone, because it tells the model the thing did not change —
                        // which after an edit is exactly the question it is asking.
                        //
                        // Only payloads worth the trade are folded. A small `{"success":true}`
                        // ack costs less than the pointer that would replace it, and every
                        // Plan updates would otherwise collide with unrelated plan updates.
                        const OBSERVATION_FOLD_FLOOR = 600;
                        if (resultString.length >= OBSERVATION_FOLD_FLOOR) {
                            const digest = createHash('sha256').update(resultString).digest('hex');
                            const seenAt = this._observationDigests.get(digest);
                            if (seenAt !== undefined) {
                                resultString = JSON.stringify({
                                    ...(result && typeof result.success === 'boolean' ? { success: result.success } : {}),
                                    identicalResult: true,
                                    output: `The serialized tool response matches step ${seenAt}. This does not prove external state is unchanged. `
                                        + (spill
                                            ? `Full output is saved at ${spill.path}; read a relevant range if needed.`
                                            : 'The earlier response may have left the active context; make a targeted read if its details are needed.')
                                });
                            }
                            else {
                                this._observationDigests.set(digest, this.stepsCompleted + 1);
                            }
                        }
                        const isCallFailed = Boolean(result && (result.success === false || typeof result.error === 'string'));
                        const stallObservation = this.stallGuard.observeCall(functionName, args || {}, result, toolCall.id, isCallFailed);
                        if (stallObservation.stub && resultString.length >= 256) {
                            resultString = stallObservation.stub;
                        }
                        this.messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: functionName,
                            content: resultString,
                            // Internal bookkeeping only: stripped before any provider call
                            // (providers/base.js INTERNAL_MESSAGE_FIELDS). It lets the decay
                            // stub keep pointing at the spill after the payload is gone.
                            ...(spill ? { spillPath: spill.path } : {})
                        });
                        if (stallObservation.notice) {
                            this.messages.push({
                                role: 'system',
                                content: stallObservation.notice
                            });
                        }
                        if (stallObservation.decision?.action === 'halt') {
                            const fatalMsg = stallObservation.decision.message;
                            this.emitEvent({ type: 'step_error', tool: functionName, error: fatalMsg, toolCallId: toolCall.id });
                            auditLog.log({ event: 'task_killed_circuit_breaker', taskId: this.taskId, reason: fatalMsg });
                            this.abort();
                            break;
                        }
                    }
                    // Save state continuously after each tool loop
                    this.memoryManager.saveHistory(this.messages);
                    if (this.stopRequested)
                        break;
                }
            }
            catch (e) {
                if (e instanceof EfficiencyCheckpoint) {
                    this.messages.push({ role: 'system', content: `[Unfinished task checkpoint] ${e.message}` });
                    this.memoryManager.saveHistory(this.messages);
                    this.emitEvent({ type: 'budget_warning', message: e.message });
                    auditLog.log({ event: 'efficiency_checkpoint', taskId: this.taskId, reason: e.reason,
                        ...this.efficiencyBudget.snapshot() });
                    break;
                }
                // A peer can fail after completing billable steps. Charge those steps
                // once even when no final result was returned, including action and
                // wall-clock limits, before deciding whether recovery is possible.
                if (e?.partialUsage) {
                    const usage = e.partialUsage;
                    if (usage.promptTokens + usage.completionTokens > 0) {
                        await this.tokenTracker.trackUsage(usage.promptTokens, usage.completionTokens, (message) => this.emitEvent({ type: 'budget_warning', message }), usage);
                        auditLog.log({
                            event: 'model_usage', scope: 'agent_loop_primary', taskId: this.taskId,
                            step: this.stepsCompleted, provider: this.config.provider || 'unknown',
                            promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
                            cachedPromptTokens: usage.cachedPromptTokens || 0,
                            measurement: 'provider_reported_partial', costBasis: 'external_subscription_unavailable'
                        });
                    }
                }
                if (e?.code === 'AGY_TOKEN_BUDGET' || e?.code === 'TASK_TOKEN_BUDGET' || e?.code === 'PROVIDER_TOKEN_BUDGET') {
                    this.emitEvent({ type: 'budget_warning', message: e.message });
                    auditLog.log({ event: 'task_stopped_on_budget', taskId: this.taskId,
                        used: this.tokenTracker.taskTokens, limit: e.tokenLimit || this.tokenTracker.budget?.maxTokensPerTask || 0 });
                    break;
                }
                if (e?.code === 'AGY_EXPLORATION_LOOP' || e?.code === 'AGENT_EXPLORATION_LOOP' || e?.code === 'STALL_EXPLORATION_LOOP') {
                    auditLog.log({ event: 'media_exploration_checkpoint', taskId: this.taskId,
                        inspectionCount: e.inspectionCount, recovery: mediaExplorationRecoveries });
                    if (mediaExplorationRecoveries++ === 0) {
                        this.messages.push({ role: 'system', content: '[TASK RECOVERY] Consecutive read-only inspections without workspace changes were paused. ' +
                                'The user requested a concrete change. Reuse the observations already gathered; do not repeat probes. ' +
                                'Make one targeted workspace edit now, then run one focused verification. ' +
                                'If editing is blocked, report the exact blocker. Do not claim completion from inspection alone.' });
                        this.memoryManager.saveHistory(this.messages);
                        this.emitEvent({ type: 'notice', message: 'Repeated inspection paused; continuing once with a direct edit instruction.' });
                        continue;
                    }
                    this.emitEvent({ type: 'error', message: 'The provider continued read-only inspection after a corrective checkpoint. The task remains unfinished; no edit was verified.' });
                    break;
                }
                if (this.stopRequested || this.abortController?.signal?.aborted || e?.name === 'AbortError') {
                    this.debugLog(`agent loop interrupted: ${e?.message || 'aborted'}`);
                    auditLog.log({ event: 'task_interrupted', taskId: this.taskId });
                    break;
                }
                // A real failure. It reaches the user as an `error` frame further down
                // this same catch; the stack is a diagnostic and stays behind the flag.
                this.debugLog(`agent loop error: ${e && e.stack ? e.stack : e}`);
                const errorType = this.classifyError(e);
                if (e.message.includes('NO_BACKEND_URL:')) {
                    this.emitEvent({ type: 'warning', message: e.message.replace('NO_BACKEND_URL: ', '') });
                    break;
                }
                // V5: Only break on fatal errors. Transient errors get fed back to LLM.
                if (errorType === 'fatal' || errorType === 'auth_error' || errorType === 'invalid_request_error') {
                    this.emitEvent({ type: 'error', message: e.message });
                    auditLog.log({ event: 'task_error', taskId: this.taskId, error: e.message, errorType });
                    break;
                }
                else {
                    // A transient error. "Transient" only means the loop MAY continue —
                    // it does not mean it should continue forever.
                    //
                    // This used to retry immediately, with no backoff and no cap, until
                    // the step budget ran out. A sleeping laptop or a wifi blip therefore
                    // produced up to 300 attempts against a dead endpoint, each one
                    // waiting out a full connect timeout, while the status line said
                    // "Thinking" and the only signal was `network_error: fetch failed`
                    // repeated in red. From the outside it is indistinguishable from
                    // working, and it burns the user's step budget doing nothing.
                    const repeated = this.lastFailureType === errorType;
                    this.consecutiveFailures = repeated ? this.consecutiveFailures + 1 : 1;
                    this.lastFailureType = errorType;
                    const isNetwork = errorType === NETWORK_ERROR_TYPE;
                    const detail = isNetwork ? explainNetworkError(e, this.config) : e.message;
                    auditLog.log({ event: 'loop_error_recovered', taskId: this.taskId, error: e.message, errorType });
                    if (this.consecutiveFailures >= AgentLoop.MAX_CONSECUTIVE_FAILURES) {
                        // Nothing is changing between attempts. Stop and say why, rather
                        // than spinning until the budget is gone.
                        this.emitEvent({
                            type: 'error',
                            message: `${detail}\n\nStopped after ${this.consecutiveFailures} attempts. `
                                + 'Nothing changed between them, so retrying further would only spend your budget.'
                        });
                        break;
                    }
                    this.emitEvent({
                        type: 'step_error',
                        tool: 'agent_loop',
                        error: `${detail}\n  retrying (${this.consecutiveFailures} of `
                            + `${AgentLoop.MAX_CONSECUTIVE_FAILURES})`
                    });
                    // Back off before trying again. Hammering a failing endpoint as fast
                    // as the loop can spin turns a one-second blip into a burst of
                    // failures and gives the endpoint no chance to recover.
                    await this.backoff(this.consecutiveFailures);
                    // Only tell the MODEL about errors the model can act on. It cannot
                    // fix DNS or a firewall, and a system message per attempt grows the
                    // context — and the bill — for nothing.
                    if (!isNetwork) {
                        this.messages.push({
                            role: 'system',
                            content: `[SYSTEM ERROR RECOVERED: A ${errorType} error occurred: "${e.message}". `
                                + 'The loop has recovered. You may continue or try a different approach.]'
                        });
                    }
                }
            }
        }
        // Successful completion is emitted only at the verified completion path
        // above. A provider error, rejected check, or exhausted recovery budget
        // must not generate a second (and misleading) success event here.
    }
    async waitForApproval(toolCallId) {
        return new Promise((resolve) => {
            this.pendingApprovals.set(toolCallId, resolve);
            // Safety timeout: If user doesn't respond in 1 hour, auto-deny.
            setTimeout(() => {
                if (this.pendingApprovals.has(toolCallId)) {
                    this.handleApprovalResponse(toolCallId, false);
                }
            }, 3600000);
        });
    }
    /**
     * Wait before retrying, and stay interruptible while waiting.
     *
     * Exponential, capped. Without the abort check a user pressing esc during a
     * backoff would wait out the full delay before anything responded.
     */
    async backoff(attempt) {
        const delay = Math.min(8000, 500 * Math.pow(2, Math.max(0, attempt - 1)));
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, delay);
            if (timer.unref)
                timer.unref();
            const signal = this.abortController && this.abortController.signal;
            if (signal) {
                signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
            }
        });
    }
    // V5: Classify errors for intelligent retry decisions
    classifyError(error) {
        if (error?.code === 'AGY_NATIVE_ACTION_DENIED'
            || error?.code === 'AGY_NATIVE_ACTION_BUDGET'
            || error?.code === 'AGY_DESKTOP_TASK_LIMIT')
            return 'fatal';
        // A provider may have charged for completed steps before the turn failed.
        // Replaying that turn can repeat actions and spend the same tokens again.
        const spent = Number(error?.partialUsage?.promptTokens || 0)
            + Number(error?.partialUsage?.completionTokens || 0);
        if (spent > 0)
            return 'fatal';
        const msg = (error.message || '').toLowerCase();
        if (msg.includes('syntax') || msg.includes('unexpected token') || msg.includes('invalid json')) {
            return 'syntax_error';
        }
        if (msg.includes('enoent') || msg.includes('no such file') || msg.includes('not found') || msg.includes('does not exist')) {
            return 'path_not_found';
        }
        if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('fetch failed') || msg.includes('network')) {
            return "network_error";
        }
        if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests') || msg.includes('quota')) {
            return 'rate_limit';
        }
        if (msg.includes('eacces') || msg.includes('permission denied') || msg.includes('eperm')) {
            return 'permission_denied';
        }
        if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('api key')) {
            return 'auth_error';
        }
        if (msg.includes('400') || msg.includes('invalid_parameter') || msg.includes('invalid_request') || msg.includes('required property') || msg.includes('bad request')) {
            return 'invalid_request_error';
        }
        if (msg.includes('kill') || msg.includes('abort') || msg.includes('signal') || msg.includes('fatal')) {
            return 'fatal';
        }
        return 'unknown_error';
    }
    // V5: Provide actionable retry hints per error type
    getRetryHint(errorType) {
        const hints = {
            'syntax_error': 'Check your command syntax or JSON structure. Ensure quotes are balanced.',
            'path_not_found': 'The file or directory does not exist. Use fs.list to verify the path first, or create it with fs.write/mkdir.',
            ["network_error"]: "Network connectivity issue. Wait a moment and retry. If persistent, check if the URL is correct.",
            'rate_limit': 'API rate limit hit. Wait 5-10 seconds before retrying.',
            'permission_denied': 'Permission denied. Check if the path is within allowed workspace paths. Try a different directory.',
            'auth_error': 'Authentication failed. Do NOT retry — the API key may be invalid.',
            'invalid_request_error': 'API request format error (400 Bad Request). Do NOT retry — check model parameter compliance.',
            'unknown_error': 'An unexpected error occurred. Try a different approach entirely.'
        };
        return hints[errorType] || hints['unknown_error'];
    }
    async runPreToolUse(toolName, args, toolCallId) {
        return runConfiguredHooks({
            hooks: this.config?.hooks,
            event: 'PreToolUse',
            toolName,
            args,
            taskId: this.taskId,
            toolCallId,
            workspacePaths: this.sandbox?.workspacePaths
        });
    }
    async runPostToolUse(toolName, args, result) {
        return runConfiguredHooks({
            hooks: this.config?.hooks,
            event: 'PostToolUse',
            toolName,
            args,
            result,
            taskId: this.taskId,
            workspacePaths: this.sandbox?.workspacePaths
        });
    }
    // V5: Validate tool call arguments before execution
    validateToolArgs(toolName, args) {
        // Check for common LLM mistakes
        // 1. File operations must have absolute paths
        const pathFields = ['path', 'source', 'destination', 'target'];
        for (const field of pathFields) {
            if (args[field] && typeof args[field] === 'string') {
                const val = args[field].trim();
                if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(val)) {
                    continue;
                }
                if (val.startsWith('~')) {
                    args[field] = val.replace(/^~(?=$|[\\/])/, os.homedir());
                }
                else if (!val.startsWith('/')) {
                    args[field] = `${this.workspaceRoot || process.cwd()}/${val}`;
                }
            }
        }
        // 2. Terminal commands must have a command string
        if ((toolName === 'sysRun' || toolName === 'sysRunBg') && !args.command) {
            return 'Missing required "command" argument';
        }
        // 3. File write must have a path AND content.
        //
        // These branches were dead: canonicalToolName() (called on every tool name
        // before this runs) normalises '.'→'_', so `toolName` is 'fs_write', never
        // 'fs.write'. The old 'fs.write' / 'codebase.search' / 'web.search' literals
        // could never match, so the model's missing-argument mistakes reached the
        // tool as runtime exceptions instead of a corrective message. Matched on the
        // canonical names now, and fs_write's `content` is actually checked (the old
        // comment said "must have content" but the code only looked at `path`).
        if (toolName === 'fs_write' && !args.path) {
            return 'Missing required "path" argument';
        }
        if (toolName === 'fs_write' && args.content === undefined) {
            return 'Missing required "content" argument';
        }
        // 4. Search must have a query
        if ((toolName === 'codebase_search' || toolName === 'web_search') && !args.query) {
            return 'Missing required "query" argument';
        }
        return null; // No validation errors
    }
}
