import io

from pypdf import PdfReader


def extract_pages_from_bytes(raw_bytes: bytes) -> list[dict]:
    """
    Extract selectable text from a PDF supplied as raw bytes, page by page.
    Returns a list of dicts: [{'page_number': int, 'text': str}, ...].
    Page numbers are 1-indexed. Pages with no extractable text are skipped.
    """
    reader = PdfReader(io.BytesIO(raw_bytes))
    pages = []
    for i, page in enumerate(reader.pages, start=1):
        text = page.extract_text()
        if text and text.strip():
            pages.append({"page_number": i, "text": text})
    return pages


def extract_text_from_bytes(raw_bytes: bytes) -> str:
    """
    Extract all selectable text from a PDF supplied as raw bytes.
    Used by the API route where the file arrives as an in-memory upload.
    Returns an empty string if the PDF contains no extractable text.
    """
    pages = extract_pages_from_bytes(raw_bytes)
    return "\n\n".join(p["text"] for p in pages)


def extract_pages_from_path(pdf_path: str) -> list[dict]:
    """
    Extract per-page text from a PDF supplied as a filesystem path.
    Used by CLI scripts where the file is read from disk.
    Returns a list of dicts: [{'page_number': int, 'text': str}, ...].
    """
    with open(pdf_path, "rb") as fh:
        return extract_pages_from_bytes(fh.read())


def extract_text_from_path(pdf_path: str) -> str:
    """
    Extract all selectable text from a PDF supplied as a filesystem path.
    Used by CLI scripts where the file is read from disk.
    """
    with open(pdf_path, "rb") as fh:
        return extract_text_from_bytes(fh.read())


def chunk_pages(
    pages: list[dict],
    chunk_size: int = 1500,
    chunk_overlap: int = 150,
) -> list[dict]:
    """
    Split per-page text into overlapping chunks, preserving the source page
    number for each chunk.

    Each input page is a dict: {'page_number': int, 'text': str}.
    Text within a page is split on double-newlines (paragraphs), then further
    split on sentence boundaries when a paragraph exceeds ``chunk_size``.

    Returns a list of dicts:
        [
            {'text': str, 'page_number': int, 'chunk_index': int},
            ...
        ]
    where ``chunk_index`` is the global 0-based position across all pages.
    """
    all_chunks: list[dict] = []
    chunk_index = 0

    for page in pages:
        page_number = page["page_number"]
        text = page["text"]
        paragraphs = text.split("\n\n")

        current_chunk: list[str] = []
        current_length: int = 0

        def _flush(parts: list[str], join_str: str) -> tuple[list[str], int]:
            nonlocal chunk_index
            all_chunks.append({
                "text": join_str.join(parts),
                "page_number": page_number,
                "chunk_index": chunk_index,
            })
            chunk_index += 1
            overlap_chars = 0
            overlap_parts: list[str] = []
            for part in reversed(parts):
                if overlap_chars + len(part) <= chunk_overlap:
                    overlap_parts.insert(0, part)
                    overlap_chars += len(part)
                else:
                    break
            seed_length = sum(len(p) for p in overlap_parts)
            return overlap_parts, seed_length

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            if len(para) > chunk_size:
                sentences = para.replace(". ", ".\n").split("\n")
                for sentence in sentences:
                    sentence = sentence.strip()
                    if not sentence:
                        continue
                    if current_length + len(sentence) > chunk_size and current_chunk:
                        current_chunk, current_length = _flush(current_chunk, " ")
                    current_chunk.append(sentence)
                    current_length += len(sentence)
            else:
                if current_length + len(para) > chunk_size and current_chunk:
                    current_chunk, current_length = _flush(current_chunk, "\n\n")
                current_chunk.append(para)
                current_length += len(para)

        if current_chunk:
            nonlocal_chunk_index = chunk_index
            all_chunks.append({
                "text": "\n\n".join(current_chunk),
                "page_number": page_number,
                "chunk_index": nonlocal_chunk_index,
            })
            chunk_index += 1

    return all_chunks


def chunk_text(
    text: str,
    chunk_size: int = 1500,
    chunk_overlap: int = 150,
) -> list[str]:
    """
    Split document text into overlapping chunks using a paragraph-sentence
    heuristic with a sliding overlap window.

    Algorithm
    ---------
    1.  Split the text on double-newlines to obtain paragraphs.
    2.  Accumulate paragraphs into the current chunk while they fit within
        ``chunk_size``.
    3.  When a paragraph does not fit, flush the current chunk, then seed
        the next chunk with the trailing portion of the flushed content that
        fits within ``chunk_overlap`` characters (sliding window).
    4.  Paragraphs wider than ``chunk_size`` are further split on sentence
        boundaries ('. '), applying the same overlap logic at sentence level.

    Parameters
    ----------
    text:         Full document text string.
    chunk_size:   Target maximum character length per chunk (default 1500).
    chunk_overlap: Number of characters from the end of the previous chunk
                   carried into the start of the next chunk (default 150).

    Returns
    -------
    A list of text chunk strings.
    """
    paragraphs = text.split("\n\n")
    chunks: list[str] = []
    current_chunk: list[str] = []
    current_length: int = 0

    def _flush(parts: list[str], join_str: str) -> tuple[list[str], int]:
        """
        Append the current chunk to ``chunks``, then build and return
        the overlap seed for the next chunk.
        """
        chunks.append(join_str.join(parts))

        overlap_chars = 0
        overlap_parts: list[str] = []
        for part in reversed(parts):
            if overlap_chars + len(part) <= chunk_overlap:
                overlap_parts.insert(0, part)
                overlap_chars += len(part)
            else:
                break
        seed_length = sum(len(p) for p in overlap_parts)
        return overlap_parts, seed_length

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        if len(para) > chunk_size:
            sentences = para.replace(". ", ".\n").split("\n")

            for sentence in sentences:
                sentence = sentence.strip()
                if not sentence:
                    continue

                if current_length + len(sentence) > chunk_size and current_chunk:
                    current_chunk, current_length = _flush(current_chunk, " ")

                current_chunk.append(sentence)
                current_length += len(sentence)

        else:
            if current_length + len(para) > chunk_size and current_chunk:
                current_chunk, current_length = _flush(current_chunk, "\n\n")

            current_chunk.append(para)
            current_length += len(para)

    if current_chunk:
        chunks.append("\n\n".join(current_chunk))

    return chunks
