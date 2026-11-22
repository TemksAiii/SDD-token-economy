import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { LlmProviderId, OllamaDiscoveryStatus, ProviderStatus } from '../engine/provenance';

export interface LlmCallRequest {
  provider: LlmProviderId;
  model: string;
  systemInstruction: string;
  prompt: string;
  signal?: AbortSignal;
  onRetry?: (error: unknown, attempt: number) => void;
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
  provider: LlmProviderId;
  model: string;
  durationMs: number;
  usage: LlmUsageSnapshot;
  rawUsage: object;
}

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

// Per-1M token reference pricing (USD). Null if unknown/custom/local model.
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

export function resolveSafeHttpBaseUrl(
  rawUrl: string | undefined,
  fallbackUrl: string
): { ok: true; url: string } | { ok: false; url: string; error: string } {
  const candidate = (rawUrl?.trim() || fallbackUrl).replace(/\/+$/, '');
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        url: candidate,
        error: `Неподдерживаемая схема URL (${parsed.protocol}); разрешены только http:// или https://.`,
      };
    }
    return { ok: true, url: parsed.origin + parsed.pathname.replace(/\/+$/, '') };
  } catch {
    return {
      ok: false,
      url: candidate,
      error: `Некорректный URL сервера: "${candidate}".`,
    };
  }
}

export async function probeOllamaStatus(timeoutMs = 1500): Promise<OllamaDiscoveryStatus> {
  const enabled = process.env.OLLAMA_ENABLED?.trim().toLowerCase() !== 'false';
  const configuredModel = process.env.OLLAMA_MODEL?.trim() || null;
  const urlCheck = resolveSafeHttpBaseUrl(process.env.OLLAMA_BASE_URL, DEFAULT_OLLAMA_BASE_URL);

  if (!enabled) {
    return {
      enabled: false,
      reachable: false,
      baseUrl: urlCheck.url,
      configuredModel,
      installedModels: [],
      error: 'Локальный провайдер Ollama отключён через OLLAMA_ENABLED=false.',
    };
  }

  if (!urlCheck.ok) {
    return {
      enabled: true,
      reachable: false,
      baseUrl: urlCheck.url,
      configuredModel,
      installedModels: [],
      error: urlCheck.error,
    };
  }

  try {
    const resp = await fetch(`${urlCheck.url}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      return {
        enabled: true,
        reachable: false,
        baseUrl: urlCheck.url,
        configuredModel,
        installedModels: [],
        error: `Ollama вернула HTTP ${resp.status} при запросе ${urlCheck.url}/api/tags.`,
      };
    }

    const payload = (await resp.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const rawNames = (payload.models ?? [])
      .map((m) => (m.name || m.model || '').trim())
      .filter(Boolean);
    const uniqueNames = Array.from(new Set(rawNames));

    // Put OLLAMA_MODEL first if it is installed
    if (configuredModel && uniqueNames.includes(configuredModel)) {
      uniqueNames.sort((a, b) => (a === configuredModel ? -1 : b === configuredModel ? 1 : 0));
    }

    if (uniqueNames.length === 0) {
      return {
        enabled: true,
        reachable: true,
        baseUrl: urlCheck.url,
        configuredModel,
        installedModels: [],
        error:
          'Сервер Ollama запущен, но локальных моделей не найдено. Скачайте модель: ollama pull qwen2.5-coder:7b',
      };
    }

    return {
      enabled: true,
      reachable: true,
      baseUrl: urlCheck.url,
      configuredModel,
      installedModels: uniqueNames,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = msg.toLowerCase().includes('timeout')
      ? `Таймаут опроса Ollama по адресу ${urlCheck.url}`
      : `Ollama не отвечает по адресу ${urlCheck.url} — убедитесь, что запущен сервис (ollama serve)`;
    return {
      enabled: true,
      reachable: false,
      baseUrl: urlCheck.url,
      configuredModel,
      installedModels: [],
      error: hint,
    };
  }
}

function assembleProviderStatus(ollamaStatus: OllamaDiscoveryStatus): ProviderStatus {
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
  const openAiCompatConfigured = Boolean(
    process.env.OPENAI_COMPAT_BASE_URL?.trim() &&
      process.env.OPENAI_COMPAT_API_KEY?.trim()
  );
  const ollamaConfigured = Boolean(
    ollamaStatus.enabled &&
      ollamaStatus.reachable &&
      ollamaStatus.installedModels.length > 0
  );

  const availableModels: ProviderStatus['availableModels'] = [];

  // Primary flagship cloud option (always preferred when GEMINI_API_KEY is present)
  if (geminiConfigured) {
    availableModels.push(
      {
        id: 'gemini-4-hydrogen',
        label: 'gemini-4-hydrogen (проверяется при запросе)',
        provider: 'gemini',
        tier: 'large',
        locality: 'cloud',
      },
      {
        id: 'gemini-3.1-flash-lite',
        label: 'gemini-3.1-flash-lite (Малая быстрая модель · облако)',
        provider: 'gemini',
        tier: 'small',
        locality: 'cloud',
      }
    );
  }

  // Optional local Ollama models (no API key required)
  if (ollamaConfigured) {
    for (const modelName of ollamaStatus.installedModels) {
      const isLargeLocal = /:(14b|22b|32b|34b|70b|72b)/i.test(modelName);
      availableModels.push({
        id: modelName,
        label: `${modelName} (Ollama · локально, без API-ключа)`,
        provider: 'ollama',
        tier: isLargeLocal ? 'large' : 'small',
        locality: 'local',
      });
    }
  }

  if (openAiCompatConfigured) {
    const compatModel = process.env.OPENAI_COMPAT_MODEL?.trim() || 'custom-model';
    availableModels.push({
      id: compatModel,
      label: `${compatModel} (OpenAI-compatible / OpenCode)`,
      provider: 'openai_compat',
      tier: 'small',
      locality: 'cloud',
    });
  }

  const defaultProvider: ProviderStatus['defaultProvider'] = geminiConfigured
    ? 'gemini'
    : ollamaConfigured
    ? 'ollama'
    : openAiCompatConfigured
    ? 'openai_compat'
    : 'none';

  let limitationNote: string;
  if (defaultProvider === 'none') {
    limitationNote = ollamaStatus.reachable
      ? `${ollamaStatus.error} Либо задайте GEMINI_API_KEY в .env / Settings > Secrets для облачного прогона Gemini Hydrogen. Детерминированные модули, тесты и симуляция работают без моделей.`
      : 'Ни облачный GEMINI_API_KEY, ни локальная Ollama сейчас не активны. Задайте GEMINI_API_KEY (для Gemini Hydrogen) или запустите локально `ollama serve` + `ollama pull qwen2.5-coder:7b` без API-ключа. Детерминированные модули (Slicer, AST-LOD, Gate) и симуляция работают сразу.';
  } else if (geminiConfigured && ollamaConfigured) {
    limitationNote =
      'Настроен GEMINI_API_KEY и доступна локальная Ollama. Доступность модели Gemini проверяется при запросе. Для одного A/B-эксперимента всегда используется строго один провайдер и одна модель.';
  } else if (defaultProvider === 'ollama') {
    limitationNote = `Готова локальная Ollama (${ollamaStatus.baseUrl}, без API-ключа). Примечание: для Ollama денежная стоимость равна n/a, а API-кэш токенов не отдаётся сервером (cacheUsageMeasured: false).`;
  } else {
    limitationNote =
      'Провайдер готов к честным замерам usageMetadata (одинаковая модель и провайдер для Baseline и SpecTrim).';
  }

  return {
    geminiConfigured,
    ollamaConfigured,
    openAiCompatConfigured,
    defaultProvider,
    ollamaStatus,
    availableModels,
    limitationNote,
  };
}

/**
 * Synchronous environment snapshot (does not probe local Ollama HTTP endpoint).
 * Prefer `getProviderStatusAsync()` on server routes and CLI runtime.
 */
export function getProviderStatus(): ProviderStatus {
  const urlCheck = resolveSafeHttpBaseUrl(process.env.OLLAMA_BASE_URL, DEFAULT_OLLAMA_BASE_URL);
  const enabled = process.env.OLLAMA_ENABLED?.trim().toLowerCase() !== 'false';
  const configuredModel = process.env.OLLAMA_MODEL?.trim() || null;
  const offlineOllama: OllamaDiscoveryStatus = {
    enabled,
    reachable: false,
    baseUrl: urlCheck.url,
    configuredModel,
    installedModels: [],
  };
  return assembleProviderStatus(offlineOllama);
}

export async function getProviderStatusAsync(timeoutMs = 1500): Promise<ProviderStatus> {
  const ollamaStatus = await probeOllamaStatus(timeoutMs);
  return assembleProviderStatus(ollamaStatus);
}

let cachedGeminiKey: string | null = null;
let cachedGeminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY не настроен в окружении сервера (.env или Settings > Secrets).'
    );
  }
  if (!cachedGeminiClient || cachedGeminiKey !== apiKey) {
    cachedGeminiKey = apiKey;
    cachedGeminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        retryOptions: { attempts: 1 },
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
            abortSignal: req.signal,
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
          model: response.modelVersion ?? req.model,
          rawUsage: um,
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
        req.onRetry?.(err, attempt);
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Gemini call failed');
  }

  if (req.provider === 'ollama') {
    const urlCheck = resolveSafeHttpBaseUrl(process.env.OLLAMA_BASE_URL, DEFAULT_OLLAMA_BASE_URL);
    if (!urlCheck.ok) {
      throw new Error(urlCheck.error);
    }

    let resp: Response;
    try {
      resp = await fetch(`${urlCheck.url}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: req.model,
          stream: false,
          format: 'json',
          messages: [
            { role: 'system', content: req.systemInstruction },
            { role: 'user', content: req.prompt },
          ],
          options: {
            temperature: 0.1,
            num_ctx: 16384,
          },
        }),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) {
        throw new Error('LLM request aborted');
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Не удалось подключиться к локальной Ollama (${urlCheck.url}): ${msg}. Запустите сервис: ollama serve`
      );
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      if (resp.status === 404 || errText.toLowerCase().includes('not found')) {
        throw new Error(
          `Модель "${req.model}" не найдена в Ollama (${urlCheck.url}). Скачайте её командой: ollama pull ${req.model}`
        );
      }
      throw new Error(`Ollama API error ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const json = (await resp.json()) as {
      model?: string;
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
      error?: string;
    };

    if (json.error) {
      throw new Error(`Ollama returned error: ${json.error}`);
    }

    if (typeof json.prompt_eval_count !== 'number' || typeof json.eval_count !== 'number') {
      throw new Error(
        'Ollama /api/chat did not return numeric prompt_eval_count and eval_count; refusing to fabricate usage.'
      );
    }

    const promptTokens = json.prompt_eval_count;
    const completionTokens = json.eval_count;

    return {
      text: (json.message?.content ?? '').trim(),
      provider: 'ollama',
      model: json.model ?? req.model,
      rawUsage: { prompt_eval_count: promptTokens, eval_count: completionTokens },
      durationMs: Date.now() - started,
      usage: {
        promptTokens,
        completionTokens,
        cachedInputTokens: 0,
        uncachedInputTokens: promptTokens,
        thoughtsTokens: 0,
        totalTokens: promptTokens + completionTokens,
        cacheUsageMeasured: false,
        costUsd: null,
      },
    };
  }

  // OpenAI-compatible provider (e.g., OpenCode / vLLM / OpenRouter / OpenAI)
  const compatUrlCheck = resolveSafeHttpBaseUrl(process.env.OPENAI_COMPAT_BASE_URL, '');
  const apiKey = process.env.OPENAI_COMPAT_API_KEY?.trim();
  if (!process.env.OPENAI_COMPAT_BASE_URL?.trim() || !compatUrlCheck.ok || !apiKey) {
    throw new Error('OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY are not configured.');
  }

  const resp = await fetch(`${compatUrlCheck.url}/chat/completions`, {
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
    model?: string;
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
    model: json.model ?? req.model,
    rawUsage: u,
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
