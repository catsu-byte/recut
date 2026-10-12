"""Local word-level transcription helper for ReCut.

The script writes JSON to stdout so Electron can consume it without a server.
Model files are cached by faster-whisper after the first download.

For songs, the vocals can optionally be separated with Demucs first (install
`demucs`), which removes most of the beat and makes lyric timing far more
reliable. A GPU is used automatically when CUDA is available.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--model", default="auto")
    parser.add_argument("--language", default=None)
    parser.add_argument("--song", action="store_true")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--vocals", action="store_true", help="separate vocals with Demucs when installed")
    parser.add_argument("--prompt-file", default=None, help="known lyrics used as vocabulary hint")
    parser.add_argument("--offset", type=float, default=0.0, help="seconds subtracted from every timestamp")
    parser.add_argument("--clip-end", type=float, default=None, help="drop words that start after this time")
    return parser.parse_args()


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def load_model(name: str, device: str):
    from faster_whisper import WhisperModel

    attempts = []
    if device in ("auto", "cuda"):
        attempts.append(("cuda", "float16"))
    if device in ("auto", "cpu"):
        attempts.append(("cpu", "int8"))
    last_error: Exception | None = None
    for target, compute_type in attempts:
        model_name = name
        if name == "auto":
            model_name = "large-v3" if target == "cuda" else "small"
        try:
            model = WhisperModel(model_name, device=target, compute_type=compute_type)
            log(f"whisper model={model_name} device={target}")
            return model, model_name, target
        except Exception as error:  # CUDA libraries missing, out of memory, …
            last_error = error
            log(f"whisper on {target} unavailable: {error}")
    raise RuntimeError(f"No usable Whisper backend: {last_error}")


def separate_vocals(media_path: str, workdir: str) -> str | None:
    try:
        import demucs.separate  # noqa: F401
    except Exception:
        return None
    try:
        import demucs.separate as separate

        separate.main(["--two-stems", "vocals", "-n", "htdemucs", "-o", workdir, media_path])
        stem = os.path.splitext(os.path.basename(media_path))[0]
        vocals = os.path.join(workdir, "htdemucs", stem, "vocals.wav")
        return vocals if os.path.exists(vocals) else None
    except Exception as error:
        log(f"vocal separation failed, using the full mix: {error}")
        return None


def clean_word(word: object, minimum_probability: float, offset: float) -> dict[str, object] | None:
    probability = float(getattr(word, "probability", 0.0) or 0.0)
    text = str(getattr(word, "word", "") or "").strip()
    # Game audio produces tempting but incorrect low-confidence syllables.
    # A stricter threshold keeps captions honest instead of filling silence.
    if not text or probability < minimum_probability:
        return None
    return {
        "text": text,
        "start": round(float(word.start) - offset, 3),
        "end": round(float(word.end) - offset, 3),
        "probability": round(probability, 3),
    }


def transcribe(model, media_path: str, args: argparse.Namespace, prompt: str | None) -> dict[str, object]:
    song = args.song
    source = media_path
    separated = False
    if song and args.vocals:
        workdir = tempfile.mkdtemp(prefix="recut-vocals-")
        vocals = separate_vocals(media_path, workdir)
        if vocals:
            source = vocals
            separated = True
    if song:
        initial_prompt = prompt[-800:] if prompt else None
    else:
        initial_prompt = "Gaming montage. Minecraft PvP, End Crystal, Totem, kill, dead."
    segments, info = model.transcribe(
        source,
        beam_size=5,
        # Separated vocals contain real silence, so VAD helps; on a full mix it
        # would discard sung parts.
        vad_filter=(not song) or separated,
        word_timestamps=True,
        condition_on_previous_text=bool(prompt),
        language=args.language,
        initial_prompt=initial_prompt,
    )
    minimum = 0.3 if (song and (separated or prompt)) else 0.36 if song else 0.48
    output_segments: list[dict[str, object]] = []
    for segment in segments:
        words = [item for word in (segment.words or []) if (item := clean_word(word, minimum, args.offset))]
        words = [word for word in words if float(word["end"]) > 0 and (args.clip_end is None or float(word["start"]) < args.clip_end)]
        text = " ".join(str(word["text"]) for word in words).strip()
        if not text or float(segment.no_speech_prob or 0.0) > 0.72:
            continue
        output_segments.append({
            "text": text,
            "start": round(float(segment.start) - args.offset, 3),
            "end": round(float(segment.end) - args.offset, 3),
            "noSpeechProbability": round(float(segment.no_speech_prob or 0.0), 3),
            "words": words,
        })
    return {
        "path": media_path,
        "language": info.language,
        "languageProbability": round(float(info.language_probability), 3),
        "vocalsSeparated": separated,
        "segments": output_segments,
    }


def main() -> None:
    args = parse_args()
    prompt = None
    if args.prompt_file:
        with open(args.prompt_file, encoding="utf-8") as handle:
            prompt = " ".join(handle.read().split()) or None
    model, model_name, device = load_model(args.model, args.device)
    result = [transcribe(model, media_path, args, prompt) for media_path in args.paths]
    for item in result:
        item["model"] = model_name
        item["device"] = device
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
