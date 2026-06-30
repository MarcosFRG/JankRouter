require('dotenv').config();
const express = require('express');
const fs = require('fs');
const app = express();
app.use(express.json());

let config;
try {
  const raw = fs.readFileSync('./config.json');
  config = JSON.parse(raw);
} catch (err) {
  console.error('Error loading config.json:', err.message);
  process.exit(1);
}

const providers = config.providers || {};
const models = config.models || [];
const defaultTimeout = config.default_timeout || 42000;
const portkeyBaseUrl = process.env.PORTKEY_BASE_URL;

const modelMap = new Map();
for (const m of models) {
  modelMap.set(m.name, m);
  if (Array.isArray(m.aliases)) {
    for (const alias of m.aliases) modelMap.set(alias, m);
  }
}

function buildPortkeyConfig(modelConfig) {
  const targets = (modelConfig.targets || []).map(target => {
    const provider = providers[target.provider];
    if (!provider) throw new Error(`Unknown provider: ${target.provider}`);
    const apiKey = process.env[provider.api_key_env];
    if (!apiKey) throw new Error(`Missing API key for provider ${target.provider} (env: ${provider.api_key_env})`);
    return {
      provider: "openai",
      custom_host: provider.url,
      api_key: apiKey,
      override_params: { model: target.model }
    };
  });

  return {
    strategy: { mode: "fallback" },
    request_timeout: modelConfig.timeout || defaultTimeout,
    targets
  };
}

async function proxyToPortkey(modelConfig, body, res, options = {}) {
  const portkeyConfig = buildPortkeyConfig(modelConfig);
  const streamTimeout = modelConfig.stream_timeout || 30000;

  const headers = {
    'Content-Type': 'application/json',
    'x-portkey-config': JSON.stringify(portkeyConfig),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);

  try {
    const upstream = await fetch(`${portkeyBaseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      const errText = await upstream.text();
      throw new Error(`Portkey error ${upstream.status}: ${errText}`);
    }

    if (!body.stream) {
      const data = await upstream.json();
      if (options.responseType === 'text') return res.type('text/plain').send(data.choices?.[0]?.message?.content || '');
      return res.json(data);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const reader = upstream.body.getReader();
    let idleTimer = setTimeout(() => {
      controller.abort();
      res.end();
    }, streamTimeout);

    try {
      while (true) {
        const { done, value } = await reader.read();
        clearTimeout(idleTimer);
        if (done) break;
        res.write(value);
        idleTimer = setTimeout(() => {
          controller.abort();
          res.end();
        }, streamTimeout);
      }
    } finally {
      clearTimeout(idleTimer);
      res.end();
    }
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

app.post('/v1/chat/completions', async (req, res) => {
  const body = req.body;
  if (!body.model) return res.status(400).json({ error: 'Missing model parameter' });

  const modelConfig = modelMap.get(body.model);
  if (!modelConfig) return res.status(404).json({ error: `Model not found: ${body.model}` });

  try {
    await proxyToPortkey(modelConfig, body, res);
  } catch (err) {
    res.status(502).json({ error: 'Portkey request failed', details: err.message });
  }
});

app.get('/generate/:text', async (req, res) => {
  const text = req.params.text;
  const {
    model,
    temperature,
    top_p,
    max_tokens,
    max_completion_tokens,
    presence_penalty,
    frequency_penalty,
    stop,
    seed,
    stream,
    system,
    response_format,
    logprobs,
    top_logprobs,
    user,
    n,
  } = req.query;

  if (!model) return res.status(400).json({ error: 'Missing model parameter' });

  const modelConfig = modelMap.get(model);
  if (!modelConfig) return res.status(404).json({ error: `Model not found: ${model}` });

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: text });

  const body = {
    model,
    messages,
    ...(temperature !== undefined && { temperature: parseFloat(temperature) }),
    ...(top_p !== undefined && { top_p: parseFloat(top_p) }),
    ...(max_tokens !== undefined && { max_tokens: parseInt(max_tokens) }),
    ...(max_completion_tokens !== undefined && { max_completion_tokens: parseInt(max_completion_tokens) }),
    ...(presence_penalty !== undefined && { presence_penalty: parseFloat(presence_penalty) }),
    ...(frequency_penalty !== undefined && { frequency_penalty: parseFloat(frequency_penalty) }),
    ...(stop !== undefined && { stop: stop.includes(',') ? stop.split(',') : stop }),
    ...(seed !== undefined && { seed: parseInt(seed) }),
    ...(stream !== undefined && { stream: stream === 'true' }),
    ...(response_format !== undefined && { response_format }),
    ...(logprobs !== undefined && { logprobs: logprobs === 'true' }),
    ...(top_logprobs !== undefined && { top_logprobs: parseInt(top_logprobs) }),
    ...(user !== undefined && { user }),
    ...(n !== undefined && { n: parseInt(n) }),
  };

  try {
    await proxyToPortkey(modelConfig, body, res, { responseType: 'text' });
  } catch (err) {
    res.status(502).json({ error: 'Portkey request failed', details: err.message });
  }
});

app.get('/', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  const modelList = models.map(m => {
    const aliasesStr = m.aliases ? ` (alias: ${m.aliases.map(a => `<code>${a}</code>`).join(', ')})` : '';
    return `<li><code>${m.name}</code>${aliasesStr}</li>`;
  }).join('\n');

  res.send(`<!doctypehtml><html lang=en><head><meta charset=UTF-8><meta name=viewport content="width=device-width,initial-scale=1"><title>JankRouter — Free & Unstable AI Gateway</title><style>*,:after,:before{box-sizing:border-box}body{background:#0d1117;color:#c9d1d9;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;max-width:880px;margin:40px auto;padding:0 24px;line-height:1.6}h1{font-size:2.4rem;font-weight:700;background:linear-gradient(135deg,#f0883e,#f0a860);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}.tagline{color:#8b949e;font-size:1.1rem;margin-top:0 0 32px}h2{font-size:1.4rem;font-weight:600;color:#f0a860;margin-top:36px;border-bottom:1px solid #21262d;padding-bottom:6px}code{background:#161b22;color:#f0883e;padding:2px 8px;border-radius:6px;font-size:.9rem}pre{background:#161b22;padding:16px;border-radius:8px;overflow-x:auto;font-size:.85rem;line-height:1.5;border:1px solid #30363d}ul{list-style-type:none;padding-left:0;display:flex;flex-wrap:wrap;gap:8px}li{background:#161b22;border:1px solid #30363d;padding:6px 14px;border-radius:20px;font-size:.9rem;margin:0}a{color:#f0883e;text-decoration:none}a:hover{text-decoration:underline}.footer{margin-top:48px;font-size:.8rem;color:#484f58;text-align:center}</style></head><body><h1>⚡ JankRouter</h1><p class=tagline>Free & occasionally unstable AI model gateway — you get what you pay for.</p><h2>📡 POST /v1/chat/completions</h2><pre>curl ${host}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hi"}]}'</pre><h2>⚡ GET /generate/:text</h2><pre>${host}/generate/Hello?model=deepseek-v4-flash</pre><h2>🧠 Models</h2><ul>${modelList}</ul><div class=footer>JankRouter — Provided as-is. May occasionally burst into flames.</div></body></html>`);
});

app.get('/v1/models', (req, res) => {
  const data = models.map(m => ({
    id: m.name,
    object: 'model',
    owned_by: m.provider || 'free'
  }));

  res.json({
    object: 'list',
    data
  });
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
  process.stdout.write(`Gateway listening on port ${PORT}\n`);
});