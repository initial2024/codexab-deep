// api/model-check.js

const DEFAULT_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 60000);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function normalizeBaseUrl(input) {
  return String(input || "").trim().replace(/\/+$/, "");
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 12) return "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase();

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1"
  ) {
    return true;
  }

  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;

  const match172 = host.match(/^172\.(\d+)\./);
  if (match172) {
    const n = Number(match172[1]);
    if (n >= 16 && n <= 31) return true;
  }

  return false;
}

function validateBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);

  if (!normalized) {
    throw new Error("缺少 API Base URL");
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("API Base URL 格式不正确");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("API Base URL 只允许 http 或 https");
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new Error("禁止请求 localhost 或内网地址");
  }

  const allowedHosts = String(process.env.ALLOWED_UPSTREAM_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (allowedHosts.length > 0 && !allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new Error(
      `当前上游域名 ${parsed.hostname} 不在 ALLOWED_UPSTREAM_HOSTS 白名单中`
    );
  }

  return normalized;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function buildHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

async function checkModels(baseUrl, apiKey, model) {
  const url = `${baseUrl}/models`;

  try {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: buildHeaders(apiKey),
    });

    const data = await safeJson(response);

    const models = Array.isArray(data?.data)
      ? data.data.map((item) => item?.id).filter(Boolean)
      : [];

    return {
      ok: response.ok,
      status: response.status,
      supported: response.ok,
      modelListed: models.includes(model),
      count: models.length,
      sample: models.slice(0, 20),
    };
  } catch (error) {
    return {
      ok: false,
      supported: false,
      modelListed: false,
      error: String(error?.message || error),
    };
  }
}

async function checkShortChat(baseUrl, apiKey, model) {
  const url = `${baseUrl}/chat/completions`;

  const started = Date.now();

  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 12,
        messages: [
          {
            role: "user",
            content: "Reply with exactly one word: OK",
          },
        ],
      }),
    });

    const data = await safeJson(response);
    const latencyMs = Date.now() - started;

    const returnedModel = data?.model || "";
    const content =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.text ||
      "";

    return {
      ok: response.ok,
      status: response.status,
      latencyMs,
      returnedModel,
      modelMatched: returnedModel ? returnedModel === model : null,
      hasUsage: Boolean(data?.usage),
      contentPreview: String(content).slice(0, 80),
      rawModel: returnedModel,
      usage: data?.usage || null,
      error: response.ok ? null : data?.error || data,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: String(error?.message || error),
    };
  }
}

async function checkJsonMode(baseUrl, apiKey, model) {
  const url = `${baseUrl}/chat/completions`;

  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 40,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: 'Return JSON only: {"ok": true}',
          },
        ],
      }),
    });

    const data = await safeJson(response);
    const content = data?.choices?.[0]?.message?.content || "";

    let validJson = false;
    try {
      JSON.parse(content);
      validJson = true;
    } catch {
      validJson = false;
    }

    return {
      ok: response.ok,
      status: response.status,
      supported: response.ok && validJson,
      validJson,
      contentPreview: String(content).slice(0, 120),
      error: response.ok ? null : data?.error || data,
    };
  } catch (error) {
    return {
      ok: false,
      supported: false,
      error: String(error?.message || error),
    };
  }
}

async function checkTools(baseUrl, apiKey, model) {
  const url = `${baseUrl}/chat/completions`;

  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 80,
        tools: [
          {
            type: "function",
            function: {
              name: "get_test_value",
              description: "Return a test value",
              parameters: {
                type: "object",
                properties: {
                  value: {
                    type: "string",
                    description: "test value",
                  },
                },
                required: ["value"],
              },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: {
            name: "get_test_value",
          },
        },
        messages: [
          {
            role: "user",
            content: "Call the tool with value equal to ok.",
          },
        ],
      }),
    });

    const data = await safeJson(response);
    const toolCalls = data?.choices?.[0]?.message?.tool_calls;

    return {
      ok: response.ok,
      status: response.status,
      supported: response.ok && Array.isArray(toolCalls) && toolCalls.length > 0,
      toolCallsCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
      error: response.ok ? null : data?.error || data,
    };
  } catch (error) {
    return {
      ok: false,
      supported: false,
      error: String(error?.message || error),
    };
  }
}

async function checkStream(baseUrl, apiKey, model) {
  const url = `${baseUrl}/chat/completions`;

  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 20,
        stream: true,
        messages: [
          {
            role: "user",
            content: "Reply with OK.",
          },
        ],
      }),
    });

    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
      const data = await safeJson(response);
      return {
        ok: false,
        status: response.status,
        supported: false,
        contentType,
        error: data?.error || data,
      };
    }

    const supported =
      contentType.includes("text/event-stream") ||
      contentType.includes("application/x-ndjson") ||
      Boolean(response.body);

    if (response.body) {
      try {
        await response.body.cancel();
      } catch {}
    }

    return {
      ok: true,
      status: response.status,
      supported,
      contentType,
    };
  } catch (error) {
    return {
      ok: false,
      supported: false,
      error: String(error?.message || error),
    };
  }
}

function scoreChecks(level, checks) {
  let score = 0;
  const flags = [];
  const warnings = [];

  if (checks.shortChat?.ok) {
    score += 25;
    flags.push("基础聊天请求成功");
  } else {
    warnings.push("基础聊天请求失败");
  }

  if (checks.models?.supported) {
    score += 10;
    flags.push("/models 接口可访问");
  } else {
    warnings.push("/models 接口不可用或不兼容");
  }

  if (checks.models?.modelListed) {
    score += 15;
    flags.push("目标模型出现在 /models 列表中");
  } else if (checks.models?.supported) {
    warnings.push("目标模型未出现在 /models 列表中");
  }

  if (checks.shortChat?.modelMatched === true) {
    score += 15;
    flags.push("返回 model 字段与请求模型一致");
  } else if (checks.shortChat?.modelMatched === false) {
    warnings.push("返回 model 字段与请求模型不一致");
  } else {
    warnings.push("无法确认返回 model 字段是否一致");
  }

  if (checks.shortChat?.hasUsage) {
    score += 5;
    flags.push("usage 字段存在");
  } else {
    warnings.push("usage 字段缺失");
  }

  if (level !== "light") {
    if (checks.stream?.supported) {
      score += 10;
      flags.push("stream 流式输出支持");
    } else {
      warnings.push("stream 流式输出未通过");
    }

    if (checks.jsonMode?.supported) {
      score += 10;
      flags.push("JSON mode 支持");
    } else {
      warnings.push("JSON mode 未通过");
    }

    if (checks.tools?.supported) {
      score += 10;
      flags.push("tools / function calling 支持");
    } else {
      warnings.push("tools / function calling 未通过");
    }
  } else {
    warnings.push("轻量检测未验证 stream、JSON mode 和 tools 能力");
  }

  score = Math.max(0, Math.min(100, score));

  let verdict = "无法验证";
  let purityLevel = "unverified";

  if (score >= 85) {
    verdict = "高可信";
    purityLevel = "high_confidence_full";
  } else if (score >= 70) {
    verdict = "基本可信";
    purityLevel = "likely_full";
  } else if (score >= 50) {
    verdict = "疑似受限";
    purityLevel = "possibly_limited";
  } else if (score >= 30) {
    verdict = "疑似降级";
    purityLevel = "likely_degraded";
  }

  return {
    score,
    verdict,
    level: purityLevel,
    flags,
    warnings,
  };
}

function inferApiType(checks) {
  if (checks.shortChat?.ok && checks.stream?.supported && checks.tools?.supported) {
    return {
      type: "openai-compatible",
      confidence: 0.86,
    };
  }

  if (checks.shortChat?.ok) {
    return {
      type: "partial-compatible",
      confidence: 0.62,
    };
  }

  return {
    type: "unknown",
    confidence: 0.2,
  };
}

function inferModelType(checks) {
  const features = [];

  if (checks.shortChat?.ok) features.push("text");
  if (checks.stream?.supported) features.push("stream");
  if (checks.jsonMode?.supported) features.push("json");
  if (checks.tools?.supported) features.push("tools");

  let type = "unknown";

  if (features.includes("tools")) {
    type = "tool-capable";
  } else if (features.includes("text")) {
    type = "text-only";
  }

  return {
    type,
    features,
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "model-check",
      levels: ["light", "standard", "deep"],
      defaultLevel: "light",
      warning:
        "模型检测会发起真实模型请求，可能消耗 token、余额或中转站额度。检测结果仅供参考，不能作为模型来源的绝对证明。",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method Not Allowed",
    });
  }

  if (process.env.ENABLE_MODEL_CHECK === "false") {
    return res.status(403).json({
      ok: false,
      error: "当前后端未启用模型可信度检测",
    });
  }

  try {
    const body = req.body || {};

    const baseUrl = validateBaseUrl(
      body.baseUrl || process.env.DEFAULT_AI_BASE_URL
    );

    const model = String(body.model || process.env.DEFAULT_AI_MODEL || "").trim();

    if (!model) {
      return res.status(400).json({
        ok: false,
        error: "缺少模型名称",
      });
    }

    const level = ["light", "standard", "deep"].includes(body.level)
      ? body.level
      : "light";

    const authHeader = req.headers.authorization || "";
    const headerKey = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";

    const apiKey = process.env.UPSTREAM_API_KEY || headerKey;

    if (!apiKey) {
      return res.status(401).json({
        ok: false,
        error:
          "缺少 API Key。请在 Authorization 中传入 Bearer Key，或在云端环境变量 UPSTREAM_API_KEY 中配置。",
      });
    }

    const checks = {};

    checks.models = await checkModels(baseUrl, apiKey, model);
    checks.shortChat = await checkShortChat(baseUrl, apiKey, model);

    if (level === "standard" || level === "deep") {
      checks.stream = await checkStream(baseUrl, apiKey, model);
      checks.jsonMode = await checkJsonMode(baseUrl, apiKey, model);
      checks.tools = await checkTools(baseUrl, apiKey, model);
    } else {
      checks.stream = null;
      checks.jsonMode = null;
      checks.tools = null;
    }

    const purity = scoreChecks(level, checks);
    const apiType = inferApiType(checks);
    const modelType = inferModelType(checks);

    return res.status(200).json({
      ok: true,
      level,
      target: {
        baseUrl,
        model,
      },
      apiType,
      modelType,
      purity,
      checks,
      security: {
        apiKeySource: process.env.UPSTREAM_API_KEY ? "env" : "authorization",
        apiKeyMasked: maskKey(apiKey),
        allowedHosts: process.env.ALLOWED_UPSTREAM_HOSTS || "",
      },
      costWarning:
        "本次检测已发起真实模型请求，可能消耗 token、余额或中转站额度。",
      disclaimer:
        "检测结果仅基于接口行为、返回字段和能力探针，不能作为模型真实来源的绝对证明。第三方中转站可能伪造模型字段或动态切换模型。",
      time: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: String(error?.message || error),
      disclaimer:
        "检测失败不一定代表模型不可用，也可能是 Base URL、API Key、模型名、网络、白名单或中转站兼容性问题。",
    });
  }
}
