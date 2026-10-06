from fastapi import APIRouter, Depends, HTTPException, status

from app.auth import require_api_key, get_current_user_id
from app import config
from app.config import LOW_CONFIDENCE_THRESHOLD, MAX_CONTEXT_DOCS
from app.logger import get_logger
from app.models.request_models import ChatRequest, Citation
from app.services.fusion_service import rrf_fusion
from app.services.llm_service import call_llm
from app.services.search_service import run_search
from app.utils.query_utils import rewrite_query_with_context

router = APIRouter()
logger = get_logger()


@router.post("/chat", dependencies=[Depends(require_api_key)])
def chat(
    req: ChatRequest,
    header_user_id: str = Depends(get_current_user_id),
):
    try:
        effective_user_id = req.user_id if (req.user_id and req.user_id != "default_user") else header_user_id

        messages = [m.model_dump() for m in req.messages]

        raw_query = next(
            (m["content"] for m in reversed(messages) if m["role"] == "user"),
            "",
        )
        logger.info(f"Query received ({len(raw_query)} chars) for user '{effective_user_id}'")

        user_query = rewrite_query_with_context(messages, logger)
        user_query_cleaned = user_query.lower().strip()
        logger.info(f"Final Query: {user_query_cleaned}")

        vector_hits, keyword_hits = run_search(
            user_query_cleaned, req.top_k, logger,
            document_filter=req.document_filter,
            user_id=effective_user_id,
        )
        logger.info(
            f"Retrieved {len(vector_hits)} vector hits and {len(keyword_hits)} keyword hits."
        )

        sorted_hits = rrf_fusion(vector_hits, keyword_hits)

        max_score = sorted_hits[0]["score"] if sorted_hits else 0
        logger.info(f"Hybrid Max Score: {max_score} (Threshold: {LOW_CONFIDENCE_THRESHOLD})")

        if max_score < LOW_CONFIDENCE_THRESHOLD:
            return {"reply": "No relevant context found.", "llm_called": False}

        top_hits = sorted_hits[:MAX_CONTEXT_DOCS]

        MAX_CONTEXT_CHARS = 8000
        context_blocks = []
        citations: list[Citation] = []
        accumulated_len = 0

        for i, hit in enumerate(top_hits):
            source = hit.get("source", {})
            combined_text = source.get("combined", "").replace("<br>", "\n").strip()
            if not combined_text:
                continue

            citation_id = len(citations) + 1
            source_file = source.get("source_file", "unknown")
            page_number = source.get("page_number")          # may be None for old chunks
            chunk_index = source.get("chunk_index")
            score = hit.get("score", 0.0)

            # Build the labeled context block for the LLM
            page_label = f", Page {page_number}" if page_number else ""
            block = (
                f"[Source {citation_id}] (File: {source_file}{page_label}):\n"
                f"{combined_text}"
            )
            if accumulated_len + len(block) > MAX_CONTEXT_CHARS and context_blocks:
                break

            context_blocks.append(block)
            accumulated_len += len(block)

            # Build the citation object (snippet = first 300 chars)
            snippet = combined_text[:300].rstrip() + ("…" if len(combined_text) > 300 else "")
            citations.append(Citation(
                id=citation_id,
                source_file=source_file,
                page_number=page_number,
                chunk_index=chunk_index,
                snippet=snippet,
                score=round(score, 6),
            ))

        retrieved_context = "\n\n".join(context_blocks)

        chat_history = [
            {"role": m["role"], "content": m["content"]}
            for m in messages[-(config.CHAT_HISTORY_WINDOW + 1):-1]
            if m.get("content", "").strip()
        ]
        chat_history.append({"role": "user", "content": user_query})

        system_prompt = (
            "Answer using only the provided context below. Do not hallucinate or add information "
            "not present in the sources.\n"
            "When you state a fact derived from a source, cite it immediately using bracket notation "
            "like [1] or [2], matching the [Source N] numbers in the context.\n\n"
            f"Context:\n{retrieved_context}"
        )

        payload = {
            "messages": [
                {"role": "system", "content": system_prompt}
            ] + chat_history
        }

        reply = call_llm(payload, logger)

        return {
            "reply": reply,
            "llm_called": True,
            "hits_used": len(context_blocks),
            "max_score": max_score,
            "citations": [c.model_dump() for c in citations],
        }

    except HTTPException:
        raise

    except Exception:
        logger.exception("Unhandled exception in POST /chat")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An internal error occurred while processing your request.",
        )
