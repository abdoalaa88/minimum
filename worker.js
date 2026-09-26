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

const SYSTEM_PROMPT = `You are the internal core of 'minimum'. Transform user prompts into hyper-condensed, instruction-dense, zero-fluff prompts optimized for AI agents. Eliminate all polite fluff, conversational filler, and redundant adjectives. Use dense structural Markdown (Role, Task, Format, Negative Constraints).

If the input is too ambiguous or short to optimize confidently, respond with a request for 1-3 multiple-choice clarification questions instead of an optimized prompt.

ALWAYS reply with strict JSON only, no markdown fences, no commentary, matching exactly one of these two shapes:

Shape A (needs clarification):
{"action":"QUESTIONNAIRE","questions":[{"key":"target_agent","question":"Which agent will run this?","options":["Chat assistant","Coding agent","Autonomous workflow agent"]}]}

Shape B (ready to optimize):
{"action":"GENERATE_PROMPT","optimized_prompt":"...","tokens_saved":"62%","execution_density_rating":"High"}

Rules:
- Never include both action types.
- tokens_saved is your honest best estimate as a percentage string.
- execution_density_rating is one of: Low, Medium, High, Maximum.
- optimized_prompt must use dense markdown headers: ## Role, ## Task, ## Format, ## Constraints — only include sections that add real information.
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

function buildUserMessage(prompt, questionnaireAnswers, archetype, mode) {
  const context = [
    archetype ? `Target agent archetype: ${archetype}.` : "",
    MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.balanced,
  ].filter(Boolean).join(" ");

  if (questionnaireAnswers && Object.keys(questionnaireAnswers).length > 0) {
    return `${context}\n\nOriginal prompt: """${prompt}"""\n\nClarification answers: ${JSON.stringify(questionnaireAnswers)}\n\nGenerate the final optimized prompt now (Shape B only).`;
  }
  return `${context}\n\nOptimize this prompt: """${prompt}"""`;
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

async function callGroq(env, userMessage) {
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
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    }),
  });
  if (!res.ok) throw new Error(`GROQ_HTTP_${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callGemini(env, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
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
    const userMessage = buildUserMessage(prompt, questionnaireAnswers, archetype, mode);

    try {
      const rawText = provider === "gemini"
        ? await callGemini(env, userMessage)
        : await callGroq(env, userMessage);

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

      return jsonResponse({
        action: "GENERATE_PROMPT",
        optimized_prompt: parsed.optimized_prompt,
        tokens_saved: typeof parsed.tokens_saved === "string" ? parsed.tokens_saved.slice(0, 40) : "—",
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
