import logging
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)

_MAX_CHARS_PER_CHUNK = 2000

logger.info("Initializing local SentenceTransformer model (all-MiniLM-L6-v2)...")
model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
logger.info("Local SentenceTransformer model loaded successfully.")


def get_embedding(text: str) -> list[float]:
    """Fetch a single 384-dimensional embedding from the local SentenceTransformer model.

    Input text is silently truncated to 2000 characters if it exceeds the limit.
    """
    if len(text) > _MAX_CHARS_PER_CHUNK:
        logger.debug(
            "Chunk truncated from %d to %d chars.", len(text), _MAX_CHARS_PER_CHUNK
        )
        text = text[:_MAX_CHARS_PER_CHUNK]

    try:
        embedding = model.encode(text, convert_to_tensor=False)
        return embedding.tolist()
    except Exception as e:
        logger.error(f"Local embedding generation failed: {str(e)}")
        raise RuntimeError(f"Local embedding failure: {str(e)}")


def get_embeddings_batch(texts: list[str]) -> list[list[float]]:
    """Embed a list of text chunks locally in a parallel batch call.

    Each chunk is truncated to 2000 characters before embedding.
    """
    truncated = [t[:_MAX_CHARS_PER_CHUNK] for t in texts]
    try:
        embeddings = model.encode(truncated, convert_to_tensor=False)
        return [emb.tolist() for emb in embeddings]
    except Exception as e:
        logger.error(f"Local batch embedding generation failed: {str(e)}")
        raise RuntimeError(f"Local batch embedding failure: {str(e)}")
