export type PlanStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  id: string;
  step: string;
  status: PlanStatus;
}

export interface PlanUpdate {
  explanation: string;
  plan: PlanStep[];
}

const MAX_STEPS = 24;

function cleanText(value: unknown, name: string, limit: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) throw new Error(`${name} must not be empty`);
  if (cleaned.length > limit) throw new Error(`${name} exceeds ${limit} characters`);
  return cleaned;
}

export function normalizePlanUpdate(value: unknown): PlanUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plan update must be an object');
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.plan) || input.plan.length === 0) throw new Error('plan must contain at least one step');
  if (input.plan.length > MAX_STEPS) throw new Error(`plan may contain at most ${MAX_STEPS} steps`);

  const ids = new Set<string>();
  let active = 0;
  const plan = input.plan.map((raw, index): PlanStep => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`plan[${index}] must be an object`);
    const item = raw as Record<string, unknown>;
    const id = cleanText(item.id ?? `step-${index + 1}`, `plan[${index}].id`, 64);
    const step = cleanText(item.step ?? item.content, `plan[${index}].step`, 240);
    const status = item.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      throw new Error(`plan[${index}].status must be pending, in_progress, or completed`);
    }
    if (ids.has(id)) throw new Error(`Duplicate plan step id: ${id}`);
    ids.add(id);
    if (status === 'in_progress') active += 1;
    return { id, step, status };
  });

  if (active > 1) throw new Error('Only one plan step may be in_progress');
  const explanation = typeof input.explanation === 'string'
    ? input.explanation.replace(/\s+/g, ' ').trim().slice(0, 500)
    : '';
  return { explanation, plan };
}

export function summarizePlan(plan: readonly PlanStep[]): string {
  const completed = plan.filter(item => item.status === 'completed').length;
  const active = plan.find(item => item.status === 'in_progress');
  return `${completed}/${plan.length} completed${active ? `; in progress: ${active.step}` : ''}`;
}

export function normalizePeerPlanEntries(value: unknown): PlanUpdate | null {
  if (!value) return null;
  let rawList: unknown[] | null = null;
  let explanation = '';
  if (Array.isArray(value)) {
    rawList = value;
  } else if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.explanation === 'string') {
      explanation = obj.explanation.replace(/\s+/g, ' ').trim().slice(0, 500);
    }
    const candidate = obj.plan ?? obj.todos ?? obj.entries ?? obj.steps ?? obj.items ?? obj.tasks
      ?? (obj.metadata && typeof obj.metadata === 'object' ? (obj.metadata as Record<string, unknown>).todos : undefined);
    if (Array.isArray(candidate)) {
      rawList = candidate;
    }
  }
  if (!rawList || rawList.length === 0) return null;

  const ids = new Set<string>();
  let activeSeen = false;
  const steps: PlanStep[] = [];

  for (let i = 0; i < Math.min(rawList.length, MAX_STEPS); i++) {
    const raw = rawList[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const rawText = item.step ?? item.content ?? item.text ?? item.title ?? item.name ?? item.description;
    if (typeof rawText !== 'string') continue;
    const step = rawText.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!step) continue;

    const baseId = typeof item.id === 'string' && item.id.trim()
      ? item.id.replace(/\s+/g, ' ').trim().slice(0, 56)
      : `step-${steps.length + 1}`;
    let id = baseId;
    let suffix = 2;
    while (ids.has(id)) {
      id = `${baseId}-${suffix++}`;
    }
    ids.add(id);

    const rawStatus = String(item.status ?? item.state ?? 'pending').toLowerCase().trim();
    let status: PlanStatus = 'pending';
    if (rawStatus === 'completed' || rawStatus === 'done' || rawStatus === 'complete' || rawStatus === 'finished') {
      status = 'completed';
    } else if (rawStatus === 'in_progress' || rawStatus === 'in-progress' || rawStatus === 'in progress' || rawStatus === 'active' || rawStatus === 'running' || rawStatus === 'working') {
      status = 'in_progress';
    }

    if (status === 'in_progress') {
      if (activeSeen) {
        status = 'pending';
      } else {
        activeSeen = true;
      }
    }

    steps.push({ id, step, status });
  }

  if (steps.length === 0) return null;
  if (!activeSeen && steps.some(s => s.status === 'pending')) {
    const firstPending = steps.find(s => s.status === 'pending');
    if (firstPending) firstPending.status = 'in_progress';
  }

  return { explanation, plan: steps };
}

export function extractToolCallJsonObjects(text: string): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  if (!text || typeof text !== 'string') return results;

  const tagRegex = /<tool_call>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(text)) !== null) {
    const startSearch = tagMatch.index + tagMatch[0].length;
    const braceStart = text.indexOf('{', startSearch);
    if (braceStart === -1) continue;
    // Ensure only whitespace separates <tool_call> and '{'
    if (text.slice(startSearch, braceStart).trim().length > 0) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let endBrace = -1;
    for (let i = braceStart; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else {
        if (ch === '"') {
          inString = true;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            endBrace = i;
            break;
          }
        }
      }
    }

    if (endBrace !== -1) {
      const candidate = text.slice(braceStart, endBrace + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          results.push(parsed as Record<string, unknown>);
          tagRegex.lastIndex = endBrace + 1;
          continue;
        }
      } catch {
        // Fall through to suffix healing below
      }
    }

    // Unclosed or truncated JSON after <tool_call>: strip trailing XML/DSML closing tags and heal
    const nextTagIndex = text.indexOf('<tool_call>', braceStart + 1);
    const sliceEnd = nextTagIndex === -1 ? text.length : nextTagIndex;
    const rawSlice = text
      .slice(braceStart, sliceEnd)
      .replace(/(?:\s*<\/?(?:tool_call|[｜|]DSML[｜|][^>]*|invoke|parameter|calls|function_calls)>)+[\s\S]*$/i, '')
      .trim();
    for (const suffix of ['', '}', '}}', '}}}', '"}', '"}}', '"}}}', '"}]}}', '"]}}', '"]}}}']) {
      try {
        const parsed = JSON.parse(rawSlice + suffix);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          results.push(parsed as Record<string, unknown>);
          break;
        }
      } catch {
        // try next suffix
      }
    }
  }

  if (results.length === 0) {
    const dsmlInvokeRegex = /<[｜|]DSML[｜|]\s*invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[｜|]DSML[｜|]\s*invoke>/gi;
    let invokeMatch: RegExpExecArray | null;
    while ((invokeMatch = dsmlInvokeRegex.exec(text)) !== null) {
      const name = (invokeMatch[1] || '').trim();
      const body = invokeMatch[2] || '';
      if (!name) continue;
      const args: Record<string, unknown> = {};
      const paramRegex = /<[｜|]DSML[｜|]\s*parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[｜|]DSML[｜|]\s*parameter>/gi;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramRegex.exec(body)) !== null) {
        const key = (paramMatch[1] || '').trim();
        const valRaw = (paramMatch[2] || '').trim();
        if (!key) continue;
        try {
          args[key] = JSON.parse(valRaw);
        } catch {
          args[key] = valRaw;
        }
      }
      results.push({ name, arguments: args });
    }
  }

  if (results.length === 0) {
    const fenceRegex = /```(?:tool_call|json)?\s*(\{[\s\S]*?"name"\s*:\s*[\s\S]*?\})\s*```/g;
    let fenceMatch: RegExpExecArray | null;
    while ((fenceMatch = fenceRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse((fenceMatch[1] || '').trim());
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          results.push(parsed as Record<string, unknown>);
        }
      } catch {
        // ignore invalid fence
      }
    }
  }

  return results;
}

export function stripToolCallMarkup(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|(?:\s*<\/?[｜|]DSML[｜|][^>]*>)+|$)/gi, '')
    .replace(/<[｜|]DSML[｜|][\s\S]*?(?:<\/[｜|]DSML[｜|]\s*calls>|$)/gi, '')
    .replace(/(?:\s*<\/?[｜|]DSML[｜|][^>]*>)+/gi, '')
    .trim();
}

export function extractLivePlanFromText(text: string, allowTrailing = false): PlanUpdate | null {
  if (!text || typeof text !== 'string') return null;

  // 1. Check for inline <tool_call>{"name": "update_plan" | "todowrite", ...}</tool_call> (including DSML-closed blocks)
  let latestToolPlan: PlanUpdate | null = null;
  for (const parsed of extractToolCallJsonObjects(text)) {
    try {
      const toolName = String(parsed?.name || parsed?.tool || '').toLowerCase().trim();
      if (toolName === 'update_plan' || toolName === 'todowrite' || toolName === 'todo_write') {
        const rawArgs = typeof parsed.arguments === 'string'
          ? JSON.parse(parsed.arguments)
          : (parsed.arguments ?? parsed.parameters ?? parsed.input ?? parsed);
        const normalized = normalizePeerPlanEntries(rawArgs);
        if (normalized) latestToolPlan = normalized;
      }
    } catch {
      // Ignore partial or invalid JSON inside <tool_call>
    }
  }
  if (latestToolPlan) return latestToolPlan;

  // 2. Check for an explicit Plan: / Implementation Plan: numbered or checkbox list in reasoning/text
  const planHeaderRegex = /(?:^|\n)[ \t]*(?:#{1,4}[ \t]+|\*{1,2})?(?:implementation[ \t]+)?plan(?:\*{1,2})?[ \t]*:[ \t]*\n((?:[ \t]*(?:\d+[.)]|[-*•][ \t]+\[[ xX✓▸>-]\])[ \t]+[^\n]+\n?){2,12})/gi;
  let headerMatch: RegExpExecArray | null;
  let latestBlock = '';
  let latestEndIndex = -1;
  while ((headerMatch = planHeaderRegex.exec(text)) !== null) {
    latestBlock = headerMatch[1] || '';
    latestEndIndex = headerMatch.index + headerMatch[0].length;
  }
  if (!latestBlock) return null;

  // While streaming, wait until the list block is followed by a blank line or another paragraph
  // so we never capture a half-streamed final bullet.
  if (!allowTrailing && latestEndIndex > 0) {
    const remainder = text.slice(latestEndIndex);
    if (!/^\s*\n/.test(remainder) && remainder.trim().length === 0) {
      return null;
    }
  }

  const lines = latestBlock
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const rawItems: Array<{ id: string; step: string; status: PlanStatus }> = [];
  for (let i = 0; i < Math.min(lines.length, MAX_STEPS); i++) {
    const line = lines[i]!;
    const itemMatch = /^(?:(\d+)[.)]|[-*•]\s*\[([ xX✓▸>-])\])\s+(.+)$/.exec(line);
    if (!itemMatch) continue;
    const checkMark = (itemMatch[2] || '').toLowerCase();
    const stepText = (itemMatch[3] || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!stepText || stepText.length < 4) continue;
    const status: PlanStatus = checkMark === 'x' || checkMark === '✓'
      ? 'completed'
      : checkMark === '>' || checkMark === '▸' || checkMark === '-'
        ? 'in_progress'
        : 'pending';
    rawItems.push({
      id: `step-${rawItems.length + 1}`,
      step: stepText,
      status
    });
  }

  if (rawItems.length < 2) return null;
  return normalizePeerPlanEntries({ plan: rawItems });
}

