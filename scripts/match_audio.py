"""Find a reference edit's song offset using spectral cross-correlation."""

from __future__ import annotations

import argparse
import json
import subprocess

import numpy as np
from scipy import signal


RATE = 8000
HOP = 256


def decode(ffmpeg: str, path: str, duration: float | None = None) -> np.ndarray:
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", path]
    if duration:
        command.extend(["-t", str(duration)])
    command.extend(["-vn", "-ac", "1", "-ar", str(RATE), "-f", "f32le", "pipe:1"])
    result = subprocess.run(command, check=True, capture_output=True)
    return np.frombuffer(result.stdout, dtype=np.float32)


def fingerprint(samples: np.ndarray) -> np.ndarray:
    frequencies, _, spectrum = signal.stft(
        samples, fs=RATE, nperseg=1024, noverlap=1024 - HOP,
        boundary=None, padded=False
    )
    useful = (frequencies >= 90) & (frequencies <= 3900)
    magnitude = np.log1p(np.abs(spectrum[useful]) * 80.0)
    bands = np.stack([
        chunk.mean(axis=0)
        for chunk in np.array_split(magnitude, 32, axis=0)
    ], axis=1)
    # Frame-wise normalization is resilient to bass boosts, volume changes and game audio.
    bands -= np.median(bands, axis=1, keepdims=True)
    bands /= np.linalg.norm(bands, axis=1, keepdims=True) + 1e-8
    return bands.astype(np.float32)


def match(reference: np.ndarray, music: np.ndarray) -> tuple[int, float]:
    if len(music) <= len(reference):
        return 0, 0.0
    correlation = np.zeros(len(music) - len(reference) + 1, dtype=np.float64)
    for band in range(reference.shape[1]):
        correlation += signal.correlate(
            music[:, band], reference[:, band], mode="valid", method="fft"
        )
    reference_energy = float(np.sum(reference * reference))
    music_energy = np.sum(music * music, axis=1)
    window_energy = np.convolve(music_energy, np.ones(len(reference)), mode="valid")
    scores = correlation / np.sqrt(np.maximum(reference_energy * window_energy, 1e-8))
    index = int(np.argmax(scores))
    return index, float(scores[index])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("reference")
    parser.add_argument("music")
    parser.add_argument("duration", type=float)
    parser.add_argument("ffmpeg")
    args = parser.parse_args()
    reference = fingerprint(decode(args.ffmpeg, args.reference, args.duration))
    music = fingerprint(decode(args.ffmpeg, args.music))
    index, confidence = match(reference, music)
    print(json.dumps({
        "offset": round(index * HOP / RATE, 3),
        "confidence": round(confidence, 6)
    }))


if __name__ == "__main__":
    main()
