import os
import re
import json
import shutil
from datetime import datetime
from pathlib import Path
import pymupdf
from rank_bm25 import BM25Okapi
from domain_detector import verify_nuclear_domain

BASE_DIR = Path(__file__).parent
WORKSPACES_ROOT = BASE_DIR / "data" / "workspaces"
BASE_HANDBOOK_PATH = BASE_DIR / "knowledge_base.json"

# Load base IAEA handbook chunks if available
BASE_HANDBOOK_CHUNKS = []
if BASE_HANDBOOK_PATH.exists():
    try:
        with open(BASE_HANDBOOK_PATH, "r", encoding="utf-8") as f:
            BASE_HANDBOOK_CHUNKS = json.load(f)
    except Exception as e:
        print(f"Warning: Could not load base handbook: {e}")

def sanitize_workspace_id(workspace_id: str) -> str:
    """Sanitize workspace id to prevent directory traversal."""
    cleaned = re.sub(r'[^a-zA-Z0-9_\-]', '_', workspace_id.strip())
    return cleaned or "default"

def get_workspace_dir(workspace_id: str) -> Path:
    ws_id = sanitize_workspace_id(workspace_id)
    ws_dir = WORKSPACES_ROOT / ws_id
    (ws_dir / "documents").mkdir(parents=True, exist_ok=True)
    return ws_dir

def get_workspace_catalog(workspace_id: str) -> list:
    ws_dir = get_workspace_dir(workspace_id)
    catalog_path = ws_dir / "catalog.json"
    if catalog_path.exists():
        try:
            with open(catalog_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []
    return []

def save_workspace_catalog(workspace_id: str, catalog: list):
    ws_dir = get_workspace_dir(workspace_id)
    catalog_path = ws_dir / "catalog.json"
    with open(catalog_path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

def get_workspace_chunks(workspace_id: str, include_base: bool = True) -> list:
    ws_dir = get_workspace_dir(workspace_id)
    chunks_path = ws_dir / "chunks.json"
    user_chunks = []
    if chunks_path.exists():
        try:
            with open(chunks_path, "r", encoding="utf-8") as f:
                user_chunks = json.load(f)
        except Exception:
            user_chunks = []
            
    if include_base and BASE_HANDBOOK_CHUNKS:
        return user_chunks + BASE_HANDBOOK_CHUNKS
    return user_chunks

def clean_text(text: str) -> str:
    text = re.sub(r'\r\n?', '\n', text)
    text = re.sub(r'Page \d+( of \d+)?', ' ', text, flags=re.I)
    text = re.sub(r'^\s*\d+\s*$', ' ', text, flags=re.M)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

def chunk_text(text: str, source: str, chunk_size: int = 800, overlap: int = 150) -> list:
    sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', text) if s.strip()]
    chunks = []
    current = ""
    for sent in sentences:
        if len(current) + len(sent) + 1 <= chunk_size:
            current = (current + " " + sent).strip()
        else:
            if current:
                chunks.append(current)
            tail = current[-overlap:] if overlap and current else ""
            current = (tail + " " + sent).strip()
    if current:
        chunks.append(current)
    return [{"text": c, "source": source, "chunk_id": f"{source}::{i}"} for i, c in enumerate(chunks)]

def process_and_add_pdf(workspace_id: str, filename: str, file_bytes: bytes) -> dict:
    """
    Ingests an uploaded PDF file:
    1. Saves file to workspace.
    2. Extracts text with PyMuPDF.
    3. Runs Nuclear Domain Detection.
    4. If approved: chunks and saves to workspace index.
    """
    ws_dir = get_workspace_dir(workspace_id)
    doc_path = ws_dir / "documents" / filename
    
    with open(doc_path, "wb") as f:
        f.write(file_bytes)
        
    # Extract text
    pages = []
    try:
        with pymupdf.open(doc_path) as pdf_doc:
            for i, page in enumerate(pdf_doc):
                t = page.get_text() or ""
                cleaned = clean_text(t)
                if cleaned:
                    pages.append((i + 1, cleaned))
    except Exception as e:
        if doc_path.exists():
            doc_path.unlink()
        return {"success": False, "error": f"Invalid or unreadable PDF: {e}"}
        
    if not pages:
        if doc_path.exists():
            doc_path.unlink()
        return {"success": False, "error": "The uploaded PDF contains no extractable text."}
        
    # Domain Detection on first 5 pages
    sample_text = "\n\n".join(text for _, text in pages[:5])
    domain_verification = verify_nuclear_domain(sample_text)
    
    if not domain_verification.get("is_nuclear", False):
        # Document is NOT related to nuclear law - remove file and reject
        if doc_path.exists():
            doc_path.unlink()
        return {
            "success": False,
            "rejected": True,
            "filename": filename,
            "domain_verification": domain_verification,
            "error": f"Document rejected: Not in Nuclear Law domain ({domain_verification.get('reason', '')})"
        }
        
    # Document verified! Chunk all pages
    new_chunks = []
    for page_num, page_text in pages:
        source_label = f"{filename} (page {page_num})"
        new_chunks.extend(chunk_text(page_text, source_label))
        
    # Update chunks.json
    chunks_path = ws_dir / "chunks.json"
    existing_chunks = []
    if chunks_path.exists():
        try:
            with open(chunks_path, "r", encoding="utf-8") as f:
                existing_chunks = json.load(f)
        except Exception:
            existing_chunks = []
            
    # Avoid duplicate chunks if file was re-uploaded
    filtered_chunks = [c for c in existing_chunks if not c.get("source", "").startswith(filename)]
    filtered_chunks.extend(new_chunks)
    
    with open(chunks_path, "w", encoding="utf-8") as f:
        json.dump(filtered_chunks, f, ensure_ascii=False, indent=2)
        
    # Update catalog
    catalog = get_workspace_catalog(workspace_id)
    catalog = [item for item in catalog if item["filename"] != filename]
    catalog.append({
        "filename": filename,
        "pages_count": len(pages),
        "chunks_count": len(new_chunks),
        "uploaded_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC"),
        "domain_verification": domain_verification
    })
    save_workspace_catalog(workspace_id, catalog)
    
    return {
        "success": True,
        "rejected": False,
        "filename": filename,
        "pages_count": len(pages),
        "chunks_count": len(new_chunks),
        "domain_verification": domain_verification
    }

def delete_workspace_document(workspace_id: str, filename: str) -> bool:
    ws_dir = get_workspace_dir(workspace_id)
    doc_path = ws_dir / "documents" / filename
    if doc_path.exists():
        doc_path.unlink()
        
    # Update chunks
    chunks_path = ws_dir / "chunks.json"
    if chunks_path.exists():
        try:
            with open(chunks_path, "r", encoding="utf-8") as f:
                chunks = json.load(f)
            updated_chunks = [c for c in chunks if not c.get("source", "").startswith(filename)]
            with open(chunks_path, "w", encoding="utf-8") as f:
                json.dump(updated_chunks, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
            
    # Update catalog
    catalog = get_workspace_catalog(workspace_id)
    catalog = [item for item in catalog if item["filename"] != filename]
    save_workspace_catalog(workspace_id, catalog)
    return True

def search_workspace_chunks(query: str, workspace_id: str, top_k: int = 4, include_base: bool = True) -> list:
    chunks = get_workspace_chunks(workspace_id, include_base=include_base)
    if not chunks:
        return []
        
    tokenized = [c["text"].lower().split() for c in chunks]
    bm25 = BM25Okapi(tokenized)
    scores = bm25.get_scores(query.lower().split())
    ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
    return [chunks[i] for i in ranked if scores[i] > 0]
