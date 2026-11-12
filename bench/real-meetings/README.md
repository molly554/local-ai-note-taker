# Real meetings: do long Chinese meetings reach the notes model whole, and does search find them?

Checks on public meeting transcripts, run against the app's own code: its notes pipeline, its tokenizers, its engine
and its search. What is still unmeasured is at the end.

```
node bench/real-meetings/fetch.mjs                # once: 26 MB of transcripts into data/ (not kept in the repository)
node bench/real-meetings/notes.mjs                # stand-in tokenizer, nothing to install, about a minute

# with the app's own tokenizers and engine (pnpm install first)
node bench/real-meetings/fetch.mjs --models       # Qwen3 1.7B and EmbeddingGemma, 2.2 GB, checked against the catalogue's SHA-256
node bench/real-meetings/headers.mjs              # the Gemma 4 notes models' tokenizer from their files' headers, 32 MB
node bench/real-meetings/tokens.mjs               # section 1
node bench/real-meetings/notes.mjs --models       # section 2, about 6 minutes
node bench/real-meetings/overlong.mjs             # section 3: a real model on the processor, very slow
pnpm --dir app exec vitest run --config ../bench/real-meetings/vitest.config.mjs     # section 4
node bench/real-meetings/chart.mjs                # the chart in the repository's README, drawn from results-notes-models.json
```

## The meetings

| set | language | meetings | lines | characters a meeting (median / most) | what the text is | licence |
|---|---|---|---|---|---|---|
| [AISHELL-4](https://www.openslr.org/111/), test set | Mandarin | 20 | 10,541 | 9,505 / 12,607 | real meetings of 4 to 8 people, written down by people, with who spoke and when | CC BY-SA 4.0 |
| [VCSum](https://github.com/hahahawu/VCSum) | Mandarin | 239 | 83,097 | 12,683 / 44,080 | round-table meetings from video sites, turned into text by a speech-to-text service | MIT (the repository) |
| [QMSum](https://github.com/Yale-LILY/QMSum), product and academic meetings | English | 196 | 115,430 | 32,103 / 90,553 | the AMI and ICSI meeting corpora, written down by people | MIT (the repository); AMI and ICSI are CC BY 4.0 |

Each source is pinned to a revision in `fetch.mjs`; `data/manifest.json` lists every file with its SHA-256. VCSum's text
comes from other people's videos, so nothing from it is quoted here: only counts.

The app does not hear a meeting the way a corpus stores it. It knows the microphone ("You") and the computer's sound
(a name when the call app shows who is talking, "Them" otherwise). Each meeting is therefore run three ways, with its
first speaker standing in for the person recording: **a call with names shown**, **a call without names**, and **a room
on one microphone**, where everything is "You" and the whole meeting is one turn.

## 1. How many tokens is Chinese?

The notes code guesses the size of any text the tokenizer has not counted. Upstream guesses a third of a token a
character. This fork's guess is one token for a Chinese, Japanese or Korean letter and a third of a token for any other
character, and it is now a last resort: what decides a part's size is counted (section 2). `tokens.mjs` counts every
line of every meeting with two of the app's tokenizers: Gemma 4 E4B (the starter notes model) and Qwen3 1.7B (the
smallest one).

| tokenizer | meetings | tokens a character | upstream's guess / real | fork's guess / real |
|---|---|---|---|---|
| Gemma 4 E4B | AISHELL-4 (Mandarin) | 0.678 | 0.52 | 1.43 |
| | VCSum (Mandarin) | 0.607 | 0.56 | 1.56 |
| | QMSum (English) | 0.247 | 1.37 | 1.37 |
| Qwen3 1.7B | AISHELL-4 (Mandarin) | 0.640 | 0.55 | 1.52 |
| | VCSum (Mandarin) | 0.576 | 0.59 | 1.64 |
| | QMSum (English) | 0.245 | 1.39 | 1.39 |

A Chinese letter is about 0.6 tokens. Upstream's guess is a little over half the real size; the fork's is about one and
a half times it. For English both guess a third too high. Full figures: [`results-tokens.json`](results-tokens.json).

## 2. Notes: is every prompt small enough for the model?

`notes.mjs` runs `enhance()` on every meeting twice: `upstream/enhance.ts`, which is the file as it was at the commit
this fork started from (db8aaf9, byte for byte), and the fork's. In place of the model there is a stand-in that writes
nothing and records each prompt; tokens are counted by the two tokenizers above. A prompt **does not fit** when its
tokens plus the room kept for the answer are more than the context. The app asks for a context of 32,768 tokens and
takes as little as 8,192 when memory is short.

**Context 8,192. Meetings with a prompt that does not fit (the worst prompt, in contexts):**

| set | heard as | upstream, Gemma 4 E4B | upstream, Qwen3 1.7B | fork, either |
|---|---|---|---|---|
| AISHELL-4 (20) | call, names shown | 13 (1.57) | 13 (1.57) | 0 |
| | call, no names | 8 (1.25) | 11 (1.30) | 0 |
| | one microphone | 3 (1.18) | 8 (1.25) | 0 |
| | one microphone, no punctuation* | 2 (1.10) | 9 (1.29) | 0 |
| VCSum (239) | call, names shown | 11 (1.84) | 15 (1.86) | 0 |
| | call, no names | 30 (1.84) | 31 (1.86) | 0 |
| | one microphone | 119 (1.83) | 125 (1.86) | 0 |
| | one microphone, no punctuation* | 112 (3.33) | 133 (3.54) | 0 |
| QMSum (196) | all three | 0 | 0 | 0 |

\* Not something the corpora contain: their own text with every punctuation mark replaced by a space, as speech to
text may leave Chinese.

**Context 32,768.** No prompt fails to fit, in either build, and the two builds do the same thing: every Mandarin
meeting is read whole. The difference between the builds exists only below the context the app asks for.

Across all 44 combinations the fork sent no prompt that does not fit and lost no words. Full figures:
[`results-notes-models.json`](results-notes-models.json).

### What the real meetings showed

- **In these corpora the cause is the length guess, not unpunctuated speech.** The guess is used in two places: to
  decide whether what is left of a meeting fits in one part (so a whole Chinese meeting too big for the context is
  passed on as a single part: most of the AISHELL-4 rows are this), and to size the pieces of a turn that has to be
  cut (a room on one microphone: half of the VCSum meetings). The fork adds up the turns' own counts for the first.
- **Without punctuation upstream cannot cut a turn at all.** It cuts only between sentences, so a room on one
  microphone with no sentence marks goes out as one part: up to 3.5 contexts.
- **A guess on the high side costs parts, so the fork stopped guessing.** Its first fix guessed one token a Chinese
  letter for the pieces of a cut turn, and these checks showed the price: 536 parts for the VCSum meetings on one
  microphone where 348 could hold them (Gemma 4, 8,192), each one more call to the model. Now the tokenizer counts
  the sentences of a turn that has to be cut, and the fork uses 348. English gained the same way, in a place upstream
  has the slack too: 280 parts on one microphone where upstream uses 396 and 279 could hold it. In calls the fork
  uses about 14% more than the fewest (404 for 355, 400 for 350): a turn that fits a part is never cut, so parts are
  not filled to the brim.
- **Sentences counted one at a time do not add up to their turn.** A tokenizer reads a space or a mark at the end of
  a text differently from one in the middle: short English sentences came to a third more than their turn, Chinese
  ones to a little less, and with sizes simply added 4 VCSum meetings went over by up to 3% on Qwen3's tokenizer. So
  each sentence gets its share of the turn's real size, and every finished piece is counted once more before it is
  sent; one too big, and all are cut again with less room.
- **A sentence splitter dropped punctuation.** When a turn is cut between sentences, a mark standing on its own
  ("the ? ? You know") fell between two sentences: upstream drops 158 marks in 41 QMSum meetings (Gemma 4, one
  microphone, 8,192), no words. Fixed in the fork, with a test.
- **English was never at risk.** Both builds fit every prompt in all 196 meetings.

## 3. What a prompt that does not fit does on a real model

`overlong.mjs` loads Qwen3 1.7B into the app's own engine (`app/src/engine/llm.ts`) with a context of 8,192.

**Where is it cut?** Three passwords are put into a transcript, near the start, the middle and the end, and the model
is asked at the end to list them.

| transcript | prompt (tokens) | read by the engine | passwords listed |
|---|---|---|---|
| fits (the start of one AISHELL-4 meeting) | 4,486 | 4,494 | all three |
| does not fit (two AISHELL-4 meetings) | 12,934 | 4,846 | none |

Nothing failed and nothing was reported. The engine read 37% of the prompt, and the model wrote a summary of a
meeting instead of a list of passwords, as if the question at the end had never reached it.

**The pipeline's own prompt.** The AISHELL-4 meeting where upstream overshoots the most (a call with names shown) was
then put through upstream's `enhance()`. Its first call was the whole meeting as one part: 12,172 tokens, plus 700 for
the answer, into a context of 8,192. The engine read 5,437 of them, raised no error, and the answer did not start
with a topic line as the prompt asks: it opened with an introduction and closed with a summary, both of which the
instructions at the end of the prompt forbid.

So on this model a prompt that does not fit is cut without a word, and both answers read as if the instructions at
its end were among what was cut.
Figures: [`results-overlong.json`](results-overlong.json). The run was stopped by hand after that call: on the machine
used (4 cores, no graphics) the model wrote about 0.3 tokens a second whether or not the prompt fitted, so upstream's
last call and the fork's calls were not run.

## 4. Search: does a Chinese word show the meetings it is in?

`search.bench.mjs` puts the 259 Mandarin meetings (93,638 lines) into the app's own `Store` and asks its `search()`
for 15 ordinary words, 30 results at a time as the search window does. The words were fixed before any result was seen.

| word | lines with it | meetings with it | should show | shown | shown and have it | time (ms) |
|---|---|---|---|---|---|---|
| 我们 | 30,013 | 259 | 30 | 30 | 30 | 260 |
| 问题 | 5,717 | 255 | 30 | 30 | 30 | 13 |
| 技术 | 2,612 | 195 | 30 | 30 | 30 | 8 |
| 数据 | 1,673 | 173 | 30 | 30 | 30 | 4 |
| 市场 | 1,536 | 168 | 30 | 30 | 30 | 5 |
| 项目 | 981 | 158 | 30 | 30 | 30 | 4 |
| 合作 | 705 | 160 | 30 | 30 | 30 | 73 |
| 客户 | 689 | 100 | 30 | 30 | 30 | 62 |
| 人工智能 | 407 | 78 | 30 | 30 | 30 | 84 |
| 区块链 | 304 | 37 | 30 | 30 | 30 | 92 |
| 供应链 | 197 | 43 | 30 | 30 | 30 | 93 |
| 物业 | 126 | 10 | 10 | 10 | 10 | 78 |
| 预算 | 30 | 18 | 18 | 18 | 18 | 72 |
| 董事会 | 15 | 9 | 9 | 9 | 9 | 74 |
| 鲸鲨 (in no meeting) | 0 | 0 | 0 | 0 | 0 | 69 |

Every word showed as many meetings as it should, and every meeting shown has the word. Nothing to fix. The same run
times the pair index that was tried and dropped ([`../cjk-search`](../cjk-search/README.md)) on these lines; the
figures are in [`results-search.json`](results-search.json) and agree with the generated ones.

## How the tokenizers were got

- **Qwen3 1.7B**: the whole file (1.83 GB) from its catalogue address; its SHA-256 matches the catalogue's.
- **Gemma 4 E4B**: the file is 5.15 GB, and counting tokens needs only its header (settings, vocabulary, list of
  tensors). `headers.mjs` fetches the first 16 MB and leaves the rest of the file empty, at the real file's length.
  The method is checked on a file that is here whole: a header-only copy of EmbeddingGemma counted all 512 lines of a
  real meeting the same as the whole file did ([`results-headers.json`](results-headers.json)). Gemma 4 E2B's header
  gave the same count as E4B's on the meeting tried.
- **Why not EmbeddingGemma's tokenizer for Gemma**: its vocabulary is not the one in the Gemma 4 files
  ([`results-vocab.json`](results-vocab.json)), so it was not taken on trust.
- **Without any of this**, `notes.mjs` falls back to a stand-in tokenizer (a Chinese letter is 1 token, or 0.7), and
  writes [`results-notes.json`](results-notes.json). Its figures differ from the real ones in both directions; they
  are there for a run with nothing to download, not to be quoted.

## What this does not show

- **Gemma 4 itself was never run**, only its tokenizer. What it does with a prompt that does not fit is assumed to be
  what Qwen3 did, because the cutting is done by the engine, not the model; that was not tested.
- **One real call.** Section 3 is two prompts with passwords and one pipeline call, on one model. The fork's own
  calls were not run on the model: that its prompts are read whole rests on the "fits" row and on the counts in
  section 2.
- **How often the app runs at 8,192.** It depends on the memory of the computer and the model chosen; no figures
  for real users.
- **How whisper writes Chinese.** These transcripts were written by people or by another speech-to-text service. How
  much punctuation whisper leaves in Chinese needs audio; the rows without punctuation are made from the corpora's
  text, not recorded.
- **Who is "You".** The three ways of hearing a meeting are built from the corpus's speaker labels, not recorded.
- **Whether the notes are any good**, which 30 meetings a common word should show first, and Japanese or Korean:
  no open meeting corpus was found for either.
