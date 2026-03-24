import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

/**
 * Unified AI client: OpenAI primary, Gemini fallback.
 *
 * Tries OpenAI first (gpt-4o-mini — cheap, fast, great structured output).
 * Falls back to Gemini with 6-key rotation if OpenAI is unavailable.
 *
 * This module is a singleton — all callers share the same state.
 */

export interface AICallOptions {
    contents: string;
    systemInstruction?: string;
    temperature?: number;
    maxOutputTokens?: number;
    /** If true, request JSON output (OpenAI uses response_format, Gemini uses responseMimeType) */
    jsonMode?: boolean;
}

/**
 * Sanitize external/user data before sending to any LLM.
 * Strips control characters, code fences, and markdown separators
 * to prevent prompt injection attacks.
 */
export function sanitize(text: string, maxLen: number = 500): string {
    return text
        .replace(/[\x00-\x1f\x7f]/g, '')  // control chars
        .replace(/```/g, '')                // code fences
        .replace(/---/g, '')                // markdown separators
        .slice(0, maxLen);
}

// ─── OpenAI ──────────────────────────────────────────────────────
let openaiClient: OpenAI | null = null;
let openaiInitialized = false;

function getOpenAI(): OpenAI | null {
    if (openaiInitialized) return openaiClient;
    openaiInitialized = true;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.log('[ai] No OPENAI_API_KEY — will use Gemini only');
        return null;
    }

    openaiClient = new OpenAI({ apiKey });
    console.log('[ai] OpenAI initialized (primary)');
    return openaiClient;
}

async function callOpenAI(options: AICallOptions): Promise<string | null> {
    const client = getOpenAI();
    if (!client) return null;

    const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

    try {
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

        if (options.systemInstruction) {
            messages.push({ role: 'system', content: options.systemInstruction });
        }
        messages.push({ role: 'user', content: options.contents });

        const response = await client.chat.completions.create({
            model,
            messages,
            temperature: options.temperature ?? 0.4,
            max_tokens: options.maxOutputTokens ?? 500,
            ...(options.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
        });

        const text = response.choices[0]?.message?.content?.trim();
        if (text && text.length > 0) {
            return text;
        }
        return null;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Rate limit — let caller fall through to Gemini
        if (msg.includes('429') || msg.includes('rate') || msg.includes('quota')) {
            console.log(`[ai] OpenAI rate limited: ${msg.slice(0, 100)}`);
            return null;
        }
        console.error(`[ai] OpenAI error: ${msg.slice(0, 200)}`);
        return null;
    }
}

// ─── Gemini (fallback) ───────────────────────────────────────────
const COOLDOWN_MS = 60_000; // 1 minute

interface KeyState {
    key: string;
    disabledUntil: number; // epoch ms, 0 = available
}

const geminiKeyStates: KeyState[] = [];
let geminiInitialized = false;

function ensureGeminiInitialized(): void {
    if (geminiInitialized) return;
    geminiInitialized = true;

    const primary = process.env.GEMINI_API_KEY;
    if (primary) geminiKeyStates.push({ key: primary, disabledUntil: 0 });

    for (let i = 2; i <= 20; i++) {
        const k = process.env[`GEMINI_API_KEY_${i}`];
        if (!k) break;
        geminiKeyStates.push({ key: k, disabledUntil: 0 });
    }

    if (geminiKeyStates.length > 0) {
        console.log(`[ai] Gemini initialized with ${geminiKeyStates.length} key(s) (fallback)`);
    }
}

function getAvailableGeminiKey(): string | null {
    ensureGeminiInitialized();
    const now = Date.now();
    for (const state of geminiKeyStates) {
        if (now >= state.disabledUntil) return state.key;
    }
    return null;
}

function disableGeminiKey(key: string): void {
    const state = geminiKeyStates.find(s => s.key === key);
    if (state) {
        state.disabledUntil = Date.now() + COOLDOWN_MS;
        const idx = geminiKeyStates.indexOf(state);
        console.log(`[ai] Gemini key #${idx + 1} rate-limited, disabled for ${COOLDOWN_MS / 1000}s`);
    }
}

function isGeminiRateLimitError(err: unknown): boolean {
    if (err instanceof Error) {
        const msg = err.message.toLowerCase();
        return msg.includes('429') || msg.includes('rate') || msg.includes('quota') || msg.includes('resource_exhausted');
    }
    return false;
}

async function callGeminiFallback(options: AICallOptions): Promise<string | null> {
    ensureGeminiInitialized();

    const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    const triedKeys = new Set<string>();

    while (true) {
        const key = getAvailableGeminiKey();
        if (!key || triedKeys.has(key)) {
            console.log('[ai] All Gemini keys exhausted');
            return null;
        }
        triedKeys.add(key);

        try {
            const ai = new GoogleGenAI({ apiKey: key });
            const response = await ai.models.generateContent({
                model,
                contents: options.contents,
                config: {
                    systemInstruction: options.systemInstruction,
                    temperature: options.temperature ?? 0.4,
                    maxOutputTokens: options.maxOutputTokens ?? 500,
                    responseMimeType: options.jsonMode ? 'application/json' : undefined,
                },
            });

            const text = response.text?.trim();
            return text && text.length > 0 ? text : null;
        } catch (err) {
            if (isGeminiRateLimitError(err)) {
                disableGeminiKey(key);
                continue;
            }
            console.error('[ai] Gemini error:', err instanceof Error ? err.message : err);
            return null;
        }
    }
}

// ─── Unified API ─────────────────────────────────────────────────

/**
 * Calls AI with OpenAI primary, Gemini fallback.
 * Returns the response text, or null if all providers fail.
 */
export async function callAI(options: AICallOptions): Promise<string | null> {
    // Try OpenAI first
    const openaiResult = await callOpenAI(options);
    if (openaiResult) return openaiResult;

    // Fall back to Gemini
    console.log('[ai] Falling back to Gemini');
    return callGeminiFallback(options);
}

/**
 * Returns true if at least one AI provider is configured.
 */
export function hasAIKeys(): boolean {
    ensureGeminiInitialized();
    return !!process.env.OPENAI_API_KEY || geminiKeyStates.length > 0;
}

// ─── Legacy exports for backward compatibility ───────────────────
// These map to the new unified API so existing callers keep working
// during migration. Can be removed once all callers use callAI/hasAIKeys.
export const callGemini = callAI;
export const hasGeminiKeys = hasAIKeys;
