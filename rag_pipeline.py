import os
import json
import requests
from pathlib import Path
from rank_bm25 import BM25Okapi

# Path to precomputed knowledge base
KB_PATH = Path(__file__).parent / "knowledge_base.json"

# Load knowledge base chunks
if KB_PATH.exists():
    with open(KB_PATH, "r", encoding="utf-8") as f:
        CHUNKS = json.load(f)
else:
    CHUNKS = []

# Initialize BM25 search
if CHUNKS:
    tokenized_corpus = [c["text"].lower().split() for c in CHUNKS]
    bm25 = BM25Okapi(tokenized_corpus)
else:
    bm25 = None

# LLM Configuration (Default: Groq or Ollama)
# If GROQ_API_KEY is set, it uses Groq; otherwise falls back to local Ollama
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1")

SYSTEM_PROMPT = """You are an expert research assistant specialized in Nuclear Law. 
Answer the user's question using ONLY the provided context chunks from the Handbook on Nuclear Law.
Rules:
1. Base your answer solely on the provided context.
2. Cite the source using bracket notation, e.g. [1], [2].
3. If the context does not contain enough information, state clearly: "The provided documents do not contain enough information to answer this question."
4. Be concise and precise.
"""

def call_llm(messages, temperature=0.2, max_tokens=800):
    """Unified LLM caller for Groq, OpenRouter, Cohere, or local Ollama."""
    groq_key = os.environ.get("GROQ_API_KEY")
    cohere_key = os.environ.get("COHERE_API_KEY")
    openrouter_key = os.environ.get("OPENROUTER_API_KEY")

    if groq_key:
        url = "https://api.groq.com/openai/v1/chat/completions"
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {groq_key}"}
        model = "openai/gpt-oss-20b"
    elif openrouter_key:
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {openrouter_key}"}
        model = "meta-llama/llama-3.1-8b-instruct:free"
    else:
        url = f"{OLLAMA_BASE_URL.rstrip('/')}/chat/completions"
        headers = {"Content-Type": "application/json", "Authorization": "Bearer ollama"}
        model = os.environ.get("OLLAMA_MODEL", "llama3.2")

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        return f"Error calling LLM ({url}): {e}"

def retrieve_top_k(query: str, top_k: int = 4):
    """Retrieve top-K most relevant chunks using BM25 keyword search."""
    if not bm25 or not CHUNKS:
        return []
    scores = bm25.get_scores(query.lower().split())
    ranked_indices = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
    return [CHUNKS[i] for i in ranked_indices if scores[i] > 0]

def query_rag(question: str) -> dict:
    """
    Main entry point required by the deployment specification.
    Input: question (str)
    Output: {"answer": str, "sources": list}
    """
    chunks = retrieve_top_k(question, top_k=4)
    if not chunks:
        return {
            "answer": "No relevant documents found to answer your question.",
            "sources": []
        }

    context_parts = []
    sources = []
    for idx, c in enumerate(chunks, 1):
        context_parts.append(f"[{idx}] Source: {c['source']}\n{c['text']}")
        if c["source"] not in sources:
            sources.append(c["source"])

    context_str = "\n\n".join(context_parts)
    user_prompt = f"Context:\n{context_str}\n\nQuestion: {question}\n\nAnswer following the system rules:"

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt}
    ]

    answer = call_llm(messages)
    return {
        "answer": answer,
        "sources": sources
    }

if __name__ == "__main__":
    # Quick CLI test
    test_q = "What are the main objectives of nuclear law?"
    print(f"Testing RAG Pipeline with question: '{test_q}'\n")
    res = query_rag(test_q)
    print("ANSWER:\n", res["answer"])
    print("\nSOURCES:\n", res["sources"])
