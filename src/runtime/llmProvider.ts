import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { ProviderStatus } from '../engine/provenance';

export interface LlmCallRequest {
  provider: 'gemini' | 'openai_compat';
  model: string;
  systemInstruction: string;
  prompt: string;
  signal?: AbortSignal;
}

export interface LlmUsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  cacheUsageMeasured: boolean;
  costUsd: number | null;
}

export interface LlmCallResponse {
  text: string;
  provider: 'gemini' | 'openai_compat';
  model: string;
  durationMs: number;
  usage: LlmUsageSnapshot;
}

// Per-1M token reference pricing (USD). Null if unknown/custom OpenAI-compat model.
const MODEL_PRICING_PER_M: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  'gemini-4-hydrogen': { input: 0.15, cachedInput: 0.0375, output: 0.6 },
  'gemini-3.1-flash-lite': { input: 0.075, cachedInput: 0.01875, output: 0.3 },
};

export function computeCostUsd(
  model: string,
  uncachedInput: number,
  cachedInput: number,
  completion: number
): number | null {
  const rate = MODEL_PRICING_PER_M[model];
  if (!rate) return null;
  const usd =
    (uncachedInput * rate.input +
      cachedInput * rate.cachedInput +
      completion * rate.output) /
    1_000_000;
  return Number(usd.toFixed(6));
}

export function getProviderStatus(): ProviderStatus {
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
  const openAiCompatConfigured = Boolean(
    process.env.OPENAI_COMPAT_BASE_URL?.trim() &&
      process.env.OPENAI_COMPAT_API_KEY?.trim()
  );

  const availableModels: ProviderStatus['availableModels'] = [];
  if (geminiConfigured) {
    availableModels.push(
      {
        id: 'gemini-4-hydrogen',
        label: 'gemini-4-hydrogen (Gemini Flash)',
        provider: 'gemini',
        tier: 'large',
      },
      {
        id: 'gemini-3.1-flash-lite',
        label: 'gemini-3.1-flash-lite (Малая быстрая модель)',
        provider: 'gemini',
        tier: 'small',
      }
    );
  }
  if (openAiCompatConfigured) {
    const compatModel = process.env.OPENAI_COMPAT_MODEL?.trim() || 'custom-model';
    availableModels.push({
      id: compatModel,
      label: `${compatModel} (OpenAI-compatible / OpenCode)`,
      provider: 'openai_compat',
      tier: 'small',
    });
  }

  const defaultProvider: ProviderStatus['defaultProvider'] = geminiConfigured
    ? 'gemini'
    : openAiCompatConfigured
    ? 'openai_compat'
    : 'none';

  const limitationNote =
    defaultProvider === 'none'
      ? 'GEMINI_API_KEY (и OPENAI_COMPAT_*) не настроены в окружении сервера. Реальные LLM-замеры (provenance: measured) требуют ключа в Settings > Secrets или .env; детерминированные модули, тесты и git-инспекция на диске работают без ключа (provenance: measured_local).'
      : 'Провайдер готов к честным замерам usageMetadata (одинаковая модель и провайдер для Baseline и SpecTrim).';

  return {
    geminiConfigured,
    openAiCompatConfigured,
    defaultProvider,
    availableModels,
    limitationNote,
  };
}

let cachedGeminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured in server environment (Settings > Secrets).'
    );
  }
  if (!cachedGeminiClient) {
    cachedGeminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedGeminiClient;
}

export async function callLlmWithUsage(req: LlmCallRequest): Promise<LlmCallResponse> {
  if (req.signal?.aborted) {
    throw new Error('LLM request aborted');
  }

  const started = Date.now();

  if (req.provider === 'gemini') {
    const ai = getGeminiClient();
    const isFlashLite = req.model === 'gemini-3.1-flash-lite';

    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (req.signal?.aborted) {
        throw new Error('LLM request aborted');
      }
      try {
        const response = await ai.models.generateContent({
          model: req.model,
          contents: req.prompt,
          config: {
            systemInstruction: req.systemInstruction,
            responseMimeType: 'application/json',
            thinkingConfig: {
              thinkingLevel: isFlashLite ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
            },
          },
        });

        const um = response.usageMetadata;
        if (!um || typeof um.promptTokenCount !== 'number') {
          throw new Error(
            'Provider did not return usageMetadata.promptTokenCount; refusing to fabricate usage.'
          );
        }

        const promptTokens = um.promptTokenCount ?? 0;
        const candidatesTokens = um.candidatesTokenCount ?? 0;
        const thoughtsTokens = um.thoughtsTokenCount ?? 0;
        const completionTokens = candidatesTokens + thoughtsTokens;
        const hasCachedField = typeof um.cachedContentTokenCount === 'number';
        const cachedInputTokens = um.cachedContentTokenCount ?? 0;
        const uncachedInputTokens = Math.max(0, promptTokens - cachedInputTokens);
        const totalTokens = um.totalTokenCount ?? promptTokens + completionTokens;

        return {
          text: (response.text ?? '').trim(),
          provider: 'gemini',
          model: req.model,
          durationMs: Date.now() - started,
          usage: {
            promptTokens,
            completionTokens,
            cachedInputTokens,
            uncachedInputTokens,
            thoughtsTokens,
            totalTokens,
            cacheUsageMeasured: hasCachedField,
            costUsd: computeCostUsd(
              req.model,
              uncachedInputTokens,
              cachedInputTokens,
              completionTokens
            ),
          },
        };
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        const retryable = msg.includes('429') || msg.includes('503') || msg.includes('RESOURCE_EXHAUSTED');
        if (!retryable || attempt === maxAttempts) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Gemini call failed');
  }

  // OpenAI-compatible provider (e.g., OpenCode / vLLM / OpenRouter / OpenAI)
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL?.trim()?.replace(/\/$/, '');
  const apiKey = process.env.OPENAI_COMPAT_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    throw new Error('OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY are not configured.');
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: req.model,
      messages: [
        { role: 'system', content: req.systemInstruction },
        { role: 'user', content: req.prompt },
      ],
      response_format: { type: 'json_object' },
    }),
    signal: req.signal,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI-compatible API error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };

  const u = json.usage;
  if (!u || typeof u.prompt_tokens !== 'number') {
    throw new Error(
      'OpenAI-compatible endpoint did not return usage.prompt_tokens; refusing to fabricate usage.'
    );
  }

  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  const hasCached = typeof u.prompt_tokens_details?.cached_tokens === 'number';
  const cachedInputTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
  const uncachedInputTokens = Math.max(0, promptTokens - cachedInputTokens);

  return {
    text: (json.choices?.[0]?.message?.content ?? '').trim(),
    provider: 'openai_compat',
    model: req.model,
    durationMs: Date.now() - started,
    usage: {
      promptTokens,
      completionTokens,
      cachedInputTokens,
      uncachedInputTokens,
      thoughtsTokens: 0,
      totalTokens: u.total_tokens ?? promptTokens + completionTokens,
      cacheUsageMeasured: hasCached,
      costUsd: null,
    },
  };
}
