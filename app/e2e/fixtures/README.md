# Test audio

Both clips are public-domain LibriVox recordings, 16.5 s each, cut from 0:40 and converted to 16 kHz mono 16-bit wav
with `ffmpeg -ss 40 -t 16.5 -i <mp3> -ac 1 -ar 16000 -c:a pcm_s16le -map_metadata -1 -fflags +bitexact <wav>`.
Two different readers, so the two sides of a meeting sound like two people.

They are then laid out as a short call, silent between turns, the way the fake transcriber (`src/main/asr/fake.ts`)
expects: me talks 0.5–4.0 s (the clip's 0–3.5 s) and 10.5–12.4 s (its 5.0–6.9 s); them talks 5.2–8.7 s (its 2.5–6.0 s)
and 13.3–14.8 s (its 7.0–8.5 s), each piece faded in and out over 20 ms. Speech on both sides the whole time put the
other side's first line at 0:00 and the tests found it twice.

| File | Source | Reader | Licence |
|---|---|---|---|
| meeting-me.wav | The Art of War by Sun Tzu, tr. Lionel Giles, chapters 1-2: https://archive.org/download/art_of_war_librivox/art_of_war_01-02_sun_tzu_64kb.mp3 (catalog: https://librivox.org/the-art-of-war-by-sun-tzu/) | Moira Fogarty | Public domain (LibriVox) |
| meeting-them.wav | Rock A Bye Library: A Book of Fables, section 1: https://archive.org/download/rockabye_library_ds_librivox/rockabyelibrary_01_anonymous_64kb.mp3 (catalog: https://librivox.org/rock-a-bye-library-a-book-of-fables-author-unknown/) | Denny Sayers | Public domain (LibriVox) |

sha256 of the source mp3s: `6cb289fa9a13cfc94b18e8a89159da687c60db88c2b6377311f9bc5664d5492f` (Art of War),
`fc473fa2f0da8fbd5beed7c2155baf0afc09ad19fd6c12f3063ecdb24f1f40ff` (Rock A Bye Library).

The speed check's clip, `app/resources/speed/clip.wav`, is John F. Kennedy's inaugural address (1961), a work of the
United States government and in the public domain; its source is in `app/resources/speed/README.txt`.
