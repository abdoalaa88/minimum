/**
 * minimum — Cloudflare Worker API
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
 *
 * Set AI_PROVIDER in wrangler.toml [vars] to "groq" or "gemini".
 */

const SYSTEM_PROMPT = `You are the internal core of 'minimum'. Transform user prompts into hyper-condensed, instruction-dense, zero-fluff prompts optimized for AI agents. Preserve the input's language, dialect, script, and voice. Remove filler and redundancy while keeping the user's intent and constraints. A compressed prompt must be shorter than the source; do not add structure or details that make it longer.

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

const OPTIMIZER_SYSTEM_PROMPT = `You are the prompt-optimization core of 'minimum'. Upgrade rough user requests into professional, execution-ready prompts for AI agents. This mode is prompt optimization, not shortening: translate the user's request into clear professional English, preserve all intent and requirements, and organize the result using concise Markdown sections. The output may be longer when structure makes the request clearer or preserves important detail.

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

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
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
  return data.choices[0].message.content;
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
      generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`GEMINI_HTTP_${res.status}`);
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin);
    }

    const url = new URL(request.url);
    if (url.pathname !== "/api/optimize") {
      return jsonResponse({ error: "Not found" }, 404, origin);
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

    try {
      const rawText = provider === "gemini"
        ? await callGemini(env, userMessage, systemPrompt)
        : await callGroq(env, userMessage, systemPrompt);

      const parsed = extractJson(rawText);

      if (parsed.action === "QUESTIONNAIRE") {
        const questions = parsed.questions;
        if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3 ||
            questions.some((q) => !q || typeof q !== "object" ||
              typeof q.question !== "string" || q.question.length > 300 ||
              !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 5 ||
              q.options.some((option) => typeof option !== "string" || option.length > 120))) {
          throw new Error("INVALID_MODEL_RESPONSE");
        }
        return jsonResponse({
          action: "QUESTIONNAIRE",
          questions: questions.map((q, i) => ({
            key: typeof q.key === "string" ? q.key.slice(0, 50) : `q${i}`,
            question: q.question,
            options: q.options,
          })),
        }, 200, origin);
      }

      if (parsed.action !== "GENERATE_PROMPT" ||
          typeof parsed.optimized_prompt !== "string" ||
          !parsed.optimized_prompt.trim() || parsed.optimized_prompt.length > 12000) {
        throw new Error("INVALID_MODEL_RESPONSE");
      }

      const optimizedPrompt = parsed.optimized_prompt.trim();
      // Never present an expanded answer as a compression. Keep the source safe
      // when the model cannot shorten it without adding wording or losing meaning.
      if (!isPromptOptimizer && optimizedPrompt.length >= prompt.length) {
        return jsonResponse({
          action: "NO_COMPRESSION_NEEDED",
          optimized_prompt: prompt,
          tokens_saved: "0%",
          execution_density_rating: "—",
        }, 200, origin);
      }

      const originalEstimate = Math.ceil(prompt.length / 4);
      const optimizedEstimate = Math.ceil(optimizedPrompt.length / 4);
      const estimatedSaving = originalEstimate > 0
        ? Math.round((1 - optimizedEstimate / originalEstimate) * 100)
        : 0;

      return jsonResponse({
        action: "GENERATE_PROMPT",
        optimized_prompt: optimizedPrompt,
        tokens_saved: `${estimatedSaving}%`,
        execution_density_rating: ["Low", "Medium", "High", "Maximum"].includes(parsed.execution_density_rating)
          ? parsed.execution_density_rating
          : "—",
      }, 200, origin);
    } catch (err) {
      // Keep provider details out of API responses; provider payloads can contain
      // user content and should never be reflected to the browser.
      console.error("Optimization provider request failed:", String(err).slice(0, 80));
      return jsonResponse({ error: "AI_PROVIDER_ERROR" }, 502, origin);
    }
  },
};
