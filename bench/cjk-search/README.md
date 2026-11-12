# Experiment: a pair index for Chinese search (not shipped)

**Question.** Search for Chinese, Japanese and Korean reads every transcript line (`instr`), because the word index
sees a run of these letters as one word. Does that get slow as a library grows, and is an index worth adding?

**What was tried.** Each run of CJK letters indexed as its pairs of neighbouring letters in an FTS5 table
("发布计划" → "发布 布计 计划"); a search becomes a phrase of pairs, ranked by the index.

**How it was measured.** `node bench/cjk-search/run.mjs` builds transcripts from a fixed seed (the same lines on
every run), then times the two SQL queries, median of 15 runs. It times the queries, not the app around them.
Numbers below: Windows, Node 26.1, Intel i5-6400. Full output in [`results.json`](results.json).

| 200,000 lines | lines that match | read every line | pair index |
|---|---|---|---|
| rare word | 35 | 66 ms | 0.2 ms |
| two words | 566 | 58 ms | 7 ms |
| word not in the library | 0 | 65 ms | 0.07 ms |
| common word | 17,322 | 3.8 ms | 38 ms |
| four-letter phrase | 17,035 | 2.3 ms | 54 ms |

- The index is about 1.8 times the size of the lines themselves (36.5 MB for 19.8 MB) and takes about 11 s to build
  once for 200,000 lines.
- Reading every line stops at the first 500 matches, so common words are already fast; the index ranks every match
  first, which makes them slower.

**Decision.** Not shipped. At 200,000 lines (several hundred hours of meetings) the existing search never took more
than 66 ms, so there was no slowness to fix. The index would add storage, a one-time build for existing libraries and
five write paths to keep in step, in exchange for ranking that was not measured to be better.

**What it does not show.** The lines are generated, not real meetings. No relevance judgments were made, so whether
ranked results are more useful than the current order is untested.
