"""Local word-level transcription helper for ReCut.

The script writes JSON to stdout so Electron can consume it without a server.
Model files are cached by faster-whisper after the first download.
"""

from __future__ import annotations

import argparse
import json
import sys

from faster_whisper import WhisperModel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--model", default="base")
    parser.add_argument("--language", default=None)
    parser.add_argument("--song", action="store_true")
    return parser.parse_args()


def clean_word(word: object) -> dict[str, object] | None:
    probability = float(getattr(word, "probability", 0.0) or 0.0)
    text = str(getattr(word, "word", "") or "").strip()
    # Game audio produces tempting but incorrect low-confidence syllables.
    # A stricter threshold keeps captions honest instead of filling silence.
    if not text or probability < 0.48:
        return None
    return {
        "text": text,
        "start": round(float(word.start), 3),
        "end": round(float(word.end), 3),
        "probability": round(probability, 3),
    }


def transcribe(model: WhisperModel, media_path: str, language: str | None, song: bool) -> dict[str, object]:
    segments, info = model.transcribe(
        media_path,
        beam_size=5,
        vad_filter=not song,
        word_timestamps=True,
        condition_on_previous_text=False,
        language=language,
        initial_prompt=(
            "Lemon Demon, Fine. Sung English lyrics."
            if song else
            "Gaming montage. Minecraft PvP, End Crystal, Totem, kill, dead."
        ),
    )
    output_segments: list[dict[str, object]] = []
    for segment in segments:
        words = [item for word in (segment.words or []) if (item := clean_word(word))]
        text = " ".join(str(word["text"]) for word in words).strip()
        if not text or float(segment.no_speech_prob or 0.0) > 0.72:
            continue
        output_segments.append({
            "text": text,
            "start": round(float(segment.start), 3),
            "end": round(float(segment.end), 3),
            "noSpeechProbability": round(float(segment.no_speech_prob or 0.0), 3),
            "words": words,
        })
    return {
        "path": media_path,
        "language": info.language,
        "languageProbability": round(float(info.language_probability), 3),
        "segments": output_segments,
    }


def main() -> None:
    args = parse_args()
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    result = [transcribe(model, media_path, args.language, args.song) for media_path in args.paths]
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
