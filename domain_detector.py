import os
import re
import json
import requests

# Core domain keyword categories for heuristic scoring (English & Arabic)
NUCLEAR_KEYWORDS = {
    "core_terms": [
        "nuclear", "atomic", "radiation", "radioactive", "fission", "fusion",
        "isotope", "enrichment", "reactor", "uranium", "plutonium", "thorium",
        "criticality", "fuel cycle", "neutron",
        # Arabic core terms
        "نووي", "نووية", "إشعاع", "إشعاعي", "إشعاعية", "مشع", "مشعة",
        "مفاعل", "مفاعلات", "يورانيوم", "بلوتونيوم", "طاقة ذرية", "ذرية",
        "ذري", "انشطار", "اندماج", "نظائر", "تخصيب"
    ],
    "regulatory_legal": [
        "nuclear law", "regulatory body", "safeguards", "non-proliferation",
        "licensing", "permission principle", "authorization", "iaea", "euratom",
        "nuclear safety", "nuclear security", "civil liability", "convention",
        "treaty", "decommissioning", "radioactive waste", "spent fuel",
        "code of conduct", "dosimetry", "radiological protection", "transport of radioactive material",
        # Arabic regulatory terms
        "قانون نووي", "الرقابة النووية", "هيئة الرقابة", "أمان نووي", "أمن نووي",
        "حظر الانتشار", "الضمانات", "وكالة الطاقة الذرية", "نفايات مشعة",
        "وقاية إشعاعية", "الوقاية من الإشعاع", "الوقود المستهلك", "ترخيص نووي", "تراخيص",
        "أمان المنشآت النووية", "جرعة إشعاعية"
    ]
}

def calculate_heuristic_score(text: str) -> dict:
    """Calculates keyword match density for nuclear law domain."""
    text_lower = text.lower()
    matches = []
    
    for category, words in NUCLEAR_KEYWORDS.items():
        for word in words:
            # For ASCII words use word boundaries; for Arabic substrings check membership
            if all(ord(c) < 128 for c in word):
                pattern = r'\b' + re.escape(word) + r'\b'
                count = len(re.findall(pattern, text_lower))
            else:
                count = text_lower.count(word)
                
            if count > 0:
                matches.append((word, count))
                
    total_occurrences = sum(count for _, count in matches)
    unique_terms = len(matches)
    
    # Heuristic threshold: at least 2 unique terms or 4 total occurrences
    is_likely_nuclear = unique_terms >= 2 or total_occurrences >= 4
    return {
        "is_likely_nuclear": is_likely_nuclear,
        "unique_terms": unique_terms,
        "total_occurrences": total_occurrences,
        "matched_words": [w for w, _ in matches[:10]]
    }

def verify_nuclear_domain(sample_text: str) -> dict:
    """
    Two-stage domain verification:
    1. Fast heuristic keyword check.
    2. LLM semantic classification (via Groq / Ollama / OpenRouter).
    Returns:
    {
        "is_nuclear": bool,
        "confidence": float,
        "detected_topic": str,
        "reason": str
    }
    """
    heuristic = calculate_heuristic_score(sample_text)
    
    # If the text has completely zero nuclear words, reject immediately
    if heuristic["total_occurrences"] == 0:
        return {
            "is_nuclear": False,
            "confidence": 0.99,
            "detected_topic": "Non-nuclear topic",
            "reason": "The document contains no nuclear, atomic, or radiological regulatory terminology."
        }
        
    # Prepare LLM Classifier prompt
    excerpt = sample_text[:3500]  # First ~3500 characters
    prompt = f"""You are a specialized document screener for a Nuclear Law and Safety repository.
Your task is to analyze the following document excerpt and decide if it genuinely belongs to Nuclear Law, Nuclear Energy/Technology, Nuclear Safety, or Radiation Protection regulation.

DOCUMENT EXCERPT:
\"\"\"
{excerpt}
\"\"\"

Respond STRICTLY with valid JSON in this exact structure (no markdown, no extra text):
{{
  "is_nuclear": true or false,
  "confidence": a number between 0.0 and 1.0,
  "detected_topic": "concise description of the document topic",
  "reason": "one sentence explaining why it is or is not related to nuclear law and safety"
}}
"""

    # Check available LLM keys
    groq_key = os.environ.get("GROQ_API_KEY")
    openrouter_key = os.environ.get("OPENROUTER_API_KEY")
    ollama_url = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1")
    
    try:
        if groq_key:
            resp = requests.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {groq_key}"},
                json={
                    "model": "llama-3.3-70b-versatile",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.0,
                    "response_format": {"type": "json_object"}
                },
                timeout=25
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            result = json.loads(content)
            return result

        elif openrouter_key:
            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {openrouter_key}"},
                json={
                    "model": "meta-llama/llama-3.1-8b-instruct:free",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.0
                },
                timeout=25
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            # Extract JSON from potential markdown tags
            match = re.search(r'\{.*\}', content, re.DOTALL)
            if match:
                return json.loads(match.group())

        else:
            # Fallback to local Ollama
            resp = requests.post(
                f"{ollama_url.rstrip('/')}/chat/completions",
                headers={"Content-Type": "application/json", "Authorization": "Bearer ollama"},
                json={
                    "model": os.environ.get("OLLAMA_MODEL", "llama3.2"),
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.0
                },
                timeout=25
            )
            if resp.status_code == 200:
                content = resp.json()["choices"][0]["message"]["content"]
                match = re.search(r'\{.*\}', content, re.DOTALL)
                if match:
                    return json.loads(match.group())

    except Exception as e:
        # If LLM is unreachable, use robust heuristic decision
        print(f"Warning: LLM classification fallback to heuristic: {e}")
        
    # Heuristic fallback if LLM is unavailable
    if heuristic["is_likely_nuclear"]:
        return {
            "is_nuclear": True,
            "confidence": 0.85,
            "detected_topic": f"Nuclear terminology detected ({', '.join(heuristic['matched_words'][:3])})",
            "reason": f"Found {heuristic['total_occurrences']} occurrences of nuclear regulatory terms."
        }
    else:
        return {
            "is_nuclear": False,
            "confidence": 0.80,
            "detected_topic": "Insufficient nuclear context",
            "reason": "Document has insufficient nuclear terminology density."
        }
