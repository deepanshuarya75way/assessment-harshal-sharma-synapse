import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import axios from "axios";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

const API_KEY = import.meta.env.VITE_API_KEY || "";

// Persistent per-browser user identity — generated once and stored in localStorage.
const USER_ID_KEY = "synapse_user_id";
const getUserId = () => {
  let uid = localStorage.getItem(USER_ID_KEY);
  if (!uid) {
    uid = crypto.randomUUID();
    localStorage.setItem(USER_ID_KEY, uid);
  }
  return uid;
};
const USER_ID = getUserId();

const authHeaders = () => ({
  ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
  "X-User-ID": USER_ID,
});

const STORAGE_KEY = "chat_context";

const generateId = () => crypto.randomUUID();

const getTimestamp = () => new Date().toISOString();

/**
 * Parse a reply string and replace [N] / [N, M] citation markers with
 * interactive badge spans. Citations are rendered as glowing pills.
 */
const formatMessageWithCitations = (text, citations = [], onBadgeClick) => {
  if (!text) return "";

  // First handle bold markers (**text**), then inline [N] citations
  const parts = [];
  // Split on citation patterns like [1], [2], [1,2], [1, 2]
  const citationRegex = /\[(\d+(?:[,\s]*\d+)*)\]/g;
  let lastIndex = 0;
  let match;

  while ((match = citationRegex.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      const segment = text.slice(lastIndex, match.index);
      parts.push(...formatBold(segment, `pre-${match.index}`));
    }
    // Parse all numbers in this badge group
    const ids = match[1].split(/[,\s]+/).map(Number).filter(Boolean);
    parts.push(
      <span
        key={`cite-${match.index}`}
        className="citation-badge"
        onClick={() => onBadgeClick && onBadgeClick(ids)}
        title={`View source${ids.length > 1 ? "s" : ""} ${ids.join(", ")}`}
      >
        {ids.map((id) => `[${id}]`).join("")}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    parts.push(...formatBold(text.slice(lastIndex), `tail-${lastIndex}`));
  }

  return parts.length ? parts : text;
};

const formatBold = (text, keyPrefix = "") => {
  if (!text) return [];
  const tokens = text.split("**");
  return tokens.map((token, i) =>
    i % 2 === 1 ? <strong key={`${keyPrefix}-b${i}`}>{token}</strong> : token
  );
};

const formatMessage = (text) => {
  if (!text) return "";
  const tokens = text.split("**");
  return tokens.map((token, i) => {
    if (i % 2 === 1) {
      return <strong key={i}>{token}</strong>;
    }
    return token;
  });
};

const formatTime = (isoString) => {
  if (!isoString) return "";
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
};

/** A collapsible citations section rendered below assistant messages. */
const CitationsAccordion = forwardRef(function CitationsAccordion({ citations }, ref) {
  const [open, setOpen] = useState(false);
  const [highlightedIds, setHighlightedIds] = useState([]);

  useImperativeHandle(ref, () => ({
    openAndHighlight(ids) {
      setOpen(true);
      setHighlightedIds(ids);
      // Delay scroll to allow accordion to render
      setTimeout(() => {
        const el = document.getElementById(`citation-${ids[0]}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 120);
    },
  }));

  if (!citations || citations.length === 0) return null;

  return (
    <div className="citations-accordion">
      <button
        className="citations-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        Sources Cited ({citations.length})
        <svg
          className={`citations-chevron ${open ? "open" : ""}`}
          width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="citations-list">
          {citations.map((c) => (
            <div
              key={c.id}
              className={`citation-card ${highlightedIds?.includes(c.id) ? "highlighted" : ""}`}
              id={`citation-${c.id}`}
            >
              <div className="citation-card-header">
                <span className="citation-index">[{c.id}]</span>
                <span className="citation-filename">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: 4}}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  {c.source_file}
                </span>
                {c.page_number && (
                  <span className="citation-page">Page {c.page_number}</span>
                )}
                <span className="citation-score" title="Relevance score">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style={{marginRight: 3}}>
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                  {(c.score * 1000).toFixed(1)}
                </span>
              </div>
              <p className="citation-snippet">&ldquo;{c.snippet}&rdquo;</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

const THEME_KEY = "synapse_theme";

/** Wrapper component for a single chat message so hooks can be used safely per-message. */
function MessageItem({ msg, isUser }) {
  const accordionRef = useRef(null);

  const handleBadgeClick = (ids) => {
    // Open accordion first, then scroll after a short delay for layout
    if (accordionRef.current) {
      accordionRef.current.openAndHighlight(ids);
    }
  };

  return (
    <div className={`chat-item ${isUser ? "user" : "bot"}`}>
      <div className="chat-tag">{isUser ? "User" : "Synapse"}</div>
      <div className={`chat-bubble ${isUser ? "user" : "bot"}`}>
        <div className="msg-text">
          {isUser
            ? formatMessage(msg.content)
            : formatMessageWithCitations(msg.content, msg.citations, handleBadgeClick)
          }
        </div>
        <span className="bubble-timestamp">{formatTime(msg.timestamp)}</span>
      </div>
      {!isUser && msg.citations && msg.citations.length > 0 && (
        <CitationsAccordion
          ref={accordionRef}
          citations={msg.citations}
        />
      )}
    </div>
  );
}


function App() {
  const [query, setQuery] = useState("");

  const [messages, setMessages] = useState(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return parsed.context || [];
      }
      return [];
    } catch {
      return [];
    }
  });

  const [loading, setLoading] = useState(false);

  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null); // {type: "success"|"error", message}
  const [showUpload, setShowUpload] = useState(false);
  const fileInputRef = useRef(null);

  const [documentFilter, setDocumentFilter] = useState("latest");
  const [documentList, setDocumentList] = useState([]); // [{source_file, chunk_count, ingested_at}]

  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) return saved === "dark";
    return true;
  });

  useEffect(() => {
    if (isDark) {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = "light";
    }
    localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
  }, [isDark]);

  const toggleTheme = () => setIsDark((v) => !v);

  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const limitedMessages = messages.slice(-50);
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ context: limitedMessages })
    );
  }, [messages]);

  const streamResponse = async (fullText, callback) => {
    const CHUNK_SIZE = 4; // characters per frame
    let current = "";
    for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
      current += fullText.slice(i, i + CHUNK_SIZE);
      callback(current);
      await new Promise((res) => setTimeout(res, 16)); // ~60fps
    }
  };

  const fetchDocuments = async () => {
    try {
      const res = await axios.get(`${API_BASE}/documents`, {
        headers: { ...authHeaders() },
      });
      setDocumentList(res.data.documents || []);
    } catch {
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, []);


  const handleSearch = async () => {
    if (!query.trim() || loading) return;

    setLoading(true);

    const userMessage = {
      id: generateId(),
      role: "user",
      content: query,
      timestamp: getTimestamp(),
    };

    const apiMessages = [...messages, userMessage];

    const botMessage = {
      id: generateId(),
      role: "assistant",
      content: "",
      timestamp: getTimestamp(),
      citations: [],
    };

    setMessages([...apiMessages, botMessage]);
    setQuery("");

    try {
      const response = await axios.post(
        `${API_BASE}/chat`,
        { messages: apiMessages, document_filter: documentFilter, user_id: USER_ID },
        { headers: { ...authHeaders() } },
      );

      const botReply = response.data.reply || "No response from server.";
      const responseCitations = response.data.citations || [];

      await streamResponse(botReply, (partialText) => {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: partialText,
            citations: responseCitations,
          };
          return updated;
        });
      });
    } catch (error) {
      const detail =
        error.response?.data?.detail ||
        error.response?.data?.error ||
        error.message ||
        "Unknown error";

      console.error("Chat ERROR:", detail);

      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          content: ` Error: ${detail}`,
        };
        return updated;
      });
    } finally {
      setLoading(false);
    }
  };

  const clearChat = () => {
    setMessages([]);
    sessionStorage.removeItem(STORAGE_KEY);
  };

  const handleUpload = async () => {
    if (!uploadFile || uploading) return;

    if (uploadFile.type !== "application/pdf") {
      setUploadStatus({ type: "error", message: "Only PDF files are accepted." });
      return;
    }

    setUploading(true);
    setUploadStatus(null);

    const formData = new FormData();
    formData.append("file", uploadFile);

    try {
      const response = await axios.post(`${API_BASE}/ingest`, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
          ...authHeaders(),
        },
      });

      const { chunks_indexed, batches_failed } = response.data;
      setUploadStatus({
        type: "success",
        message: `Data Ingested "${uploadFile.name}" — ${chunks_indexed} chunks indexed${batches_failed > 0 ? `, ${batches_failed} batch(es) failed` : ""}.`,
      });
      setUploadFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      // Refresh the document list so the dropdown shows the new file
      await fetchDocuments();
      // Auto-switch scope to latest after a successful upload
      setDocumentFilter("latest");
      setTimeout(() => {
        setShowUpload(false);
        setUploadStatus(null);
      }, 1500);
    } catch (error) {
      const detail =
        error.response?.data?.detail || error.message || "Upload failed.";
      setUploadStatus({ type: "error", message: `❌ ${detail}` });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="app-container">

      {/* HEADER */}
      <div className="header">
        <div className="brand">
          <svg className="brand-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1 0-3.12 3 3 0 0 1 0-4.88 2.5 2.5 0 0 1 0-3.12A2.5 2.5 0 0 1 9.5 2z" />
            <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 0-3.12 3 3 0 0 0 0-4.88 2.5 2.5 0 0 0 0-3.12A2.5 2.5 0 0 0 14.5 2z" />
          </svg>
          <h1>Synapse</h1>
        </div>

        <div className="header-actions">
          {/* Clear Chat */}
          <button className="header-btn btn-clear" onClick={clearChat}>
            <svg className="btn-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
            <span>Clear Chat</span>
          </button>

          {/* Document Scope Selector */}
          <div className="doc-scope-wrapper" title="Select which document(s) to query">
            <svg className="doc-scope-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <select
              id="doc-scope-select"
              className="doc-scope-select"
              value={documentFilter}
              onChange={(e) => setDocumentFilter(e.target.value)}
              aria-label="Document search scope"
            >
              <option value="latest">Latest Document</option>
              <option value="all">All Documents</option>
              {documentList
                .filter((d) => d.source_file)
                .map((d) => (
                  <option key={d.source_file} value={d.source_file}>
                    {d.source_file}
                  </option>
                ))}
            </select>
          </div>

          {/* Dark / Light mode toggle */}
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {isDark ? (
              /* Sun icon */
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              /* Moon icon */
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* UPLOAD PANEL */}
      {showUpload && (
        <div className="upload-panel">
          {/* Back button */}
          <button
            className="upload-back-btn"
            onClick={() => {
              setShowUpload(false);
              setUploadFile(null);
              setUploadStatus(null);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
            title="Back to chat"
            aria-label="Back to chat"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            Back to Chat
          </button>

          <h2>Upload a PDF to the Knowledge Base</h2>
          <p className="upload-hint">
            The document will be chunked, embedded, and indexed into Qdrant so
            Synapse can answer questions about it.
          </p>

          <div className="upload-controls">
            <input
              id="pdf-file-input"
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              onChange={(e) => {
                setUploadFile(e.target.files[0] || null);
                setUploadStatus(null);
              }}
              className="file-input"
            />
            <button
              id="upload-submit-btn"
              onClick={handleUpload}
              disabled={!uploadFile || uploading}
              className="btn-primary"
            >
              {uploading ? "Uploading…" : "Ingest PDF"}
            </button>
          </div>

          {uploadFile && !uploadStatus && (
            <p className="upload-hint">Selected: <strong>{uploadFile.name}</strong></p>
          )}

          {uploadStatus && (
            <p className={`upload-status ${uploadStatus.type}`}>
              {uploadStatus.message}
            </p>
          )}
        </div>
      )}

      {/* CHAT */}
      {!showUpload && (
        <div className="chat-container">
          {messages.length > 0 &&
            messages.map((msg) => {
              const isUser = msg.role === "user";
              // Each bot message gets its own accordion that manages its own highlight state
              return (
                <MessageItem key={msg.id} msg={msg} isUser={isUser} />
              );
            })
          }
          <div ref={bottomRef}></div>
        </div>
      )}

      {/* INPUT */}
      {!showUpload && (
        <div className={`input-section ${messages.length === 0 ? "centered" : "bottom"}`}>
          {messages.length === 0 && (
            <div className="hero-container">
              <h2 className="hero-title">What&apos;s on your mind?</h2>
            </div>
          )}
          <div className="input-wrapper">
            <button
              className="input-icon-btn attachment-btn"
              type="button"
              title="Attach file"
              onClick={() => {
                setShowUpload(true);
                setUploadStatus(null);
              }}
            >
              <svg className="input-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
              </svg>
            </button>
            <input
              id="chat-input"
              type="text"
              placeholder="Ask anything…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && query.trim() && !loading) {
                  handleSearch();
                }
              }}
            />
            <button
              id="chat-send-btn"
              onClick={handleSearch}
              disabled={loading || !query.trim()}
              title="Send message"
            >
              {loading ? (
                <span className="spinner"></span>
              ) : (
                <svg className="send-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
