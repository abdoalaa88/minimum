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
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
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
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;

  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_ANON_KEY,
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch {
    return null;
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
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callGemini(env, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
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

    // Require a signed-in Supabase user — ties every AI call to an account
    // and keeps the API from being hit anonymously.
    const user = await verifySupabaseUser(env, request);
    if (!user) {
      return jsonResponse({ error: "Sign in required" }, 401, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
    }

    const prompt = (body.prompt || "").toString().trim();
    const questionnaireAnswers = body.questionnaireAnswers || null;
    const archetype = (body.archetype || "").toString().slice(0, 60);
    const mode = (body.mode || "balanced").toString().slice(0, 20);

    if (!prompt) {
      return jsonResponse({ error: "`prompt` is required" }, 400, origin);
    }
    if (prompt.length > 8000) {
      return jsonResponse({ error: "Prompt too long (max 8000 chars)" }, 413, origin);
    }

    const userMessage = buildUserMessage(prompt, questionnaireAnswers, archetype, mode);
    const provider = (env.AI_PROVIDER || "groq").toLowerCase();

    try {
      const rawText = provider === "gemini"
        ? await callGemini(env, userMessage)
        : await callGroq(env, userMessage);

      const parsed = extractJson(rawText);

      if (parsed.action === "QUESTIONNAIRE") {
        return jsonResponse(
          { action: "QUESTIONNAIRE", questions: parsed.questions || [] },
          200,
          origin
        );
      }

      return jsonResponse(
        {
          action: "GENERATE_PROMPT",
          optimized_prompt: parsed.optimized_prompt || "",
          tokens_saved: parsed.tokens_saved || "—",
          execution_density_rating: parsed.execution_density_rating || "—",
        },
        200,
        origin
      );
    } catch (err) {
      return jsonResponse({ error: "Optimization failed", detail: String(err) }, 502, origin);
    }
  },
};
