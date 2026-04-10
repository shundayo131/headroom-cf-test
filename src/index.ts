// Headroom proxy test worker — reproduces response decompression bug from Cloudflare Workers.
// Cloudflare's edge infrastructure manages compression between the Worker and upstream servers.
// The forwarded Accept-Encoding header can cause OpenAI to return responses in an encoding
// that Headroom's httpx cannot decompress, resulting in UnicodeDecodeError.
//
// Three test patterns:
//   GET /test/openai    — OpenAI via Headroom passthrough (fails: handler doesn't strip accept-encoding)
//   GET /test/claude    — Claude via Headroom passthrough (works: handler strips accept-encoding)
//   GET /test/compress  — Headroom compress + direct OpenAI call (works: workaround)
//   GET /test/all       — Run all three patterns

interface Env {
  HEADROOM_URL: string;       // e.g. https://memoca-production.up.railway.app/v1
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
}

const TEST_MESSAGES = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Say hello in one sentence." },
];

// Pattern 1: Call OpenAI /v1/chat/completions through Headroom proxy passthrough.
// Headroom's OpenAI handler forwards the client's Accept-Encoding header to OpenAI.
// OpenAI may return a compressed response that httpx cannot decompress → 502 error.
async function testOpenAiPassthrough(env: Env) {
  const response = await fetch(`${env.HEADROOM_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: TEST_MESSAGES,
    }),
  });

  const body = await response.text();
  return {
    pattern: "openai-passthrough",
    status: response.status,
    ok: response.ok,
    body: tryParseJson(body),
  };
}

// Pattern 2: Call Claude /v1/messages through Headroom proxy passthrough.
// Headroom's Anthropic handler strips accept-encoding before forwarding, so no issue.
async function testClaudePassthrough(env: Env) {
  const response = await fetch(`${env.HEADROOM_URL}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 50,
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Say hello in one sentence." }],
    }),
  });

  const body = await response.text();
  return {
    pattern: "claude-passthrough",
    status: response.status,
    ok: response.ok,
    body: tryParseJson(body),
  };
}

// Pattern 3: Compress via Headroom, then call OpenAI directly.
// Avoids the decompression issue because /v1/compress doesn't make an upstream LLM call.
async function testCompressThenOpenAi(env: Env) {
  // Step 1: Compress
  const compressResponse = await fetch(`${env.HEADROOM_URL}/compress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: TEST_MESSAGES,
    }),
  });

  const compressResult = await compressResponse.json() as {
    messages?: Array<{ role: string; content: string }>;
    tokens_before?: number;
    tokens_after?: number;
    tokens_saved?: number;
  };

  const messages = compressResult.messages ?? TEST_MESSAGES;

  // Step 2: Call OpenAI directly
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
    }),
  });

  const body = await response.text();
  return {
    pattern: "compress-then-openai",
    status: response.status,
    ok: response.ok,
    compression: {
      tokens_before: compressResult.tokens_before,
      tokens_after: compressResult.tokens_after,
      tokens_saved: compressResult.tokens_saved,
    },
    body: tryParseJson(body),
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      let result: unknown;

      switch (url.pathname) {
        case "/test/openai":
          result = await testOpenAiPassthrough(env);
          break;
        case "/test/claude":
          result = await testClaudePassthrough(env);
          break;
        case "/test/compress":
          result = await testCompressThenOpenAi(env);
          break;
        case "/test/all": {
          // Run all three patterns
          const [openai, claude, compress] = await Promise.allSettled([
            testOpenAiPassthrough(env),
            testClaudePassthrough(env),
            testCompressThenOpenAi(env),
          ]);
          result = {
            openai: openai.status === "fulfilled" ? openai.value : { error: (openai as PromiseRejectedResult).reason?.message },
            claude: claude.status === "fulfilled" ? claude.value : { error: (claude as PromiseRejectedResult).reason?.message },
            compress: compress.status === "fulfilled" ? compress.value : { error: (compress as PromiseRejectedResult).reason?.message },
          };
          break;
        }
        default:
          result = {
            endpoints: [
              "GET /test/openai    — OpenAI via Headroom passthrough (expect: fail)",
              "GET /test/claude    — Claude via Headroom passthrough (expect: pass)",
              "GET /test/compress  — Compress + direct OpenAI (expect: pass)",
              "GET /test/all       — Run all three patterns",
            ],
          };
      }

      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  },
} satisfies ExportedHandler<Env>;
