# Real meetings: do long Chinese meetings reach the notes model whole, and does search find them?

Two checks on public meeting transcripts, run against the app's own code. No model runs in either; what that leaves
unmeasured is at the end.

```
node bench/real-meetings/fetch.mjs                                                   # once: 26 MB of transcripts into data/ (not kept in the repository)
node bench/real-meetings/notes.mjs                                                   # about a minute
pnpm --dir app exec vitest run --config ../bench/real-meetings/vitest.config.mjs     # search; needs pnpm install
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

## 1. Notes: is every prompt small enough for the model?

`notes.mjs` runs `enhance()` on every meeting twice: `upstream/enhance.ts`, which is the file as it was at the commit
this fork started from (db8aaf9, byte for byte), and the fork's. In place of the model there is a stand-in that writes
nothing and records each prompt. A prompt **does not fit** when its tokens plus the room kept for the answer are more
than the context. The app asks for a context of 32,768 tokens and takes as little as 8,192 when memory is short.

Tokens are counted by a stand-in tokenizer: one for every four characters, and for a Chinese letter either 1 or 0.7
(both are run, because the real figure for the app's models was not measured).

**Context 8,192. Meetings with a prompt that does not fit (the worst prompt, in contexts):**

| set | heard as | upstream, 1 token a letter | upstream, 0.7 | fork, either |
|---|---|---|---|---|
| AISHELL-4 (20) | call, names shown | 20 (1.67) | 1 (1.01) | 0 |
| | call, no names | 20 (1.59) | 3 (1.11) | 0 |
| | one microphone | 20 (1.56) | 3 (1.14) | 0 |
| VCSum (239) | call, names shown | 102 (1.93) | 83 (1.78) | 0 |
| | call, no names | 119 (2.56) | 93 (1.78) | 0 |
| | one microphone | 183 (2.59) | 142 (1.86) | 0 |
| QMSum (196) | all three | 0 | - | 0 |

**Context 32,768.** Every AISHELL-4 and QMSum meeting is read whole, and the two builds do the same thing. In VCSum, at
1 token a letter, 11 of 239 meetings are read in parts; upstream has a prompt that does not fit in 1 of them (call
without names) and 3 of them (one microphone), 1.02 to 1.03 contexts; the fork in none. At 0.7 every meeting is read whole.

Across all 30 combinations the fork sent no prompt that does not fit and lost no words. Full figures: [`results-notes.json`](results-notes.json).

### What the real meetings showed

- **The cause is the length guess, not unpunctuated speech.** Text the tokenizer has not counted is guessed at a third
  of a token a character. That is on the safe side for English and two to three times too low for Chinese (at 0.7 to
  1 token a letter). The guess is used in
  two places: to decide whether what is left of a meeting fits in one part (so a whole Chinese meeting too big for the
  context is passed on as a single part: every AISHELL-4 row above is this), and to size the pieces of a turn that has
  to be cut (a room on one microphone). The fork counts a Chinese, Japanese or Korean letter as one token.
- **The fork's guess is on the high side, and that costs parts.** Fewest parts that could hold the VCSum meetings at
  8,192: 378 to 380 at 0.7 tokens a letter. The fork used 438 (names shown), 506 (no names) and 565 (one microphone):
  up to half as many again, each one more call to the model. At 1 token a letter it used 528 to 653 for 523 to 525.
  English has the same slack in both builds on one microphone: 407 parts where 289 could hold it.
- **A sentence splitter dropped punctuation.** When a turn is cut between sentences, a mark standing on its own
  ("the ? ? You know") fell between two sentences: 164 marks in 43 QMSum meetings, no words. Fixed in the fork, with a test.
- **English was never at risk.** Both builds fit every prompt in all 196 meetings.

## 2. Search: does a Chinese word show the meetings it is in?

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

## What this does not show

- **Real token counts.** The stand-in tokenizer is an assumption. How many tokens a Chinese letter is for the app's
  models decides how often upstream goes over (the two columns above) and how many extra parts the fork makes.
- **What the model does with a prompt that does not fit.** No model was run; whether it fails or reads only some of
  the transcript was not tested.
- **How whisper writes Chinese.** These transcripts were written by people or by another speech-to-text service. How
  much punctuation whisper leaves in Chinese, which is what cutting a long turn depends on, needs audio.
- **Who is "You".** The three ways of hearing a meeting are built from the corpus's speaker labels, not recorded.
- **Whether the notes are any good**, which 30 meetings a common word should show first, and Japanese or Korean:
  no open meeting corpus was found for either.
