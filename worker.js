/**
 * CORNERS ENGINE — CLOUDFLARE WORKER
 * ====================================
 * Handles two responsibilities:
 *   1. Proxies all Anthropic API calls (keeps API key server-side)
 *   2. Manages KV storage for the Adaptive Learning results tracker
 *
 * Routes:
 *   POST /api/chat        → Anthropic API proxy
 *   GET  /api/results     → Load all results from KV
 *   POST /api/results     → Save a new result to KV
 *   DELETE /api/results/:id → Delete a result from KV
 *   DELETE /api/results   → Clear all results from KV
 */

const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';
const RESULTS_KV_KEY = 'corners:results:v1';

// ── CORS HEADERS ─────────────────────────────────────────────
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

// ── MAIN HANDLER ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method;

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── Route: Anthropic API proxy ────────────────────────────
    if (url.pathname === '/api/chat' && method === 'POST') {
      return handleChat(request, env);
    }

    // ── Route: Results CRUD ───────────────────────────────────
    if (url.pathname === '/api/results') {
      if (method === 'GET')    return handleLoadResults(env);
      if (method === 'POST')   return handleSaveResult(request, env);
      if (method === 'DELETE') return handleClearResults(env);
    }

    // DELETE /api/results/:id
    const deleteMatch = url.pathname.match(/^\/api\/results\/(\d+)$/);
    if (deleteMatch && method === 'DELETE') {
      return handleDeleteResult(parseInt(deleteMatch[1]), env);
    }

    // ── Serve the app HTML ────────────────────────────────────
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return env.ASSETS.fetch(request);
    }

    return err('Not found', 404);
  }
};

// ── ANTHROPIC PROXY ──────────────────────────────────────────
async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err('Invalid JSON body');
  }

  // Validate required fields
  if (!body.messages || !Array.isArray(body.messages)) {
    return err('messages array required');
  }

  // Build the Anthropic request — enforce safe token limits
  const anthropicBody = {
    model:      body.model      || 'claude-sonnet-4-6',
    max_tokens: Math.min(body.max_tokens || 3000, 4096), // cap at 4096
    messages:   body.messages,
  };

  if (body.system)  anthropicBody.system = body.system;
  if (body.tools)   anthropicBody.tools  = body.tools;

  try {
    const upstream = await fetch(ANTHROPIC_API, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error('Anthropic error:', data);
      return json({ error: data.error?.message || 'Anthropic API error' }, upstream.status);
    }

    return json(data);

  } catch (e) {
    console.error('Proxy fetch error:', e);
    return err('Failed to reach Anthropic API', 502);
  }
}

// ── KV: LOAD RESULTS ─────────────────────────────────────────
async function handleLoadResults(env) {
  try {
    const raw = await env.RESULTS.get(RESULTS_KV_KEY);
    const results = raw ? JSON.parse(raw) : [];
    return json({ results });
  } catch (e) {
    console.error('KV load error:', e);
    return json({ results: [] });
  }
}

// ── KV: SAVE NEW RESULT ──────────────────────────────────────
async function handleSaveResult(request, env) {
  let record;
  try {
    record = await request.json();
  } catch {
    return err('Invalid JSON body');
  }

  if (!record.teamA || !record.teamB) {
    return err('teamA and teamB required');
  }

  // Assign ID if not present
  if (!record.id) record.id = Date.now();

  try {
    const raw     = await env.RESULTS.get(RESULTS_KV_KEY);
    const results = raw ? JSON.parse(raw) : [];
    results.unshift(record);

    // Cap at 200 results to keep KV value under 25MB
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
  try {
    await env.RESULTS.put(RESULTS_KV_KEY, JSON.stringify([]));
    return json({ success: true });
  } catch (e) {
    console.error('KV clear error:', e);
    return err('Failed to clear results', 500);
  }
}
