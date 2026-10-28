/** OpenAI-compatible provider client (chat + embeddings) with honest
 * failure semantics, usage accounting and process-level request guards.
 *
 * What the guards ARE: EMBER_MAX_CALLS caps provider requests per process
 * and EMBER_MAX_PROMPT_CHARS caps input size per call. Both actually block
 * the request they name.
 * What they are NOT: billing limits. Ember never sees provider billing;
 * real spend is only on the provider's dashboard. Usage records say
 * "estimated" whenever a token figure is a chars/4 approximation rather
 * than provider-reported usage. */
export class NullUsageLogger {
    async log() { }
}
/** Appends one JSON record per provider call to .ember/usage.jsonl. */
export class JsonlUsageLogger {
    file;
    constructor(file) {
        this.file = file;
    }
    static forRepo(repoRoot) {
        return new JsonlUsageLogger(`${repoRoot}/.ember/usage.jsonl`);
    }
    async log(r) {
        // Resolved through Function so non-Node builds (browser demo bundle, no
        // @types/node) never have to resolve the specifier at compile time; in
        // the browser this code path simply never runs.
        const fs = await (new Function('return import("node:fs/promises")')());
        const dir = this.file.slice(0, this.file.lastIndexOf("/"));
        await fs.mkdir(dir, { recursive: true });
        await fs.appendFile(this.file, JSON.stringify(r) + "\n");
    }
}
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const TIMEOUT_MS = 60_000;
export class LlmClient {
    cfg;
    usage;
    fetchFn;
    calls = 0;
    /** Provider requests are serialized through this chain: one in flight per
     * client, so concurrency 1 is enforced, not just customary. */
    queue = Promise.resolve();
    constructor(cfg, usage = new NullUsageLogger(), fetchFn = fetch) {
        this.cfg = cfg;
        this.usage = usage;
        this.fetchFn = fetchFn;
    }
    providerHost() {
        try {
            return new URL(this.cfg.base).host;
        }
        catch {
            return this.cfg.base;
        }
    }
    /** Guards that genuinely block the named request. Not billing limits. */
    guard(inputChars) {
        if (this.cfg.maxCalls !== undefined && this.calls >= this.cfg.maxCalls) {
            throw new Error(`request blocked: EMBER_MAX_CALLS=${this.cfg.maxCalls} reached. This guard caps provider requests per process (it does not track or limit spending - check the provider dashboard for real billing). Raise or unset it to continue.`);
        }
        if (this.cfg.maxPromptCharsPerCall !== undefined && inputChars > this.cfg.maxPromptCharsPerCall) {
            throw new Error(`request blocked: input is ${inputChars} chars, over EMBER_MAX_PROMPT_CHARS=${this.cfg.maxPromptCharsPerCall}. Narrow the query or raise the cap.`);
        }
    }
    post(urlPath, body) {
        const run = this.queue.then(() => this.postImmediate(urlPath, body));
        this.queue = run.catch(() => { });
        return run;
    }
    async postImmediate(urlPath, body) {
        const url = `${this.cfg.base.replace(/\/$/, "")}${urlPath}`;
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            this.calls++;
            let res;
            try {
                res = await this.fetchFn(url, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        authorization: `Bearer ${this.cfg.apiKey}`,
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
            }
            catch (e) {
                lastErr = new Error(`endpoint unreachable (${this.providerHost()}): ${e instanceof Error ? e.message : String(e)}`);
                if (attempt === 0) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                throw lastErr;
            }
            if (res.ok)
                return res;
            const text = await res.text().catch(() => "");
            lastErr = new Error(`endpoint ${res.status}: ${text.slice(0, 500)}`);
            if (RETRYABLE.has(res.status) && attempt === 0) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            throw lastErr;
        }
        throw lastErr ?? new Error("request failed");
    }
    async chat(messages, opts = {}) {
        if (!this.cfg.chatModel)
            throw new Error("no chat model configured (EMBER_CHAT_MODEL)");
        const inputChars = messages.reduce((n, m) => n + m.content.length, 0);
        this.guard(inputChars);
        const model = this.cfg.chatModel;
        const rec = {
            ts: new Date().toISOString(), kind: "chat", model,
            provider: this.providerHost(), items: messages.length,
            estimated: false, ok: false,
        };
        try {
            const res = await this.post("/chat/completions", {
                model,
                temperature: opts.temperature ?? 0.2,
                ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
                messages,
            });
            const data = await res.json();
            const content = data.choices[0]?.message?.content ?? "";
            if (!content.trim())
                throw new Error("chat endpoint returned an empty answer");
            rec.ok = true;
            if (data.usage?.prompt_tokens !== undefined) {
                rec.inputTokens = data.usage.prompt_tokens;
                rec.outputTokens = data.usage.completion_tokens;
                rec.estimated = false;
            }
            else {
                rec.estimatedInputTokens = Math.ceil(inputChars / 4);
                rec.estimated = true;
            }
            return { content, inputTokens: rec.inputTokens, outputTokens: rec.outputTokens, providerReported: !rec.estimated };
        }
        catch (e) {
            rec.error = e instanceof Error ? e.message : String(e);
            throw e;
        }
        finally {
            await this.usage.log(rec).catch(() => { });
        }
    }
    /** Raw embeddings call; dimension validation stays with the caller. */
    async embedRaw(texts) {
        if (!this.cfg.embedModel)
            throw new Error("no embedding model configured (EMBER_EMBED_MODEL)");
        const inputChars = texts.reduce((n, t) => n + t.length, 0);
        this.guard(inputChars);
        const model = this.cfg.embedModel;
        const rec = {
            ts: new Date().toISOString(), kind: "embed", model,
            provider: this.providerHost(), items: texts.length,
            estimated: false, ok: false,
        };
        try {
            const res = await this.post("/embeddings", { model, input: texts });
            const data = await res.json();
            rec.ok = true;
            const reported = data.usage?.prompt_tokens ?? data.usage?.total_tokens;
            if (reported !== undefined) {
                rec.inputTokens = reported;
                rec.estimated = false;
            }
            else {
                rec.estimatedInputTokens = Math.ceil(inputChars / 4);
                rec.estimated = true;
            }
            return data.data.map(d => d.embedding);
        }
        catch (e) {
            rec.error = e instanceof Error ? e.message : String(e);
            throw e;
        }
        finally {
            await this.usage.log(rec).catch(() => { });
        }
    }
}
function parseOptInt(v) {
    if (v === undefined || v.trim() === "")
        return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
}
/** Build provider config from the environment, or null when unconfigured
 * (offline mode). EMBER_API_BASE is the single base URL; EMBER_CHAT_BASE is
 * still honored for backward compatibility. */
export function llmConfigFromEnv(env = typeof process !== "undefined" ? process.env : {}) {
    const base = env.EMBER_API_BASE ?? env.EMBER_CHAT_BASE;
    const apiKey = env.EMBER_API_KEY;
    if (!base || !apiKey)
        return null;
    const embedDim = parseOptInt(env.EMBER_EMBED_DIM);
    return {
        base, apiKey,
        embedModel: env.EMBER_EMBED_MODEL || undefined,
        embedDim: embedDim,
        chatModel: env.EMBER_CHAT_MODEL || undefined,
        maxCalls: parseOptInt(env.EMBER_MAX_CALLS),
        maxPromptCharsPerCall: parseOptInt(env.EMBER_MAX_PROMPT_CHARS),
    };
}
