// In-memory workspace storage for Cloudflare Worker instance
const memoryWorkspaces = new Map();

// Base Handbook dynamically fetched from GitHub and cached
let cachedBaseHandbook = null;
async function getBaseHandbook() {
  if (cachedBaseHandbook && cachedBaseHandbook.length > 0) {
    return cachedBaseHandbook;
  }
  try {
    const res = await fetch("https://raw.githubusercontent.com/maibeltagy/nuclear/main/knowledge_base.json");
    if (res.ok) {
      cachedBaseHandbook = await res.json();
      return cachedBaseHandbook;
    }
  } catch (err) {
    console.warn("Could not load remote handbook:", err);
  }
  return [];
}

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

// Core Nuclear keywords for domain verification (English + Arabic)
const NUCLEAR_KEYWORDS = [
  // English terms
  "nuclear", "atomic", "radiation", "radioactive", "fission", "fusion", "reactor",
  "uranium", "plutonium", "thorium", "regulatory body", "safeguards", "iaea", "euratom",
  "licensing", "non-proliferation", "radioactive waste", "waste", "spent fuel",
  "dosimetry", "radiological", "neutron", "radiological protection", "nuclear law",
  "nuclear safety", "nuclear security", "radioisotope", "criticality",
  // Arabic terms
  "نووي", "نووية", "إشعاع", "إشعاعي", "إشعاعية", "مشع", "مشعة", "مفاعل", "مفاعلات",
  "يورانيوم", "بلوتونيوم", "طاقة ذرية", "ذرية", "ذري", "الرقابة النووية", "أمان نووي",
  "أمن نووي", "وقاية إشعاعية", "الوقاية من الإشعاع", "نفايات مشعة", "وقود نووي",
  "الوقود المستهلك", "حظر الانتشار", "الضمانات", "وكالة الطاقة الذرية", "انشطار",
  "اندماج", "ترخيص نووي", "قانون نووي", "حوادث نووية", "جرعة إشعاعية", "هيئة الرقابة"
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
    const textLower = (chunk.text || "").toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
      const regex = new RegExp(token, "gi");
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

    // Health check & welcome route
    if (path === "/" || path === "/api/health") {
      return new Response(
        JSON.stringify({
          status: "online",
          service: "Nuclear Law RAG Worker API",
          version: "1.0",
          endpoints: ["/api/workspaces/:id/documents", "/api/workspaces/:id/upload", "/chat", "/api/debug"]
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    // Diagnostic route to check Groq connection and available models
    if (path === "/api/debug") {
      let groqStatus = "no_key";
      let modelsList = [];
      if (env.GROQ_API_KEY) {
        try {
          const mResp = await fetch("https://api.groq.com/openai/v1/models", {
            headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}` }
          });
          groqStatus = `http_${mResp.status}`;
          const mData = await mResp.json();
          modelsList = mData.data ? mData.data.map(m => m.id) : mData;
        } catch (e) {
          groqStatus = `err_${e.message}`;
        }
      }
      return new Response(
        JSON.stringify({
          groq_key_set: !!env.GROQ_API_KEY,
          groq_status: groqStatus,
          models: modelsList
        }),
        { status: 200, headers: corsHeaders }
      );
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
        let reportedPages = 1;

        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("multipart/form-data")) {
          const formData = await request.formData();
          const file = formData.get("file");
          const clientText = formData.get("extracted_text");
          const clientPages = formData.get("pages_count");

          if (!file && !clientText) {
            return new Response(JSON.stringify({ error: "No file or text uploaded." }), { status: 400, headers: corsHeaders });
          }

          filename = (file && file.name) ? file.name : "document.pdf";
          if (clientPages) {
            reportedPages = Math.max(1, parseInt(clientPages, 10) || 1);
          }

          if (clientText && clientText.trim().length > 30) {
            textSample = clientText.trim();
          } else if (file) {
            const buffer = await file.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let str = "";
            for (let i = 0; i < Math.min(bytes.length, 100000); i++) {
              if (bytes[i] >= 32 && bytes[i] <= 126) {
                str += String.fromCharCode(bytes[i]);
              } else if (bytes[i] === 10 || bytes[i] === 13) {
                str += " ";
              }
            }
            textSample = str.replace(/\s+/g, " ");
          }
        } else {
          const jsonBody = await request.json().catch(() => ({}));
          filename = jsonBody.filename || "document.pdf";
          textSample = jsonBody.text || "";
          reportedPages = jsonBody.pages || 1;
        }

        // Domain Detection: Check text AND filename against Nuclear keywords
        const scanTarget = (filename + " " + textSample).toLowerCase();
        let matchCount = 0;
        const matched = [];
        for (const kw of NUCLEAR_KEYWORDS) {
          if (scanTarget.includes(kw.toLowerCase())) {
            matchCount++;
            matched.push(kw);
          }
        }

        let isNuclear = matchCount >= 1; // 1 or more distinct nuclear terms
        let detectedTopic = isNuclear 
          ? `Nuclear regulation (${matched.slice(0, 3).join(", ")})` 
          : "Non-nuclear topic";
        let reason = isNuclear
          ? `Verified nuclear keywords found (${matched.slice(0, 4).join(", ")})`
          : "Document contains insufficient nuclear or radiation safety terminology.";

        // If not verified yet by keywords, but text is available and Groq key exists, ask Groq LLM
        if (!isNuclear && env.GROQ_API_KEY && textSample.length > 40) {
          try {
            const promptText = `Analyze if this document belongs to Nuclear Law, Nuclear Energy/Technology, Nuclear Safety, or Radiation Protection regulation.\nDocument excerpt:\n"""${textSample.slice(0, 2500)}"""\n\nRespond ONLY with a JSON object: {"is_nuclear": true or false, "topic": "concise topic", "reason": "concise reason"}`;
            const gResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${env.GROQ_API_KEY}`
              },
              body: JSON.stringify({
                model: "openai/gpt-oss-20b",
                messages: [{ role: "user", content: promptText }],
                temperature: 0.1,
                response_format: { type: "json_object" }
              })
            });
            if (gResp.ok) {
              const gData = await gResp.json();
              const parsed = JSON.parse(gData.choices?.[0]?.message?.content || "{}");
              if (parsed.is_nuclear === true) {
                isNuclear = true;
                detectedTopic = parsed.topic || "Nuclear regulation";
                reason = parsed.reason || "Semantic AI verification confirmed nuclear domain.";
              }
            }
          } catch (llmErr) {
            console.warn("Groq domain check error:", llmErr);
          }
        }

        if (!isNuclear) {
          return new Response(
            JSON.stringify({
              status: "rejected",
              error: `Document rejected: Not in Nuclear Law domain. ${reason}`,
              domain_verification: {
                is_nuclear: false,
                confidence: 0.95,
                detected_topic: detectedTopic,
                reason: reason
              }
            }),
            { status: 400, headers: corsHeaders }
          );
        }

        // Verified! Chunk the text and store in workspace
        const wsData = memoryWorkspaces.get(wsId) || { documents: [], chunks: [] };
        const newChunks = [];

        // If we have actual extracted text, chunk it properly
        if (textSample && textSample.length > 50) {
          const sentences = textSample.split(/(?<=[.!?؟\n])\s+/);
          let currentChunk = "";
          for (const sent of sentences) {
            if ((currentChunk + " " + sent).length <= 700) {
              currentChunk = (currentChunk + " " + sent).trim();
            } else {
              if (currentChunk.length > 40) {
                newChunks.push({
                  text: currentChunk,
                  source: `${filename} (section ${newChunks.length + 1})`,
                  chunk_id: `${filename}::${newChunks.length}`
                });
              }
              currentChunk = sent.trim();
            }
          }
          if (currentChunk.length > 40) {
            newChunks.push({
              text: currentChunk,
              source: `${filename} (section ${newChunks.length + 1})`,
              chunk_id: `${filename}::${newChunks.length}`
            });
          }
        }

        if (newChunks.length === 0) {
          newChunks.push({
            text: textSample.slice(0, 1000) || `Document: ${filename}`,
            source: filename,
            chunk_id: `${filename}::0`
          });
        }

        wsData.documents = wsData.documents.filter(d => d.filename !== filename);
        wsData.documents.push({
          filename: filename,
          pages_count: reportedPages || Math.max(1, Math.ceil(newChunks.length / 2)),
          chunks_count: newChunks.length,
          uploaded_at: new Date().toISOString(),
          domain_verification: {
            is_nuclear: true,
            confidence: 0.95,
            detected_topic: detectedTopic,
            reason: reason
          }
        });

        wsData.chunks = wsData.chunks.filter(c => !c.source.startsWith(filename));
        wsData.chunks.push(...newChunks);
        memoryWorkspaces.set(wsId, wsData);

        return new Response(
          JSON.stringify({
            status: "approved",
            message: `Document '${filename}' verified and indexed in workspace '${wsId}'.`,
            pages: reportedPages || Math.max(1, Math.ceil(newChunks.length / 2)),
            chunks: newChunks.length,
            domain_verification: {
              is_nuclear: true,
              confidence: 0.95,
              detected_topic: detectedTopic
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

        // Combine user workspace chunks with baseline handbook fetched from GitHub
        const wsData = memoryWorkspaces.get(wsId) || { documents: [], chunks: [] };
        let allChunks = [...wsData.chunks];
        if (includeBase) {
          const baseHandbook = await getBaseHandbook();
          allChunks.push(...baseHandbook);
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

        const userPrompt = `Context:\n${contextStr}\n\nQuestion: ${question}\n\nAnswer:`;

        let answer = "";
        const groqKey = env.GROQ_API_KEY ? env.GROQ_API_KEY.trim() : "";
        const openRouterKey = env.OPENROUTER_API_KEY ? env.OPENROUTER_API_KEY.trim() : "";

        if (groqKey) {
          const candidateModels = [
            "openai/gpt-oss-20b",
            "openai/gpt-oss-120b",
            "qwen/qwen3.8-27b",
            "allam-2-7b"
          ];
          let lastErr = "";
          for (const modelName of candidateModels) {
            try {
              const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${groqKey}`
                },
                body: JSON.stringify({
                  model: modelName,
                  messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                  ],
                  temperature: 0.2,
                  max_tokens: 800
                })
              });

              if (resp.ok) {
                const data = await resp.json();
                const content = data.choices?.[0]?.message?.content;
                if (content) {
                  answer = content;
                  break;
                }
              } else {
                lastErr = await resp.text();
              }
            } catch (callErr) {
              lastErr = callErr.message;
            }
          }

          if (!answer) {
            answer = `### 📋 Relevant Information (Direct Match):\n\n` +
              retrieved.map((r, i) => `**[${i + 1}] ${r.source}**:\n${r.text}`).join("\n\n") +
              (lastErr ? `\n\n*(LLM Notice: ${lastErr})*` : "");
          }
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
          answer = `### 📋 Retrieved Context Chunks:\n\n` +
            retrieved.map((r, i) => `**[${i + 1}] ${r.source}**:\n${r.text}`).join("\n\n");
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
