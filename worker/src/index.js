import knowledgeBase from "./knowledge_base.json";

// Common stop words to filter out during keyword scoring
const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being",
  "below", "between", "both", "but", "by", "can", "can't", "cannot", "could",
  "did", "do", "does", "doing", "don't", "down", "during", "each", "few", "for",
  "from", "further", "had", "has", "have", "having", "he", "her", "here", "hers",
  "herself", "him", "himself", "his", "how", "i", "if", "in", "into", "is",
  "isn't", "it", "it's", "its", "itself", "just", "me", "more", "most", "my",
  "myself", "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or",
  "other", "our", "ours", "ourselves", "out", "over", "own", "same", "she", "should",
  "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "themselves",
  "then", "there", "these", "they", "this", "those", "through", "to", "too", "under",
  "until", "up", "very", "was", "we", "were", "what", "when", "where", "which",
  "while", "who", "whom", "why", "with", "would", "you", "your", "yours"
]);

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

// Fast BM25-style keyword search over the precomputed knowledge base
function searchChunks(query, topK = 4) {
  const queryTokens = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));

  if (queryTokens.length === 0) {
    return knowledgeBase.slice(0, topK);
  }

  const scored = knowledgeBase.map(chunk => {
    const textLower = chunk.text.toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
      // Term frequency in chunk
      const regex = new RegExp("\\b" + token + "\\b", "gi");
      const matches = textLower.match(regex);
      if (matches) {
        score += matches.length * 2.0;
      } else if (textLower.includes(token)) {
        score += 1.0;
      }
    }
    return { chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score > 0).slice(0, topK).map(s => s.chunk);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 2. Accept only POST /chat
    if (request.method !== "POST" || url.pathname !== "/chat") {
      return new Response(
        JSON.stringify({ error: "Not Found. Only POST /chat is supported." }),
        { status: 404, headers: corsHeaders }
      );
    }

    try {
      // 3. Parse JSON Body
      const body = await request.json();
      const question = body.question?.trim();

      if (!question) {
        return new Response(
          JSON.stringify({ error: "Empty question provided." }),
          { status: 400, headers: corsHeaders }
        );
      }

      // 4. Retrieve Relevant Chunks
      const retrieved = searchChunks(question, 4);
      if (retrieved.length === 0) {
        return new Response(
          JSON.stringify({
            answer: "The provided documents do not contain enough information to answer this question.",
            sources: []
          }),
          { status: 200, headers: corsHeaders }
        );
      }

      // 5. Build Context & Sources
      const sources = [];
      const contextParts = retrieved.map((c, idx) => {
        if (!sources.includes(c.source)) {
          sources.push(c.source);
        }
        return `[${idx + 1}] (Source: ${c.source})\n${c.text}`;
      });
      const contextStr = contextParts.join("\n\n");

      // 6. System Prompt
      const systemPrompt = `You are an expert research assistant specialized in Nuclear Law.
Answer the user's question using ONLY the provided context chunks from the Handbook on Nuclear Law.
Rules:
1. Base your answer solely on the given context. Do not make assumptions.
2. Cite the sources of your claims using bracket numbers, e.g. [1], [2].
3. If the context does not contain enough information, state: "The provided documents do not contain this information."
4. Be clear, accurate, and concise.`;

      const userPrompt = `Context:\n${contextStr}\n\nQuestion: ${question}\n\nAnswer:`;

      // 7. Call LLM (Supports GROQ, OPENROUTER, or COHERE secrets)
      let answer = "";
      const groqKey = env.GROQ_API_KEY;
      const openRouterKey = env.OPENROUTER_API_KEY;
      const cohereKey = env.COHERE_API_KEY;

      if (groqKey) {
        // Groq API (High-speed Llama-3.3 70B)
        const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${groqKey}`
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            temperature: 0.2,
            max_tokens: 800
          })
        });

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Groq LLM call failed [${resp.status}]: ${errText}`);
        }
        const data = await resp.json();
        answer = data.choices?.[0]?.message?.content || "No response received.";

      } else if (openRouterKey) {
        // OpenRouter API
        const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${openRouterKey}`,
            "HTTP-Referer": "https://rag-app.pages.dev",
            "X-Title": "Nuclear Law RAG App"
          },
          body: JSON.stringify({
            model: "meta-llama/llama-3.1-8b-instruct:free",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            temperature: 0.2,
            max_tokens: 800
          })
        });

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`OpenRouter LLM call failed [${resp.status}]: ${errText}`);
        }
        const data = await resp.json();
        answer = data.choices?.[0]?.message?.content || "No response received.";

      } else if (cohereKey) {
        // Cohere Chat API v2
        const resp = await fetch("https://api.cohere.com/v2/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${cohereKey}`
          },
          body: JSON.stringify({
            model: "command-r",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ]
          })
        });

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Cohere LLM call failed [${resp.status}]: ${errText}`);
        }
        const data = await resp.json();
        answer = data.message?.content?.[0]?.text || "No response received.";

      } else {
        return new Response(
          JSON.stringify({
            error: "Backend API key is not configured. Please set GROQ_API_KEY, OPENROUTER_API_KEY, or COHERE_API_KEY as a secret in Cloudflare Workers."
          }),
          { status: 500, headers: corsHeaders }
        );
      }

      // 8. Return formatted response
      return new Response(
        JSON.stringify({
          answer: answer.trim(),
          sources: sources
        }),
        { status: 200, headers: corsHeaders }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message || "An unexpected error occurred in the RAG Worker." }),
        { status: 500, headers: corsHeaders }
      );
    }
  }
};
