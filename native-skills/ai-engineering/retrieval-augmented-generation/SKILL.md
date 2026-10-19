---
name: retrieval-augmented-generation
description: Build or fix a retrieval system that feeds a language model. Use when answers cite the wrong source, when retrieval returns irrelevant chunks, or when building search over documents.
---

# Retrieval-Augmented Generation

## Where these systems actually fail

Almost never in the generation step. They fail in retrieval — the right passage was not in the top results, so the model answered from its own parameters and sounded equally confident. Debug retrieval first, always.

## Workflow

1. Evaluate retrieval on its own.
   - Build a set of questions with known correct sources. Measure recall at k. If the right chunk is not retrieved, no prompt change can fix the answer.
   - **Done when:** recall at k is measured and reported separately from answer quality.

2. Chunk on structure, not on length.
   - Split at headings, paragraphs and other semantic boundaries. A fixed character split cuts sentences in half and produces chunks that mean nothing alone. Include the document title and heading path in each chunk so it is self-describing.
   - **Done when:** a randomly sampled chunk is comprehensible in isolation.

3. Combine keyword and vector search.
   - Vector search misses exact identifiers, error codes and rare proper nouns; keyword search misses paraphrase. Hybrid retrieval with reciprocal rank fusion beats either alone on almost every corpus.
   - **Done when:** both retrievers run and their results are fused.

4. Rerank the candidates.
   - Retrieve broadly, then rerank with a cross-encoder and keep a few. This consistently produces the largest quality gain per unit of effort in the whole pipeline.
   - **Done when:** a reranking stage exists and its effect on recall is measured.

5. Make grounding enforceable.
   - Instruct the model to answer only from the context and to say so when the context is insufficient. Require a citation per claim, and verify the citation points at retrieved text.
   - **Done when:** a question with no supporting context produces a refusal, not an invention.

6. Handle the update path.
   - Documents change. Re-embedding everything on each change does not scale; track content hashes and re-embed only what changed.
   - **Done when:** updating one document does not require a full reindex.

## Verification

- Retrieval recall is measured against a labelled set.
- An out-of-corpus question is refused rather than answered.
- Every claim in an answer maps to a retrieved passage.
