#!/usr/bin/env python3
"""Fallback immagini via Gemini API a consumo, usato quando Google Flow non e' disponibile.
Standalone (non importa la skill design: vive fuori dal perimetro di scrittura di questo progetto).
"""
import argparse
import json
import os
import sys
from pathlib import Path

CONFIG_PATH = Path(__file__).parent / "config.json"

GEMINI_FLASH = "gemini-2.5-flash-image"  # Nano Banana
GEMINI_PRO = "gemini-3-pro-image-preview"  # Nano Banana Pro
ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"]


def load_api_key():
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if key:
        return key
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8")).get("apiKey")
        except Exception:
            return None
    return None


def main():
    parser = argparse.ArgumentParser(description="Fallback generazione immagini via Gemini API")
    parser.add_argument("--prompt", "-p", required=True)
    parser.add_argument("--model", "-m", choices=["flash", "pro"], default="flash")
    parser.add_argument("--ratio", "-r", choices=ASPECT_RATIOS, default="1:1")
    parser.add_argument("--output", "-o", required=True)
    args = parser.parse_args()

    api_key = load_api_key()
    if not api_key:
        print("Errore: GEMINI_API_KEY mancante (env var o fallback/config.json)", file=sys.stderr)
        sys.exit(1)

    try:
        from google import genai
        from google.genai import types
    except ImportError:
        print("Errore: pacchetto google-genai non installato (pip install google-genai)", file=sys.stderr)
        sys.exit(1)

    client = genai.Client(api_key=api_key)
    model = GEMINI_PRO if args.model == "pro" else GEMINI_FLASH

    response = client.models.generate_content(
        model=model,
        contents=args.prompt,
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE", "TEXT"],
            image_config=types.ImageConfig(aspect_ratio=args.ratio),
        ),
    )

    image_data = None
    for part in response.candidates[0].content.parts:
        if getattr(part, "inline_data", None) and part.inline_data.mime_type.startswith("image/"):
            image_data = part.inline_data.data
            break

    if not image_data:
        print("Errore: nessuna immagine generata dal modello", file=sys.stderr)
        sys.exit(1)

    Path(args.output).write_bytes(image_data)
    print(f"Immagine salvata: {args.output}")
    sys.exit(0)


if __name__ == "__main__":
    main()
