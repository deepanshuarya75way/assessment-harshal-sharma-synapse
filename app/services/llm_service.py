"""LLM service — Hugging Face OpenAI-compatible chat completions router.

The application uses the Hugging Face serverless inference router exclusively.
Model is configured via the HF_LLM_MODEL environment variable.
"""

import time
import requests
from app import config

_HF_LLM_URL = "https://router.huggingface.co/v1/chat/completions"


def _normalize_messages(messages: list[dict]) -> list[dict]:
    """Ensure at most ONE system message exists at the start of the message list.

    Combines multiple system messages into a single system message to ensure
    compatibility with OpenAI-style router standards.
    """
    system_parts = []
    other_messages = []

    for msg in messages:
        if msg.get("role") == "system":
            content = msg.get("content", "").strip()
            if content:
                system_parts.append(content)
        else:
            other_messages.append(msg)

    if not system_parts:
        return other_messages

    combined_system = "\n\n".join(system_parts)
    return [{"role": "system", "content": combined_system}] + other_messages


def _call_with_retry(
    url: str,
    headers: dict,
    payload: dict,
    logger,
    max_retries: int = 3,
) -> requests.Response:
    """POST to ``url`` with exponential backoff on HTTP 429 (rate limit) and

    503 (model loading). Raises ``RuntimeError`` after all retries are
    exhausted.
    """
    for attempt in range(max_retries):
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=60)
        except requests.exceptions.Timeout:
            logger.warning(f"LLM API timeout (attempt {attempt + 1}/{max_retries}).")
            if attempt == max_retries - 1:
                raise TimeoutError(f"LLM API timed out after {max_retries} attempts.")
            time.sleep(2**attempt)
            continue

        if response.status_code == 200:
            return response

        if response.status_code == 429:
            wait = int(response.headers.get("Retry-After", 2**attempt))
            logger.warning(
                f"LLM API rate limited (429). Retrying in {wait}s "
                f"(attempt {attempt + 1}/{max_retries})."
            )
            time.sleep(wait)
            continue

        if response.status_code == 503:
            body = response.json() if response.content else {}
            wait = min(float(body.get("estimated_time", 20)), 30.0)
            logger.warning(
                f"LLM model loading (503). Waiting {wait:.0f}s "
                f"(attempt {attempt + 1}/{max_retries})."
            )
            time.sleep(wait)
            continue

        return response

    raise RuntimeError(f"LLM API failed after {max_retries} retries.")


def call_llm(payload: dict, logger) -> str:
    """Send a chat completion request to the Hugging Face OpenAI-compatible

    router and return the generated reply string.

    Normalizes system messages, enforces token-friendly structure, and targets
    only the primary model specified in config.HF_LLM_MODEL.
    """
    try:
        headers: dict = {"Content-Type": "application/json"}
        if config.HF_TOKEN:
            headers["Authorization"] = f"Bearer {config.HF_TOKEN}"

        messages = _normalize_messages(payload.get("messages", []))
        model = config.HF_LLM_MODEL

        hf_payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.3,
        }

        try:
            response = _call_with_retry(_HF_LLM_URL, headers, hf_payload, logger)

            if response.status_code == 200:
                data = response.json()
                reply: str | None = (
                    data.get("choices", [{}])[0].get("message", {}).get("content")
                )
                if reply:
                    return reply

            error_msg = f"HTTP {response.status_code} — {response.text}"
            logger.error(f"HF LLM model '{model}' failed: {error_msg}")
            return f"Error communicating with the language model ({error_msg}). Please try again."

        except Exception as e:
            logger.error(f"Exception trying model '{model}': {e}")
            return f"Error communicating with the language model: {e}"

    except Exception as exc:
        logger.exception("Unhandled exception in call_llm")
        return f"Error communicating with the language model: {exc}"
