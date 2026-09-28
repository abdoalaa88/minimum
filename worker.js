/**
 * MiniMiz — Cloudflare Worker API
 * Endpoint: POST /api/optimize
 * Body: { prompt: string, questionnaireAnswers?: object, archetype?: string, mode?: string }
 * Header: Authorization: Bearer <supabase access token>   (required — ties usage to an account)
 *
 * Public variable in wrangler.toml:
 *   SUPABASE_URL        — the same Supabase project URL used by the frontend
 *
 * Secrets (set via `wrangler secret put <NAME>`):
 *   GROQ_API_KEY        — if using Groq (recommended, generous free tier, fast)
 *   GEMINI_API_KEY      — if using Google Gemini instead
 *   SUPABASE_ANON_KEY   — the same project's public anon key used by the frontend
 *   SUPABASE_SECRET_KEY — service-role secret used only for atomic usage accounting
 *
 * Set AI_PROVIDER in wrangler.toml [vars] to "groq" or "gemini".
 */

const SYSTEM_PROMPT = `You are the internal core of 'MiniMiz'. Transform user prompts into hyper-condensed, instruction-dense, zero-fluff prompts optimized for AI agents. Preserve the input's language, dialect, script, and voice. Remove filler and redundancy while keeping the user's intent and constraints. A compressed prompt must be shorter than the source; do not add structure or details that make it longer.

If the input is too ambiguous or short to optimize confidently, respond with 1-3 concise multiple-choice clarification questions in the input's language.

ALWAYS reply with strict JSON only, no markdown fences, no commentary, matching exactly one of these two shapes:

Shape A (needs clarification):
{"action":"QUESTIONNAIRE","questions":[{"key":"target_agent","question":"...","options":["...","..."]}]}

Shape B (ready to optimize):
{"action":"GENERATE_PROMPT","optimized_prompt":"...","tokens_saved":"0%","execution_density_rating":"High"}

Rules:
- Never include both action types.
- tokens_saved is a placeholder; the application calculates its own rough estimate.
- execution_density_rating is one of: Low, Medium, High, Maximum.
- Return only the shortened prompt, without added headings or translation.
- If questionnaireAnswers are provided in the user message, treat the input as already clarified and always return Shape B.`;

const OPTIMIZER_SYSTEM_PROMPT = `You are the prompt-optimization core of 'MiniMiz'. Upgrade rough user requests into professional, execution-ready prompts for AI agents. This mode is prompt optimization, not shortening: translate the user's request into clear professional English, preserve all intent and requirements, and organize the result using concise Markdown sections. The output may be longer when structure makes the request clearer or preserves important detail.

Use these headings when they contain relevant information:
## Role
## Task
## Format
## Constraints

Do not invent requirements, facts, examples, or deliverables. Keep named entities and technical details accurate. Preserve meaningful specifics from the source. If a key decision is ambiguous, ask 1-3 concise multiple-choice questions before producing the prompt.

ALWAYS reply with strict JSON only, no markdown fences or commentary, matching exactly one of these shapes:

Shape A (needs clarification):
{"action":"QUESTIONNAIRE","questions":[{"key":"target_agent","question":"...","options":["...","..."]}]}

Shape B (ready to optimize):
{"action":"GENERATE_PROMPT","optimized_prompt":"...","tokens_saved":"0%","execution_density_rating":"High"}

Rules:
- Never include both action types.
- tokens_saved is a placeholder; the application calculates the estimated length change.
- execution_density_rating is one of: Low, Medium, High, Maximum.
- Write the optimized prompt in professional English, using the headings above where applicable.
- If questionnaireAnswers are provided in the user message, treat the input as already clarified and always return Shape B.`;

const ALLOWED_ORIGINS = new Set([
  "https://minimiz-ai.pages.dev",
  "https://minimum-ai.pages.dev",
  "http://localhost:8787",
  "http://localhost:3000",
]);

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Vary": "Origin",
      ...corsHeaders(origin),
    },
  });
}

const MODE_INSTRUCTIONS = {
  conservative: "Compression strictness: CONSERVATIVE. Preserve nuance and secondary constraints; only strip clear filler.",
  balanced: "Compression strictness: BALANCED. Strip filler and redundancy while keeping all functional constraints.",
  aggressive: "Compression strictness: AGGRESSIVE. Maximize token reduction; keep only what changes agent behavior, drop all soft/nice-to-have guidance.",
};

const OPTIMIZER_MODE_INSTRUCTIONS = {
  conservative: "Improvement style: conservative. Preserve context and make only useful clarity improvements.",
  balanced: "Improvement style: balanced. Organize the request and clarify its requirements without inventing details.",
  aggressive: "Improvement style: intensive. Make the prompt professional and execution-ready, with useful structure and necessary detail.",
};

function buildUserMessage(prompt, questionnaireAnswers, archetype, mode, isPromptOptimizer) {
  const modeInstruction = isPromptOptimizer
    ? (OPTIMIZER_MODE_INSTRUCTIONS[mode] || OPTIMIZER_MODE_INSTRUCTIONS.balanced)
    : (MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.balanced);
  const context = [
    archetype ? `Target agent archetype: ${archetype}.` : "",
    modeInstruction,
  ].filter(Boolean).join(" ");

  if (questionnaireAnswers && Object.keys(questionnaireAnswers).length > 0) {
    const request = isPromptOptimizer
      ? "Generate the final professionally optimized English prompt now (Shape B only)."
      : "Generate the final compressed prompt now (Shape B only).";
    return `${context}\\n\\nOriginal prompt: """${prompt}"""\\n\\nClarification answers: ${JSON.stringify(questionnaireAnswers)}\\n\\n${request}`;
  }
  const request = isPromptOptimizer
    ? "Translate and structure this request as a professional English prompt. It may be longer if useful:"
    : "Compress this prompt without changing its language or meaning:";
  return `${context}\\n\\n${request} """${prompt}"""`;
}
function extractJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "");
  return JSON.parse(cleaned);
}

// Verifies the bearer token against Supabase Auth and returns the user, or null.
async function verifySupabaseUser(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return { error: "AUTH_CONFIG_MISSING", status: 503 };
  }
  if (!token) return { error: "AUTH_REQUIRED", status: 401 };

  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_ANON_KEY,
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { error: "AUTH_REQUIRED", status: 401 };
    }
    if (!res.ok) return { error: "AUTH_SERVICE_UNAVAILABLE", status: 503 };
    const user = await res.json();
    return user && user.id
      ? { user }
      : { error: "AUTH_REQUIRED", status: 401 };
  } catch {
    return { error: "AUTH_SERVICE_UNAVAILABLE", status: 503 };
  }
}

const MAX_OUTPUT_TOKENS = 1024;

function estimateReservedInputTokens(text) {
  let arabicCharacters = 0;
  let totalCharacters = 0;
  for (const character of text) {
    totalCharacters += 1;
    if (/\p{Script=Arabic}/u.test(character)) arabicCharacters += 1;
  }
  // Reserve one token per Arabic character and one per three other characters.
  // This safely fits normal prompts into the configured free allowance without
  // counting every English system-prompt character as a separate token.
  return Math.ceil(arabicCharacters + (totalCharacters - arabicCharacters) / 3);
}

function numericTokenCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function callGroq(env, userMessage, systemPrompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      temperature: 0.3,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      reasoning_format: "hidden",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });
  if (!res.ok) throw new Error(`GROQ_HTTP_${res.status}`);
  const data = await res.json();
  const usage = data.usage || {};
  return {
    text: data.choices?.[0]?.message?.content || "",
    inputTokens: numericTokenCount(usage.prompt_tokens),
    outputTokens: numericTokenCount(usage.completion_tokens),
    totalTokens: numericTokenCount(usage.total_tokens),
  };
}

async function callGemini(env, userMessage, systemPrompt) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: { temperature: 0.3, responseMimeType: "application/json", maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
  });
  if (!res.ok) throw new Error(`GEMINI_HTTP_${res.status}`);
  const data = await res.json();
  const usage = data.usageMetadata || {};
  return {
    text: data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "",
    inputTokens: numericTokenCount(usage.promptTokenCount),
    outputTokens: numericTokenCount(usage.candidatesTokenCount),
    totalTokens: numericTokenCount(usage.totalTokenCount),
  };
}

async function adminRpc(env, functionName, args) {
  const adminKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!adminKey) throw new Error("USAGE_ACCOUNTING_NOT_CONFIGURED");
  const headers = {
    "Content-Type": "application/json",
    apikey: adminKey,
  };
  // Legacy service_role keys are JWTs and must also be sent as Bearer tokens.
  // New Supabase secret keys are not JWTs and belong only in the apikey header.
  if (adminKey.startsWith("eyJ")) headers.Authorization = `Bearer ${adminKey}`;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    console.error("Usage RPC failed:", functionName, response.status);
    throw new Error("USAGE_ACCOUNTING_UNAVAILABLE");
  }
  return response.json();
}

function publicUsageMeter(status) {
  const used = Number(status?.user_used ?? status?.used ?? 0);
  const limit = Number(status?.user_limit ?? status?.limit ?? 1);
  return {
    used_percent: limit > 0 ? Math.max(0, Math.min(100, Math.ceil((used / limit) * 100))) : 100,
    reset_at: status?.reset_at || null,
  };
}

async function getUsageStatus(env, userId) {
  return adminRpc(env, "get_my_ai_usage", { p_user_id: userId });
}

function supabaseAdminHeaders(env) {
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("ADMIN_API_NOT_CONFIGURED");
  return {
    apikey: key,
    ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
  };
}

async function getServerProfile(env, userId) {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,email,is_admin,is_suspended`,
    { headers: supabaseAdminHeaders(env) },
  );
  if (!response.ok) throw new Error("PROFILE_LOOKUP_FAILED");
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function supabaseAuthAdmin(env, userId, method, body) {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method,
    headers: { ...supabaseAdminHeaders(env), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    console.error("Supabase admin user operation failed:", method, response.status);
    throw new Error("USER_ACCOUNT_ACTION_FAILED");
  }
  return response.status === 204 ? null : response.json().catch(() => null);
}

async function handleAdminUsers(request, env, origin, actor, actorProfile) {
  const isAdmin = actorProfile?.is_admin === true || (
    !!env.ADMIN_EMAIL && String(actor.email || "").trim().toLowerCase() === String(env.ADMIN_EMAIL).trim().toLowerCase()
  );
  if (!isAdmin) return jsonResponse({ error: "ADMIN_REQUIRED" }, 403, origin);
  if (request.method !== "POST") return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405, origin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "INVALID_JSON" }, 400, origin); }
  const userId = typeof body?.userId === "string" ? body.userId : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return jsonResponse({ error: "INVALID_USER_ID" }, 400, origin);
  }
  if (userId === actor.id) return jsonResponse({ error: "CANNOT_MANAGE_SELF" }, 400, origin);

  let target;
  try { target = await getServerProfile(env, userId); }
  catch { return jsonResponse({ error: "ADMIN_API_UNAVAILABLE" }, 503, origin); }
  if (!target) return jsonResponse({ error: "USER_NOT_FOUND" }, 404, origin);
  if (target.is_admin) return jsonResponse({ error: "CANNOT_MANAGE_ADMIN" }, 403, origin);

  if (body.action === "set_status" && typeof body.suspended === "boolean") {
    try {
      await adminRpc(env, "admin_set_user_suspended", { p_user_id: userId, p_suspended: body.suspended, p_actor_user_id: actor.id });
      return jsonResponse({ ok: true, suspended: body.suspended }, 200, origin);
    } catch {
      return jsonResponse({ error: "USER_ACCOUNT_ACTION_FAILED" }, 503, origin);
    }
  }

  if (body.action === "delete_user") {
    try {
      await supabaseAuthAdmin(env, userId, "DELETE");
      return jsonResponse({ ok: true }, 200, origin);
    } catch {
      return jsonResponse({ error: "USER_ACCOUNT_ACTION_FAILED" }, 503, origin);
    }
  }
  return jsonResponse({ error: "INVALID_ADMIN_ACTION" }, 400, origin);
}

async function hasActiveSubscription(env, userId) {
  return (await adminRpc(env, "has_active_subscription", { p_user_id: userId })) === true;
}

async function settleUsage(env, reservation, userId, usage, status) {
  try {
    return await adminRpc(env, "settle_ai_usage", {
      p_request_id: reservation,
      p_user_id: userId,
      p_input_tokens: usage.inputTokens,
      p_output_tokens: usage.outputTokens,
      p_total_tokens: usage.totalTokens,
      p_status: status,
      p_is_estimate: usage.isEstimate,
    });
  } catch (error) {
    // The open reservation stays charged at its conservative ceiling if
    // Supabase is temporarily unavailable after the provider call.
    console.error("Usage settlement deferred:", String(error).slice(0, 80));
    return null;
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (!["/api/optimize", "/api/usage", "/api/admin/users"].includes(url.pathname)) {
      return jsonResponse({ error: "Not found" }, 404, origin);
    }
    if (request.method !== "POST" && !(request.method === "GET" && url.pathname === "/api/usage")) {
      return jsonResponse({ error: "Method not allowed" }, 405, origin);
    }

    // Resolve configuration separately from credentials so a deployment problem
    // is never misreported as a user sign-out.
    const authResult = await verifySupabaseUser(env, request);
    if (!authResult.user) {
      return jsonResponse(
        { error: authResult.error },
        authResult.status,
        origin
      );
    }

    let actorProfile;
    try { actorProfile = await getServerProfile(env, authResult.user.id); }
    catch { return jsonResponse({ error: "ACCOUNT_STATUS_UNAVAILABLE" }, 503, origin); }
    if (!actorProfile) return jsonResponse({ error: "ACCOUNT_NOT_FOUND" }, 403, origin);
    if (actorProfile.is_suspended) return jsonResponse({ error: "ACCOUNT_SUSPENDED" }, 403, origin);

    if (url.pathname === "/api/admin/users") {
      return handleAdminUsers(request, env, origin, authResult.user, actorProfile);
    }

    if (url.pathname === "/api/usage") {
      try {
        const usage = await getUsageStatus(env, authResult.user.id);
        return jsonResponse({ usage: publicUsageMeter(usage) }, 200, origin);
      } catch {
        return jsonResponse({ error: "USAGE_ACCOUNTING_UNAVAILABLE" }, 503, origin);
      }
    }

    // Apply a per-user limit after authentication so shared mobile IPs do not
    // throttle unrelated users. Cloudflare's local counters are an abuse guard,
    // not a billing or exact global quota system.
    if (env.OPTIMIZE_LIMITER) {
      const { success } = await env.OPTIMIZE_LIMITER.limit({ key: authResult.user.id });
      if (!success) return jsonResponse({ error: "RATE_LIMITED" }, 429, origin);
    }

    let body;
    try {
      const contentLength = Number(request.headers.get("Content-Length") || 0);
      if (contentLength > 25000) {
        return jsonResponse({ error: "REQUEST_TOO_LARGE" }, 413, origin);
      }
      body = await request.json();
    } catch {
      return jsonResponse({ error: "INVALID_JSON" }, 400, origin);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "INVALID_REQUEST" }, 400, origin);
    }

    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const archetype = typeof body.archetype === "string" ? body.archetype.slice(0, 60) : "";
    const isAdmin = actorProfile.is_admin === true || (
      !!env.ADMIN_EMAIL && String(authResult.user.email || "").trim().toLowerCase() === String(env.ADMIN_EMAIL).trim().toLowerCase()
    );
    if (!isAdmin && archetype !== "Agent System") {
      try {
        if (!(await hasActiveSubscription(env, authResult.user.id))) {
          return jsonResponse({ error: "SUBSCRIPTION_REQUIRED" }, 403, origin);
        }
      } catch {
        return jsonResponse({ error: "SUBSCRIPTION_CHECK_UNAVAILABLE" }, 503, origin);
      }
    }
    const mode = ["conservative", "balanced", "aggressive"].includes(body.mode)
      ? body.mode
      : "balanced";
    let questionnaireAnswers = null;
    if (body.questionnaireAnswers != null) {
      const answers = body.questionnaireAnswers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
        return jsonResponse({ error: "INVALID_ANSWERS" }, 400, origin);
      }
      const entries = Object.entries(answers);
      if (entries.length > 3 || entries.some(([key, value]) =>
        key.length > 50 || (value !== null && (typeof value !== "string" || value.length > 200))
      )) {
        return jsonResponse({ error: "INVALID_ANSWERS" }, 400, origin);
      }
      questionnaireAnswers = Object.fromEntries(entries);
    }

    if (!prompt) {
      return jsonResponse({ error: "PROMPT_REQUIRED" }, 400, origin);
    }
    if (prompt.length > 8000) {
      return jsonResponse({ error: "PROMPT_TOO_LONG" }, 413, origin);
    }

    const provider = (env.AI_PROVIDER || "groq").toLowerCase();
    if (provider !== "groq" && provider !== "gemini") {
      return jsonResponse({ error: "AI_PROVIDER_UNSUPPORTED" }, 503, origin);
    }
    if (provider === "groq" && !env.GROQ_API_KEY) {
      return jsonResponse({ error: "AI_PROVIDER_NOT_CONFIGURED" }, 503, origin);
    }
    if (provider === "gemini" && !env.GEMINI_API_KEY) {
      return jsonResponse({ error: "AI_PROVIDER_NOT_CONFIGURED" }, 503, origin);
    }
    // Accept the former archetype flag during cache rollouts; task archetype is separate now.
    const isPromptOptimizer = body.operationMode === "enhance" || archetype === "Prompt Optimizer";
    const systemPrompt = isPromptOptimizer ? OPTIMIZER_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const userMessage = buildUserMessage(prompt, questionnaireAnswers, archetype, mode, isPromptOptimizer);
    if (!env.SUPABASE_SECRET_KEY && !env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: "USAGE_ACCOUNTING_NOT_CONFIGURED" }, 503, origin);
    }

    const requestId = crypto.randomUUID();
    // Reserve before calling the provider. The Arabic estimate is deliberately
    // conservative, while English system instructions are estimated at one token
    // per three characters. The output cap keeps requests within small free quotas.
    const reservedTokens = estimateReservedInputTokens(userMessage) + estimateReservedInputTokens(systemPrompt) + MAX_OUTPUT_TOKENS;
    let reservation;
    try {
      reservation = await adminRpc(env, "reserve_ai_usage", {
        p_request_id: requestId,
        p_user_id: authResult.user.id,
        p_provider: provider,
        p_model: provider === "groq" ? "openai/gpt-oss-120b" : "gemini-3.8-flash",
        p_operation_mode: isPromptOptimizer ? "enhance" : "shorten",
        p_reserved_tokens: reservedTokens,
        p_bypass_user_limit: isAdmin,
      });
    } catch {
      return jsonResponse({ error: "USAGE_ACCOUNTING_UNAVAILABLE" }, 503, origin);
    }
    if (!reservation.allowed) {
      const usage = publicUsageMeter(reservation);
      const remainingUserTokens = Number(reservation.user_limit) - Number(reservation.user_used);
      const requestExceedsRemainingAllowance = reservation.reason === "user_limit" && remainingUserTokens > 0;
      return jsonResponse({
        error: reservation.reason === "global_limit"
          ? "APP_DAILY_LIMIT"
          : requestExceedsRemainingAllowance ? "REQUEST_EXCEEDS_FREE_BUDGET" : "FREE_WINDOW_LIMIT",
        usage,
      }, requestExceedsRemainingAllowance ? 413 : 429, origin);
    }

    let providerUsage = null;
    let providerOutputChars = 0;
    let responseBody = null;
    let usageStatus = "completed";
    let responseError = null;
    let statusCode = 200;
    try {
      const completion = provider === "gemini"
        ? await callGemini(env, userMessage, systemPrompt)
        : await callGroq(env, userMessage, systemPrompt);
      providerUsage = completion;
      providerOutputChars = completion.text.length;
      const parsed = extractJson(completion.text);

      if (parsed.action === "QUESTIONNAIRE") {
        const questions = parsed.questions;
        if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3 ||
            questions.some((q) => !q || typeof q !== "object" ||
              typeof q.question !== "string" || q.question.length > 300 ||
              !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 5 ||
              q.options.some((option) => typeof option !== "string" || option.length > 120))) {
          throw new Error("INVALID_MODEL_RESPONSE");
        }
        usageStatus = "questionnaire";
        responseBody = {
          action: "QUESTIONNAIRE",
          questions: questions.map((q, i) => ({
            key: typeof q.key === "string" ? q.key.slice(0, 50) : `q${i}`,
            question: q.question,
            options: q.options,
          })),
        };
      } else if (parsed.action !== "GENERATE_PROMPT" ||
          typeof parsed.optimized_prompt !== "string" ||
          !parsed.optimized_prompt.trim() || parsed.optimized_prompt.length > 12000) {
        throw new Error("INVALID_MODEL_RESPONSE");
      } else {
        const optimizedPrompt = parsed.optimized_prompt.trim();
        if (!isPromptOptimizer && optimizedPrompt.length >= prompt.length) {
          usageStatus = "no_compression";
          responseBody = {
            action: "NO_COMPRESSION_NEEDED",
            optimized_prompt: prompt,
            tokens_saved: "0%",
            execution_density_rating: "—",
          };
        } else {
          const originalEstimate = Math.ceil(prompt.length / 4);
          const optimizedEstimate = Math.ceil(optimizedPrompt.length / 4);
          const estimatedSaving = originalEstimate > 0
            ? Math.round((1 - optimizedEstimate / originalEstimate) * 100)
            : 0;
          responseBody = {
            action: "GENERATE_PROMPT",
            optimized_prompt: optimizedPrompt,
            tokens_saved: `${estimatedSaving}%`,
            execution_density_rating: ["Low", "Medium", "High", "Maximum"].includes(parsed.execution_density_rating)
              ? parsed.execution_density_rating
              : "—",
          };
        }
      }
    } catch (err) {
      usageStatus = providerUsage ? "invalid_response" : "provider_error";
      responseError = "AI_PROVIDER_ERROR";
      statusCode = 502;
      // Provider details can contain prompt text; never return them to the client.
      console.error("Optimization provider request failed:", String(err).slice(0, 80));
    }

    const inputTokens = providerUsage?.inputTokens;
    const outputTokens = providerUsage?.outputTokens;
    const totalTokens = providerUsage?.totalTokens;
    const isEstimate = inputTokens === null || inputTokens === undefined ||
      outputTokens === null || outputTokens === undefined || totalTokens === null || totalTokens === undefined;
    const settledUsage = await settleUsage(env, requestId, authResult.user.id, providerUsage
      ? {
          inputTokens: inputTokens ?? Math.ceil((userMessage.length + systemPrompt.length) / 3),
          outputTokens: outputTokens ?? Math.ceil(providerOutputChars / 3),
          totalTokens: totalTokens ?? ((inputTokens ?? Math.ceil((userMessage.length + systemPrompt.length) / 3)) +
            (outputTokens ?? Math.ceil(providerOutputChars / 3))),
          isEstimate,
        }
      : { inputTokens: 0, outputTokens: 0, totalTokens: reservedTokens, isEstimate: true },
      responseError ? "provider_error" : usageStatus);
    let usage = publicUsageMeter(settledUsage || reservation);
    if (!settledUsage) {
      try { usage = publicUsageMeter(await getUsageStatus(env, authResult.user.id)); } catch {}
    }
    if (responseError) return jsonResponse({ error: responseError, usage }, statusCode, origin);
    return jsonResponse({ ...responseBody, usage }, 200, origin);
  },
};
