# ReCut

**Drop clips. Add a reference. Get the cut.**

ReCut is a local-first desktop tool that turns pre-selected gaming highlights into a short montage inspired by the pacing of a reference edit. It detects scene cuts and audio peaks in the reference, scans source clips for impact moments, creates a 15–45 second edit, generates subtitles, renders a preview, and exports an editable timeline for DaVinci Resolve Free.

> ReCut is an early MVP. It matches structure and energy rather than copying a creator's exact proprietary effects or creative decisions.

## Schnellstart Windows (Kurzfassung)

**Was man braucht:**

| | Wofür | Pflicht? |
|---|---|---|
| `ReCut-0.8.0-portable.exe` ([Releases](https://github.com/catsu-byte/recut/releases)) | Die App – Doppelklick, keine Installation | ✅ |
| Python **3.12** (nicht 3.13/3.14), mit „Add python.exe to PATH“ | Lyrics / Untertitel | empfohlen |
| `faster-whisper numpy scipy` (pip) | Lyrics / Untertitel + Musik-Matching | empfohlen |
| `demucs` (pip, ~2 GB) | Sauberere Lyrics (Gesang vom Beat trennen) | optional |
| `yt-dlp` (pip) | Ersatz, falls Medal-Download klemmt | optional |
| NVIDIA-GPU mit CUDA 12 + cuDNN 9 | Schnellere/genauere Lyrics (sonst CPU) | optional |

Schnitt, Effekte, Hit-Sync, Key-Moments, Medal-Links, Watermark-Entfernung und Font-aus-Bild laufen **ohne** Python.

**Alles auf einmal installieren:** [`windows/setup-lyrics.bat`](windows/setup-lyrics.bat) herunterladen und doppelklicken – oder diese PowerShell-Befehle nacheinander ausführen:

```powershell
winget install -e --id Python.Python.3.12
```

PowerShell danach schließen und neu öffnen, dann:

```powershell
python -m pip install --upgrade pip
python -m pip install faster-whisper numpy scipy
```

Optional:

```powershell
python -m pip install demucs yt-dlp
```

Danach ReCut neu starten – oben rechts steht dann „Local AI ready“. Beim ersten Render mit Lyrics wird das Sprachmodell einmalig geladen (0,5–3 GB). Windows-SmartScreen-Warnung beim Start: „Weitere Informationen“ → „Trotzdem ausführen“ (die exe ist nicht signiert). Bei Problemen die `recut-report.json` aus dem Ausgabeordner schicken.

## What works

**Key moments & hit sync**
- Multiple key moments per clip: every audio transient is scored with visual motion and a crisp high-frequency "hit sound" component
- Multi-kill clusters: the final kill gets the big beat-synced hit, earlier kills get smaller accent hits
- Double Crystal Tap (D-tap) scoring from paired audio transients plus visual motion
- Global hit sync: one dynamic-programming pass picks a strong music beat (preferably on a reference cut) for every clip, so all hits land on the beat instead of each clip being nudged individually
- The visual hit (not the trailing kill sound) lands on the beat; the slot stays open until the kill sound has played

**Edit style**
- Velocity edit: speed-up into the kill, slow motion right after it, natural speed in between
- Freeze frame with a slow push-in when a clip ends right after the kill
- Zoom punch, RGB split, flash and shake on the hit; grayscale pull-back before it
- Beat pulses (zoom kicks on strong beats), whip-in transitions between clips
- Game audio is boosted around each kill and ducked elsewhere
- Cinematic, Balanced and Aggressive presets with distinct pacing, ramps, effects and grading

**Lyrics**
- Local Whisper transcription with automatic GPU use (large-v3 on CUDA, small on CPU, selectable)
- Optional vocal isolation with Demucs before transcription for much cleaner timing
- Context padding around the song section so words at the edges are not lost
- Paste the plain song text: ReCut aligns it to what Whisper heard, fixes misheard words and keeps the timing (the full song text is fine)
- Pasted LRC text or LRC/SRT/VTT files for exact user-provided timing

**Instructions (German or English)**
- e.g. `Die Kills sind immer am Ende der Clips`, `Kill in den letzten 3 Sekunden`, `exakt auf den Beat`, `keine Slowmo`, `kein Freeze`, `keine Lyrics`, `mehr Effekte`, `eher smooth`, `Wasserzeichen bei allen Clips entfernen`
- "Kills at the end" also changes detection: the search window moves to the end of each clip instead of skipping it
- Recognised directives are shown as chips under the text field

**Medal & watermarks**
- Paste several Medal.tv links at once; highest available quality, cached per clip ID, retries, yt-dlp fallback when installed
- Watermark removal for clips you own: the static overlay is located automatically (edges that stay put while the gameplay moves) and erased with `delogo`; the detected box is shown in the review storyboard; edge crop remains as an option

**Fonts**
- Font from an image: choose a screenshot (e.g. a frame of the reference edit), type the text it shows, and ReCut ranks all installed fonts by shape similarity
- The real family name is read from TTF/OTF files automatically

**Everything else**
- Reference scene-cut detection, audio-onset detection and spectral music matching
- Human-review storyboard with key-moment ticks and an editable marker for every clip
- 16:9 and 9:16, Draft/High/Master render profiles, analysis caching, cancellable rendering
- FCPXML timeline for DaVinci Resolve, JSON analysis report, ASS subtitle sidecar
- Offline processing; clips never leave the computer (Medal import only downloads)

## Requirements

Required:
- Windows 10/11 (the portable build), or Linux/macOS when running from source
- Node.js 20 or newer when running from source

For lyrics and the best music matching (strongly recommended):
- Python 3.10–3.12 (3.13+ may not have `faster-whisper`/`ctranslate2` wheels yet), on PATH as `python`, or set `RECUT_PYTHON`
- `python -m pip install faster-whisper numpy scipy`

Optional:
- NVIDIA GPU + CUDA 12 runtime (cuBLAS + cuDNN 9) for fast, high-quality lyric recognition (`pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` is the easiest route)
- `python -m pip install demucs` for vocal isolation (pulls PyTorch, ~2 GB)
- `yt-dlp` on PATH (or `RECUT_YTDLP`) as Medal download fallback
- DaVinci Resolve Free to keep editing the exported timeline

The Whisper model (~0.5–3 GB depending on quality) downloads once on the first lyric render.

## Run from source

```powershell
npm install
python -m pip install faster-whisper numpy scipy
python -m pip install demucs   # optional
npm run dev
```

Choose one reference edit and one or more gaming clips. An optional music file can replace the reference audio. Analysis works immediately; choose an output folder only when you are ready to render the montage.

You can also paste one or more public Medal.tv clip links below the local clip picker. Imported files are cached in ReCut's user-data directory. Use watermark removal only for clips you own or are authorized to modify.

The instruction field recognizes focused editing directives in English and German. Examples:

- `Kills immer am Ende jedes Clips.`
- `Sync impacts exactly to the beat.`
- `Wasserzeichen entfernen.`
- `No D-tap detection.`

For custom fonts, select the font file — the family name is filled in automatically — or let ReCut find the font from a screenshot. Image overlays are scaled to 18% of the output width and can be placed in any corner.

## Import into DaVinci Resolve Free

1. Open a project in Resolve.
2. Use **File → Import → Timeline**.
3. Select `recut-timeline.fcpxml` from the generated output folder.
4. Relink the generated `segments` folder if Resolve asks for media locations.

The generated `recut-preview.mp4` includes burned-in styled captions. Captions stay visible between detected lyric phrases so the lower subtitle strip remains continuous. `recut-captions.ass` is the editable subtitle sidecar. The imported timeline contains the individually rendered segments so the order and timing remain editable.

Lyric text is transcribed from the selected local audio file by default. For exact wording, select a legally obtained `.lrc` or `.srt` file before rendering. ReCut does not scrape copyrighted lyric sites.

## Development

```powershell
npm test
npm run build
npm run dist
```

`npm run dist` produces a portable Windows build in `release/`.

## Roadmap

- Bundle the audio-matching and speech engines into the portable build
- Detect effect signatures from reference frames
- Add RGB split, blur and configurable Fusion macros
- Optional game profiles for Valorant and Minecraft
- Better highlight scoring using audio and HUD events
- Manual timeline review before rendering
- Crossfade and transition matching

## Privacy

All analysis and rendering happen locally using the bundled FFmpeg binaries. ReCut does not upload media or require an account.

## License

[MIT](LICENSE)
