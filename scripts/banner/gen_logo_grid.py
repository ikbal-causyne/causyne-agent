"""Regenerate terminal pixel grids from the canonical Causyne vector paths.

This is a development tool, not an install-time hook. It intentionally lives
outside the npm artifact, so users never receive a Python or native dependency.
Each output pixel stores a blade ID (0-5 clockwise from the lime blade) or '.'.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

try:
    import cairosvg
    import numpy as np
    from PIL import Image
    from scipy import ndimage
except ModuleNotFoundError as error:
    raise SystemExit(
        "Logo regeneration requires cairosvg, numpy, Pillow, and scipy; "
        f"missing {error.name}. The generated runtime grids are already committed."
    ) from error


PARTS = json.loads(Path(__file__).with_name("logo-parts.json").read_text())
VIEW_BOX = PARTS["vb"]
OVERSAMPLE = 16


def raster_mask(path_data: str, width: int, height: int) -> np.ndarray:
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VIEW_BOX}">'
        f'<path fill="#000" fill-rule="evenodd" d="{path_data}"/></svg>'
    )
    png = cairosvg.svg2png(
        bytestring=svg.encode(), output_width=width, output_height=height
    )
    return np.array(Image.open(io.BytesIO(png)).split()[-1]) > 127


def logo_grid(
    target_width: int,
    target_height: int,
    erosion: float,
    threshold: float = 0.34,
) -> list[str]:
    width = target_width * OVERSAMPLE
    height = target_height * OVERSAMPLE
    lime = raster_mask(PARTS["lime"], width, height)
    labels, count = ndimage.label(raster_mask(PARTS["gray"], width, height))
    if count != 5:
        raise RuntimeError(f"expected five gray blades, found {count}")

    blades = [lime, *(labels == index for index in range(1, 6))]
    angles: list[float] = []
    for blade in blades:
        ys, xs = np.nonzero(blade)
        angles.append(np.arctan2(ys.mean() - height / 2, xs.mean() - width / 2))

    order = sorted(
        range(6), key=lambda index: (angles[index] - angles[0]) % (2 * np.pi)
    )
    coverage = []
    for index in order:
        eroded = ndimage.distance_transform_edt(blades[index]) > erosion * OVERSAMPLE
        coverage.append(
            eroded.reshape(target_height, OVERSAMPLE, target_width, OVERSAMPLE)
            .mean(axis=(1, 3))
        )

    stacked = np.stack(coverage)
    strongest = stacked.argmax(0)
    visible = stacked.max(0) >= threshold
    return [
        "".join(
            str(strongest[y, x]) if visible[y, x] else "."
            for x in range(target_width)
        )
        for y in range(target_height)
    ]


if __name__ == "__main__":
    # These dimensions match LOGO_L and LOGO_S in src/tui/banner.ts.
    variants = [("LOGO_L", 22, 24, 0.26), ("LOGO_S", 18, 20, 0.30)]
    for name, width, height, erosion in variants:
        print(f"--- {name} ({width}x{height})")
        print("\n".join(logo_grid(width, height, erosion)))
