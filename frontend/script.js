// API Base URL: auto-detects current host (FastAPI server) or falls back to localhost:8000
const API_BASE = "https://nuclear-rag-worker.mai244040.workers.dev/";

// Workspace Management
let currentWorkspace = localStorage.getItem("nuclear_rag_workspace") || "default";

// DOM Elements
const docSidebar = document.getElementById("docSidebar");
const openSidebarBtn = document.getElementById("openSidebarBtn");
const closeSidebarBtn = document.getElementById("closeSidebarBtn");
const displayWorkspaceName = document.getElementById("displayWorkspaceName");
const activeWorkspaceBadge = document.getElementById("activeWorkspaceBadge");
const switchWorkspaceBtn = document.getElementById("switchWorkspaceBtn");
const workspaceModal = document.getElementById("workspaceModal");
const closeModalBtn = document.getElementById("closeModalBtn");
const newWorkspaceInput = document.getElementById("newWorkspaceInput");
const confirmWorkspaceBtn = document.getElementById("confirmWorkspaceBtn");

// Upload & Documents
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const uploadStatusCard = document.getElementById("uploadStatusCard");
const statusTitle = document.getElementById("statusTitle");
const statusDesc = document.getElementById("statusDesc");
const statusSpinner = document.getElementById("statusSpinner");
const docsList = document.getElementById("docsList");
const docCountBadge = document.getElementById("docCountBadge");
const headerDocBadge = document.getElementById("headerDocBadge");
const includeBaseHandbook = document.getElementById("includeBaseHandbook");

// Chat Elements
const chatViewport = document.getElementById("chatViewport");
const messagesList = document.getElementById("messagesList");
const chatForm = document.getElementById("chatForm");
const userInput = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");
const typingIndicator = document.getElementById("typingIndicator");
const themeToggle = document.getElementById("themeToggle");
const welcomeCard = document.getElementById("welcomeCard");

// Initialize on page load
document.addEventListener("DOMContentLoaded", () => {
  updateWorkspaceUI();
  loadWorkspaceDocuments();
});

// Workspace UI handlers
function updateWorkspaceUI() {
  displayWorkspaceName.textContent = currentWorkspace;
  activeWorkspaceBadge.innerHTML = `Workspace: <strong>${currentWorkspace}</strong>`;
}

switchWorkspaceBtn.addEventListener("click", () => {
  newWorkspaceInput.value = currentWorkspace;
  workspaceModal.style.display = "flex";
  newWorkspaceInput.focus();
});

closeModalBtn.addEventListener("click", () => {
  workspaceModal.style.display = "none";
});

confirmWorkspaceBtn.addEventListener("click", () => {
  const ws = newWorkspaceInput.value.trim().toLowerCase().replace(/[^a-z0-9_\-]/g, "_");
  if (ws) {
    currentWorkspace = ws;
    localStorage.setItem("nuclear_rag_workspace", currentWorkspace);
    updateWorkspaceUI();
    workspaceModal.style.display = "none";
    loadWorkspaceDocuments();
    appendSystemNotice(`Switched to workspace: <strong>${currentWorkspace}</strong>`);
  }
});

// Sidebar Toggle (Mobile & Desktop)
openSidebarBtn.addEventListener("click", () => {
  docSidebar.classList.toggle("open");
});
closeSidebarBtn.addEventListener("click", () => {
  docSidebar.classList.remove("open");
});

// Fetch & Display Workspace Documents
async function loadWorkspaceDocuments() {
  try {
    const resp = await fetch(`${API_BASE}/api/workspaces/${currentWorkspace}/documents`);
    if (!resp.ok) throw new Error("Could not load documents");
    const data = await resp.json();
    renderDocuments(data.documents || []);
  } catch (err) {
    console.warn("Could not load documents list from backend:", err);
    renderDocuments([]);
  }
}

function renderDocuments(docs) {
  docCountBadge.textContent = docs.length;
  headerDocBadge.textContent = docs.length;

  if (docs.length === 0) {
    docsList.innerHTML = `<div class="empty-docs">No custom documents uploaded in workspace <strong>${currentWorkspace}</strong>.</div>`;
    return;
  }

  docsList.innerHTML = "";
  docs.forEach(doc => {
    const item = document.createElement("div");
    item.className = "doc-item";

    const isVerified = doc.domain_verification?.is_nuclear;
    const badgeHtml = isVerified 
      ? `<span style="color: var(--success-color); font-size: 0.7rem;">✔ Nuclear Verified</span>`
      : "";

    item.innerHTML = `
      <div class="doc-info">
        <span class="doc-title" title="${doc.filename}">📄 ${doc.filename}</span>
        <span class="doc-meta">${doc.pages_count} pages • ${doc.chunks_count} chunks ${badgeHtml}</span>
      </div>
      <button class="btn-delete-doc" title="Remove Document" data-filename="${doc.filename}">🗑️</button>
    `;

    item.querySelector(".btn-delete-doc").addEventListener("click", () => {
      deleteDocument(doc.filename);
    });

    docsList.appendChild(item);
  });
}

// Delete Document
async function deleteDocument(filename) {
  if (!confirm(`Remove '${filename}' from workspace '${currentWorkspace}'?`)) return;
  try {
    const resp = await fetch(`${API_BASE}/api/workspaces/${currentWorkspace}/documents/${encodeURIComponent(filename)}`, {
      method: "DELETE"
    });
    if (resp.ok) {
      loadWorkspaceDocuments();
      appendSystemNotice(`Document <strong>${filename}</strong> removed from workspace.`);
    }
  } catch (err) {
    alert("Error deleting document: " + err.message);
  }
}

// File Upload & Domain Verification Handlers
dropzone.addEventListener("click", () => fileInput.click());

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragover");
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length > 0) {
    handleFileUpload(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    handleFileUpload(fileInput.files[0]);
  }
});

async function handleFileUpload(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    showUploadStatus("error", "Invalid File", "Only PDF documents are supported.");
    return;
  }

  showUploadStatus("verifying", "Scanning & Verifying...", `Analyzing '${file.name}' for Nuclear Law and Radiation Safety domain...`);

  const formData = new FormData();
  formData.append("file", file);

  try {
    const resp = await fetch(`${API_BASE}/api/workspaces/${currentWorkspace}/upload`, {
      method: "POST",
      body: formData
    });

    const textResp = await resp.text();
    let data = {};
    try {
      data = textResp ? JSON.parse(textResp) : {};
    } catch (e) {
      throw new Error(`Server returned status ${resp.status} (${resp.statusText || "Empty or invalid response"}). Ensure backend is running.`);
    }

    if (!resp.ok || data.status === "rejected") {
      const reason = data.domain_verification?.reason || data.error || data.detail || `Server returned error (${resp.status})`;
      const topic = data.domain_verification?.detected_topic || "Rejection";
      showUploadStatus(
        "error",
        "❌ Document Rejected",
        `<strong>Status:</strong> ${topic}<br><strong>Reason:</strong> ${reason}`
      );
      return;
    }

    // Success
    const topic = data.domain_verification?.detected_topic || "Nuclear Regulation";
    const conf = Math.round((data.domain_verification?.confidence || 0.9) * 100);
    showUploadStatus(
      "success",
      "✅ Domain Verified & Indexed!",
      `<strong>${file.name}</strong> (${data.pages} pages, ${data.chunks} chunks)<br>Topic: ${topic} (${conf}% match)`
    );

    loadWorkspaceDocuments();
    appendSystemNotice(`✅ Successfully added <strong>${file.name}</strong> to workspace <strong>${currentWorkspace}</strong>.`);

  } catch (err) {
    showUploadStatus("error", "Upload Failed", err.message);
  } finally {
    fileInput.value = "";
  }
}

function showUploadStatus(type, title, desc) {
  uploadStatusCard.style.display = "block";
  uploadStatusCard.className = `upload-status-card ${type}`;
  statusTitle.innerHTML = title;
  statusDesc.innerHTML = desc;
  statusSpinner.style.display = type === "verifying" ? "inline-block" : "none";
}

// Chat Pipeline
userInput.addEventListener("input", function() {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});

userInput.addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event("submit"));
  }
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = userInput.value.trim();
  if (!q) return;
  submitQuestion(q);
});

document.querySelectorAll(".chip-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const q = btn.getAttribute("data-question");
    if (q) submitQuestion(q);
  });
});

async function submitQuestion(question) {
  if (welcomeCard) welcomeCard.style.display = "none";
  userInput.value = "";
  userInput.style.height = "auto";

  appendMessage("user", question);
  showLoading(true);

  try {
    const resp = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: question,
        workspace_id: currentWorkspace,
        include_base_handbook: includeBaseHandbook.checked
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `Server error [${resp.status}]`);
    }

    const data = await resp.json();
    appendMessage("assistant", data.answer || "No response received.", data.sources || []);

  } catch (err) {
    appendMessage(
      "assistant",
      `⚠️ **Connection Error**: ${err.message}\n\nPlease ensure the backend server is running (\`python server.py\`).`
    );
  } finally {
    showLoading(false);
  }
}

function appendMessage(role, content, sources = []) {
  const row = document.createElement("div");
  row.className = `message-row ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "👤" : "⚛️";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  if (role === "assistant" && window.marked) {
    bubble.innerHTML = marked.parse(content);
  } else {
    const p = document.createElement("p");
    p.textContent = content;
    bubble.appendChild(p);
  }

  if (sources && sources.length > 0) {
    const sourcesCard = document.createElement("div");
    sourcesCard.className = "sources-card";
    sourcesCard.innerHTML = `<div class="sources-header">📚 <span>Cited References:</span></div>`;
    const list = document.createElement("ul");
    list.className = "sources-list";
    sources.forEach(src => {
      const li = document.createElement("li");
      li.textContent = src;
      list.appendChild(li);
    });
    sourcesCard.appendChild(list);
    bubble.appendChild(sourcesCard);
  }

  row.appendChild(avatar);
  row.appendChild(bubble);
  messagesList.appendChild(row);
  chatViewport.scrollTop = chatViewport.scrollHeight;
}

function appendSystemNotice(html) {
  const div = document.createElement("div");
  div.style.textAlign = "center";
  div.style.fontSize = "0.8rem";
  div.style.color = "var(--text-muted)";
  div.style.margin = "8px 0";
  div.innerHTML = `ℹ️ ${html}`;
  messagesList.appendChild(div);
  chatViewport.scrollTop = chatViewport.scrollHeight;
}

function showLoading(show) {
  typingIndicator.style.display = show ? "flex" : "none";
  sendBtn.disabled = show;
  if (show) chatViewport.scrollTop = chatViewport.scrollHeight;
}

// Dark / Light Theme
themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  themeToggle.querySelector(".theme-icon").textContent = next === "dark" ? "☀️" : "🌙";
  localStorage.setItem("theme", next);
});

const savedTheme = localStorage.getItem("theme");
if (savedTheme) {
  document.documentElement.setAttribute("data-theme", savedTheme);
  themeToggle.querySelector(".theme-icon").textContent = savedTheme === "dark" ? "☀️" : "🌙";
}
