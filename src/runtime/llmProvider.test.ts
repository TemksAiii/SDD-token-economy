import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  callLlmWithUsage,
  getProviderStatusAsync,
  resolveSafeHttpBaseUrl,
} from './llmProvider';
import { runRealAbWorktreeBenchmark } from './abWorktreeRunner';

async function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    prev[key] = process.env[key];
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (prev[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev[key];
      }
    }
  }
}

async function startMockServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      handler(req, body, res);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind mock HTTP server');
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test('resolveSafeHttpBaseUrl validates http/https schemes and strips trailing slashes', () => {
  const ok = resolveSafeHttpBaseUrl('http://127.0.0.1:11434///', 'http://127.0.0.1:11434');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.url, 'http://127.0.0.1:11434');

  const badScheme = resolveSafeHttpBaseUrl('file:///etc/passwd', 'http://127.0.0.1:11434');
  assert.equal(badScheme.ok, false);
});

test('getProviderStatusAsync reports unreachable Ollama cleanly without fabricating models', async () => {
  // Bind and immediately close a port so connection fails fast with ECONNREFUSED
  const temp = await startMockServer((_req, _body, res) => {
    res.end('{}');
  });
  await temp.close();

  await withEnv(
    {
      GEMINI_API_KEY: undefined,
      OPENAI_COMPAT_BASE_URL: undefined,
      OPENAI_COMPAT_API_KEY: undefined,
      OLLAMA_ENABLED: 'true',
      OLLAMA_BASE_URL: temp.baseUrl,
    },
    async () => {
      const status = await getProviderStatusAsync(500);
      assert.equal(status.geminiConfigured, false);
      assert.equal(status.ollamaConfigured, false);
      assert.equal(status.defaultProvider, 'none');
      assert.equal(status.ollamaStatus.reachable, false);
      assert.match(status.ollamaStatus.error ?? '', /ollama serve/);
      assert.equal(status.availableModels.length, 0);
    }
  );
});

test('getProviderStatusAsync discovers Ollama models and keeps Gemini Hydrogen as flagship default when key is set', async () => {
  const mock = await startMockServer((req, _body, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5-coder:7b' }],
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    await withEnv(
      {
        GEMINI_API_KEY: undefined,
        OPENAI_COMPAT_BASE_URL: undefined,
        OPENAI_COMPAT_API_KEY: undefined,
        OLLAMA_ENABLED: 'true',
        OLLAMA_BASE_URL: mock.baseUrl,
        OLLAMA_MODEL: 'qwen2.5-coder:7b',
      },
      async () => {
        const statusLocalOnly = await getProviderStatusAsync(1000);
        assert.equal(statusLocalOnly.ollamaConfigured, true);
        assert.equal(statusLocalOnly.defaultProvider, 'ollama');
        assert.equal(statusLocalOnly.ollamaStatus.installedModels[0], 'qwen2.5-coder:7b');
        assert.equal(statusLocalOnly.availableModels[0].provider, 'ollama');
        assert.equal(statusLocalOnly.availableModels[0].locality, 'local');
      }
    );

    await withEnv(
      {
        GEMINI_API_KEY: 'test-gemini-key',
        OLLAMA_ENABLED: 'true',
        OLLAMA_BASE_URL: mock.baseUrl,
        OLLAMA_MODEL: 'qwen2.5-coder:7b',
      },
      async () => {
        const statusBoth = await getProviderStatusAsync(1000);
        assert.equal(statusBoth.geminiConfigured, true);
        assert.equal(statusBoth.ollamaConfigured, true);
        assert.equal(statusBoth.defaultProvider, 'gemini');
        assert.equal(statusBoth.availableModels[0].id, 'gemini-4-hydrogen');
        assert.ok(statusBoth.availableModels.some((m) => m.provider === 'ollama'));
      }
    );
  } finally {
    await mock.close();
  }
});

test('getProviderStatusAsync reports empty Ollama model list with ollama pull hint', async () => {
  const mock = await startMockServer((_req, _body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [] }));
  });

  try {
    await withEnv(
      {
        GEMINI_API_KEY: undefined,
        OLLAMA_ENABLED: 'true',
        OLLAMA_BASE_URL: mock.baseUrl,
      },
      async () => {
        const status = await getProviderStatusAsync(1000);
        assert.equal(status.ollamaStatus.reachable, true);
        assert.equal(status.ollamaConfigured, false);
        assert.equal(status.defaultProvider, 'none');
        assert.match(status.ollamaStatus.error ?? '', /ollama pull qwen2\.5-coder:7b/);
      }
    );
  } finally {
    await mock.close();
  }
});

test('callLlmWithUsage executes Ollama /api/chat, returns real counts with costUsd: null, and refuses missing usage', async () => {
  let mode: 'ok' | 'missing_usage' | 'not_found' = 'ok';
  let capturedBody: Record<string, unknown> | null = null;

  const mock = await startMockServer((req, body, res) => {
    if (req.url === '/api/chat' && req.method === 'POST') {
      capturedBody = JSON.parse(body);
      if (mode === 'not_found') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "model 'missing:7b' not found" }));
        return;
      }
      if (mode === 'missing_usage') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { content: '{"ok":true}' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: { role: 'assistant', content: '{"plan":["step 1"]}' },
          prompt_eval_count: 412,
          eval_count: 88,
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    await withEnv({ OLLAMA_BASE_URL: mock.baseUrl }, async () => {
      const okResp = await callLlmWithUsage({
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        systemInstruction: 'Return JSON only.',
        prompt: 'Plan task TSK-01',
      });

      assert.equal(okResp.provider, 'ollama');
      assert.equal(okResp.model, 'qwen2.5-coder:7b');
      assert.equal(okResp.text, '{"plan":["step 1"]}');
      assert.equal(okResp.usage.promptTokens, 412);
      assert.equal(okResp.usage.completionTokens, 88);
      assert.equal(okResp.usage.totalTokens, 500);
      assert.equal(okResp.usage.cachedInputTokens, 0);
      assert.equal(okResp.usage.cacheUsageMeasured, false);
      assert.equal(okResp.usage.costUsd, null);
      assert.equal(capturedBody?.stream, false);
      assert.equal(capturedBody?.format, 'json');

      mode = 'not_found';
      await assert.rejects(
        () =>
          callLlmWithUsage({
            provider: 'ollama',
            model: 'missing:7b',
            systemInstruction: 'sys',
            prompt: 'user',
          }),
        /ollama pull missing:7b/
      );

      mode = 'missing_usage';
      await assert.rejects(
        () =>
          callLlmWithUsage({
            provider: 'ollama',
            model: 'qwen2.5-coder:7b',
            systemInstruction: 'sys',
            prompt: 'user',
          }),
        /refusing to fabricate usage/
      );
    });
  } finally {
    await mock.close();
  }
});

test('runRealAbWorktreeBenchmark rejects explicitly when provider ollama is requested but server is down', async () => {
  const temp = await startMockServer((_req, _body, res) => res.end('{}'));
  await temp.close();

  await withEnv(
    {
      OLLAMA_ENABLED: 'true',
      OLLAMA_BASE_URL: temp.baseUrl,
    },
    async () => {
      await assert.rejects(
        () =>
          runRealAbWorktreeBenchmark({
            repoPath: 'benchmarks/orders-ts',
            changeId: 'add-idempotency-and-webhooks',
            provider: 'ollama',
            model: 'qwen2.5-coder:7b',
          }),
        /ollama serve/
      );
    }
  );
});
