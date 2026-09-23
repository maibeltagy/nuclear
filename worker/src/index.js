import knowledgeBase from "./knowledge_base.json";

// In-memory workspace storage for Cloudflare Worker instance
const memoryWorkspaces = new Map();

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

// Core Nuclear keywords for domain verification
const NUCLEAR_KEYWORDS = [
  "nuclear", "atomic", "radiation", "radioactive", "fission", "reactor",
  "uranium", "plutonium", "regulatory body", "safeguards", "iaea",
  "licensing", "non-proliferation", "waste", "spent fuel", "dosimetry"
];

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

function searchChunks(query, chunksList, topK = 4) {
  const queryTokens = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));

  if (queryTokens.length === 0) {
    return chunksList.slice(0, topK);
  }

  const scored = chunksList.map(chunk => {
    const textLower = chunk.text.toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
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
    const path = url.pathname;

    // 1. Handle CORS Preflight for any route
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // 2. Route: GET /api/workspaces/:id/documents
      const docMatch = path.match(/^\/api\/workspaces\/([^\/]+)\/documents$/);
      if (request.method === "GET" && docMatch) {
        const wsId = docMatch[1];
        const wsData = memoryWorkspaces.get(wsId) || { documents: [], chunks: [] };
        return new Response(
          JSON.stringify({
            workspace_id: wsId,
            documents: wsData.documents,
            total_user_chunks: wsData.chunks.length
          }),
          { status: 200, headers: corsHeaders }
        );
      }

      // 3. Route: POST /api/workspaces/:id/upload
      const uploadMatch = path.match(/^\/api\/workspaces\/([^\/]+)\/upload$/);
      if (request.method === "POST" && uploadMatch) {
        const wsId = uploadMatch[1];
        let filename = "uploaded_document.pdf";
        let textSample = "";

        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("multipart/form-data")) {
          const formData = await request.formData();
          const file = formData.get("file");
          if (!file) {
            return new Response(JSON.stringify({ error: "No file uploaded." }), { status: 400, headers: corsHeaders });
          }
          filename = file.name || "document.pdf";
          
          // Read binary text stream from file (rough ASCII/text extraction in Worker V8)
          const buffer = await file.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          // Extract readable text chunks from raw PDF bytes
          let str = "";
          for (let i = 0; i < Math.min(bytes.length, 50000); i++) {
            if (bytes[i] >= 32 && bytes[i] <= 126) {
              str += String.fromCharCode(bytes[i]);
            } else if (bytes[i] === 10 || bytes[i] === 13) {
              str += " ";
            }
          }
          textSample = str.replace(/\s+/g, " ");
        } else {
          const jsonBody = await request.json().catch(() => ({}));
          filename = jsonBody.filename || "document.pdf";
          textSample = jsonBody.text || "";
        }

        // Domain Detection Heuristic
        const sampleLower = textSample.toLowerCase();
        let matchCount = 0;
        const matched = [];
        for (const kw of NUCLEAR_KEYWORDS) {
          if (sampleLower.includes(kw)) {
            matchCount++;
            matched.push(kw);
          }
        }

        const isNuclear = matchCount >= 2;
        if (!isNuclear) {
          return new Response(
            JSON.stringify({
              status: "rejected",
              error: "Document rejected: Not in Nuclear Law domain. (Insufficient nuclear regulatory terminology detected).",
              domain_verification: {
                is_nuclear: false,
                confidence: 0.95,
                detected_topic: "Non-nuclear topic",
                reason: "Document contains insufficient nuclear or radiation safety terminology."
              }
            }),
            { status: 400, headers: corsHeaders }
          );
        }

        // Verified! Store document in workspace
        const wsData = memoryWorkspaces.get(wsId) || { documents: [], chunks: [] };
        
        // Split sample into simple chunks
        const newChunks = [];
        const words = textSample.split(" ");
        for (let i = 0; i < words.length; i += 120) {
          const chunkText = words.slice(i, i + 140).join(" ");
          if (chunkText.length > 50) {
            newChunks.push({
              text: chunkText,
              source: `${filename} (page ${Math.floor(i / 120) + 1})`,
              chunk_id: `${filename}::${newChunks.length}`
            });
          }
        }

        wsData.documents = wsData.documents.filter(d => d.filename !== filename);
        wsData.documents.push({
          filename: filename,
          pages_count: Math.max(1, Math.floor(newChunks.length / 2)),
          chunks_count: newChunks.length,
          uploaded_at: new Date().toISOString(),
          domain_verification: {
            is_nuclear: true,
            confidence: 0.92,
            detected_topic: `Nuclear regulation (${matched.slice(0, 3).join(", ")})`,
            reason: `Found verified nuclear terms (${matched.slice(0, 4).join(", ")})`
          }
        });

        wsData.chunks = wsData.chunks.filter(c => !c.source.startsWith(filename));
        wsData.chunks.push(...newChunks);
        memoryWorkspaces.set(wsId, wsData);

        return new Response(
          JSON.stringify({
            status: "approved",
            message: `Document '${filename}' verified and indexed.`,
            pages: Math.max(1, Math.floor(newChunks.length / 2)),
            chunks: newChunks.length,
            domain_verification: {
              is_nuclear: true,
              confidence: 0.92,
              detected_topic: `Nuclear regulation (${matched.slice(0, 3).join(", ")})`
            }
          }),
          { status: 200, headers: corsHeaders }
        );
      }

      // 4. Route: DELETE /api/workspaces/:id/documents/:filename
      const deleteMatch = path.match(/^\/api\/workspaces\/([^\/]+)\/documents\/([^\/]+)$/);
      if (request.method === "DELETE" && deleteMatch) {
        const wsId = deleteMatch[1];
        const filename = decodeURIComponent(deleteMatch[2]);
        const wsData = memoryWorkspaces.get(wsId);
        if (wsData) {
          wsData.documents = wsData.documents.filter(d => d.filename !== filename);
          wsData.chunks = wsData.chunks.filter(c => !c.source.startsWith(filename));
        }
        return new Response(JSON.stringify({ status: "deleted", filename }), { status: 200, headers: corsHeaders });
      }

      // 5. Route: POST /chat or POST /api/chat
      if (request.method === "POST" && (path === "/chat" || path === "/api/chat")) {
        const body = await request.json();
        const question = body.question?.trim();
        const wsId = body.workspace_id || "default";
        const includeBase = body.include_base_handbook !== false;

        if (!question) {
          return new Response(JSON.stringify({ error: "Empty question provided." }), { status: 400, headers: corsHeaders });
        }

        // Combine user workspace chunks with baseline handbook
        const wsData = memoryWorkspaces.get(wsId) || { documents: [], chunks: [] };
        let allChunks = [...wsData.chunks];
        if (includeBase) {
          allChunks.push(...knowledgeBase);
        }

        const retrieved = searchChunks(question, allChunks, 4);
        if (retrieved.length === 0) {
          return new Response(
            JSON.stringify({
              answer: "The provided documents do not contain enough information to answer this question.",
              sources: [],
              workspace_id: wsId
            }),
            { status: 200, headers: corsHeaders }
          );
        }

        const sources = [];
        const contextParts = retrieved.map((c, idx) => {
          if (!sources.includes(c.source)) sources.push(c.source);
          return `[${idx + 1}] (Source: ${c.source})\n${c.text}`;
        });
        const contextStr = contextParts.join("\n\n");

        const systemPrompt = `You are an expert research assistant specialized in Nuclear Law.
Answer the user's question using ONLY the provided context chunks from the Nuclear Law repository.
Rules:
1. Base your answer solely on the given context.
2. Cite the sources using bracket numbers, e.g. [1], [2].
3. If the context does not contain enough information, state: "The provided documents do not contain this information."
4. Be concise and precise.`;

        const userPrompt = `Context:\n${contextStr}\n\nQuestion: {question}\n\nAnswer:`;

        let answer = "";
        const groqKey = env.GROQ_API_KEY;
        const openRouterKey = env.OPENROUTER_API_KEY;
        const cohereKey = env.COHERE_API_KEY;

        if (groqKey) {
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
          answer = data.choices?.[0]?.message?.content || "No response.";
        } else if (openRouterKey) {
          const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${openRouterKey}`
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
          const data = await resp.json();
          answer = data.choices?.[0]?.message?.content || "No response.";
        } else {
          answer = `(Note: GROQ_API_KEY is not set in Cloudflare Secrets. Retrieved ${retrieved.length} chunks from ${sources.join(', ')}).`;
        }

        return new Response(
          JSON.stringify({
            answer: answer.trim(),
            sources: sources,
            workspace_id: wsId
          }),
          { status: 200, headers: corsHeaders }
        );
      }

      // Default 404 for unmatched routes with JSON
      return new Response(
        JSON.stringify({ error: `Not Found: ${request.method} ${path}` }),
        { status: 404, headers: corsHeaders }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message || "An unexpected error occurred in the Worker." }),
        { status: 500, headers: corsHeaders }
      );
    }
  }
};
