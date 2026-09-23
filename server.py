import os
import sys
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel

# Add current folder to sys.path
BASE_DIR = Path(__file__).parent
sys.path.insert(0, str(BASE_DIR))

from workspace_manager import (
    process_and_add_pdf,
    delete_workspace_document,
    get_workspace_catalog,
    get_workspace_chunks,
    search_workspace_chunks,
    sanitize_workspace_id
)
from rag_pipeline import call_llm, SYSTEM_PROMPT

app = FastAPI(title="Nuclear Law RAG Platform", version="2.0.0")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    question: str
    workspace_id: str = "default"
    include_base_handbook: bool = True

@app.get("/api/workspaces/{workspace_id}/documents")
async def get_documents(workspace_id: str):
    ws_id = sanitize_workspace_id(workspace_id)
    catalog = get_workspace_catalog(ws_id)
    chunks = get_workspace_chunks(ws_id, include_base=False)
    return {
        "workspace_id": ws_id,
        "documents": catalog,
        "total_user_chunks": len(chunks)
    }

@app.post("/api/workspaces/{workspace_id}/upload")
async def upload_document(
    workspace_id: str,
    file: UploadFile = File(...)
):
    ws_id = sanitize_workspace_id(workspace_id)
    filename = file.filename
    
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF documents are supported.")
        
    contents = await file.read()
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="Empty file uploaded.")
        
    result = process_and_add_pdf(ws_id, filename, contents)
    
    if not result.get("success", False):
        if result.get("rejected", False):
            # Domain rejection
            return JSONResponse(
                status_code=400,
                content={
                    "status": "rejected",
                    "error": result.get("error"),
                    "domain_verification": result.get("domain_verification")
                }
            )
        else:
            raise HTTPException(status_code=400, detail=result.get("error", "Failed to process PDF."))
            
    return {
        "status": "approved",
        "message": f"Document '{filename}' successfully verified and indexed in workspace '{ws_id}'.",
        "pages": result.get("pages_count"),
        "chunks": result.get("chunks_count"),
        "domain_verification": result.get("domain_verification")
    }

@app.delete("/api/workspaces/{workspace_id}/documents/{filename}")
async def delete_document(workspace_id: str, filename: str):
    ws_id = sanitize_workspace_id(workspace_id)
    success = delete_workspace_document(ws_id, filename)
    return {"status": "deleted", "filename": filename, "workspace_id": ws_id}

@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    question = request.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")
        
    ws_id = sanitize_workspace_id(request.workspace_id)
    retrieved = search_workspace_chunks(
        question,
        workspace_id=ws_id,
        top_k=4,
        include_base=request.include_base_handbook
    )
    
    if not retrieved:
        return {
            "answer": "The documents in this workspace do not contain enough information to answer this question. Try uploading relevant nuclear law PDFs or enabling the base IAEA handbook.",
            "sources": [],
            "workspace_id": ws_id
        }
        
    context_parts = []
    sources = []
    for idx, c in enumerate(retrieved, 1):
        context_parts.append(f"[{idx}] Source: {c['source']}\n{c['text']}")
        if c["source"] not in sources:
            sources.append(c["source"])
            
    context_str = "\n\n".join(context_parts)
    user_prompt = f"Context:\n{context_str}\n\nQuestion: {question}\n\nAnswer:"
    
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt}
    ]
    
    try:
        answer = call_llm(messages)
    except Exception as e:
        answer = f"Error generating answer: {e}"
        
    return {
        "answer": answer,
        "sources": sources,
        "workspace_id": ws_id
    }

# Mount static frontend files
FRONTEND_DIR = BASE_DIR / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    print("\n🚀 Starting Nuclear Law RAG Server...")
    print("📍 Web Interface: http://localhost:8000")
    print("📍 API Docs:      http://localhost:8000/docs\n")
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
