# headroom-cf-test

Minimal Cloudflare Worker to reproduce a zstd decompression bug in [Headroom](https://github.com/chopratejas/headroom) proxy's OpenAI handler.

## The Bug

Cloudflare Workers automatically adds `Accept-Encoding: zstd` to all outbound `fetch()` requests at the infrastructure level. This cannot be overridden from application code.

Headroom's OpenAI handler forwards this header as-is to OpenAI. OpenAI returns a zstd-compressed response, but Headroom's httpx client cannot decompress it, causing a `UnicodeDecodeError` and returning a 502 error.

The Anthropic handler already strips `accept-encoding` from forwarded headers, so it works correctly.

## Test Patterns

This worker tests three patterns:

| Endpoint | Pattern | Expected Result |
|----------|---------|----------------|
| `GET /test/openai` | OpenAI via Headroom passthrough | **502 fail** (zstd bug) |
| `GET /test/claude` | Claude via Headroom passthrough | **200 pass** (handler strips accept-encoding) |
| `GET /test/compress` | Headroom `/v1/compress` + direct OpenAI | **200 pass** (workaround) |
| `GET /test/all` | Run all three patterns | Shows all results side by side |

## Setup

### Prerequisites

- A Headroom proxy deployed somewhere (e.g., Railway)
- OpenAI API key
- Anthropic API key
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### Install

```bash
npm install
```

### Set Secrets

```bash
npx wrangler secret put HEADROOM_URL
# Enter your Headroom proxy URL, e.g.: https://your-proxy.up.railway.app/v1

npx wrangler secret put OPENAI_API_KEY
# Enter your OpenAI API key

npx wrangler secret put ANTHROPIC_API_KEY
# Enter your Anthropic API key
```

### Deploy

```bash
npx wrangler deploy
```

### Test

```bash
# Run all three patterns
curl https://headroom-cf-test.<your-subdomain>.workers.dev/test/all | python3 -m json.tool
```

## Example Output

```json
{
  "openai": {
    "pattern": "openai-passthrough",
    "status": 502,
    "ok": false,
    "body": "error code: 502"
  },
  "claude": {
    "pattern": "claude-passthrough",
    "status": 200,
    "ok": true,
    "body": { "..." }
  },
  "compress": {
    "pattern": "compress-then-openai",
    "status": 200,
    "ok": true,
    "body": { "..." }
  }
}
```

## Headroom Proxy Error Log

```
headroom.proxy - ERROR - OpenAI request failed: UnicodeDecodeError: 'utf-8' codec can't decode byte 0x9a in position 8: invalid start byte
```

## Suggested Fix

Add `headers.pop("accept-encoding", None)` in `headroom/proxy/handlers/openai.py` after the existing `host`/`content-length` pops — matching what the Anthropic handler already does. This applies to both the `/v1/chat/completions` and `/v1/responses` handlers.

## Environment

- Headroom version: 0.5.21
- Cloudflare Workers (wrangler 4.x)
- Tested with gpt-4o-mini and claude-sonnet-4
