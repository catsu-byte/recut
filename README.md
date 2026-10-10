# ReCut

**Drop clips. Add a reference. Get the cut.**

ReCut is a local-first desktop tool that turns pre-selected gaming highlights into a short montage inspired by the pacing of a reference edit. It detects scene cuts and audio peaks in the reference, scans source clips for impact moments, creates a 15–45 second edit, generates subtitles, renders a preview, and exports an editable timeline for DaVinci Resolve Free.

> ReCut is an early MVP. It matches structure and energy rather than copying a creator's exact proprietary effects or creative decisions.

## What works

- Reference scene-cut detection
- Audio-onset and peak detection
- Game-agnostic motion and audio-impact scoring for source clips
- One intentional macro shot per selected highlight, ending just after the detected impact
- Spectral music matching, resilient to bass boosts and game audio
- Local song transcription with word timestamps
- Optional LRC/SRT import for exact user-provided lyrics and timing
- Continuous white lyric captions on a black background
- Soft, semi-transparent 3D keywords with bundled Bebas Neue typography and directional light trails
- Pre-impact grayscale pullback followed by RGB split, flash and micro-shake
- Reference-cut subdivision, push, drift and glitch effects
- Lanczos HD delivery, controlled sharpening and reduced saturation
- 16:9 and 9:16 output
- H.264 preview render with matched music and original clip audio
- FCPXML timeline and JSON analysis report
- Offline processing; clips never leave the computer

## Requirements

- Windows 10 or 11
- DaVinci Resolve Free
- Node.js 20 or newer when running from source
- Python 3.10+ with `faster-whisper`, `numpy`, and `scipy` for music matching and lyric captions in the current MVP

## Run from source

```powershell
npm install
python -m pip install faster-whisper numpy scipy
npm run dev
```

Choose one reference edit and one or more gaming clips. An optional music file can replace the reference audio. Analysis works immediately; choose an output folder only when you are ready to render the montage.

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
