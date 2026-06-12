/**
 * CORNERS ENGINE — CLOUDFLARE WORKER
 * ====================================
 * Routes:
 *   POST /api/chat          → Anthropic API proxy
 *   GET  /api/results       → Load all results from KV
 *   POST /api/results       → Save a new result to KV
 *   DELETE /api/results/:id → Delete a result by ID
 *   DELETE /api/results     → Clear all results
 *   *                       → Serve static assets
 */

const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';
const RESULTS_KV_KEY = 'corners:results:v1';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method;

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── API: Anthropic proxy ──────────────────────────────────
    if (url.pathname === '/api/chat' && method === 'POST') {
      return handleChat(request, env);
    }

    // ── API: Results CRUD ─────────────────────────────────────
    if (url.pathname === '/api/results') {
      if (method === 'GET')    return handleLoadResults(env);
      if (method === 'POST')   return handleSaveResult(request, env);
      if (method === 'DELETE') return handleClearResults(env);
    }

    const deleteMatch = url.pathname.match(/^\/api\/results\/(\d+)$/);
    if (deleteMatch && method === 'DELETE') {
      return handleDeleteResult(parseInt(deleteMatch[1]), env);
    }

    // ── Static assets (index.html etc.) ──────────────────────
    // Pass everything else to Cloudflare Assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return err('Not found', 404);
  }
};

// ── ANTHROPIC PROXY ──────────────────────────────────────────
async function handleChat(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return err('ANTHROPIC_API_KEY secret not configured', 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return err('Invalid JSON body');
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return err('messages array required');
  }

  // Always use a valid current model; reject unknown model strings
  const ALLOWED_MODELS = [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-7',
    'claude-opus-4-8',
  ];
  const model = ALLOWED_MODELS.includes(body.model)
    ? body.model
    : 'claude-sonnet-4-6';

  const anthropicBody = {
    model,
    max_tokens: Math.min(body.max_tokens || 3000, 4096),
    messages:   body.messages,
  };
  if (body.system) anthropicBody.system = body.system;
  if (body.tools)  anthropicBody.tools  = body.tools;

  try {
    const upstream = await fetch(ANTHROPIC_API, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'web-search-2025-03-05',
      },
      body: JSON.stringify(anthropicBody),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error('Anthropic error:', JSON.stringify(data));
      return json({ error: data.error?.message || 'Anthropic API error' }, upstream.status);
    }

    return json(data);

  } catch (e) {
    console.error('Proxy fetch error:', e.message);
    return err('Failed to reach Anthropic API', 502);
  }
}

// ── KV: LOAD RESULTS ─────────────────────────────────────────
async function handleLoadResults(env) {
  if (!env.RESULTS) return json({ results: [] });
  try {
    const raw = await env.RESULTS.get(RESULTS_KV_KEY);
    return json({ results: raw ? JSON.parse(raw) : [] });
  } catch (e) {
    console.error('KV load error:', e);
    return json({ results: [] });
  }
}

// ── KV: SAVE NEW RESULT ──────────────────────────────────────
async function handleSaveResult(request, env) {
  let record;
  try { record = await request.json(); }
  catch { return err('Invalid JSON body'); }

  if (!record.teamA || !record.teamB) return err('teamA and teamB required');
  if (!record.id) record.id = Date.now();

  if (!env.RESULTS) return json({ success: true, id: record.id, total: 0 });

  try {
    const raw     = await env.RESULTS.get(RESULTS_KV_KEY);
    const results = raw ? JSON.parse(raw) : [];
    results.unshift(record);
    const trimmed = results.slice(0, 200);
    await env.RESULTS.put(RESULTS_KV_KEY, JSON.stringify(trimmed));
    return json({ success: true, id: record.id, total: trimmed.length });
  } catch (e) {
    console.error('KV save error:', e);
    return err('Failed to save result', 500);
  }
}

// ── KV: DELETE ONE RESULT ────────────────────────────────────
async function handleDeleteResult(id, env) {
  if (!env.RESULTS) return json({ success: true, remaining: 0 });
  try {
    const raw     = await env.RESULTS.get(RESULTS_KV_KEY);
    const results = raw ? JSON.parse(raw) : [];
    const updated = results.filter(r => r.id !== id);
    await env.RESULTS.put(RESULTS_KV_KEY, JSON.stringify(updated));
    return json({ success: true, remaining: updated.length });
  } catch (e) {
    console.error('KV delete error:', e);
    return err('Failed to delete result', 500);
  }
}

// ── KV: CLEAR ALL RESULTS ────────────────────────────────────
async function handleClearResults(env) {
  if (!env.RESULTS) return json({ success: true });
  try {
    await env.RESULTS.put(RESULTS_KV_KEY, JSON.stringify([]));
    return json({ success: true });
  } catch (e) {
    console.error('KV clear error:', e);
    return err('Failed to clear results', 500);
  }
}
