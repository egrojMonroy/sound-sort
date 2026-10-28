# Sound Sort

Record or upload sounds, find the pitch of each one, and keep one library of all of them, sorted by pitch.

Site: https://egrojmonroy.github.io/sound-sort/

## How it works

1. **Add.** Record with the microphone, or upload a recording. Leave a short silence between sounds.
2. **Split.** The page cuts the recording at the silences. Sliders adjust the threshold, the gap and the tail.
3. **Pitch.** Each sound gets up to three pitch candidates. They are the strongest frequencies, weighted by how loud they sound to a human ear. Tap the one you hear to confirm it.
4. **Library.** Kept sounds join the library with an ID (`S0001`…), a name, notes and their source.
5. **Save.** "Save to GitHub" writes one commit to this repository.

Everything runs in the browser. Nothing is sent anywhere except GitHub.

## What is stored

- `library/sounds.json` holds one line per sound: ID, name, source, position in the source file, pitch candidates, the chosen pitch and whether you confirmed it.
- It also holds saved orders, so earlier sorts can be reopened.
- `library/previews/<ID>.wav` is a short listening copy: mono, 16-bit, 24 kHz, about 50 KB per second.
- Full-quality originals are not stored. Keep them on your computer.

## Saving from a phone

Settings asks for a fine-grained GitHub token once per browser.
Give it access to this repository only, with **Contents: Read and write**.
The token stays in that browser and is never written to the repository.

## Notes

- The microphone is opened with echo cancellation, noise suppression and automatic gain turned off.
- Adding a sound that is already in the library is detected and skipped.
- "Download zip" exports the current order as numbered WAV files plus `order.csv`.
