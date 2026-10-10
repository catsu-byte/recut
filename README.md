# ReCut

**Drop clips. Add a reference. Get the cut.**

ReCut is a local-first desktop tool that turns pre-selected gaming highlights into a short montage inspired by the pacing of a reference edit. It detects scene cuts and audio peaks in the reference, scans source clips for high-motion moments, creates a 15–45 second edit, renders a preview, and exports an editable timeline for DaVinci Resolve Free.

> ReCut is an early MVP. It matches structure and energy rather than copying a creator's exact proprietary effects or creative decisions.

## What works

- Reference scene-cut detection
- Audio-onset and peak detection
- Game-agnostic motion scoring for source clips
- Automatic highlight-to-timeline assignment
- Five local FFmpeg effects: clean, drift, push, punch, shake, and flash
- 16:9 and 9:16 output
- H.264 preview render with music
- FCPXML timeline and JSON analysis report
- Offline processing; clips never leave the computer

## Requirements

- Windows 10 or 11
- DaVinci Resolve Free
- Node.js 20 or newer when running from source

## Run from source

```powershell
npm install
npm run dev
```

Choose one reference edit and one or more gaming clips. An optional music file can replace the reference audio. Analysis works immediately; choose an output folder only when you are ready to render the montage.

## Import into DaVinci Resolve Free

1. Open a project in Resolve.
2. Use **File → Import → Timeline**.
3. Select `recut-timeline.fcpxml` from the generated output folder.
4. Relink the generated `segments` folder if Resolve asks for media locations.

The generated `recut-preview.mp4` is a quick preview. The imported timeline contains the individually rendered segments so the order, timing, audio and additional effects remain editable.

## Development

```powershell
npm test
npm run build
npm run dist
```

`npm run dist` produces a portable Windows build in `release/`.

## Roadmap

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
