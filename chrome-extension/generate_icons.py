#!/usr/bin/env python3
"""Generate simple PNG icons for the MapXtractor Chrome extension."""
import struct, zlib, os

def make_png(size):
    """Create a minimal valid PNG with a dark background and 'MX' text-like design."""
    # We'll draw a simple colored square as a placeholder icon
    # Color: dark blue-ish background (#1f6feb) with lighter center
    pixels = []
    bg = (31, 111, 235)   # #1f6feb  blue
    fg = (255, 255, 255)  # white

    for y in range(size):
        row = []
        for x in range(size):
            # Simple 'map pin' shape: filled circle
            cx, cy = size / 2, size / 2
            r = size * 0.42
            dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if dist <= r:
                # Inner highlight
                if dist <= r * 0.55:
                    row.extend(fg)
                else:
                    row.extend(bg)
            else:
                row.extend((13, 17, 23))  # #0d1117 background
        pixels.append(bytes(row))

    def png_chunk(tag, data):
        c = zlib.crc32(tag + data) & 0xffffffff
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', c)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    idat_raw = b''.join(b'\x00' + row for row in pixels)
    idat = zlib.compress(idat_raw, 9)

    return (
        b'\x89PNG\r\n\x1a\n'
        + png_chunk(b'IHDR', ihdr)
        + png_chunk(b'IDAT', idat)
        + png_chunk(b'IEND', b'')
    )

os.makedirs('icons', exist_ok=True)
for size in (16, 48, 128):
    with open(f'icons/icon{size}.png', 'wb') as f:
        f.write(make_png(size))
    print(f'icons/icon{size}.png created ({size}x{size})')
